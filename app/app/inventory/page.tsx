import Link from "next/link";
import { randomUUID } from "node:crypto";
import {
  adjustStockAction,
  markAlertsReadAction,
  recomputeAction,
  setReorderAction,
  stockInAction,
} from "@/app/actions/inventory";
import { ActionForm } from "@/components/forms/action-form";
import { Card, CardTitle } from "@/components/ui/card";
import { Input, Label, Select } from "@/components/ui/input";
import { can, requirePermission } from "@/lib/auth/can";
import { requireTenantUser } from "@/lib/auth/guards";
import { STOCK_STATUS_LABEL, type StockStatus } from "@/lib/inventory/status";
import { es } from "@/lib/i18n/es";
import { searchProducts, listOldTires } from "@/server/services/catalog";
import {
  listStock,
  listStockAlerts,
  listWarehouses,
  stockSummary,
} from "@/server/services/stock-queries";

const STATUS_STYLE: Record<StockStatus, string> = {
  CRITICAL: "bg-danger/15 text-danger border-danger/40",
  REORDER: "bg-warning/15 text-warning border-warning/40",
  OPTIMAL: "bg-success/15 text-success border-success/40",
};
const DOT: Record<StockStatus, string> = { CRITICAL: "🔴", REORDER: "🟡", OPTIMAL: "🟢" };

const STATUS_FILTERS = ["CRITICAL", "REORDER", "OPTIMAL"] as const;

