import { randomUUID } from "node:crypto";
import { createOrderAction, createSupplierAction, orderStepAction } from "@/app/actions/purchasing";
import { ActionForm } from "@/components/forms/action-form";
import { Card, CardTitle } from "@/components/ui/card";
import { Input, Label, Select } from "@/components/ui/input";
import { can, requirePermission } from "@/lib/auth/can";
import { requireTenantUser } from "@/lib/auth/guards";
import { STATUS_LABEL } from "@/lib/purchasing/state";
import { es } from "@/lib/i18n/es";
import { searchProducts } from "@/server/services/catalog";
import { listPurchaseOrders } from "@/server/services/purchasing";
import { listSuppliers } from "@/server/services/suppliers";

export default async function PurchasingPage() {
  const user = await requireTenantUser();
  requirePermission(user, "purchasing:ver");
  const t = es.purchasing;
  const [orders, suppliers, products] = await Promise.all([
    listPurchaseOrders(user),
    listSuppliers(user),
    can(user, "catalog:ver") ? searchProducts(user, { limit: 200 }) : Promise.resolve([]),
  ]);
  const canCreate = can(user, "purchasing:crear");
  const canEdit = can(user, "purchasing:editar");
  const canSeeCost = can(user, "purchasing:ver_costos_compra");
  const stocked = products.filter((product) => product.isStocked);

  return (
    <>
      <h1 className="text-2xl font-semibold">{t.title}</h1>

      <h2 className="text-xl font-semibold">{t.orders}</h2>
      {orders.length === 0 ? <p className="text-muted-foreground">{t.noOrders}</p> : null}
      <ul className="space-y-3">
        {orders.map((order) => (
          <li key={order.id}>
            <Card className="space-y-2" data-testid="order">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <p className="font-medium">
                  #{order.number} · {order.supplier} · {t.origin[order.origin]}
                </p>
                <span
                  className="rounded-full bg-muted px-3 py-1 text-sm"
                  data-testid="order-status"
                >
                  {STATUS_LABEL[order.status]}
                </span>
              </div>
              <ul className="text-sm">
                {order.items.map((item) => (
                  <li key={item.id}>
                    {item.qtyOrdered} × {item.name}{" "}
                    <span className="text-muted-foreground">
                      ({item.sku}) · recibido {item.qtyReceived}
                    </span>
                  </li>
                ))}
              </ul>
              {"total" in order && order.total ? (
                <p className="text-sm font-medium">
                  {t.total}: S/ {Number(order.total).toFixed(2)}
                </p>
              ) : null}
              {canEdit ? (
                <div className="flex flex-wrap gap-2">
                  {order.status === "DRAFT" ? (
                    <ActionForm
                      action={orderStepAction}
                      submitLabel={t.send}
                      size="sm"
                      className="inline"
                    >
                      <input type="hidden" name="orderId" value={order.id} />
                      <input type="hidden" name="step" value="send" />
                    </ActionForm>
                  ) : null}
                  {order.status === "REQUESTED" || order.status === "QUOTED" ? (
                    <ActionForm
                      action={orderStepAction}
                      submitLabel={t.inTransit}
                      size="sm"
                      variant="outline"
                      className="inline"
                    >
                      <input type="hidden" name="orderId" value={order.id} />
                      <input type="hidden" name="step" value="transit" />
                    </ActionForm>
                  ) : null}
                  {["REQUESTED", "QUOTED", "IN_TRANSIT", "PARTIALLY_RECEIVED"].includes(
                    order.status,
                  ) && can(user, "inventory:crear") ? (
                    <ActionForm
                      action={orderStepAction}
                      submitLabel={t.receive}
                      size="sm"
                      variant="outline"
                      className="inline"
                    >
                      <input type="hidden" name="orderId" value={order.id} />
                      <input type="hidden" name="step" value="receive" />
                      <input type="hidden" name="idempotencyKey" value={randomUUID()} />
                    </ActionForm>
                  ) : null}
                  {["DRAFT", "REQUESTED", "QUOTED", "IN_TRANSIT", "PARTIALLY_RECEIVED"].includes(
                    order.status,
                  ) ? (
                    <ActionForm
                      action={orderStepAction}
                      submitLabel={t.cancel}
                      size="sm"
                      variant="destructive"
                      className="flex flex-wrap items-end gap-2"
                    >
                      <input type="hidden" name="orderId" value={order.id} />
                      <input type="hidden" name="step" value="cancel" />
                      <Input
                        name="reason"
                        placeholder={t.cancelReason}
                        minLength={5}
                        required
                        aria-label={t.cancelReason}
                        className="w-64"
                      />
                    </ActionForm>
                  ) : null}
                </div>
              ) : null}
            </Card>
          </li>
        ))}
      </ul>

      {canCreate && canSeeCost ? (
        <Card>
          <CardTitle>{t.newOrder}</CardTitle>
          <ActionForm
            action={createOrderAction}
            submitLabel={t.orderSubmit}
            className="grid gap-4 sm:grid-cols-2"
          >
            <input type="hidden" name="idempotencyKey" value={randomUUID()} />
            <div>
              <Label htmlFor="po-supplier">{t.supplier}</Label>
              <Select id="po-supplier" name="supplierId" required>
                {suppliers.map((supplier) => (
                  <option key={supplier.id} value={supplier.id}>
                    {supplier.name}
                  </option>
                ))}
              </Select>
            </div>
            <div>
              <Label htmlFor="po-product">{t.product}</Label>
              <Select id="po-product" name="productId" required>
                {stocked.map((product) => (
                  <option key={product.id} value={product.id}>
                    {product.sku} · {product.name}
                  </option>
                ))}
              </Select>
            </div>
            <div>
              <Label htmlFor="po-qty">{t.quantity}</Label>
              <Input id="po-qty" name="quantity" inputMode="decimal" required />
            </div>
            <div>
              <Label htmlFor="po-cost">{t.unitCost}</Label>
              <Input id="po-cost" name="unitCost" inputMode="decimal" required />
            </div>
          </ActionForm>
        </Card>
      ) : null}

      <h2 className="text-xl font-semibold">{t.suppliers}</h2>
      <ul className="space-y-2">
        {suppliers.map((supplier) => (
          <li key={supplier.id}>
            <Card className="text-sm">
              <p className="font-medium">{supplier.name}</p>
              <p className="text-muted-foreground">
                {supplier.whatsapp ?? supplier.email ?? "Sin contacto"} ·{" "}
                {supplier.defaultLeadTimeDays ?? "—"} días · {supplier._count.products} productos
                {supplier.aiWhitelisted ? " · Lista blanca IA" : ""}
              </p>
            </Card>
          </li>
        ))}
      </ul>
      {canCreate ? (
        <Card>
          <CardTitle>{t.newSupplier}</CardTitle>
          <ActionForm
            action={createSupplierAction}
            submitLabel={t.supplierSubmit}
            className="grid gap-4 sm:grid-cols-2"
          >
            <div>
              <Label htmlFor="sup-name">{t.name}</Label>
              <Input id="sup-name" name="name" required />
            </div>
            <div>
              <Label htmlFor="sup-ruc">{t.taxId}</Label>
              <Input id="sup-ruc" name="taxId" inputMode="numeric" />
            </div>
            <div>
              <Label htmlFor="sup-wa">{t.whatsapp}</Label>
              <Input id="sup-wa" name="whatsapp" placeholder="+51 987 000 000" />
            </div>
            <div>
              <Label htmlFor="sup-mail">{t.email}</Label>
              <Input id="sup-mail" name="email" type="email" />
            </div>
            <div>
              <Label htmlFor="sup-lead">{t.leadTime}</Label>
              <Input id="sup-lead" name="defaultLeadTimeDays" type="number" min={0} />
            </div>
            {can(user, "ai_agent:editar") ? (
              <label className="flex min-h-12 items-center gap-2 text-sm">
                <input type="checkbox" name="aiWhitelisted" className="size-5" />
                {t.whitelisted}
              </label>
            ) : null}
          </ActionForm>
        </Card>
      ) : null}
    </>
  );
}
