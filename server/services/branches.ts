import { z } from "zod";
import { can, requirePermission, requireTenantId, type AuthUser } from "@/lib/auth/can";
import { withTenant, type TenantTx } from "@/lib/db";
import { ConflictError, ModuleDisabledError, NotFoundError } from "@/lib/errors";
import { auditContextOf, recordAudit, type RequestMeta } from "./audit";
import { assertWithinPlan, isModuleEnabled, loadPlan } from "./limits";
import { invalidateAuthCache } from "./session-resolver";

const code = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9-]{2,20}$/, "Código inválido (2–20 letras, números o guiones)");
const name = z.string().trim().min(2, "Ingresa un nombre").max(120);
const branchSchema = z.object({
  code,
  name,
  address: z.string().trim().max(300).optional(),
  phone: z.string().trim().max(40).optional(),
});
const warehouseSchema = z.object({ branchId: z.uuid(), code, name });
const branchUpdateSchema = z.object({
  id: z.uuid(),
  name,
  address: z.string().trim().max(300).optional(),
  phone: z.string().trim().max(40).optional(),
});
const warehouseUpdateSchema = z.object({ id: z.uuid(), name });
const activeSchema = z.object({ id: z.uuid(), active: z.boolean() });

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && (error as { code?: string }).code === "P2002"
  );
}

/**
 * Alta de sucursal (tienda o sede) con su almacén principal, para poder vender y mover stock ahí desde el primer
 * día. Respeta el límite de sucursales y almacenes del plan y exige el módulo Multi-sucursal.
 */
export async function createBranch(
  actor: AuthUser,
  input: z.input<typeof branchSchema>,
  meta: RequestMeta = {},
) {
  requirePermission(actor, "settings:editar");
  const data = branchSchema.parse(input);
  return withTenant(requireTenantId(actor), async (tx) => {
    await assertWithinPlan(tx, "branches");
    if (!(await isModuleEnabled(tx, "BRANCHES"))) throw new ModuleDisabledError("BRANCHES");
    try {
      const branch = await tx.branch.create({
        data: {
          code: data.code,
          name: data.name,
          address: data.address ?? null,
          phone: data.phone ?? null,
        },
      });
      await assertWithinPlan(tx, "warehouses");
      const warehouse = await tx.warehouse.create({
        data: {
          branchId: branch.id,
          code: `ALM-${data.code}`.slice(0, 20),
          name: `Almacén ${data.name}`.slice(0, 120),
          isDefault: true,
        },
      });
      await recordAudit(tx, auditContextOf(actor, meta), {
        action: "branch.created",
        entityType: "branch",
        entityId: branch.id,
        after: { code: data.code, name: data.name, warehouseId: warehouse.id },
      });
      return { id: branch.id, warehouseId: warehouse.id };
    } catch (error) {
      if (isUniqueViolation(error))
        throw new ConflictError(
          "BRANCH_CODE_TAKEN",
          "Ya existe una sucursal o almacén con ese código",
        );
      throw error;
    }
  });
}

/** Sin plan multialmacén solo se permite un almacén; con él, hasta el máximo del plan. */
export async function createWarehouse(
  actor: AuthUser,
  input: z.input<typeof warehouseSchema>,
  meta: RequestMeta = {},
) {
  requirePermission(actor, "inventory:crear");
  const data = warehouseSchema.parse(input);
  return withTenant(requireTenantId(actor), async (tx) => {
    if (!(await tx.branch.findFirst({ where: { id: data.branchId, isActive: true } })))
      throw new NotFoundError("Sucursal");
    await assertWithinPlan(tx, "warehouses");
    try {
      const warehouse = await tx.warehouse.create({
        data: { branchId: data.branchId, code: data.code, name: data.name },
      });
      await recordAudit(tx, auditContextOf(actor, meta), {
        action: "warehouse.created",
        entityType: "warehouse",
        entityId: warehouse.id,
        after: { code: data.code, branchId: data.branchId },
      });
      return { id: warehouse.id };
    } catch (error) {
      if (isUniqueViolation(error))
        throw new ConflictError("WAREHOUSE_CODE_TAKEN", "Ya existe un almacén con ese código");
      throw error;
    }
  });
}

export async function listBranches(actor: AuthUser) {
  requirePermission(actor, "settings:ver");
  return withTenant(requireTenantId(actor), (tx) =>
    tx.branch.findMany({ include: { warehouses: true }, orderBy: { createdAt: "asc" } }),
  );
}

