import { randomUUID } from "node:crypto";
import Link from "next/link";
import { convertWorkOrderAction } from "@/app/actions/sales";
import {
  addItemAction,
  approveInPersonAction,
  issuePartAction,
  photoAction,
  removeItemAction,
  returnPartAction,
  workOrderStepAction,
} from "@/app/actions/workshop";
import { ActionForm } from "@/components/forms/action-form";
import { SignaturePad } from "@/components/forms/signature-pad";
import { Alert } from "@/components/ui/alert";
import { Card, CardTitle } from "@/components/ui/card";
import { Input, Label, Select } from "@/components/ui/input";
import { can, isOwnRecordsOnly, requirePermission } from "@/lib/auth/can";
import { requireTenantUser } from "@/lib/auth/guards";
import { es } from "@/lib/i18n/es";
import { METHOD_LABEL, PAYMENT_METHODS } from "@/lib/pos/cash";
import { formatDate, formatDateTime, formatKm, formatMoney } from "@/lib/workshop/format";
import { searchProducts } from "@/server/services/catalog";
import { listWarrantyPolicies } from "@/server/services/warranties";
import { getWorkOrder, listAssignableMechanics } from "@/server/services/work-orders";

function Step({
  id,
  step,
  label,
  variant,
  children,
}: {
  id: string;
  step: string;
  label: string;
  variant?: "outline" | "destructive";
  children?: React.ReactNode;
}) {
  return (
    <ActionForm
      action={workOrderStepAction}
      submitLabel={label}
      variant={variant}
      size="sm"
      className="flex flex-wrap items-end gap-2"
    >
      <input type="hidden" name="workOrderId" value={id} />
      <input type="hidden" name="step" value={step} />
      {children}
    </ActionForm>
  );
}

