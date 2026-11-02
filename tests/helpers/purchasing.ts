import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@/lib/db/generated/client.ts";
import { createRole } from "@/server/services/roles";
import { createSupplier, upsertSupplierProduct } from "@/server/services/suppliers";
import { registerStockIn } from "@/server/services/inventory";
import { setReorderPolicy } from "@/server/services/reorder";
import { updateAiSettings } from "@/server/services/ai-settings";
import { inviteUser } from "@/server/services/users";
import {
  setAiClientFactoryForTests,
  type AiClient,
  type AiRequest,
  type AiResponse,
} from "@/server/integrations/openai";
import { setChannelDepsForTests } from "@/server/integrations/channels";
import { addUser, meta } from "./auth.ts";
import { inventoryWorld, key, make, plain, type InventoryWorld } from "./inventory.ts";
import type { AuthUser } from "@/lib/auth/can";

export const API_KEY = "sk-test-0123456789abcdefghij";

export interface PurchasingWorld extends InventoryWorld {
  /** Rol personalizado: ve compras pero NO los costos de compra. */
  noCost: AuthUser;
  suppliers: { whitelisted: string; other: string; third: string };
}

export async function purchasingWorld(
  admin: PrismaClient,
  plan: "pro" | "enterprise" = "enterprise",
): Promise<PurchasingWorld> {
  const w = await inventoryWorld(admin, plan);
  const role = await createRole(
    w.admin,
    { name: "Compras sin costos", permissions: ["purchasing:ver", "catalog:ver", "inventory:ver"] },
    meta(),
  );
  const noCost = await addUser(
    (input) => inviteUser(w.admin, input, meta()),
    admin,
    w.tenantId,
    role.id,
    "Sin Costos",
  );
  // Sin el módulo de IA en el plan no se puede tocar la lista blanca (es un guardrail del agente).
  const supplier = async (name: string, over: Record<string, unknown>) =>
    (
      await createSupplier(
        w.admin,
        {
          name,
          ...over,
          aiWhitelisted:
            plan === "enterprise" ? (over.aiWhitelisted as boolean | undefined) : undefined,
        },
        meta(),
      )
    ).id;
  const suppliers = {
    whitelisted: await supplier("Distribuidora Andina SAC", {
      whatsapp: "+51 987 000 001",
      defaultLeadTimeDays: 3,
      aiWhitelisted: true,
      email: "ventas@andina.pe",
    }),
    other: await supplier("Importaciones Lima SAC", {
      whatsapp: "+51 987 000 002",
      defaultLeadTimeDays: 7,
      aiWhitelisted: false,
    }),
    third: await supplier("Baterías del Sur EIRL", {
      whatsapp: "+51 987 000 003",
      defaultLeadTimeDays: 2,
      aiWhitelisted: true,
    }),
  };
  return { ...w, noCost, suppliers };
}

/** Producto con stock y umbrales manuales; con `qty` ≤ reorden aparece como candidato del agente. */
export async function lowStockProduct(
  w: PurchasingWorld,
  options: {
    qty: number;
    min?: number;
    rop?: number;
    prices?: Array<{
      supplier: string;
      price: number;
      lead?: number;
      preferred?: boolean;
      minOrderQty?: string;
    }>;
    over?: Record<string, unknown>;
  },
) {
  const product = await make(
    w.admin,
    plain({ name: `Filtro ${randomUUID().slice(0, 4)}`, ...options.over }),
  );
  if (options.qty > 0) {
    await registerStockIn(
      w.admin,
      {
        warehouseId: w.warehouseId,
        productId: product.id,
        quantity: String(options.qty),
        unitCost: "5",
        idempotencyKey: key(),
      },
      meta(),
    );
  }
  await setReorderPolicy(
    w.admin,
    {
      warehouseId: w.warehouseId,
      productId: product.id,
      mode: "MANUAL",
      manualMinStock: options.min ?? 5,
      manualReorderPoint: options.rop ?? 10,
    },
    meta(),
  );
  for (const price of options.prices ?? []) {
    await upsertSupplierProduct(
      w.admin,
      {
        supplierId: price.supplier,
        productId: product.id,
        price: String(price.price),
        leadTimeDays: price.lead,
        isPreferred: price.preferred ?? false,
        ...(price.minOrderQty ? { minOrderQty: price.minOrderQty } : {}),
      },
      meta(),
    );
  }
  return product;
}

export async function configureAi(w: PurchasingWorld, over: Record<string, unknown> = {}) {
  await updateAiSettings(
    w.admin,
    { apiKey: API_KEY, model: "gpt-4o-mini", mode: "DRAFT_APPROVAL", maxOrdersPerDay: 5, ...over },
    meta(),
  );
}

export interface FakeAi {
  requests: AiRequest[];
  keys: string[];
  /** Define la respuesta siguiente. */
  respond: (handler: (request: AiRequest) => AiResponse | Promise<AiResponse>) => void;
}

/** Instala un cliente de IA falso: ninguna prueba llama a OpenAI. */
export function installFakeAi(): FakeAi {
  const state: FakeAi = {
    requests: [],
    keys: [],
    respond(handler) {
      current = handler;
    },
  };
  let current: (request: AiRequest) => AiResponse | Promise<AiResponse> = () => {
    throw new Error("IA falsa sin respuesta configurada");
  };
  const client = (apiKey: string): AiClient => ({
    async complete(request) {
      state.requests.push(request);
      state.keys.push(apiKey);
      return current(request);
    },
  });
  setAiClientFactoryForTests(client);
  return state;
}

export function uninstallFakes(): void {
  setAiClientFactoryForTests(null);
  setChannelDepsForTests(null);
}

export const toolResponse = (
  args: unknown,
  usage = { promptTokens: 1200, completionTokens: 300 },
): AiResponse => ({
  content: null,
  toolCalls: [{ name: "propose_orders", argumentsJson: JSON.stringify(args) }],
  usage,
});

/** Los datos del prompt del agente (lo que ve el modelo dentro de <datos>). */
export function promptData(request: AiRequest): Array<{
  productId: string;
  sku: string;
  suggestedQty: number;
  suppliers: Array<{
    supplierId: string;
    onTimeRate: number | null;
    priceChangePct: number | null;
    unitPrice: number;
  }>;
}> {
  const user = request.messages.find((m) => m.role === "user")?.content ?? "";
  const match = /<datos>([\s\S]*)<\/datos>/.exec(user);
  return match?.[1] ? (JSON.parse(match[1]) as ReturnType<typeof promptData>) : [];
}
