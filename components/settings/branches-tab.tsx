import {
  createBranchAction,
  createWarehouseAction,
  setBranchActiveAction,
  setWarehouseActiveAction,
  updateBranchAction,
  updateWarehouseAction,
} from "@/app/actions/tenant";
import { ActionForm } from "@/components/forms/action-form";
import { Alert } from "@/components/ui/alert";
import { Card, CardTitle } from "@/components/ui/card";
import { Input, Label } from "@/components/ui/input";
import { can, type AuthUser } from "@/lib/auth/can";
import { es } from "@/lib/i18n/es";
import { getBranchesOverview } from "@/server/services/branches";

const limit = (max: number | null) => (max === null ? es.users.unlimited : String(max));

/** Pestaña «Sucursales»: sedes o tiendas y sus almacenes, dentro de los límites del plan. */
export async function BranchesTab({ user }: { user: AuthUser }) {
  const t = es.branches;
  const overview = await getBranchesOverview(user);
  const canCreate = can(user, "settings:editar") && can(user, "branches:crear");
  const canEdit = can(user, "branches:editar");
  const { usage } = overview;
  const branchLimitReached =
    usage.branches.max !== null && usage.branches.used >= usage.branches.max;
  const warehouseLimitReached =
    usage.warehouses.max !== null && usage.warehouses.used >= usage.warehouses.max;

  return (
    <>
      <p className="text-sm text-muted-foreground" data-testid="branches-usage">
        {t.usage}: {usage.branches.used} {es.users.of} {limit(usage.branches.max)} {t.branchesWord}{" "}
        · {usage.warehouses.used} {es.users.of} {limit(usage.warehouses.max)} {t.warehousesWord}
      </p>
      {branchLimitReached ? <Alert tone="info">{t.branchLimit}</Alert> : null}

      {canCreate && !branchLimitReached ? (
        <Card data-testid="branch-new">
          <CardTitle>{t.newBranch}</CardTitle>
          <ActionForm
            action={createBranchAction}
            submitLabel={t.createBranch}
            className="grid gap-4 sm:grid-cols-2"
          >
            <div>
              <Label htmlFor="b-code">{t.code}</Label>
              <Input id="b-code" name="code" required maxLength={20} placeholder="SUR" />
            </div>
            <div>
              <Label htmlFor="b-name">{t.name}</Label>
              <Input id="b-name" name="name" required maxLength={120} placeholder="Tienda Sur" />
            </div>
            <div>
              <Label htmlFor="b-address">{t.address}</Label>
              <Input id="b-address" name="address" maxLength={300} />
            </div>
            <div>
              <Label htmlFor="b-phone">{t.phone}</Label>
              <Input id="b-phone" name="phone" maxLength={40} inputMode="tel" />
            </div>
          </ActionForm>
        </Card>
      ) : null}

      <ul className="space-y-4" data-testid="branch-list">
        {overview.branches.map((branch) => (
          <li key={branch.id}>
            <Card className="space-y-4" data-testid="branch-card" data-active={branch.isActive}>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h3 className="text-lg font-semibold">
                    {branch.name}{" "}
                    <span className="text-sm font-normal text-muted-foreground">
                      ({branch.code})
                    </span>
                  </h3>
                  <p className="text-sm text-muted-foreground">
                    {branch.address ?? t.noAddress} · {branch.users} {t.people}
                  </p>
                </div>
                <div className="flex flex-wrap gap-2 text-xs">
                  {branch.isMain ? (
                    <span className="rounded-full bg-primary/15 px-3 py-1">{t.main}</span>
                  ) : null}
                  {!branch.isActive ? (
                    <span className="rounded-full bg-muted px-3 py-1">{t.inactive}</span>
                  ) : null}
                </div>
              </div>

              {canEdit ? (
                <ActionForm
                  action={updateBranchAction}
                  submitLabel={t.save}
                  variant="outline"
                  size="sm"
                  className="grid gap-3 sm:grid-cols-3"
                >
                  <input type="hidden" name="id" value={branch.id} />
                  <div>
                    <Label htmlFor={`bn-${branch.id}`}>{t.name}</Label>
                    <Input id={`bn-${branch.id}`} name="name" defaultValue={branch.name} required />
                  </div>
                  <div>
                    <Label htmlFor={`ba-${branch.id}`}>{t.address}</Label>
                    <Input
                      id={`ba-${branch.id}`}
                      name="address"
                      defaultValue={branch.address ?? ""}
                    />
                  </div>
                  <div>
                    <Label htmlFor={`bp-${branch.id}`}>{t.phone}</Label>
                    <Input id={`bp-${branch.id}`} name="phone" defaultValue={branch.phone ?? ""} />
                  </div>
                </ActionForm>
              ) : null}

              <div>
                <h4 className="mb-2 text-sm font-medium">{t.warehouses}</h4>
                <ul className="divide-y divide-border">
                  {branch.warehouses.map((warehouse) => (
                    <li
                      key={warehouse.id}
                      className="flex flex-wrap items-center justify-between gap-3 py-2"
                      data-testid="warehouse-row"
                    >
                      <p className="text-sm">
                        <span className="font-medium">{warehouse.name}</span>{" "}
                        <span className="text-muted-foreground">({warehouse.code})</span>
                        {warehouse.isDefault ? ` · ${t.main}` : ""}
                        {!warehouse.isActive ? ` · ${t.inactive}` : ""}
                      </p>
                      {canEdit ? (
                        <div className="flex flex-wrap items-center gap-2">
                          <ActionForm
                            action={updateWarehouseAction}
                            submitLabel={t.rename}
                            variant="outline"
                            size="sm"
                            className="flex items-center gap-2"
                          >
                            <input type="hidden" name="id" value={warehouse.id} />
                            <Input
                              name="name"
                              aria-label={`${t.name} ${warehouse.code}`}
                              defaultValue={warehouse.name}
                              className="h-10 w-44"
                              required
                            />
                          </ActionForm>
                          {!warehouse.isDefault ? (
                            <ActionForm
                              action={setWarehouseActiveAction}
                              submitLabel={warehouse.isActive ? t.deactivate : t.activate}
                              variant={warehouse.isActive ? "destructive" : "outline"}
                              size="sm"
                            >
                              <input type="hidden" name="id" value={warehouse.id} />
                              <input
                                type="hidden"
                                name="active"
                                value={String(!warehouse.isActive)}
                              />
                            </ActionForm>
                          ) : null}
                        </div>
                      ) : null}
                    </li>
                  ))}
                </ul>
                {branch.isActive && can(user, "inventory:crear") && !warehouseLimitReached ? (
                  <ActionForm
                    action={createWarehouseAction}
                    submitLabel={t.addWarehouse}
                    variant="outline"
                    size="sm"
                    className="mt-3 grid gap-3 sm:grid-cols-[1fr_2fr_auto] sm:items-end"
                  >
                    <input type="hidden" name="branchId" value={branch.id} />
                    <div>
                      <Label htmlFor={`wc-${branch.id}`}>{t.code}</Label>
                      <Input
                        id={`wc-${branch.id}`}
                        name="code"
                        required
                        maxLength={20}
                        placeholder="ALM-2"
                      />
                    </div>
                    <div>
                      <Label htmlFor={`wn-${branch.id}`}>{t.name}</Label>
                      <Input id={`wn-${branch.id}`} name="name" required maxLength={120} />
                    </div>
                  </ActionForm>
                ) : null}
              </div>

              {canEdit && !branch.isMain ? (
                <ActionForm
                  action={setBranchActiveAction}
                  submitLabel={branch.isActive ? t.deactivateBranch : t.activateBranch}
                  variant={branch.isActive ? "destructive" : "outline"}
                  size="sm"
                >
                  <input type="hidden" name="id" value={branch.id} />
                  <input type="hidden" name="active" value={String(!branch.isActive)} />
                </ActionForm>
              ) : null}
            </Card>
          </li>
        ))}
      </ul>
    </>
  );
}