/** Sucursales con sus almacenes, personas asignadas y el uso del plan (pestaña Sucursales). */
export async function getBranchesOverview(actor: AuthUser) {
  requirePermission(actor, "branches:ver");
  return withTenant(requireTenantId(actor), async (tx) => {
    const [branches, assigned, { plan }, branchCount, warehouseCount] = await Promise.all([
      tx.branch.findMany({
        include: { warehouses: { orderBy: [{ isDefault: "desc" }, { code: "asc" }] } },
        orderBy: [{ isMain: "desc" }, { createdAt: "asc" }],
      }),
      tx.user.groupBy({
        by: ["defaultBranchId"],
        where: { status: { not: "DISABLED" }, defaultBranchId: { not: null } },
        _count: { _all: true },
      }),
      loadPlan(tx),
      tx.branch.count({ where: { isActive: true } }),
      tx.warehouse.count({ where: { isActive: true } }),
    ]);
    const users = new Map(assigned.map((row) => [row.defaultBranchId, row._count._all]));
    return {
      branches: branches.map((branch) => ({
        id: branch.id,
        code: branch.code,
        name: branch.name,
        address: branch.address,
        phone: branch.phone,
        isMain: branch.isMain,
        isActive: branch.isActive,
        users: users.get(branch.id) ?? 0,
        warehouses: branch.warehouses.map((w) => ({
          id: w.id,
          code: w.code,
          name: w.name,
          isDefault: w.isDefault,
          isActive: w.isActive,
        })),
      })),
      usage: {
        branches: { used: branchCount, max: plan.maxBranches },
        warehouses: { used: warehouseCount, max: plan.multiWarehouse ? plan.maxWarehouses : 1 },
      },
    };
  });
}

export async function updateBranch(
  actor: AuthUser,
  input: z.input<typeof branchUpdateSchema>,
  meta: RequestMeta = {},
) {
  requirePermission(actor, "branches:editar");
  const data = branchUpdateSchema.parse(input);
  await withTenant(requireTenantId(actor), async (tx) => {
    const before = await tx.branch.findFirst({ where: { id: data.id } });
    if (!before) throw new NotFoundError("Sucursal");
    await tx.branch.update({
      where: { id: data.id },
      data: { name: data.name, address: data.address ?? null, phone: data.phone ?? null },
    });
    await recordAudit(tx, auditContextOf(actor, meta), {
      action: "branch.updated",
      entityType: "branch",
      entityId: data.id,
      before: { name: before.name, address: before.address, phone: before.phone },
      after: { name: data.name, address: data.address ?? null, phone: data.phone ?? null },
    });
  });
}

/** Desactiva o reactiva una sucursal. La principal y la última activa no se desactivan; tampoco con cajas abiertas ni gente asignada. */
export async function setBranchActive(
  actor: AuthUser,
  input: z.input<typeof activeSchema>,
  meta: RequestMeta = {},
) {
  requirePermission(actor, "branches:editar");
  const data = activeSchema.parse(input);
  await withTenant(requireTenantId(actor), async (tx) => {
    const branch = await tx.branch.findFirst({ where: { id: data.id } });
    if (!branch) throw new NotFoundError("Sucursal");
    if (!data.active) {
      if (branch.isMain)
        throw new ConflictError("BRANCH_MAIN", "La sucursal principal no se puede desactivar");
      if ((await tx.branch.count({ where: { isActive: true, id: { not: data.id } } })) === 0)
        throw new ConflictError("BRANCH_LAST", "Debe quedar al menos una sucursal activa");
      const open = await tx.cashSession.count({ where: { branchId: data.id, status: "OPEN" } });
      if (open > 0)
        throw new ConflictError(
          "BRANCH_OPEN_CASH",
          `Hay ${open} caja(s) abierta(s) en esta sucursal: ciérralas primero`,
        );
      const people = await tx.user.count({
        where: { defaultBranchId: data.id, status: { not: "DISABLED" } },
      });
      if (people > 0)
        throw new ConflictError(
          "BRANCH_HAS_USERS",
          `Hay ${people} usuario(s) asignados a esta sucursal: cámbialos de sucursal primero`,
        );
    } else {
      await assertWithinPlan(tx, "branches");
    }
    await tx.branch.update({ where: { id: data.id }, data: { isActive: data.active } });
    await recordAudit(tx, auditContextOf(actor, meta), {
      action: data.active ? "branch.activated" : "branch.deactivated",
      entityType: "branch",
      entityId: data.id,
      before: { isActive: branch.isActive },
      after: { isActive: data.active },
    });
  });
}

