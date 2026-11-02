import { randomUUID } from "node:crypto";
import type { AuthUser } from "@/lib/auth/can";
import type { PrismaClient } from "@/lib/db/generated/client.ts";
import { createWarehouse } from "@/server/services/branches";
import { createProduct, type ProductView } from "@/server/services/catalog";
import { inviteUser } from "@/server/services/users";
import { addUser, bootstrapTenant, meta } from "./auth.ts";

export const key = (): string => `k-${randomUUID()}`;
export const sku = (prefix = "P"): string => `${prefix}-${randomUUID().slice(0, 8)}`.toUpperCase();

export interface InventoryWorld {
  tenantId: string;
  admin: AuthUser;
  superAdmin: AuthUser;
  manager: AuthUser; // Jefe de Almacén: inventario y costos, sin permitir_stock_negativo
  cashier: AuthUser; // Cajero: sin costos de compra ni permisos de inventario de escritura
  mechanic: AuthUser;
  warehouseId: string;
  warehouse2Id: string;
  branchId: string;
}

export async function inventoryWorld(
  admin: PrismaClient,
  plan: "basic" | "pro" | "enterprise" = "pro",
): Promise<InventoryWorld> {
  const t = await bootstrapTenant(admin, plan);
  const role = async (k: "admin" | "warehouse_manager" | "cashier" | "mechanic") =>
    (await admin.role.findFirstOrThrow({ where: { tenantId: t.tenantId, key: k } })).id;
  const invite = (input: { email: string; name: string; roleId: string }) =>
    inviteUser(t.admin, input, meta());
  const manager = await addUser(
    invite,
    admin,
    t.tenantId,
    await role("warehouse_manager"),
    "Jefe Almacén",
  );
  const cashier = await addUser(invite, admin, t.tenantId, await role("cashier"), "Cajera Ana");
  const mechanic = await addUser(
    invite,
    admin,
    t.tenantId,
    await role("mechanic"),
    "Mecánico Beto",
  );
  const warehouse = await admin.warehouse.findFirstOrThrow({ where: { tenantId: t.tenantId } });
  const { id: warehouse2Id } = await createWarehouse(
    t.admin,
    { branchId: warehouse.branchId, code: "ALM-2", name: "Almacén 2" },
    meta(),
  );
  return {
    tenantId: t.tenantId,
    admin: t.admin,
    superAdmin: t.superAdmin,
    manager,
    cashier,
    mechanic,
    warehouseId: warehouse.id,
    warehouse2Id,
    branchId: warehouse.branchId,
  };
}

export const tire = (over: Record<string, unknown> = {}) => ({
  kind: "TIRE" as const,
  sku: sku("LL"),
  name: "Llanta 205/55 R16 Michelin",
  salePrice: 389,
  tire: { size: "205/55 R16", loadIndex: 91, speedRating: "V", design: "Primacy 4" },
  ...over,
});

export const battery = (over: Record<string, unknown> = {}) => ({
  kind: "BATTERY" as const,
  sku: sku("BAT"),
  name: "Batería 12V 60Ah 550CCA",
  salePrice: 389,
  battery: { capacityAh: 60, ccaA: 550, polarity: "LEFT_POSITIVE" as const },
  ...over,
});

export const plain = (over: Record<string, unknown> = {}) => ({
  kind: "ACCESSORY" as const,
  sku: sku("AC"),
  name: "Escobilla limpiaparabrisas",
  salePrice: 25,
  ...over,
});

export async function make(actor: AuthUser, input: Record<string, unknown>): Promise<ProductView> {
  return createProduct(actor, input as Parameters<typeof createProduct>[1], meta());
}
