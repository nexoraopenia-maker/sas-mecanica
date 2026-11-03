import {
  changeRoleAction,
  changeUserBranchAction,
  inviteUserAction,
  resendInviteAction,
  userStatusAction,
} from "@/app/actions/tenant";
import { ActionForm } from "@/components/forms/action-form";
import { Alert } from "@/components/ui/alert";
import { Card, CardTitle } from "@/components/ui/card";
import { Input, Label, Select } from "@/components/ui/input";
import { can, type AuthUser } from "@/lib/auth/can";
import { es } from "@/lib/i18n/es";
import { formatDateTime } from "@/lib/workshop/format";
import { listRoles } from "@/server/services/roles";
import { getUsersOverview } from "@/server/services/users";

/** Pestaña «Usuarios»: invitar, cambiar rol y sucursal, desactivar y reactivar. */
export async function UsersTab({ user }: { user: AuthUser }) {
  const t = es.users;
  const [{ users, branches, usage }, allRoles] = await Promise.all([
    getUsersOverview(user),
    listRoles(user),
  ]);
  const canEdit = can(user, "users:editar");
  // Solo un administrador puede otorgar el rol Administrador (el servidor también lo exige).
  const roles =
    user.roleKey === "admin" ? allRoles : allRoles.filter((role) => role.key !== "admin");
  const oneBranch = branches.length === 1;

  return (
    <>
      <p className="text-sm text-muted-foreground" data-testid="users-usage">
        {t.usage}: {usage.used} {t.of} {usage.max ?? t.unlimited}
      </p>
      {usage.reached ? (
        <Alert tone="info" data-testid="users-limit">
          {t.limitReached(usage.used, usage.max ?? 0)}
        </Alert>
      ) : null}
      {can(user, "users:crear") && !usage.reached ? (
        <Card>
          <CardTitle>{t.invite}</CardTitle>
          <ActionForm
            action={inviteUserAction}
            submitLabel={t.inviteSubmit}
            className="grid gap-4 sm:grid-cols-2"
          >
            <div>
              <Label htmlFor="name">{t.name}</Label>
              <Input id="name" name="name" required />
            </div>
            <div>
              <Label htmlFor="email">{es.auth.email}</Label>
              <Input id="email" name="email" type="email" required />
            </div>
            <div>
              <Label htmlFor="roleId">{t.role}</Label>
              <Select id="roleId" name="roleId" required>
                {roles.map((role) => (
                  <option key={role.id} value={role.id}>
                    {role.name}
                  </option>
                ))}
              </Select>
            </div>
            {/* Con una sola sucursal el servidor la asigna sola: el campo se oculta. */}
            {oneBranch ? null : (
              <div>
                <Label htmlFor="branchId">{t.branch}</Label>
                <Select id="branchId" name="branchId" defaultValue={branches[0]?.id}>
                  {branches.map((branch) => (
                    <option key={branch.id} value={branch.id}>
                      {branch.name}
                    </option>
                  ))}
                </Select>
              </div>
            )}
          </ActionForm>
        </Card>
      ) : null}

      <Card className="overflow-x-auto p-0" data-testid="users-table">
        <table className="w-full min-w-[60rem] text-left text-sm">
          <thead className="border-b border-border text-muted-foreground">
            <tr>
              <th className="px-3 py-3 font-medium">{t.name}</th>
              <th className="px-3 py-3 font-medium">{es.auth.email}</th>
              <th className="px-3 py-3 font-medium">{t.role}</th>
              <th className="px-3 py-3 font-medium">{t.branch}</th>
              <th className="px-3 py-3 font-medium">{t.lastAccess}</th>
              <th className="px-3 py-3 font-medium">{t.status}</th>
              <th className="px-3 py-3 font-medium">{t.actions}</th>
            </tr>
          </thead>
          <tbody>
            {users.map((row) => {
              const own = row.id === user.userId;
              return (
                <tr
                  key={row.id}
                  className="border-b border-border last:border-0"
                  data-testid="user-row"
                >
                  <td className="px-3 py-3 font-medium">
                    {row.name}
                    {own ? (
                      <span className="ml-2 text-xs text-muted-foreground">({t.you})</span>
                    ) : null}
                  </td>
                  <td className="max-w-44 break-all px-3 py-3">{row.email}</td>
                  <td className="px-3 py-3">
                    {canEdit && !own ? (
                      <ActionForm
                        action={changeRoleAction}
                        submitLabel={t.save}
                        variant="outline"
                        size="sm"
                        className="flex items-center gap-2"
                      >
                        <input type="hidden" name="userId" value={row.id} />
                        <Select
                          name="roleId"
                          defaultValue={row.role?.id}
                          aria-label={t.role}
                          className="h-10 w-36"
                        >
                          {roles.map((role) => (
                            <option key={role.id} value={role.id}>
                              {role.name}
                            </option>
                          ))}
                        </Select>
                      </ActionForm>
                    ) : (
                      (row.role?.name ?? "—")
                    )}
                  </td>
                  <td className="px-3 py-3">
                    {canEdit ? (
                      <ActionForm
                        action={changeUserBranchAction}
                        submitLabel={t.save}
                        variant="outline"
                        size="sm"
                        className="flex items-center gap-2"
                      >
                        <input type="hidden" name="userId" value={row.id} />
                        <Select
                          name="branchId"
                          defaultValue={row.defaultBranchId ?? ""}
                          aria-label={t.branch}
                          className="h-10 w-32"
                        >
                          <option value="">{t.noBranch}</option>
                          {branches.map((branch) => (
                            <option key={branch.id} value={branch.id}>
                              {branch.name}
                            </option>
                          ))}
                        </Select>
                      </ActionForm>
                    ) : (
                      (row.defaultBranch?.name ?? t.noBranch)
                    )}
                  </td>
                  <td className="px-3 py-3">
                    {row.lastLoginAt ? formatDateTime(row.lastLoginAt) : "—"}
                  </td>
                  <td className="px-3 py-3">
                    <span className="rounded-full bg-muted px-3 py-1" data-testid="user-status">
                      {t.statuses[row.status]}
                    </span>
                  </td>
                  <td className="px-3 py-3">
                    {canEdit && !own ? (
                      row.status === "INVITED" ? (
                        <ActionForm
                          action={resendInviteAction}
                          submitLabel={t.resend}
                          variant="outline"
                          size="sm"
                        >
                          <input type="hidden" name="userId" value={row.id} />
                        </ActionForm>
                      ) : (
                        <ActionForm
                          action={userStatusAction}
                          submitLabel={row.status === "DISABLED" ? t.enable : t.disable}
                          variant={row.status === "DISABLED" ? "outline" : "destructive"}
                          size="sm"
                        >
                          <input type="hidden" name="userId" value={row.id} />
                          <input
                            type="hidden"
                            name="status"
                            value={row.status === "DISABLED" ? "ACTIVE" : "DISABLED"}
                          />
                        </ActionForm>
                      )
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Card>
    </>
  );
}
