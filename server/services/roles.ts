import { requirePermission, requireTenantId, type AuthUser } from "@/lib/auth/can";
import { isPermissionKey, permissionKey, type PermissionKey } from "@/lib/auth/permissions";
import { withTenant } from "@/lib/db";
import { ConflictError, NotFoundError } from "@/lib/errors";
import { z } from "zod";
import { auditContextOf, recordAudit, type RequestMeta } from "./audit";
import { invalidateAuthCache } from "./session-resolver";

const roleInputSchema = z.object({
  name: z.string().trim().min(2, "Ingresa un nombre").max(60),
  description: z.string().trim().max(200).optional(),
  permissions: z.array(z.string().refine(isPermissionKey, "Permiso desconocido")).max(200),
  maxDiscountPercent: z.coerce.number().min(0).max(100).default(0),
});

export async function listRoles(actor: AuthUser) {
  requirePermission(actor, "users:ver");
  const roles = await withTenant(requireTenantId(actor), (tx) =>
    tx.role.findMany({
      include: {
        permissions: { include: { permission: true } },
        _count: { select: { users: true } },
      },
      orderBy: { createdAt: "asc" },
    }),
  );
  return roles.map((role) => ({
    id: role.id,
    key: role.key,
    name: role.name,
    description: role.description,
    isSystem: role.isSystem,
    maxDiscountPercent: Number(role.maxDiscountPercent),
    userCount: role._count.users,
    permissions: role.permissions
      .map((rp) => permissionKey(rp.permission.module, rp.permission.action))
      .sort(),
  }));
}

async function replacePermissions(
  tx: Parameters<Parameters<typeof withTenant>[1]>[0],
  roleId: string,
  keys: PermissionKey[],
): Promise<void> {
  const catalog = await tx.permission.findMany();
  const idByKey = new Map(catalog.map((p) => [permissionKey(p.module, p.action), p.id]));
  await tx.rolePermission.deleteMany({ where: { roleId } });
  await tx.rolePermission.createMany({
    data: [...new Set(keys)].flatMap((key) => {
      const permissionId = idByKey.get(key);
      return permissionId ? [{ roleId, permissionId }] : [];
    }),
  });
}

export async function createRole(
  actor: AuthUser,
  input: z.input<typeof roleInputSchema>,
  meta: RequestMeta = {},
) {
  requirePermission(actor, "users:crear");
  const data = roleInputSchema.parse(input);
  const keys = data.permissions as PermissionKey[];
  const role = await withTenant(requireTenantId(actor), async (tx) => {
    if (await tx.role.findFirst({ where: { name: data.name } }))
      throw new ConflictError("ROLE_NAME_TAKEN", "Ya existe un rol con ese nombre");
    const created = await tx.role.create({
      data: {
        name: data.name,
        description: data.description ?? null,
        maxDiscountPercent: data.maxDiscountPercent,
      },
    });
    await replacePermissions(tx, created.id, keys);
    await recordAudit(tx, auditContextOf(actor, meta), {
      action: "role.created",
      entityType: "role",
      entityId: created.id,
      after: { name: data.name, permissions: keys },
    });
    return created;
  });
  invalidateAuthCache();
  return { id: role.id };
}

/** Cambia los permisos de un rol. El rol Administrador es inmutable (evita quedarse sin acceso). */
export async function setRolePermissions(
  actor: AuthUser,
  roleId: string,
  permissions: string[],
  meta: RequestMeta = {},
): Promise<void> {
  requirePermission(actor, "users:editar");
  const keys = z
    .array(z.string().refine(isPermissionKey, "Permiso desconocido"))
    .parse(permissions) as PermissionKey[];
  await withTenant(requireTenantId(actor), async (tx) => {
    const role = await tx.role.findFirst({
      where: { id: roleId },
      include: { permissions: { include: { permission: true } } },
    });
    if (!role) throw new NotFoundError("Rol");
    if (role.key === "admin")
      throw new ConflictError("ROLE_IMMUTABLE", "El rol Administrador no se puede modificar");
    const before = role.permissions
      .map((rp) => permissionKey(rp.permission.module, rp.permission.action))
      .sort();
    await replacePermissions(tx, roleId, keys);
    await recordAudit(tx, auditContextOf(actor, meta), {
      action: "role.permissions_changed",
      entityType: "role",
      entityId: roleId,
      before: { permissions: before },
      after: { permissions: [...new Set(keys)].sort() },
    });
  });
  invalidateAuthCache();
}

export async function deleteRole(
  actor: AuthUser,
  roleId: string,
  meta: RequestMeta = {},
): Promise<void> {
  requirePermission(actor, "users:eliminar");
  await withTenant(requireTenantId(actor), async (tx) => {
    const role = await tx.role.findFirst({ where: { id: roleId } });
    if (!role) throw new NotFoundError("Rol");
    if (role.isSystem)
      throw new ConflictError("ROLE_SYSTEM", "Los roles base no se pueden eliminar");
    if ((await tx.user.count({ where: { roleId } })) > 0)
      throw new ConflictError("ROLE_IN_USE", "Hay usuarios con este rol");
    await tx.role.update({ where: { id: roleId }, data: { deletedAt: new Date() } });
    await recordAudit(tx, auditContextOf(actor, meta), {
      action: "role.deleted",
      entityType: "role",
      entityId: roleId,
      before: { name: role.name },
    });
  });
  invalidateAuthCache();
}

/** Tope de descuento (% por línea) que un rol puede aplicar en el POS. El de Administrador es fijo. */
export async function setRoleDiscountLimit(
  actor: AuthUser,
  roleId: string,
  percent: number | string,
  meta: RequestMeta = {},
): Promise<void> {
  requirePermission(actor, "users:editar");
  const value = z.coerce.number().min(0).max(100).parse(percent);
  await withTenant(requireTenantId(actor), async (tx) => {
    const role = await tx.role.findFirst({ where: { id: roleId } });
    if (!role) throw new NotFoundError("Rol");
    if (role.key === "admin")
      throw new ConflictError("ROLE_IMMUTABLE", "El rol Administrador no se puede modificar");
    await tx.role.update({ where: { id: roleId }, data: { maxDiscountPercent: value } });
    await recordAudit(tx, auditContextOf(actor, meta), {
      action: "role.discount_limit_changed",
      entityType: "role",
      entityId: roleId,
      before: { maxDiscountPercent: Number(role.maxDiscountPercent) },
      after: { maxDiscountPercent: value },
    });
  });
  invalidateAuthCache();
}
