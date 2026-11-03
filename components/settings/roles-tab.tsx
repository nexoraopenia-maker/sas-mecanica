import { roleDiscountAction } from "@/app/actions/sales";
import {
  createRoleAction,
  createRoleTemplateAction,
  deleteRoleAction,
  roleCapabilitiesAction,
  rolePermissionsAction,
} from "@/app/actions/tenant";
import { ActionForm } from "@/components/forms/action-form";
import { PermissionGrid } from "@/components/permission-grid";
import { Card, CardTitle } from "@/components/ui/card";
import { Input, Label } from "@/components/ui/input";
import { can, type AuthUser } from "@/lib/auth/can";
import {
  CUSTOM_ROLE_TEMPLATES,
  ROLE_CAPABILITIES,
  type PermissionKey,
} from "@/lib/auth/permissions";
import { es } from "@/lib/i18n/es";
import { listRoles } from "@/server/services/roles";

/** Pestaña «Roles y permisos»: plantillas, matriz de capacidades y permisos finos por rol. */
export async function RolesTab({ user }: { user: AuthUser }) {
  const roles = await listRoles(user);
  const canEdit = can(user, "users:editar");
  const templates = CUSTOM_ROLE_TEMPLATES.filter(
    (template) => !roles.some((role) => role.name === template.name),
  );

  return (
    <>
      {can(user, "users:crear") && templates.length > 0 ? (
        <Card data-testid="role-templates">
          <CardTitle>{es.roles.templates}</CardTitle>
          <ul className="space-y-3">
            {templates.map((template) => (
              <li key={template.id} className="flex flex-wrap items-center justify-between gap-3">
                <div className="max-w-xl">
                  <p className="font-medium">{template.name}</p>
                  <p className="text-sm text-muted-foreground">{template.description}</p>
                </div>
                <ActionForm
                  action={createRoleTemplateAction}
                  submitLabel={es.roles.createTemplate}
                  variant="outline"
                  size="sm"
                  className="shrink-0"
                >
                  <input type="hidden" name="templateId" value={template.id} />
                </ActionForm>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      <Card className="space-y-3" data-testid="role-matrix">
        <CardTitle>{es.roles.matrix}</CardTitle>
        <p className="text-sm text-muted-foreground">{es.roles.matrixHelp}</p>
        <ul className="space-y-3">
          {roles.map((role) => {
            const locked = role.key === "admin";
            return (
              <li key={role.id} className="border-t border-border pt-3 first:border-0 first:pt-0">
                {locked || !canEdit ? (
                  <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
                    <span className="w-40 font-medium">{role.name}</span>
                    {ROLE_CAPABILITIES.map((capability) => (
                      <label key={capability.id} className="flex items-center gap-2 text-sm">
                        <input
                          type="checkbox"
                          checked={role.permissions.includes(capability.permission)}
                          disabled
                          readOnly
                          className="size-5"
                          data-testid={`cap-${role.id}-${capability.id}`}
                        />
                        {capability.label}
                      </label>
                    ))}
                  </div>
                ) : (
                  <ActionForm
                    action={roleCapabilitiesAction}
                    submitLabel={es.roles.savePermissions}
                    variant="outline"
                    size="sm"
                    className="flex flex-wrap items-center gap-x-5 gap-y-2"
                  >
                    <input type="hidden" name="roleId" value={role.id} />
                    <span className="w-40 font-medium">{role.name}</span>
                    {ROLE_CAPABILITIES.map((capability) => (
                      <label key={capability.id} className="flex items-center gap-2 text-sm">
                        <input
                          type="checkbox"
                          name="capability"
                          value={capability.id}
                          defaultChecked={role.permissions.includes(capability.permission)}
                          className="size-5"
                          data-testid={`cap-${role.id}-${capability.id}`}
                        />
                        {capability.label}
                      </label>
                    ))}
                  </ActionForm>
                )}
              </li>
            );
          })}
        </ul>
      </Card>

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
