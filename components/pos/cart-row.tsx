"use client";

import { memo } from "react";
import { Input, Label } from "@/components/ui/input";
import { es } from "@/lib/i18n/es";

export interface CartLine {
  key: string;
  productId?: string;
  sku?: string;
  name: string;
  trackingMode: "NONE" | "LOT" | "SERIAL";
  unitPrice: string;
  quantity: string;
  discount: string;
  serialsText: string;
  stock: number | null;
  affectation: "TAXED" | "EXEMPT" | "UNAFFECTED";
}

/**
 * Fila del carrito. Está memorizada: al teclear una cantidad solo se vuelve a pintar esa fila
 * (los controladores son estables, así que el resto del mostrador no se entera).
 */
export const CartRow = memo(function CartRow({
  line,
  onChange,
  onRemove,
}: {
  line: CartLine;
  onChange: (key: string, patch: Partial<CartLine>) => void;
  onRemove: (key: string) => void;
}) {
  const t = es.pos;
  return (
    <li className="space-y-2 py-3" data-testid="cart-line">
      <div className="flex items-start justify-between gap-2">
        <p className="font-medium">
          {line.name} <span className="text-xs text-muted-foreground">{line.sku ?? ""}</span>
        </p>
        <button
          type="button"
          className="min-h-11 px-2 text-sm text-danger underline"
          onClick={() => onRemove(line.key)}
        >
          Quitar
        </button>
      </div>
      <div className="grid grid-cols-3 gap-2">
        <div>
          <Label htmlFor={`q-${line.key}`}>{t.quantity}</Label>
          <Input
            id={`q-${line.key}`}
            inputMode="decimal"
            value={line.quantity}
            onChange={(e) => onChange(line.key, { quantity: e.target.value })}
          />
        </div>
        <div>
          <Label>Precio</Label>
          <p className="flex h-12 items-center text-sm">S/ {Number(line.unitPrice).toFixed(2)}</p>
        </div>
        <div>
          <Label htmlFor={`d-${line.key}`}>{t.discount}</Label>
          <Input
            id={`d-${line.key}`}
            inputMode="decimal"
            value={line.discount}
            onChange={(e) => onChange(line.key, { discount: e.target.value })}
          />
        </div>
      </div>
      {line.trackingMode === "SERIAL" ? (
        <div>
          <Label htmlFor={`s-${line.key}`}>{t.serials}</Label>
          <textarea
            id={`s-${line.key}`}
            rows={2}
            className="w-full rounded-lg border border-border bg-input px-3 py-2 text-base"
            value={line.serialsText}
            onChange={(e) => onChange(line.key, { serialsText: e.target.value })}
          />
        </div>
      ) : null}
    </li>
  );
});