export default async function WorkOrderPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ aviso?: string; g?: string; r?: string }>;
}) {
  const { id } = await params;
  const notice = await searchParams;
  const user = await requireTenantUser();
  requirePermission(user, "workshop:ver");
  const t = es.workshop;
  const order = await getWorkOrder(user, id);
  const canEdit = can(user, "workshop:editar");
  const canStock = can(user, "inventory:editar");
  const closed = order.status === "DELIVERED" || order.status === "CANCELLED";
  const editable = canEdit && !closed && order.status !== "READY";
  const [mechanics, products, policies] = await Promise.all([
    canEdit && !closed && !isOwnRecordsOnly(user)
      ? listAssignableMechanics(user)
      : Promise.resolve([]),
    editable && can(user, "catalog:ver")
      ? searchProducts(user, { limit: 200 })
      : Promise.resolve([]),
    editable && can(user, "warranties:ver") ? listWarrantyPolicies(user) : Promise.resolve([]),
  ]);
  const pending = order.items.filter((item) => item.approvalStatus === "PENDING");
  const approvedParts = order.items.filter(
    (item) => item.type === "PART" && item.approvalStatus === "APPROVED",
  );

  return (
    <>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-2xl font-semibold">
          OT #{order.number} · {order.vehicle.plate}
        </h1>
        <span className="rounded-full bg-muted px-3 py-1 text-sm" data-testid="wo-status">
          {t.status[order.status]}
        </span>
      </div>
      <p className="text-sm text-muted-foreground">
        <Link className="underline" href={`/app/vehicles/${order.vehicle.id}`}>
          {[order.vehicle.make, order.vehicle.model].filter(Boolean).join(" ") ||
            order.vehicle.plate}
        </Link>{" "}
        · {order.customer.name} · {formatKm(order.mileageIn)} · {t.fuel.split(" ")[0]}{" "}
        {order.fuelLevelEighths}/8 · {formatDateTime(order.receivedAt)}
      </p>
      {notice.aviso === "entregada" &&
      /^\d+$/.test(notice.g ?? "") &&
      /^\d+$/.test(notice.r ?? "") ? (
        <Alert tone="success">
          Vehículo entregado. Garantías emitidas: {notice.g}. Recordatorios programados: {notice.r}.
        </Alert>
      ) : null}
      {notice.aviso === "lista" ? (
        <Alert tone="success">Orden lista; se avisó al cliente.</Alert>
      ) : null}
      {notice.aviso === "lista_sin_aviso" ? (
        <Alert>Orden lista. El cliente no fue avisado (sin consentimiento o sin número).</Alert>
      ) : null}
      <p>{order.complaint}</p>

      <Card className="space-y-3">
        <CardTitle>{t.mechanic}</CardTitle>
        <p>{order.mechanic?.name ?? t.unassigned}</p>
        {canEdit && !closed && mechanics.length > 0 ? (
          <Step id={id} step="assign" label={t.assign} variant="outline">
            <Select name="mechanicId" aria-label={t.mechanic} className="max-w-xs">
              {mechanics.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </Select>
          </Step>
        ) : null}
      </Card>

      <Card className="space-y-3">
        <CardTitle>{t.diagnosis}</CardTitle>
        {order.diagnosis ? <p>{order.diagnosis}</p> : null}
        {editable ? (
          <>
            {order.status === "RECEIVED" ? (
              <Step id={id} step="diagnose" label={t.startDiagnosis} variant="outline" />
            ) : null}
            <Step id={id} step="saveDiagnosis" label={t.saveDiagnosis} variant="outline">
              <Input
                name="diagnosis"
                defaultValue={order.diagnosis ?? ""}
                minLength={3}
                maxLength={2000}
                required
                aria-label={t.diagnosis}
                className="min-w-64 flex-1"
              />
            </Step>
          </>
        ) : null}
      </Card>

      <Card className="space-y-3">
        <CardTitle>{t.budget}</CardTitle>
        <ul className="divide-y divide-border">
          {order.items.map((item) => (
            <li key={item.id} className="space-y-2 py-3" data-testid="wo-item">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <p>
                  <span className="text-xs text-muted-foreground">
                    {item.type === "PART" ? t.part : t.labor} ·{" "}
                  </span>
                  {item.description}
                  {item.sku ? <span className="text-muted-foreground"> ({item.sku})</span> : null}
                </p>
                <p className="text-sm">
                  {item.quantity} × {formatMoney(item.unitPrice)}
                  {Number(item.discount) > 0 ? ` − ${formatMoney(item.discount)}` : ""}
                </p>
              </div>
              <p className="text-xs text-muted-foreground">
                {t.round} {item.approvalRound} · {t.approval[item.approvalStatus]}
                {item.partStatus !== "NOT_APPLICABLE" ? ` · ${t.partStatus[item.partStatus]}` : ""}
                {"unitCost" in item && item.partStatus === "ISSUED"
                  ? ` · costo ${formatMoney(item.unitCost ?? 0)}`
                  : ""}
              </p>
              <div className="flex flex-wrap gap-2">
                {editable && item.approvalStatus === "PENDING" ? (
                  <ActionForm
                    action={removeItemAction}
                    submitLabel={t.remove}
                    variant="outline"
                    size="sm"
                    className="inline"
                  >
                    <input type="hidden" name="workOrderId" value={id} />
                    <input type="hidden" name="itemId" value={item.id} />
                  </ActionForm>
                ) : null}
                {canStock &&
                !closed &&
                item.type === "PART" &&
                item.approvalStatus === "APPROVED" &&
                item.partStatus === "REQUESTED" ? (
                  <ActionForm
                    action={issuePartAction}
                    submitLabel={t.issue}
                    size="sm"
                    className="flex flex-wrap items-end gap-2"
                  >
                    <input type="hidden" name="workOrderId" value={id} />
                    <input type="hidden" name="itemId" value={item.id} />
                    {item.trackingMode === "SERIAL" ? (
                      <Input
                        name="serial"
                        placeholder={t.serial}
                        required
                        className="max-w-56"
                        aria-label={t.serial}
                      />
                    ) : null}
                  </ActionForm>
                ) : null}
                {canStock && !closed && item.type === "PART" && item.partStatus === "ISSUED" ? (
                  <ActionForm
                    action={returnPartAction}
                    submitLabel={t.returnPart}
                    variant="outline"
                    size="sm"
                    className="flex flex-wrap items-end gap-2"
                  >
                    <input type="hidden" name="workOrderId" value={id} />
                    <input type="hidden" name="itemId" value={item.id} />
                    <Input
                      name="reason"
                      placeholder={t.reason}
                      minLength={5}
                      required
                      className="max-w-56"
                      aria-label={t.reason}
                    />
                  </ActionForm>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
        <dl className="grid grid-cols-2 gap-1 text-sm sm:max-w-xs">
          <dt>{t.subtotal}</dt>
          <dd className="text-right">{formatMoney(order.subtotal)}</dd>
          <dt>{t.tax}</dt>
          <dd className="text-right">{formatMoney(order.taxTotal)}</dd>
          <dt className="font-semibold">{t.total}</dt>
          <dd className="text-right font-semibold" data-testid="wo-total">
            {formatMoney(order.total)}
          </dd>
        </dl>
        {order.approvedAt ? (
          <p className="text-sm text-muted-foreground">
            {t.approvedBy} {order.approvedByName} (
            {order.approvalMethod === "SIGNATURE" ? "firma" : "enlace"}) ·{" "}
            {formatDateTime(order.approvedAt)}
          </p>
        ) : null}
        {order.approvalPending ? (
          <Alert>
            {t.approvalLinkPending} {formatDateTime(order.approvalExpiresAt)}
          </Alert>
        ) : null}

        {editable ? (
          <ActionForm
            action={addItemAction}
            submitLabel={t.addItem}
            className="grid gap-3 rounded-lg border border-border p-3 sm:grid-cols-3"
          >
            <input type="hidden" name="workOrderId" value={id} />
            <div>
              <Label htmlFor="type">Tipo</Label>
              <Select id="type" name="type" defaultValue="LABOR">
                <option value="LABOR">{t.labor}</option>
                <option value="PART">{t.part}</option>
              </Select>
            </div>
            <div className="sm:col-span-2">
              <Label htmlFor="productId">{t.product}</Label>
              <Select id="productId" name="productId" defaultValue="">
                <option value="">—</option>
                {products.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.sku} · {p.name} · {formatMoney(p.salePrice)}
                  </option>
                ))}
              </Select>
            </div>
            <div className="sm:col-span-2">
              <Label htmlFor="description">{t.description}</Label>
              <Input id="description" name="description" maxLength={200} />
            </div>
            <div>
              <Label htmlFor="quantity">{t.quantity}</Label>
              <Input id="quantity" name="quantity" inputMode="decimal" defaultValue="1" required />
            </div>
            {can(user, "pos:aplicar_descuentos") ? (
              <>
                <div>
                  <Label htmlFor="unitPrice">{t.unitPrice}</Label>
                  <Input id="unitPrice" name="unitPrice" inputMode="decimal" />
                </div>
                <div>
                  <Label htmlFor="discount">{t.discount}</Label>
                  <Input id="discount" name="discount" inputMode="decimal" />
                </div>
              </>
            ) : null}
            {policies.length > 0 ? (
              <div>
                <Label htmlFor="warrantyPolicyId">{t.warrantyPolicy}</Label>
                <Select id="warrantyPolicyId" name="warrantyPolicyId" defaultValue="">
                  <option value="">{t.noWarranty}</option>
                  {policies.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </Select>
              </div>
            ) : null}
          </ActionForm>
        ) : null}
      </Card>

      {canEdit && !closed ? (
        <Card className="space-y-4">
          <div className="flex flex-wrap gap-2">
            {pending.length > 0 &&
            ["RECEIVED", "DIAGNOSING", "AWAITING_APPROVAL", "IN_REPAIR", "AWAITING_PARTS"].includes(
              order.status,
            ) ? (
              <Step id={id} step="requestApproval" label={t.requestApproval} />
            ) : null}
            {pending.length === 0 &&
            ["AWAITING_PARTS"].includes(order.status) &&
            approvedParts.length > 0 ? (
              <Step id={id} step="startRepair" label={t.startRepair} variant="outline" />
            ) : null}
            {order.status === "IN_REPAIR" ? (
              <Step id={id} step="ready" label={t.markReady} />
            ) : null}
            {order.status === "READY" ? (
              <Step id={id} step="reopen" label={t.reopen} variant="outline">
                <Input
                  name="reason"
                  placeholder={t.reason}
                  minLength={5}
                  required
                  className="max-w-56"
                  aria-label={t.reason}
                />
              </Step>
            ) : null}
          </div>
          {order.status === "AWAITING_APPROVAL" && pending.length > 0 ? (
            <ActionForm
              action={approveInPersonAction}
              submitLabel={t.approve}
              className="space-y-3"
            >
              <p className="font-medium">{t.approveInPerson}</p>
              <input type="hidden" name="workOrderId" value={id} />
              <div>
                <Label htmlFor="name">{t.signerName}</Label>
                <Input
                  id="name"
                  name="name"
                  required
                  minLength={3}
                  maxLength={120}
                  className="max-w-sm"
                />
              </div>
              {pending.length > 1 ? (
                <fieldset className="space-y-1">
                  <legend className="text-sm text-muted-foreground">
                    Marca lo que el cliente NO aprueba
                  </legend>
                  {pending.map((item) => (
                    <label key={item.id} className="flex items-center gap-2 text-sm">
                      <input type="checkbox" name="rejected" value={item.id} className="size-5" />
                      {item.description}
                    </label>
                  ))}
                </fieldset>
              ) : null}
              <SignaturePad name="signature" label={t.signHere} clearLabel={t.clearSignature} />
            </ActionForm>
          ) : null}
        </Card>
      ) : null}

      {order.status === "READY" && canEdit && !isOwnRecordsOnly(user) ? (
        <Card>
          <CardTitle>{t.deliver}</CardTitle>
          <Step id={id} step="deliver" label={t.deliver}>
            <div>
              <Label htmlFor="mileageOut">{t.mileageOut}</Label>
              <Input
                id="mileageOut"
                name="mileageOut"
                type="number"
                inputMode="numeric"
                min={order.mileageIn ?? 0}
                required
                defaultValue={order.mileageIn ?? undefined}
              />
            </div>
            <div>
              <Label htmlFor="notes">{t.notes}</Label>
              <Input id="notes" name="notes" maxLength={300} />
            </div>
          </Step>
        </Card>
      ) : null}

      {canEdit && !closed ? (
        <Card>
          <CardTitle>{t.cancel}</CardTitle>
          <Step id={id} step="cancel" label={t.cancel} variant="destructive">
            <Input
              name="reason"
              placeholder={t.reason}
              minLength={5}
              required
              className="max-w-64"
              aria-label={t.reason}
            />
            {canStock ? (
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" name="returnParts" className="size-5" />
                {t.returnParts}
              </label>
            ) : null}
          </Step>
        </Card>
      ) : null}

      {["READY", "DELIVERED"].includes(order.status) && can(user, "pos:crear") ? (
        <Card className="space-y-3" data-testid="wo-billing">
          <CardTitle>{es.pos.convertWo}</CardTitle>
          {order.sale ? (
            <div className="space-y-1 text-sm">
              <p>
                {order.sale.isCredit ? es.pos.billedCredit : es.pos.billedCash}{" "}
                <Link className="underline" href={`/app/sales/${order.sale.id}`}>
                  venta #{order.sale.number}
                </Link>{" "}
                · {formatMoney(order.sale.total)}
              </p>
              {order.sale.isCredit && order.sale.dueDate ? (
                <p data-testid="wo-credit-status">
                  {es.pos.balance}: {formatMoney(order.sale.balance ?? 0)} ·{" "}
                  {es.receivables.dueDate} {formatDate(order.sale.dueDate)} ·{" "}
                  <Link className="underline" href="/app/receivables">
                    {es.receivables.title}
                  </Link>
                </p>
              ) : null}
            </div>
          ) : (
            <ActionForm
              action={convertWorkOrderAction}
              submitLabel={es.pos.convertWo}
              className="grid gap-3 sm:grid-cols-4"
            >
              <input type="hidden" name="workOrderId" value={id} />
              <input type="hidden" name="idempotencyKey" value={randomUUID()} />
              <input type="hidden" name="total" value={order.total} />
              <div>
                <Label htmlFor="documentType">{es.pos.document}</Label>
                <Select id="documentType" name="documentType" defaultValue="BOLETA">
                  <option value="BOLETA">{es.pos.boleta}</option>
                  <option value="FACTURA">{es.pos.factura}</option>
                  <option value="NOTA_VENTA">{es.pos.saleNote}</option>
                </Select>
              </div>
              <div>
                <Label htmlFor="terms">{es.pos.terms}</Label>
                <Select id="terms" name="terms" defaultValue="CASH">
                  <option value="CASH">{es.pos.termsCash}</option>
                  <option value="CREDIT">{es.pos.termsCredit}</option>
                </Select>
              </div>
              <div>
                <Label htmlFor="creditDays">{es.pos.creditTerm}</Label>
                <Input
                  id="creditDays"
                  name="creditDays"
                  type="number"
                  inputMode="numeric"
                  min={1}
                  max={365}
                  placeholder="30"
                />
              </div>
              <div>
                <Label htmlFor="method">{es.pos.method}</Label>
                <Select id="method" name="method" defaultValue="CASH">
                  {PAYMENT_METHODS.map((m) => (
                    <option key={m} value={m}>
                      {METHOD_LABEL[m]}
                    </option>
                  ))}
                </Select>
              </div>
              <div className="sm:col-span-4">
                <Label htmlFor="amount">{es.pos.amountNow}</Label>
                <Input id="amount" name="amount" inputMode="decimal" className="max-w-48" />
                <p className="mt-1 text-xs text-muted-foreground">{es.pos.amountNowHelp}</p>
              </div>
            </ActionForm>
          )}
        </Card>
      ) : null}

      <Card className="space-y-3">
        <CardTitle>{t.photos}</CardTitle>
        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {order.photos.map((photo) => (
            <li key={photo.id} className="space-y-1 text-xs">
              {/* URL firmada y temporal del bucket privado. */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={photo.url}
                alt={photo.caption ?? t.photoKind[photo.kind]}
                className="aspect-square w-full rounded-lg object-cover"
              />
              <p>
                {t.photoKind[photo.kind]}
                {photo.caption ? ` · ${photo.caption}` : ""}
              </p>
            </li>
          ))}
        </ul>
        {canEdit && order.status !== "CANCELLED" ? (
          <ActionForm
            action={photoAction}
            submitLabel={t.addPhoto}
            className="grid gap-3 sm:grid-cols-3"
          >
            <input type="hidden" name="workOrderId" value={id} />
            <div>
              <Label htmlFor="photo">Foto</Label>
              <input
                id="photo"
                name="photo"
                type="file"
                accept="image/jpeg,image/png,image/webp"
                capture="environment"
                required
                className="block w-full text-sm"
              />
            </div>
            <div>
              <Label htmlFor="kind">Tipo</Label>
              <Select id="kind" name="kind" defaultValue="DAMAGE">
                {(Object.keys(t.photoKind) as Array<keyof typeof t.photoKind>).map((k) => (
                  <option key={k} value={k}>
                    {t.photoKind[k]}
                  </option>
                ))}
              </Select>
            </div>
            <div>
              <Label htmlFor="caption">{t.caption}</Label>
              <Input id="caption" name="caption" maxLength={200} />
            </div>
          </ActionForm>
        ) : null}
      </Card>

      <Card className="space-y-2">
        <CardTitle>{t.checklist}</CardTitle>
        <ul className="grid gap-1 text-sm sm:grid-cols-2">
          {order.checklist.map((entry) => (
            <li key={entry.id}>
              {entry.checked ? "☑" : "☐"} {entry.label}
              {entry.value ? ` · ${entry.value}` : ""}
            </li>
          ))}
        </ul>
      </Card>

      <Card className="space-y-2">
        <CardTitle>{t.history}</CardTitle>
        <ul className="space-y-1 text-sm">
          {order.history.map((entry) => (
            <li key={entry.id}>
              {formatDateTime(entry.changedAt)} · {t.status[entry.toStatus]}
              {entry.note ? ` — ${entry.note}` : ""}
            </li>
          ))}
        </ul>
      </Card>
    </>
  );
}
