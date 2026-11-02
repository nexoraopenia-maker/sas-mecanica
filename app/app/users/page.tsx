import {
  changeRoleAction,
  inviteUserAction,
  resendInviteAction,
  userStatusAction,
} from "@/app/actions/tenant";
import { ActionForm } from "@/components/forms/action-form";
import { Card, CardTitle } from "@/components/ui/card";
import { Input, Label, Select } from "@/components/ui/input";
import { can, requirePermission } from "@/lib/auth/can";
import { requireTenantUser } from "@/lib/auth/guards";
import { es } from "@/lib/i18n/es";
import { listRoles } from "@/server/services/roles";
import { listUsers } from "@/server/services/users";

export default async function UsersPage() {
  const user = await requireTenantUser();
  requirePermission(user, "users:ver");
  const [users, roles] = await Promise.all([listUsers(user), listRoles(user)]);
  const canEdit = can(user, "users:editar");

  return (
    <>
      <h1 className="text-2xl font-semibold">{es.users.title}</h1>
      {can(user, "users:crear") ? (
        <Card>
          <CardTitle>{es.users.invite}</CardTitle>
          <ActionForm
            action={inviteUserAction}
            submitLabel={es.users.inviteSubmit}
            className="grid gap-4 sm:grid-cols-2"
          >
            <div>
              <Label htmlFor="name">{es.users.name}</Label>
              <Input id="name" name="name" required />
            </div>
            <div>
              <Label htmlFor="email">{es.auth.email}</Label>
              <Input id="email" name="email" type="email" required />
            </div>
            <div className="sm:col-span-2">
              <Label htmlFor="roleId">{es.users.role}</Label>
              <Select id="roleId" name="roleId" required>
                {roles.map((role) => (
                  <option key={role.id} value={role.id}>
                    {role.name}
                  </option>
                ))}
              </Select>
            </div>
          </ActionForm>
        </Card>
      ) : null}
      <ul className="space-y-3">
        {users.map((row) => (
          <li key={row.id}>
            <Card className="space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <p className="font-medium">{row.name}</p>
                  <p className="text-sm text-muted-foreground">{row.email}</p>
                </div>
                <span className="rounded-full bg-muted px-3 py-1 text-sm">
                  {es.users.statuses[row.status]}
                </span>
              </div>
              {canEdit && row.id !== user.userId ? (
                <div className="flex flex-wrap items-end gap-3">
                  <ActionForm
                    action={changeRoleAction}
                    submitLabel={es.users.save}
                    variant="outline"
                    size="sm"
                    className="flex flex-wrap items-end gap-2"
                  >
                    <input type="hidden" name="userId" value={row.id} />
                    <Select
                      name="roleId"
                      defaultValue={row.role?.id}
                      aria-label={es.users.role}
                      className="w-56"
                    >
                      {roles.map((role) => (
                        <option key={role.id} value={role.id}>
                          {role.name}
                        </option>
                      ))}
                    </Select>
                  </ActionForm>
                  {row.status === "INVITED" ? (
                    <ActionForm
                      action={resendInviteAction}
                      submitLabel={es.users.resend}
                      variant="outline"
                      size="sm"
                      className="inline"
                    >
                      <input type="hidden" name="userId" value={row.id} />
                    </ActionForm>
                  ) : (
                    <ActionForm
                      action={userStatusAction}
                      submitLabel={row.status === "DISABLED" ? es.users.enable : es.users.disable}
                      variant={row.status === "DISABLED" ? "outline" : "destructive"}
                      size="sm"
                      className="inline"
                    >
                      <input type="hidden" name="userId" value={row.id} />
                      <input
                        type="hidden"
                        name="status"
                        value={row.status === "DISABLED" ? "ACTIVE" : "DISABLED"}
                      />
                    </ActionForm>
                  )}
                </div>
              ) : null}
            </Card>
          </li>
        ))}
      </ul>
    </>
  );
}
