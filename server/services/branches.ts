import { z } from "zod";
import { requirePermission, requireTenantId, type AuthUser } from "@/lib/auth/can";
import { withTenant } from "@/lib/db";
import { NotFoundError } from "@/lib/errors";
import { auditContextOf, recordAudit, type RequestMeta } from "./audit";
import { assertWithinPlan } from "./limits";

const code = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9-]{2,20}$/, "Código inválido (2–20 letras, números o guiones)");
const branchSchema = z.object({
  code,
  name: z.string().trim().min(2).max(120),
  address: z.string().trim().max(300).optional(),
});
const warehouseSchema = z.object({
  branchId: z.uuid(),
  code,
  name: z.string().trim().min(2).max(120),
});

export async function createBranch(
  actor: AuthUser,
  input: z.input<typeof branchSchema>,
  meta: RequestMeta = {},
) {
  requirePermission(actor, "settings:editar");
  const data = branchSchema.parse(input);
  return withTenant(requireTenantId(actor), async (tx) => {
    await assertWithinPlan(tx, "branches");
    const branch = await tx.branch.create({
      data: { code: data.code, name: data.name, address: data.address ?? null },
    });
    await recordAudit(tx, auditContextOf(actor, meta), {
      action: "branch.created",
      entityType: "branch",
      entityId: branch.id,
      after: { code: data.code },
    });
    return { id: branch.id };
  });
}

/** Sin plan multialmacén solo se permite un almacén; con él, hasta el máximo del plan. */
export async function createWarehouse(
  actor: AuthUser,
  input: z.input<typeof warehouseSchema>,
  meta: RequestMeta = {},
) {
  requirePermission(actor, "settings:editar");
  const data = warehouseSchema.parse(input);
  return withTenant(requireTenantId(actor), async (tx) => {
    if (!(await tx.branch.findFirst({ where: { id: data.branchId } })))
      throw new NotFoundError("Sucursal");
    await assertWithinPlan(tx, "warehouses");
    const warehouse = await tx.warehouse.create({
      data: { branchId: data.branchId, code: data.code, name: data.name },
    });
    await recordAudit(tx, auditContextOf(actor, meta), {
      action: "warehouse.created",
      entityType: "warehouse",
      entityId: warehouse.id,
      after: { code: data.code },
    });
    return { id: warehouse.id };
  });
}

export async function listBranches(actor: AuthUser) {
  requirePermission(actor, "settings:ver");
  return withTenant(requireTenantId(actor), (tx) =>
    tx.branch.findMany({ include: { warehouses: true }, orderBy: { createdAt: "asc" } }),
  );
}
