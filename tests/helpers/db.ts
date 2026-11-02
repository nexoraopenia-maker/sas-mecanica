import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@/lib/db/generated/client.ts";
import { createClient } from "@/lib/db/raw.ts";

/** Dueño de las tablas: ignora RLS. Solo para sembrar datos y comprobar resultados. */
export function adminClient(): PrismaClient {
  return createClient(requiredEnv("ADMIN_DATABASE_URL"));
}

/** Cliente CRUDO con el rol `sas_app`, sin extensión: simula SQL directo / un bug de la app. */
export function appRawClient(): PrismaClient {
  return createClient(requiredEnv("DATABASE_URL"));
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} no está definida (¿falló globalSetup?)`);
  return value;
}

type RawTx = Parameters<Parameters<PrismaClient["$transaction"]>[0]>[0];

/** Ejecuta SQL crudo como `sas_app` con el GUC del tenant fijado, igual que withTenant. */
export async function asTenantRaw<T>(
  client: PrismaClient,
  tenantId: string,
  fn: (tx: RawTx) => Promise<T>,
): Promise<T> {
  return client.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
    return fn(tx);
  });
}

export interface SeededTenant {
  tenantId: string;
  branchId: string;
  warehouseId: string;
  categoryId: string;
  productId: string;
  customerId: string;
  vehicleId: string;
  supplierId: string;
  equivalenceId: string;
  sku: string;
}

export async function ensurePlan(admin: PrismaClient): Promise<string> {
  const plan = await admin.plan.upsert({
    where: { code: "test-plan" },
    update: {},
    create: { code: "test-plan", name: "Plan de pruebas", priceMonthly: "0" },
  });
  return plan.id;
}

/** Crea un tenant completo con una fila en cada tabla clave. Usa el cliente dueño. */
export async function seedTenant(admin: PrismaClient, label: string): Promise<SeededTenant> {
  const planId = await ensurePlan(admin);
  const suffix = randomUUID().slice(0, 8);
  const tenant = await admin.tenant.create({
    data: {
      legalName: `Taller ${label} ${suffix}`,
      taxId: `20${Math.floor(Math.random() * 1e9)}`,
      planId,
    },
  });
  const tenantId = tenant.id;

  const branch = await admin.branch.create({
    data: { tenantId, code: "PRINCIPAL", name: "Principal", isMain: true },
  });
  const warehouse = await admin.warehouse.create({
    data: { tenantId, branchId: branch.id, code: "ALM-1", name: "Almacén 1", isDefault: true },
  });
  const category = await admin.productCategory.create({ data: { tenantId, name: "Llantas" } });
  const sku = `LL-205-55-R16-${suffix}`;
  const product = await admin.product.create({
    data: {
      tenantId,
      sku,
      name: `Llanta 205/55 R16 (${label})`,
      kind: "TIRE",
      categoryId: category.id,
      salePrice: "250.00",
    },
  });
  const customer = await admin.customer.create({
    data: { tenantId, name: `Cliente ${label}`, docNumber: suffix },
  });
  const vehicle = await admin.vehicle.create({
    data: { tenantId, customerId: customer.id, plate: `ABC-${suffix}`.toUpperCase() },
  });
  const supplier = await admin.supplier.create({ data: { tenantId, name: `Proveedor ${label}` } });
  const equivalence = await admin.partEquivalence.create({
    data: { tenantId, productId: product.id, code: `EQ-${suffix}` },
  });

  return {
    tenantId,
    branchId: branch.id,
    warehouseId: warehouse.id,
    categoryId: category.id,
    productId: product.id,
    customerId: customer.id,
    vehicleId: vehicle.id,
    supplierId: supplier.id,
    equivalenceId: equivalence.id,
    sku,
  };
}
