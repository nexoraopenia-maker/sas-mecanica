"use client";

import { useState } from "react";
import { createProductAction } from "@/app/actions/inventory";
import { ActionForm } from "@/components/forms/action-form";
import { Input, Label, Select } from "@/components/ui/input";
import { es } from "@/lib/i18n/es";

const KINDS = ["TIRE", "BATTERY", "LUBRICANT", "PART", "ACCESSORY", "SERVICE"] as const;

function Field({
  id,
  label,
  hint,
  ...props
}: { id: string; label: string; hint?: string } & React.ComponentProps<"input">) {
  return (
    <div>
      <Label htmlFor={id}>{label}</Label>
      <Input id={id} name={id} {...props} />
      {hint ? <p className="mt-1 text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

/** Alta de producto: los campos técnicos cambian según el tipo (llanta, batería, lubricante, repuesto). */
export function ProductForm({ canSeeCost }: { canSeeCost: boolean }) {
  const [kind, setKind] = useState<(typeof KINDS)[number]>("TIRE");
  const c = es.catalog;
  return (
    <ActionForm
      action={createProductAction}
      submitLabel={c.createSubmit}
      className="grid gap-4 sm:grid-cols-2"
    >
      <div className="sm:col-span-2">
        <Label htmlFor="kind">{c.kind}</Label>
        <Select
          id="kind"
          name="kind"
          value={kind}
          onChange={(event) => setKind(event.target.value as (typeof KINDS)[number])}
        >
          {KINDS.map((value) => (
            <option key={value} value={value}>
              {c.kinds[value]}
            </option>
          ))}
        </Select>
      </div>
      <Field id="sku" label={c.sku} required />
      <Field id="name" label={c.name} required />
      <Field id="brand" label={c.brand} />
      {kind !== "SERVICE" ? (
        <div>
          <Field id="barcode" label={c.barcode} hint={c.barcodeHint} />
          <label className="mt-2 flex min-h-8 items-center gap-2 text-xs text-muted-foreground">
            <input type="checkbox" name="noAutoBarcode" className="size-4" />
            {c.noAutoBarcode}
          </label>
        </div>
      ) : null}
      <Field id="salePrice" label={c.price} type="number" min={0} step="0.01" required />
      {canSeeCost ? (
        <Field id="lastPurchaseCost" label={c.purchasePrice} type="number" min={0} step="0.01" />
      ) : null}
      {kind !== "SERVICE" ? (
        <Field
          id="minStock"
          label={c.minStock}
          hint={c.minStockHint}
          type="number"
          min={0}
          step="any"
        />
      ) : null}
      {kind !== "SERVICE" && kind !== "PART" ? <Field id="oemCode" label={c.oemCode} /> : null}

      {kind === "TIRE" ? (
        <>
          <Field id="size" label={c.tireSize} hint={c.tireSizeHint} required />
          <Field id="loadIndex" label={c.loadIndex} type="number" min={50} max={140} />
          <Field id="speedRating" label={c.speedRating} maxLength={3} />
          <Field id="design" label={c.design} />
          <Field id="rackLocation" label={c.rack} />
        </>
      ) : null}
      {kind === "BATTERY" ? (
        <>
          <Field id="capacityAh" label={c.capacity} type="number" min={1} required />
          <Field id="ccaA" label={c.cca} type="number" min={1} required />
          <div>
            <Label htmlFor="polarity">{c.polarity}</Label>
            <Select id="polarity" name="polarity" required>
              <option value="LEFT_POSITIVE">{c.polarities.LEFT_POSITIVE}</option>
              <option value="RIGHT_POSITIVE">{c.polarities.RIGHT_POSITIVE}</option>
            </Select>
          </div>
        </>
      ) : null}
      {kind === "LUBRICANT" ? (
        <Field id="viscosity" label={c.viscosity} placeholder="5W-30" required />
      ) : null}
      {kind === "PART" ? (
        <>
          <Field id="oemCode" label={c.oemCode} />
          <Field id="partNumber" label={c.partNumber} />
          <label className="flex min-h-12 items-center gap-2 text-sm sm:col-span-2">
            <input type="checkbox" name="isOem" className="size-5" />
            {c.isOem}
          </label>
        </>
      ) : null}
      {kind !== "SERVICE" ? (
        <fieldset className="grid gap-4 rounded-lg border border-border p-3 sm:col-span-2 sm:grid-cols-4">
          <legend className="px-1 text-sm font-medium">{c.compatibility}</legend>
          <Field id="vehicleMake" label={c.vehicleMake} />
          <Field id="vehicleModel" label={c.vehicleModel} />
          <Field id="yearFrom" label={c.yearFrom} type="number" min={1950} max={2100} />
          <Field id="yearTo" label={c.yearTo} type="number" min={1950} max={2100} />
        </fieldset>
      ) : null}
    </ActionForm>
  );
}
