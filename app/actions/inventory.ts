"use server";

import { revalidatePath } from "next/cache";
import { runAction, field, type ActionState } from "@/lib/action";
import { requireTenantUser } from "@/lib/auth/guards";
import { getRequestMeta } from "@/lib/http";
import { createProduct } from "@/server/services/catalog";
import { adjustStock, registerStockIn } from "@/server/services/inventory";
import { recomputeForTenant, setReorderPolicy } from "@/server/services/reorder";
import { markAlertsRead } from "@/server/services/stock-queries";

const opt = (formData: FormData, name: string): string | undefined =>
  field(formData, name).trim() || undefined;

function serialsOf(formData: FormData): string[] | undefined {
  const list = field(formData, "serials")
    .split(/[\n,;]+/)
    .map((serial) => serial.trim())
    .filter(Boolean);
  return list.length > 0 ? list : undefined;
}

function lotOf(formData: FormData): { code: string; dotCode?: string } | undefined {
  const code = opt(formData, "lotCode");
  const dotCode = opt(formData, "dot");
  if (!code && !dotCode) return undefined;
  return { code: code ?? `DOT-${dotCode}`, ...(dotCode ? { dotCode } : {}) };
}

export async function createProductAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  return runAction(async () => {
    const actor = await requireTenantUser();
    const kind = field(formData, "kind");
    const base = {
      kind,
      sku: field(formData, "sku"),
      name: field(formData, "name"),
      brand: opt(formData, "brand"),
      barcode: opt(formData, "barcode"),
      salePrice: field(formData, "salePrice") || "0",
      lastPurchaseCost: opt(formData, "lastPurchaseCost"),
    };
    const detail: Record<string, unknown> =
      kind === "TIRE"
        ? {
            tire: {
              size: field(formData, "size"),
              loadIndex: opt(formData, "loadIndex"),
              speedRating: opt(formData, "speedRating"),
              design: opt(formData, "design"),
              rackLocation: opt(formData, "rackLocation"),
            },
          }
        : kind === "BATTERY"
          ? {
              battery: {
                capacityAh: field(formData, "capacityAh"),
                ccaA: field(formData, "ccaA"),
                polarity: field(formData, "polarity"),
              },
            }
          : kind === "LUBRICANT"
            ? { lubricant: { viscosity: field(formData, "viscosity") } }
            : kind === "PART"
              ? {
                  part: {
                    oemCode: opt(formData, "oemCode"),
                    partNumber: opt(formData, "partNumber"),
                    isOem: formData.get("isOem") === "on",
                  },
                }
              : {};
    const product = await createProduct(
      actor,
      { ...base, ...detail } as Parameters<typeof createProduct>[1],
      await getRequestMeta(),
    );
    revalidatePath("/app/catalog");
    return { message: `Producto ${product.sku} creado.` };
  });
}

export async function stockInAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  return runAction(async () => {
    const actor = await requireTenantUser();
    const outcome = await registerStockIn(
      actor,
      {
        warehouseId: field(formData, "warehouseId"),
        productId: field(formData, "productId"),
        quantity: opt(formData, "quantity"),
        unitCost: field(formData, "unitCost"),
        lot: lotOf(formData),
        serials: serialsOf(formData),
        idempotencyKey: field(formData, "idempotencyKey"),
      },
      await getRequestMeta(),
    );
    revalidatePath("/app/inventory");
    return {
      message: outcome.replayed ? "Esta entrada ya estaba registrada." : "Entrada registrada.",
    };
  });
}

export async function adjustStockAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  return runAction(async () => {
    const actor = await requireTenantUser();
    const outcome = await adjustStock(
      actor,
      {
        warehouseId: field(formData, "warehouseId"),
        productId: field(formData, "productId"),
        direction: field(formData, "direction") === "IN" ? "IN" : "OUT",
        quantity: opt(formData, "quantity"),
        reason: field(formData, "reason"),
        serials: serialsOf(formData),
        lot: lotOf(formData),
        idempotencyKey: field(formData, "idempotencyKey"),
      },
      await getRequestMeta(),
    );
    revalidatePath("/app/inventory");
    return {
      message: outcome.replayed ? "Este ajuste ya estaba registrado." : "Ajuste registrado.",
    };
  });
}

export async function setReorderAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  return runAction(async () => {
    const actor = await requireTenantUser();
    await setReorderPolicy(
      actor,
      {
        warehouseId: field(formData, "warehouseId"),
        productId: field(formData, "productId"),
        mode: field(formData, "mode") === "MANUAL" ? "MANUAL" : "AUTO",
        manualMinStock: opt(formData, "manualMinStock"),
        manualReorderPoint: opt(formData, "manualReorderPoint"),
        seasonalityFactor: opt(formData, "seasonalityFactor"),
      },
      await getRequestMeta(),
    );
    revalidatePath("/app/inventory");
    return { message: "Umbrales guardados." };
  });
}

export async function recomputeAction(_previous: ActionState): Promise<ActionState> {
  return runAction(async () => {
    const summary = await recomputeForTenant(await requireTenantUser(), await getRequestMeta());
    revalidatePath("/app/inventory");
    return { message: `Recalculado: ${summary.updated} productos, ${summary.alerts} con alerta.` };
  });
}

export async function markAlertsReadAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  return runAction(async () => {
    const count = await markAlertsRead(
      await requireTenantUser(),
      formData.getAll("ids").map(String),
    );
    revalidatePath("/app/inventory");
    return { message: `${count} alertas marcadas como leídas.` };
  });
}