export async function updateWarehouse(
  actor: AuthUser,
  input: z.input<typeof warehouseUpdateSchema>,
  meta: RequestMeta = {},
) {
  requirePermission(actor, "branches:editar");
  const data = warehouseUpdateSchema.parse(input);
  await withTenant(requireTenantId(actor), async (tx) => {
    const before = await tx.warehouse.findFirst({ where: { id: data.id } });
    if (!before) throw new NotFoundError("Almacén");
    await tx.warehouse.update({ where: { id: data.id }, data: { name: data.name } });
    await recordAudit(tx, auditContextOf(actor, meta), {
      action: "warehouse.updated",
      entityType: "warehouse",
      entityId: data.id,
      before: { name: before.name },
      after: { name: data.name },
    });
  });
}

/** Un almacén con existencias o el principal de la sucursal no se desactiva. */
export async function setWarehouseActive(
  actor: AuthUser,
  input: z.input<typeof activeSchema>,
  meta: RequestMeta = {},
) {
  requirePermission(actor, "branches:editar");
  const data = activeSchema.parse(input);
  await withTenant(requireTenantId(actor), async (tx) => {
    const warehouse = await tx.warehouse.findFirst({ where: { id: data.id } });
    if (!warehouse) throw new NotFoundError("Almacén");
    if (!data.active) {
      if (warehouse.isDefault)
        throw new ConflictError(
          "WAREHOUSE_DEFAULT",
          "El almacén principal de la sucursal no se puede desactivar",
        );
      const stock = await tx.stockBalance.aggregate({
        where: { warehouseId: data.id },
        _sum: { quantity: true },
      });
      if (Number(stock._sum.quantity ?? 0) > 0)
        throw new ConflictError(
          "WAREHOUSE_HAS_STOCK",
          "El almacén aún tiene existencias: transfiérelas antes de desactivarlo",
        );
    } else {
      await assertWithinPlan(tx, "warehouses");
    }
    await tx.warehouse.update({ where: { id: data.id }, data: { isActive: data.active } });
    await recordAudit(tx, auditContextOf(actor, meta), {
      action: data.active ? "warehouse.activated" : "warehouse.deactivated",
      entityType: "warehouse",
      entityId: data.id,
    });
  });
}

/** Sucursal en la que opera el usuario y a cuáles puede pasarse (solo quien tiene permiso de ver sucursales). */
export async function getBranchContext(actor: AuthUser) {
  const tenantId = requireTenantId(actor);
  const canSwitch = can(actor, "branches:ver");
  return withTenant(tenantId, async (tx: TenantTx) => {
    const [user, branches] = await Promise.all([
      tx.user.findFirst({ where: { id: actor.userId }, select: { defaultBranchId: true } }),
      tx.branch.findMany({
        where: { isActive: true },
        select: { id: true, name: true, isMain: true },
        orderBy: [{ isMain: "desc" }, { name: "asc" }],
      }),
    ]);
    const active =
      branches.find((b) => b.id === user?.defaultBranchId) ??
      branches.find((b) => b.isMain) ??
      branches[0];
    return { active: active ?? null, branches, canSwitch: canSwitch && branches.length > 1 };
  });
}

/**
 * Cambia la sucursal de trabajo del propio usuario: las ventas, la caja y el almacén por defecto siguen a la
 * sucursal activa. Con una caja abierta en la sucursal actual hay que cerrarla antes (cada caja es de una sede).
 */
export async function setActiveBranch(actor: AuthUser, branchId: string, meta: RequestMeta = {}) {
  requirePermission(actor, "branches:ver");
  const id = z.uuid().parse(branchId);
  await withTenant(requireTenantId(actor), async (tx) => {
    const target = await tx.branch.findFirst({ where: { id, isActive: true } });
    if (!target) throw new NotFoundError("Sucursal");
    const me = await tx.user.findFirst({
      where: { id: actor.userId },
      select: { defaultBranchId: true },
    });
    if (me?.defaultBranchId === id) return;
    const open = await tx.cashSession.count({
      where: { openedById: actor.userId, status: "OPEN" },
    });
    if (open > 0)
      throw new ConflictError(
        "BRANCH_SWITCH_OPEN_CASH",
        "Cierra tu caja abierta antes de cambiar de sucursal",
      );
    await tx.user.update({ where: { id: actor.userId }, data: { defaultBranchId: id } });
    await recordAudit(tx, auditContextOf(actor, meta), {
      action: "user.active_branch_changed",
      entityType: "user",
      entityId: actor.userId,
      before: { branchId: me?.defaultBranchId ?? null },
      after: { branchId: id },
    });
  });
  invalidateAuthCache();
}
