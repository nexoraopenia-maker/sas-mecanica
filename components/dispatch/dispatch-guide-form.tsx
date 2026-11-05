"use client";

import { useState } from "react";
import { createDispatchGuideAction } from "@/app/actions/dispatch";
import { ActionForm } from "@/components/forms/action-form";
import { Button } from "@/components/ui/button";
import { Input, Label, Select } from "@/components/ui/input";
import { DISPATCH_MODE_LABEL, DISPATCH_REASON_LABEL } from "@/lib/dispatch/sunat";
import { es } from "@/lib/i18n/es";
import type { GuideDraft } from "@/server/services/dispatch-guides";

interface ItemRow {
  id: number;
  productId?: string;
  description: string;
  sku: string;
  unit: string;
  quantity: string;
}

function Field({
  id,
  label,
  hint,
  className,
  ...props
}: { id: string; label: string; hint?: string } & React.ComponentProps<"input">) {
  return (
    <div className={className}>
      <Label htmlFor={id}>{label}</Label>
      <Input id={id} name={id} {...props} />
      {hint ? <p className="mt-1 text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

const REASONS = Object.keys(DISPATCH_REASON_LABEL) as Array<keyof typeof DISPATCH_REASON_LABEL>;
const MODES = Object.keys(DISPATCH_MODE_LABEL) as Array<keyof typeof DISPATCH_MODE_LABEL>;
const DOC_TYPES = ["DNI", "RUC", "CE", "PASSPORT", "OTHER"] as const;

/** Formulario de la GRE remitente con los datos que exige SUNAT; el transporte cambia según la modalidad. */
export function DispatchGuideForm({ draft, today }: { draft: GuideDraft | null; today: string }) {
  const g = es.gre;
  const [reason, setReason] = useState<string>(draft?.reason ?? "SALE");
  const [mode, setMode] = useState<string>("PRIVATE");
  const [nextId, setNextId] = useState(draft?.items.length ?? 1);
  const [items, setItems] = useState<ItemRow[]>(
    draft && draft.items.length > 0
      ? draft.items.map((item, index) => ({
          id: index,
          productId: item.productId,
          description: item.description,
          sku: item.sku ?? "",
          unit: item.unit,
          quantity: item.quantity.replace(/\.?0+$/, ""),
        }))
      : [{ id: 0, description: "", sku: "", unit: "UND", quantity: "1" }],
  );
  const patch = (id: number, change: Partial<ItemRow>) =>
    setItems((rows) => rows.map((row) => (row.id === id ? { ...row, ...change } : row)));

  const payload = JSON.stringify(
    items.map(({ productId, description, sku, unit, quantity }) => ({
      productId,
      description,
      sku,
      unit,
      quantity,
    })),
  );

  return (
    <ActionForm
      action={createDispatchGuideAction}
      submitLabel={g.submit}
      className="grid gap-4 sm:grid-cols-2"
    >
      <input type="hidden" name="items" value={payload} />
      {draft?.saleId ? <input type="hidden" name="saleId" value={draft.saleId} /> : null}
      {draft?.transferId ? (
        <input type="hidden" name="transferId" value={draft.transferId} />
      ) : null}

      <h2 className="text-lg font-semibold sm:col-span-2">{g.sectionTransfer}</h2>
      <div>
        <Label htmlFor="reason">{g.reason}</Label>
        <Select
          id="reason"
          name="reason"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        >
          {REASONS.map((value) => (
            <option key={value} value={value}>
              {DISPATCH_REASON_LABEL[value]}
            </option>
          ))}
        </Select>
      </div>
      <Field id="transferDate" label={g.transferDate} type="date" defaultValue={today} required />
      {reason === "OTHER" ? (
        <Field id="reasonNote" label={g.reasonNote} className="sm:col-span-2" required />
      ) : null}
      <Field
        id="relatedDocument"
        label={g.relatedDocument}
        defaultValue={draft?.relatedDocument}
        maxLength={40}
      />

      <h2 className="text-lg font-semibold sm:col-span-2">{g.sectionRecipient}</h2>
      <div>
        <Label htmlFor="recipientDocType">{g.docType}</Label>
        <Select
          id="recipientDocType"
          name="recipientDocType"
          defaultValue={draft?.recipientDocType ?? "RUC"}
        >
          {DOC_TYPES.map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </Select>
      </div>
      <Field
        id="recipientDocNumber"
        label={g.docNumber}
        defaultValue={draft?.recipientDocNumber}
        required
      />
      <Field
        id="recipientName"
        label={g.recipientName}
        defaultValue={draft?.recipientName}
        className="sm:col-span-2"
        required
      />

      <h2 className="text-lg font-semibold sm:col-span-2">{g.sectionRoute}</h2>
      <Field
        id="originAddress"
        label={g.originAddress}
        defaultValue={draft?.originAddress}
        required
      />
      <Field
        id="originUbigeo"
        label={g.originUbigeo}
        hint={g.ubigeoHint}
        inputMode="numeric"
        maxLength={6}
        required
      />
      <Field
        id="destinationAddress"
        label={g.destinationAddress}
        defaultValue={draft?.destinationAddress}
        required
      />
      <Field
        id="destinationUbigeo"
        label={g.destinationUbigeo}
        hint={g.ubigeoHint}
        inputMode="numeric"
        maxLength={6}
        required
      />

      <h2 className="text-lg font-semibold sm:col-span-2">{g.sectionTransport}</h2>
      <div className="sm:col-span-2">
        <Label htmlFor="transportMode">{g.mode}</Label>
        <Select
          id="transportMode"
          name="transportMode"
          value={mode}
          onChange={(e) => setMode(e.target.value)}
        >
          {MODES.map((value) => (
            <option key={value} value={value}>
              {DISPATCH_MODE_LABEL[value]}
            </option>
          ))}
        </Select>
      </div>
      {mode === "PUBLIC" ? (
        <>
          <Field
            id="carrierDocNumber"
            label={g.carrierRuc}
            inputMode="numeric"
            maxLength={11}
            required
          />
          <Field id="carrierName" label={g.carrierName} required />
          <Field id="vehiclePlate" label={g.plateOptional} maxLength={10} />
        </>
      ) : (
        <>
          <Field
            id="driverDocNumber"
            label={g.driverDni}
            inputMode="numeric"
            maxLength={8}
            required
          />
          <Field id="driverName" label={g.driverName} required />
          <Field
            id="driverLicense"
            label={g.driverLicense}
            maxLength={12}
            placeholder="Q12345678"
          />
          <Field id="vehiclePlate" label={g.plate} maxLength={10} required />
        </>
      )}
      <Field id="grossWeightKg" label={g.grossWeight} type="number" min={0} step="0.001" required />
      <Field id="packages" label={g.packages} type="number" min={1} step={1} />

      <h2 className="text-lg font-semibold sm:col-span-2">{g.sectionItems}</h2>
      <div className="space-y-3 sm:col-span-2" data-testid="gre-items">
        {items.map((item, index) => (
          <div
            key={item.id}
            className="grid gap-3 rounded-lg border border-border p-3 sm:grid-cols-12"
          >
            <div className="sm:col-span-5">
              <Label htmlFor={`item-desc-${item.id}`}>{g.itemDescription}</Label>
              <Input
                id={`item-desc-${item.id}`}
                value={item.description}
                onChange={(e) => patch(item.id, { description: e.target.value })}
                maxLength={200}
                required
              />
            </div>
            <div className="sm:col-span-3">
              <Label htmlFor={`item-sku-${item.id}`}>{g.itemSku}</Label>
              <Input
                id={`item-sku-${item.id}`}
                value={item.sku}
                onChange={(e) => patch(item.id, { sku: e.target.value })}
                maxLength={40}
              />
            </div>
            <div className="sm:col-span-1">
              <Label htmlFor={`item-unit-${item.id}`}>{g.itemUnit}</Label>
              <Input
                id={`item-unit-${item.id}`}
                value={item.unit}
                onChange={(e) => patch(item.id, { unit: e.target.value })}
                maxLength={10}
              />
            </div>
            <div className="sm:col-span-2">
              <Label htmlFor={`item-qty-${item.id}`}>{g.itemQty}</Label>
              <Input
                id={`item-qty-${item.id}`}
                type="number"
                min={0}
                step="any"
                value={item.quantity}
                onChange={(e) => patch(item.id, { quantity: e.target.value })}
                required
              />
            </div>
            <div className="flex items-end sm:col-span-1">
              <Button
                type="button"
                variant="ghost"
                disabled={items.length === 1}
                aria-label={`${g.removeItem} ${index + 1}`}
                onClick={() => setItems((rows) => rows.filter((row) => row.id !== item.id))}
              >
                {g.removeItem}
              </Button>
            </div>
          </div>
        ))}
        <Button
          type="button"
          variant="outline"
          onClick={() => {
            setItems((rows) => [
              ...rows,
              { id: nextId, description: "", sku: "", unit: "UND", quantity: "1" },
            ]);
            setNextId((value) => value + 1);
          }}
        >
          {g.addItem}
        </Button>
      </div>
    </ActionForm>
  );
}