export default async function InventoryPage({
  searchParams,
}: {
  searchParams: Promise<{ estado?: string }>;
}) {
  const { estado } = await searchParams;
  const statusFilter = STATUS_FILTERS.find((value) => value === estado);
  const user = await requireTenantUser();
  requirePermission(user, "inventory:ver");
  const t = es.inventory;
  const canWrite = can(user, "inventory:crear");
  const canEdit = can(user, "inventory:editar");
  const [summary, alerts, stock, warehouses, oldTires, products] = await Promise.all([
    stockSummary(user),
    listStockAlerts(user),
    listStock(user, { limit: 300, ...(statusFilter ? { status: statusFilter } : {}) }),
    listWarehouses(user),
    listOldTires(user),
    can(user, "catalog:ver") ? searchProducts(user, { limit: 200 }) : Promise.resolve([]),
  ]);
  const stocked = products.filter((product) => product.isStocked);
  const warehouseOptions = warehouses.map((w) => (
    <option key={w.id} value={w.id}>
      {w.code} · {w.name}
    </option>
  ));
  const productOptions = stocked.map((p) => (
    <option key={p.id} value={p.id}>
      {p.sku} · {p.name}
    </option>
  ));

  return (
    <>
      <h1 className="text-2xl font-semibold">{t.title}</h1>
      <div className="grid grid-cols-3 gap-3" data-testid="stock-summary">
        {(["CRITICAL", "REORDER", "OPTIMAL"] as const).map((status) => (
          <Card key={status} className={`border ${STATUS_STYLE[status]}`}>
            <p className="text-sm">
              {DOT[status]}{" "}
              {
                t.summary[
                  status === "CRITICAL" ? "critical" : status === "REORDER" ? "reorder" : "optimal"
                ]
              }
            </p>
            <p className="text-3xl font-semibold" data-testid={`count-${status}`}>
              {
                summary[
                  status === "CRITICAL" ? "critical" : status === "REORDER" ? "reorder" : "optimal"
                ]
              }
            </p>
          </Card>
        ))}
      </div>

      <Card>
        <CardTitle>{t.alerts}</CardTitle>
        {alerts.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t.noAlerts}</p>
        ) : (
          <ActionForm
            action={markAlertsReadAction}
            submitLabel={t.markRead}
            variant="outline"
            size="sm"
          >
            <ul className="space-y-2">
              {alerts.map((alert) => (
                <li key={alert.id} className="flex items-start gap-3 text-sm">
                  <input type="hidden" name="ids" value={alert.id} />
                  <span aria-hidden>{alert.severity === "CRITICAL" ? "🔴" : "🟡"}</span>
                  <span>
                    <strong>{alert.title}</strong>
                    <br />
                    <span className="text-muted-foreground">{alert.body}</span>
                  </span>
                </li>
              ))}
            </ul>
          </ActionForm>
        )}
      </Card>

      <Card>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <CardTitle className="mb-0">{t.stock}</CardTitle>
          {canEdit ? (
            <ActionForm
              action={recomputeAction}
              submitLabel={t.recompute}
              variant="outline"
              size="sm"
              className="shrink-0"
            />
          ) : null}
        </div>
        <nav aria-label="Filtrar por estado" className="mb-3 flex flex-wrap gap-2">
          {[null, ...STATUS_FILTERS].map((value) => {
            const active = (value ?? undefined) === statusFilter;
            return (
              <Link
                key={value ?? "todos"}
                href={value ? `/app/inventory?estado=${value}` : "/app/inventory"}
                aria-current={active ? "true" : undefined}
                data-testid={`stock-filter-${value ?? "todos"}`}
                className={`inline-flex min-h-10 items-center rounded-full border px-4 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                  active
                    ? "border-primary bg-primary/15 text-foreground"
                    : "border-border text-muted-foreground hover:bg-muted"
                }`}
              >
                {value ? STOCK_STATUS_LABEL[value] : "Todos"}
              </Link>
            );
          })}
        </nav>
        {stock.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t.noStock}</p>
        ) : (
          <ul className="space-y-2">
            {stock.map((row) => (
              <li
                key={`${row.warehouseId}:${row.productId}`}
                className={`rounded-lg border p-3 ${STATUS_STYLE[row.status]}`}
              >
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <p className="font-medium">
                    {DOT[row.status]} {row.name}
                  </p>
                  <p className="text-lg font-semibold">{row.quantity}</p>
                </div>
                <p className="text-xs">
                  {row.sku} · {row.warehouse} · {STOCK_STATUS_LABEL[row.status]} · {t.min}{" "}
                  {row.minStock} · {t.reorder} {row.reorderPoint} · {t.mode[row.mode]}
                  {row.daysOfCover !== null
                    ? ` · ${t.cover} ${Math.round(row.daysOfCover)} ${t.days}`
                    : ""}
                  {row.avgCost ? ` · S/ ${Number(row.avgCost).toFixed(2)}` : ""}
                </p>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {canWrite ? (
        <Card>
          <CardTitle>{t.stockIn}</CardTitle>
          <ActionForm
            action={stockInAction}
            submitLabel={t.stockInSubmit}
            className="grid gap-4 sm:grid-cols-2"
          >
            <input type="hidden" name="idempotencyKey" value={randomUUID()} />
            <div>
              <Label htmlFor="in-warehouse">{t.warehouse}</Label>
              <Select id="in-warehouse" name="warehouseId" required>
                {warehouseOptions}
              </Select>
            </div>
            <div>
              <Label htmlFor="in-product">{t.product}</Label>
              <Select id="in-product" name="productId" required>
                {productOptions}
              </Select>
            </div>
            <div>
              <Label htmlFor="in-qty">{t.quantity}</Label>
              <Input id="in-qty" name="quantity" inputMode="decimal" />
            </div>
            <div>
              <Label htmlFor="in-cost">{t.unitCost}</Label>
              <Input id="in-cost" name="unitCost" inputMode="decimal" required />
            </div>
            <div>
              <Label htmlFor="in-lot">{t.lotCode}</Label>
              <Input id="in-lot" name="lotCode" />
            </div>
            <div>
              <Label htmlFor="in-dot">{t.dot}</Label>
              <Input id="in-dot" name="dot" inputMode="numeric" maxLength={4} />
            </div>
            <div className="sm:col-span-2">
              <Label htmlFor="in-serials">{t.serials}</Label>
              <textarea
                id="in-serials"
                name="serials"
                rows={3}
                className="w-full rounded-lg border border-border bg-input p-3 text-base"
              />
            </div>
          </ActionForm>
        </Card>
      ) : null}

      {canEdit ? (
        <>
          <Card>
            <CardTitle>{t.adjust}</CardTitle>
            <ActionForm
              action={adjustStockAction}
              submitLabel={t.adjustSubmit}
              variant="outline"
              className="grid gap-4 sm:grid-cols-2"
            >
              <input type="hidden" name="idempotencyKey" value={randomUUID()} />
              <div>
                <Label htmlFor="adj-warehouse">{t.warehouse}</Label>
                <Select id="adj-warehouse" name="warehouseId" required>
                  {warehouseOptions}
                </Select>
              </div>
              <div>
                <Label htmlFor="adj-product">{t.product}</Label>
                <Select id="adj-product" name="productId" required>
                  {productOptions}
                </Select>
              </div>
              <div>
                <Label htmlFor="adj-direction">{t.direction}</Label>
                <Select id="adj-direction" name="direction">
                  <option value="OUT">{t.directionOut}</option>
                  <option value="IN">{t.directionIn}</option>
                </Select>
              </div>
              <div>
                <Label htmlFor="adj-qty">{t.quantity}</Label>
                <Input id="adj-qty" name="quantity" inputMode="decimal" />
              </div>
              <div className="sm:col-span-2">
                <Label htmlFor="adj-reason">{t.reason}</Label>
                <Input id="adj-reason" name="reason" minLength={5} required />
              </div>
            </ActionForm>
          </Card>
          <Card>
            <CardTitle>{t.policy}</CardTitle>
            <ActionForm
              action={setReorderAction}
              submitLabel={t.policySubmit}
              variant="outline"
              className="grid gap-4 sm:grid-cols-2"
            >
              <div>
                <Label htmlFor="pol-warehouse">{t.warehouse}</Label>
                <Select id="pol-warehouse" name="warehouseId" required>
                  {warehouseOptions}
                </Select>
              </div>
              <div>
                <Label htmlFor="pol-product">{t.product}</Label>
                <Select id="pol-product" name="productId" required>
                  {productOptions}
                </Select>
              </div>
              <div>
                <Label htmlFor="pol-mode">Modo</Label>
                <Select id="pol-mode" name="mode">
                  <option value="AUTO">{t.mode.AUTO}</option>
                  <option value="MANUAL">{t.mode.MANUAL}</option>
                </Select>
              </div>
              <div>
                <Label htmlFor="pol-season">{t.seasonality}</Label>
                <Input
                  id="pol-season"
                  name="seasonalityFactor"
                  inputMode="decimal"
                  placeholder="1"
                />
              </div>
              <div>
                <Label htmlFor="pol-min">{t.min}</Label>
                <Input id="pol-min" name="manualMinStock" inputMode="decimal" />
              </div>
              <div>
                <Label htmlFor="pol-rop">{t.reorder}</Label>
                <Input id="pol-rop" name="manualReorderPoint" inputMode="decimal" />
              </div>
            </ActionForm>
          </Card>
        </>
      ) : null}

      <Card>
        <CardTitle>{t.oldTires}</CardTitle>
        {oldTires.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t.noOldTires}</p>
        ) : (
          <ul className="space-y-1 text-sm">
            {oldTires.map((lot) => (
              <li key={lot.lotId}>
                <strong>{lot.name}</strong> · DOT {lot.dotCode} · {lot.ageYears} {t.ageYears} ·{" "}
                {lot.quantity} u.
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}
