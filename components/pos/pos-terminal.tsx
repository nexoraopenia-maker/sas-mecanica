"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import {
  createSaleAction,
  posCustomerSearchAction,
  posPlateAction,
  posPreviewAction,
  posSearchAction,
  type PosProduct,
} from "@/app/actions/sales";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardTitle } from "@/components/ui/card";
import { Input, Label, Select } from "@/components/ui/input";
import { es } from "@/lib/i18n/es";
import { METHOD_LABEL, PAYMENT_METHODS, type Method } from "@/lib/pos/methods";

interface CartLine {
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
}

interface CustomerChoice {
  id: string;
  name: string;
  docType: string;
  docNumber: string | null;
}

interface PaymentRow {
  key: string;
  method: Method;
  amount: string;
}

/** Aritmética en céntimos enteros solo para mostrar el vuelto; el servidor es la fuente de verdad del dinero. */
const cents = (value: string): number => Math.round(Number(value || "0") * 100);
const money = (value: number): string => (value / 100).toFixed(2);
const newKey = (): string => crypto.randomUUID();

export function PosTerminal() {
  const t = es.pos;
  const [scan, setScan] = useState("");
  const [tireSize, setTireSize] = useState("");
  const [make, setMake] = useState("");
  const [model, setModel] = useState("");
  const [plate, setPlate] = useState("");
  const [results, setResults] = useState<PosProduct[] | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [cart, setCart] = useState<CartLine[]>([]);
  const [customer, setCustomer] = useState<CustomerChoice | null>(null);
  const [vehicleId, setVehicleId] = useState<string | null>(null);
  const [customerQuery, setCustomerQuery] = useState("");
  const [customerResults, setCustomerResults] = useState<
    Array<CustomerChoice & { plates: string[] }>
  >([]);
  const [documentType, setDocumentType] = useState<"BOLETA" | "FACTURA" | "NOTA_VENTA">("BOLETA");
  const [payments, setPayments] = useState<PaymentRow[]>([
    { key: newKey(), method: "CASH", amount: "" },
  ]);
  const [isCredit, setIsCredit] = useState(false);
  const [creditDays, setCreditDays] = useState("");
  const [received, setReceived] = useState("");
  const [free, setFree] = useState({ description: "", price: "" });
  const [previewState, setPreview] = useState<{
    subtotal: string;
    tax: string;
    total: string;
    discount: string;
  } | null>(null);
  const [previewErrorState, setPreviewError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [searching, startSearch] = useTransition();
  const [charging, startCharge] = useTransition();
  const idempotencyKey = useRef(newKey());
  const scanRef = useRef<HTMLInputElement>(null);
  const previewSeq = useRef(0);

  const itemsPayload = cart.map((line) =>
    line.productId
      ? {
          productId: line.productId,
          quantity: line.quantity,
          discount: line.discount || "0",
          ...(line.trackingMode === "SERIAL"
            ? {
                serials: line.serialsText
                  .split(/\r?\n/)
                  .map((s) => s.trim())
                  .filter(Boolean),
              }
            : {}),
        }
      : {
          description: line.name,
          quantity: line.quantity,
          unitPrice: line.unitPrice,
          discount: line.discount || "0",
        },
  );

  // Totales del servidor, con una pequeña espera para no consultar en cada tecla.
  useEffect(() => {
    if (cart.length === 0) return;
    const seq = (previewSeq.current += 1);
    const timer = setTimeout(async () => {
      const result = await posPreviewAction(itemsPayload);
      if (seq !== previewSeq.current) return;
      setPreview(result.totals ?? null);
      setPreviewError(result.error ?? null);
    }, 300);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(itemsPayload)]);

  // Con el carrito vacío no hay totales que mostrar (se deriva, no se guarda).
  const preview = cart.length > 0 ? previewState : null;
  const previewError = cart.length > 0 ? previewErrorState : null;
  const totalCents = preview ? cents(preview.total) : 0;
  const paidCents = payments.reduce((sum, p) => sum + cents(p.amount), 0);
  const remaining = totalCents - paidCents;
  const cashPayment = payments.find((p) => p.method === "CASH");
  const change =
    received && cashPayment ? Math.max(0, cents(received) - cents(cashPayment.amount)) : 0;
  const serialsOk = cart.every(
    (line) =>
      line.trackingMode !== "SERIAL" ||
      line.serialsText.split(/\r?\n/).filter((s) => s.trim()).length === Number(line.quantity),
  );
  const canCharge =
    cart.length > 0 &&
    preview !== null &&
    !previewError &&
    serialsOk &&
    (isCredit ? remaining > 0 && customer !== null : remaining === 0);

  function addProduct(product: PosProduct) {
    setCart((current) => {
      const existing = current.find(
        (line) => line.productId === product.id && product.trackingMode !== "SERIAL",
      );
      if (existing)
        return current.map((line) =>
          line === existing ? { ...line, quantity: String(Number(line.quantity) + 1) } : line,
        );
      return [
        ...current,
        {
          key: newKey(),
          productId: product.id,
          sku: product.sku,
          name: product.name,
          trackingMode: product.trackingMode,
          unitPrice: product.salePrice,
          quantity: "1",
          discount: "",
          serialsText: "",
          stock: product.stock,
        },
      ];
    });
    setResults(null);
    setScan("");
    scanRef.current?.focus();
  }

  function runSearch(source: "scan" | "filters") {
    setNotice(null);
    startSearch(async () => {
      const response = await posSearchAction(
        source === "scan" ? { q: scan } : { tireSize, make, model },
      );
      if (response.error) {
        setNotice(response.error);
        setResults([]);
        return;
      }
      const exact = response.products.filter(
        (p) => p.sku.toLowerCase() === scan.trim().toLowerCase(),
      );
      // Un lector de códigos termina con Enter: una coincidencia exacta entra directo al carrito.
      if (source === "scan" && (exact.length === 1 || response.products.length === 1)) {
        addProduct(exact[0] ?? (response.products[0] as PosProduct));
        return;
      }
      setResults(response.products);
    });
  }

  function lookupPlate() {
    startSearch(async () => {
      const response = await posPlateAction(plate);
      if (response.error) return setNotice(response.error);
      if (!response.found) return setNotice("No hay un vehículo registrado con esa placa.");
      setCustomer(response.found.customer);
      setVehicleId(response.found.vehicleId);
      setMake(response.found.make ?? "");
      setModel(response.found.model ?? "");
      setNotice(`Placa ${response.found.plate}: ${response.found.customer.name}`);
    });
  }

  function searchCustomer() {
    startSearch(async () => {
      const response = await posCustomerSearchAction(customerQuery);
      setCustomerResults(response.customers);
      if (response.error) setNotice(response.error);
    });
  }

  function updateLine(key: string, patch: Partial<CartLine>) {
    setCart((current) => current.map((line) => (line.key === key ? { ...line, ...patch } : line)));
  }

  function reset() {
    setCart([]);
    setCustomer(null);
    setVehicleId(null);
    setPayments([{ key: newKey(), method: "CASH", amount: "" }]);
    setIsCredit(false);
    setReceived("");
    setError(null);
    idempotencyKey.current = newKey();
    scanRef.current?.focus();
  }

  function charge() {
    setError(null);
    startCharge(async () => {
      const state = await createSaleAction({
        idempotencyKey: idempotencyKey.current,
        documentType,
        customerId: customer?.id,
        vehicleId: vehicleId ?? undefined,
        items: itemsPayload,
        payments: payments
          .filter((p) => cents(p.amount) > 0)
          .map((p) => ({ method: p.method, amount: p.amount })),
        isCredit,
        creditDays: isCredit && creditDays ? Number(creditDays) : undefined,
      });
      if (state?.error) setError(state.error);
    });
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[1.2fr_1fr]">
      <div className="space-y-4">
        <Card className="space-y-3">
          <form
            onSubmit={(event) => {
              event.preventDefault();
              runSearch("scan");
            }}
          >
            <Label htmlFor="scan">{t.scan}</Label>
            <Input
              id="scan"
              ref={scanRef}
              autoFocus
              value={scan}
              onChange={(e) => setScan(e.target.value)}
              placeholder={t.scanHelp}
              autoComplete="off"
            />
          </form>
          <div className="grid gap-2 sm:grid-cols-4">
            <div>
              <Label htmlFor="tire">{t.tireSize}</Label>
              <Input
                id="tire"
                value={tireSize}
                onChange={(e) => setTireSize(e.target.value)}
                placeholder="205/55 R16"
              />
            </div>
            <div>
              <Label htmlFor="make">Marca</Label>
              <Input id="make" value={make} onChange={(e) => setMake(e.target.value)} />
            </div>
            <div>
              <Label htmlFor="model">Modelo</Label>
              <Input id="model" value={model} onChange={(e) => setModel(e.target.value)} />
            </div>
            <div className="flex items-end">
              <Button
                type="button"
                variant="outline"
                className="w-full"
                disabled={searching}
                onClick={() => runSearch("filters")}
              >
                {t.search}
              </Button>
            </div>
          </div>
          <div className="flex flex-wrap items-end gap-2">
            <div className="min-w-40 flex-1">
              <Label htmlFor="plate">{t.plateLookup}</Label>
              <Input
                id="plate"
                value={plate}
                onChange={(e) => setPlate(e.target.value)}
                autoCapitalize="characters"
              />
            </div>
            <Button
              type="button"
              variant="outline"
              disabled={searching || plate.trim().length < 3}
              onClick={lookupPlate}
            >
              {t.search}
            </Button>
          </div>
          {notice ? <Alert>{notice}</Alert> : null}
        </Card>

        {results ? (
          <Card className="space-y-2">
            <CardTitle>{t.results}</CardTitle>
            {results.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t.noResults}</p>
            ) : null}
            <ul className="divide-y divide-border">
              {results.map((product) => (
                <li
                  key={product.id}
                  className="flex flex-wrap items-center justify-between gap-2 py-2"
                  data-testid="pos-result"
                >
                  <div>
                    <p className="font-medium">{product.name}</p>
                    <p className="text-xs text-muted-foreground">
                      {product.sku} · S/ {Number(product.salePrice).toFixed(2)}
                      {product.isStocked && product.stock !== null
                        ? ` · stock ${product.stock}`
                        : ""}
                    </p>
                  </div>
                  <Button type="button" size="sm" onClick={() => addProduct(product)}>
                    {t.add}
                  </Button>
                </li>
              ))}
            </ul>
          </Card>
        ) : null}

        <Card className="space-y-2">
          <CardTitle>{t.freeService}</CardTitle>
          <div className="grid gap-2 sm:grid-cols-[2fr_1fr_auto]">
            <Input
              aria-label={t.freeDescription}
              placeholder={t.freeDescription}
              value={free.description}
              onChange={(e) => setFree({ ...free, description: e.target.value })}
            />
            <Input
              aria-label={t.freePrice}
              placeholder={t.freePrice}
              inputMode="decimal"
              value={free.price}
              onChange={(e) => setFree({ ...free, price: e.target.value })}
            />
            <Button
              type="button"
              variant="outline"
              disabled={free.description.trim().length < 3 || !(Number(free.price) > 0)}
              onClick={() => {
                setCart((current) => [
                  ...current,
                  {
                    key: newKey(),
                    name: free.description.trim(),
                    trackingMode: "NONE",
                    unitPrice: free.price,
                    quantity: "1",
                    discount: "",
                    serialsText: "",
                    stock: null,
                  },
                ]);
                setFree({ description: "", price: "" });
              }}
            >
              {t.addFree}
            </Button>
          </div>
        </Card>
      </div>

      <div className="space-y-4">
        <Card className="space-y-3">
          <div className="flex items-center justify-between">
            <CardTitle className="mb-0">{t.cart}</CardTitle>
            {cart.length > 0 ? (
              <Button type="button" variant="ghost" size="sm" onClick={reset}>
                {t.clear}
              </Button>
            ) : null}
          </div>
          {cart.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t.emptyCart}</p>
          ) : null}
          <ul className="divide-y divide-border">
            {cart.map((line) => (
              <li key={line.key} className="space-y-2 py-3" data-testid="cart-line">
                <div className="flex items-start justify-between gap-2">
                  <p className="font-medium">
                    {line.name}{" "}
                    <span className="text-xs text-muted-foreground">{line.sku ?? ""}</span>
                  </p>
                  <button
                    type="button"
                    className="text-sm text-destructive underline"
                    onClick={() => setCart((c) => c.filter((l) => l.key !== line.key))}
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
                      onChange={(e) => updateLine(line.key, { quantity: e.target.value })}
                    />
                  </div>
                  <div>
                    <Label>Precio</Label>
                    <p className="flex h-12 items-center text-sm">
                      S/ {Number(line.unitPrice).toFixed(2)}
                    </p>
                  </div>
                  <div>
                    <Label htmlFor={`d-${line.key}`}>{t.discount}</Label>
                    <Input
                      id={`d-${line.key}`}
                      inputMode="decimal"
                      value={line.discount}
                      onChange={(e) => updateLine(line.key, { discount: e.target.value })}
                    />
                  </div>
                </div>
                {line.trackingMode === "SERIAL" ? (
                  <div>
                    <Label htmlFor={`s-${line.key}`}>{t.serials}</Label>
                    <textarea
                      id={`s-${line.key}`}
                      rows={2}
                      className="w-full rounded-lg border border-border bg-background px-3 py-2 text-base"
                      value={line.serialsText}
                      onChange={(e) => updateLine(line.key, { serialsText: e.target.value })}
                    />
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
          {previewError ? <Alert tone="error">{previewError}</Alert> : null}
          {preview ? (
            <dl className="grid grid-cols-2 gap-1 text-sm">
              <dt>{t.subtotal}</dt>
              <dd className="text-right">S/ {preview.subtotal}</dd>
              <dt>{t.tax}</dt>
              <dd className="text-right">S/ {preview.tax}</dd>
              <dt className="text-lg font-semibold">{t.total}</dt>
              <dd className="text-right text-lg font-semibold" data-testid="pos-total">
                S/ {preview.total}
              </dd>
            </dl>
          ) : null}
        </Card>

        <Card className="space-y-3">
          <div className="grid gap-2 sm:grid-cols-2">
            <div>
              <Label htmlFor="doc">{t.document}</Label>
              <Select
                id="doc"
                value={documentType}
                onChange={(e) => setDocumentType(e.target.value as typeof documentType)}
              >
                <option value="BOLETA">{t.boleta}</option>
                <option value="FACTURA">{t.factura}</option>
                <option value="NOTA_VENTA">{t.saleNote}</option>
              </Select>
            </div>
            <div>
              <Label>{t.customer}</Label>
              <p className="flex h-12 items-center text-sm" data-testid="pos-customer">
                {customer ? `${customer.name} (${customer.docNumber ?? "s/d"})` : t.noCustomer}
              </p>
            </div>
          </div>
          <div className="flex gap-2">
            <Input
              aria-label={t.searchCustomer}
              placeholder={t.searchCustomer}
              value={customerQuery}
              onChange={(e) => setCustomerQuery(e.target.value)}
            />
            <Button
              type="button"
              variant="outline"
              disabled={customerQuery.trim().length < 2}
              onClick={searchCustomer}
            >
              {t.search}
            </Button>
            {customer ? (
              <Button
                type="button"
                variant="ghost"
                onClick={() => {
                  setCustomer(null);
                  setVehicleId(null);
                }}
              >
                ✕
              </Button>
            ) : null}
          </div>
          {customerResults.length > 0 ? (
            <ul className="divide-y divide-border rounded-lg border border-border">
              {customerResults.map((c) => (
                <li key={c.id}>
                  <button
                    type="button"
                    className="w-full px-3 py-2 text-left text-sm hover:bg-muted"
                    onClick={() => {
                      setCustomer(c);
                      setCustomerResults([]);
                    }}
                  >
                    {c.name} · {c.docType} {c.docNumber ?? ""}{" "}
                    {c.plates.length ? `· ${c.plates.join(", ")}` : ""}
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </Card>

        <Card className="space-y-3">
          <CardTitle>{t.payments}</CardTitle>
          {payments.map((payment) => (
            <div key={payment.key} className="grid grid-cols-[1fr_1fr_auto] gap-2">
              <Select
                aria-label={t.method}
                value={payment.method}
                onChange={(e) =>
                  setPayments((c) =>
                    c.map((p) =>
                      p.key === payment.key ? { ...p, method: e.target.value as Method } : p,
                    ),
                  )
                }
              >
                {PAYMENT_METHODS.map((m) => (
                  <option key={m} value={m}>
                    {METHOD_LABEL[m]}
                  </option>
                ))}
              </Select>
              <Input
                aria-label={t.amount}
                inputMode="decimal"
                placeholder="0.00"
                value={payment.amount}
                onChange={(e) =>
                  setPayments((c) =>
                    c.map((p) => (p.key === payment.key ? { ...p, amount: e.target.value } : p)),
                  )
                }
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={remaining <= 0 && payment.amount !== ""}
                onClick={() =>
                  setPayments((c) =>
                    c.map((p) =>
                      p.key === payment.key
                        ? { ...p, amount: money(Math.max(0, remaining + cents(p.amount))) }
                        : p,
                    ),
                  )
                }
              >
                {t.exact}
              </Button>
            </div>
          ))}
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() =>
                setPayments((c) => [...c, { key: newKey(), method: "YAPE", amount: "" }])
              }
            >
              {t.addPayment}
            </Button>
          </div>
          {cashPayment ? (
            <div className="grid grid-cols-2 gap-2 text-sm">
              <div>
                <Label htmlFor="received">{t.received}</Label>
                <Input
                  id="received"
                  inputMode="decimal"
                  value={received}
                  onChange={(e) => setReceived(e.target.value)}
                />
              </div>
              <div>
                <Label>{t.change}</Label>
                <p
                  className="flex h-12 items-center text-lg font-semibold"
                  data-testid="pos-change"
                >
                  S/ {money(change)}
                </p>
              </div>
            </div>
          ) : null}
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              className="size-5"
              checked={isCredit}
              onChange={(e) => setIsCredit(e.target.checked)}
            />
            {t.credit}
          </label>
          {isCredit ? (
            <div className="max-w-40">
              <Label htmlFor="creditDays">{t.creditDays}</Label>
              <Input
                id="creditDays"
                inputMode="numeric"
                value={creditDays}
                onChange={(e) => setCreditDays(e.target.value)}
              />
            </div>
          ) : null}
          {preview ? (
            <p className="text-sm" data-testid="pos-remaining">
              {t.pending}: S/ {money(Math.max(0, remaining))}
            </p>
          ) : null}
          {error ? <Alert tone="error">{error}</Alert> : null}
          <Button
            type="button"
            className="h-14 w-full text-lg"
            disabled={!canCharge || charging}
            onClick={charge}
          >
            {charging ? "Registrando…" : `${t.charge} S/ ${preview?.total ?? "0.00"}`}
          </Button>
        </Card>
      </div>
    </div>
  );
}
