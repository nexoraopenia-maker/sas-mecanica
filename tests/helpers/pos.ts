import { randomUUID } from "node:crypto";
import type { AuthUser } from "@/lib/auth/can";
import type { PrismaClient } from "@/lib/db/generated/client.ts";
import { createCustomer } from "@/server/services/customers";
import { registerStockIn } from "@/server/services/inventory";
import { openCashSession } from "@/server/services/cash";
import { meta } from "./auth.ts";
import { inventoryWorld, key, type InventoryWorld } from "./inventory.ts";

export interface PosWorld extends InventoryWorld {
  /** Segundo cajero: tiene su propia caja. */
  cashier2: AuthUser;
}

const VALID_RUC = "20100070970";

/** Tenant (ya con RUC emisor al crearse), proveedor de facturación simulado y dos cajeros. */
export async function posWorld(admin: PrismaClient): Promise<PosWorld> {
  const w = await inventoryWorld(admin, "enterprise");
  await admin.tenant.update({
    where: { id: w.tenantId },
    data: { address: "Av. Los Talleres 123, Lima" },
  });
  await admin.tenantSettings.update({
    where: { tenantId: w.tenantId },
    data: { invoiceProvider: "SIMULATED" },
  });
  return { ...w, cashier2: await secondCashier(admin, w) };
}

async function secondCashier(admin: PrismaClient, w: InventoryWorld): Promise<AuthUser> {
  const { addUser } = await import("./auth.ts");
  const { inviteUser } = await import("@/server/services/users");
  const role = await admin.role.findFirstOrThrow({
    where: { tenantId: w.tenantId, key: "cashier" },
  });
  return addUser(
    (input) => inviteUser(w.admin, input, meta()),
    admin,
    w.tenantId,
    role.id,
    "Cajero Dos",
  );
}

export const openCash = (user: AuthUser, amount: string | number = 100) =>
  openCashSession(user, { openingAmount: amount }, meta());

export const stockUp = (
  w: InventoryWorld,
  productId: string,
  quantity: string,
  extra: Record<string, unknown> = {},
) =>
  registerStockIn(
    w.manager,
    {
      warehouseId: w.warehouseId,
      productId,
      quantity,
      unitCost: "50",
      idempotencyKey: key(),
      ...extra,
    } as never,
    meta(),
  );

export const rucCustomer = (user: AuthUser, over: Record<string, unknown> = {}) =>
  createCustomer(
    user,
    {
      docType: "RUC",
      docNumber: VALID_RUC,
      name: "Transportes SAC",
      whatsapp: "987654321",
      whatsappOptIn: true,
      ...over,
    } as never,
    meta(),
  );

export const dniCustomer = (user: AuthUser, over: Record<string, unknown> = {}) =>
  createCustomer(
    user,
    {
      docType: "DNI",
      docNumber: String(Math.floor(10_000_000 + Math.random() * 89_999_999)),
      name: "Cliente Mostrador",
      whatsapp: "987654322",
      whatsappOptIn: true,
      ...over,
    } as never,
    meta(),
  );

export const saleKey = (): string => `s-${randomUUID()}`;
