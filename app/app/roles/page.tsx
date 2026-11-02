import { roleDiscountAction } from "@/app/actions/sales";
import { createRoleAction, deleteRoleAction, rolePermissionsAction } from "@/app/actions/tenant";
import { ActionForm } from "@/components/forms/action-form";
import { PermissionGrid } from "@/components/permission-grid";
import { Card, CardTitle } from "@/components/ui/card";
import { Input, Label } from "@/components/ui/input";
import { can, requirePermission } from "@/lib/auth/can";
import { requireTenantUser } from "@/lib/auth/guards";
import type { PermissionKey } from "@/lib/auth/permissions";
import { es } from "@/lib/i18n/es";
import { listRoles } from "@/server/services/roles";

export default async function RolesPage() {
  const user = await requireTenantUser();
  requirePermission(user, "users:ver");
  const roles = await listRoles(user);
  const canEdit = can(user, "users:editar");

  return (
    <>
      <h1 className="text-2xl font-semibold">{es.roles.title}</h1>
      {can(user, "users:crear") ? (
        <Card>
          <CardTitle>{es.roles.create}</CardTitle>
          <ActionForm action={createRoleAction} submitLabel={es.roles.createSubmit}>
            <div>
              <Label htmlFor="name">{es.roles.name}</Label>
              <Input id="name" name="name" required />
            </div>
            <PermissionGrid />
          </ActionForm>
        </Card>
      ) : null}
      {roles.map((role) => {
        const locked = role.key === "admin";
        return (
          <Card key={role.id} className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h2 className="text-lg font-semibold">{role.name}</h2>
                <p className="text-sm text-muted-foreground">
                  {role.description ?? ""} {role.isSystem ? `· ${es.roles.system}` : ""} ·{" "}
                  {role.userCount} {es.roles.users}
                </p>
              </div>
            </div>
            {locked ? <p className="text-sm text-muted-foreground">{es.roles.immutable}</p> : null}
            {locked ? (
              <p className="text-sm">
                {es.roles.maxDiscount}: {role.maxDiscountPercent} %
              </p>
            ) : (
              <ActionForm
                action={roleDiscountAction}
                submitLabel={es.roles.saveDiscount}
                variant="outline"
                size="sm"
                className="flex flex-wrap items-end gap-2"
              >
                <input type="hidden" name="roleId" value={role.id} />
                <div>
                  <Label htmlFor={`d-${role.id}`}>{es.roles.maxDiscount}</Label>
                  <Input
                    id={`d-${role.id}`}
                    name="percent"
                    type="number"
                    inputMode="decimal"
                    min={0}
                    max={100}
                    step="0.5"
                    defaultValue={role.maxDiscountPercent}
                    disabled={!canEdit}
                    className="max-w-32"
                  />
                </div>
              </ActionForm>
            )}
            {locked ? (
              <PermissionGrid selected={role.permissions as PermissionKey[]} disabled />
            ) : (
              <ActionForm
                action={rolePermissionsAction}
                submitLabel={es.roles.savePermissions}
                variant="outline"
              >
                <input type="hidden" name="roleId" value={role.id} />
                <PermissionGrid
                  selected={role.permissions as PermissionKey[]}
                  disabled={!canEdit}
                />
              </ActionForm>
            )}
            {!role.isSystem && can(user, "users:eliminar") ? (
              <ActionForm
                action={deleteRoleAction}
                submitLabel={es.roles.delete}
                variant="destructive"
                size="sm"
              >
                <input type="hidden" name="roleId" value={role.id} />
              </ActionForm>
            ) : null}
          </Card>
        );
      })}
    </>
  );
}
