"use client";

import { useCallback, useMemo, useRef, useState, useTransition } from "react";
import { createSaleAction } from "@/app/actions/sales";
import { useOffline } from "@/components/offline/offline-provider";
import { CartRow, type CartLine } from "@/components/pos/cart-row";
import { ProductSearch } from "@/components/pos/product-search";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardTitle } from "@/components/ui/card";
import { Input, Label, Select } from "@/components/ui/input";
import type { Buyer, DocType } from "@/lib/billing/sunat";
import { es } from "@/lib/i18n/es";
import { priceDraft, validateDraftDocument } from "@/lib/pos/draft";
import { METHOD_LABEL, PAYMENT_METHODS, type Method } from "@/lib/pos/methods";
import { PosFetchError, posGet } from "@/lib/pos/pos-fetch";
import type { PosProduct, PosTaxContext } from "@/lib/pos/types";

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

type DocumentType = "BOLETA" | "FACTURA" | "NOTA_VENTA";

/** Aritmética en céntimos enteros solo para mostrar el vuelto; el servidor es la fuente de verdad del dinero. */
const cents = (value: string): number => Math.round(Number(value || "0") * 100);
const money = (value: number): string => (value / 100).toFixed(2);
const newKey = (): string => crypto.randomUUID();
const ACTION_TIMEOUT_MS = 25_000;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new PosFetchError("Tiempo de espera agotado", true)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

const buyerOf = (customer: CustomerChoice | null): Buyer | null =>
  customer && customer.docNumber
    ? {
        docType: customer.docType as DocType,
        docNumber: customer.docNumber,
        name: customer.name,
      }
    : null;

export function PosTerminal({
  tax,
  maxDiscountPercent,
}: {
  tax: PosTaxContext;
  maxDiscountPercent: number;
}) {
  const t = es.pos;
  const offline = useOffline();
  const online = offline.online;
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
  const [documentType, setDocumentType] = useState<DocumentType>("BOLETA");
  const [payments, setPayments] = useState<PaymentRow[]>([
    { key: newKey(), method: "CASH", amount: "" },
  ]);
  const [isCredit, setIsCredit] = useState(false);
  const [creditDays, setCreditDays] = useState("");
  const [received, setReceived] = useState("");
  const [free, setFree] = useState({ description: "", price: "" });
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<{ id: string; total: string } | null>(null);
  const [searching, startSearch] = useTransition();
  const [charging, startCharge] = useTransition();
  const idempotencyKey = useRef(newKey());
  const scanRef = useRef<HTMLInputElement>(null);

  // Totales calculados aquí mismo con la aritmética del servidor: aparecen al instante y sin conexión.
  const pricing = useMemo(
    () =>
      cart.length === 0
        ? null
        : priceDraft(
            cart.map((line) => ({
              name: line.name,
              unitPrice: line.unitPrice,
              quantity: line.quantity,
              discount: line.discount,
              affectation: line.affectation,
            })),
            tax,
            maxDiscountPercent,
          ),
    [cart, tax, maxDiscountPercent],
  );
  const preview = pricing?.ok ? pricing.totals : null;
  const previewError = pricing && !pricing.ok ? pricing.error : null;
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
  const hasSerial = cart.some((line) => line.trackingMode === "SERIAL");
  const documentProblem = preview
    ? validateDraftDocument({
        documentType,
        total: Number(preview.total),
        buyer: buyerOf(customer),
        offline: !online,
        isCredit,
      })
    : null;
  const offlineProblem =
    !online && hasSerial
      ? "Los productos con número de serie solo se venden con conexión."
      : !online && !offline.supported
        ? "Este navegador no puede guardar ventas sin conexión."
        : null;
  const blocker = documentProblem ?? offlineProblem;
  const canCharge =
    cart.length > 0 &&
    preview !== null &&
    !previewError &&
    serialsOk &&
    !blocker &&
    (isCredit ? remaining > 0 && customer !== null : remaining === 0);

  const addProduct = useCallback((product: PosProduct) => {
    setSaved(null);
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
          affectation: product.taxAffectation,
        },
      ];
    });
    setResults(null);
  }, []);

  const updateLine = useCallback((key: string, patch: Partial<CartLine>) => {
    setCart((current) => current.map((line) => (line.key === key ? { ...line, ...patch } : line)));
  }, []);
  const removeLine = useCallback(
    (key: string) => setCart((current) => current.filter((line) => line.key !== key)),
    [],
  );

  function runFilterSearch() {
    setNotice(null);
    startSearch(async () => {
      try {
        const response = await posGet<{ products: PosProduct[] }>("/api/pos/products", {
          tire: tireSize,
          make,
          model,
        });
        setResults(response.products);
      } catch (error) {
        // Sin conexión: se filtra el catálogo del dispositivo por medida de llanta.
        if (error instanceof PosFetchError && error.network && tireSize) {
          setResults(offline.searchLocal(tireSize, 30));
          setNotice(t.offlineCatalog);
          return;
        }
        setNotice(error instanceof Error ? error.message : t.noResults);
        setResults([]);
      }
    });
  }

  function lookupPlate() {
    startSearch(async () => {
      try {
        const response = await posGet<{
          found: null | {
            vehicleId: string;
            plate: string;
            make: string | null;
            model: string | null;
            customer: CustomerChoice;
          };
        }>("/api/pos/plate", { plate });
        if (!response.found) return setNotice("No hay un vehículo registrado con esa placa.");
        setCustomer(response.found.customer);
        setVehicleId(response.found.vehicleId);
        setMake(response.found.make ?? "");
        setModel(response.found.model ?? "");
        setNotice(`Placa ${response.found.plate}: ${response.found.customer.name}`);
      } catch (error) {
        setNotice(
          error instanceof PosFetchError && error.network
            ? "Sin conexión: la búsqueda por placa necesita internet."
            : error instanceof Error
              ? error.message
              : "No se pudo buscar la placa.",
        );
      }
    });
  }

  function searchCustomer() {
    startSearch(async () => {
      try {
        const response = await posGet<{ customers: Array<CustomerChoice & { plates: string[] }> }>(
          "/api/pos/customers",
          { q: customerQuery },
        );
        setCustomerResults(response.customers);
      } catch (error) {
        setNotice(
          error instanceof PosFetchError && error.network
            ? "Sin conexión: la búsqueda de clientes necesita internet."
            : error instanceof Error
              ? error.message
              : "No se pudo buscar al cliente.",
        );
      }
    });
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

  function buildSale() {
    return {
      idempotencyKey: idempotencyKey.current,
      documentType,
      customerId: customer?.id,
      vehicleId: vehicleId ?? undefined,
      items: cart.map((line) =>
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
      ),
      payments: payments
        .filter((p) => cents(p.amount) > 0)
        .map((p) => ({ method: p.method, amount: p.amount })),
      isCredit,
      creditDays: isCredit && creditDays ? Number(creditDays) : undefined,
    };
  }

  /** Guarda la venta en el dispositivo (misma clave de idempotencia): se registrará sola al volver la conexión. */
  async function saveOffline(sale: ReturnType<typeof buildSale>) {
    const entry = await offline.enqueue(sale, {
      total: preview?.total ?? "0.00",
      documentType,
      items: cart.length,
    });
    setSaved({ id: entry.id.slice(0, 8).toUpperCase(), total: preview?.total ?? "0.00" });
    reset();
  }

  function charge() {
    setError(null);
    const sale = buildSale();
    startCharge(async () => {
      if (!online) {
        try {
          await saveOffline(sale);
        } catch (err) {
          setError(err instanceof Error ? err.message : "No se pudo guardar la venta");
        }
        return;
      }
      try {
        const state = await withTimeout(createSaleAction(sale), ACTION_TIMEOUT_MS);
        if (state?.error) setError(state.error);
      } catch (err) {
        // Sin respuesta del servidor (corte de red o demora): la venta se guarda en el dispositivo. Si en
        // realidad sí llegó, al sincronizar se reconoce por su clave y no se duplica.
        if (
          err instanceof PosFetchError &&
          err.network &&
          offline.supported &&
          !hasSerial &&
          documentType !== "FACTURA" &&
          !isCredit
        ) {
          try {
            await saveOffline(sale);
            return;
          } catch {
            // cae al mensaje genérico
          }
        }
        if (err instanceof Error && "digest" in err) throw err; // redirección de Next tras cobrar
        setError("No se pudo confirmar el cobro. Revisa tu conexión e inténtalo de nuevo.");
      }
    });
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[1.2fr_1fr]">
      <div className="space-y-4">
        <Card className="space-y-3">
          <ProductSearch onPick={addProduct} inputRef={scanRef} />
          <details className="group">
            <summary className="flex min-h-11 cursor-pointer list-none items-center text-sm text-muted-foreground">
              {t.moreFilters}
            </summary>
            <div className="mt-2 grid gap-2 sm:grid-cols-4">
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
                  disabled={searching || (!tireSize.trim() && !make.trim())}
                  onClick={runFilterSearch}
                >
                  {t.search}
                </Button>
              </div>
            </div>
          </details>
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
              disabled={searching || plate.trim().length < 3 || !online}
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
                    affectation: "TAXED",
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
        {saved ? (
          <Alert tone="success" data-testid="pos-saved-offline">
            {t.savedOffline(saved.id, saved.total)}
          </Alert>
        ) : null}
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
              <CartRow key={line.key} line={line} onChange={updateLine} onRemove={removeLine} />
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
                onChange={(e) => setDocumentType(e.target.value as DocumentType)}
              >
                <option value="BOLETA">{t.boleta}</option>
                <option value="FACTURA" disabled={!online}>
                  {t.factura}
                  {online ? "" : ` (${t.needsConnection})`}
                </option>
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
          {documentProblem ? (
            <Alert tone="info" data-testid="pos-document-rule">
              {documentProblem}
            </Alert>
          ) : null}
          <div className="flex gap-2">
            <Input
              aria-label={t.searchCustomer}
              placeholder={t.searchCustomer}
              value={customerQuery}
              onChange={(e) => setCustomerQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && customerQuery.trim().length >= 2) {
                  e.preventDefault();
                  searchCustomer();
                }
              }}
            />
            <Button
              type="button"
              variant="outline"
              disabled={customerQuery.trim().length < 2 || !online}
              onClick={searchCustomer}
            >
              {t.search}
            </Button>
            {customer ? (
              <Button
                type="button"
                variant="ghost"
                aria-label="Quitar cliente"
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
                    className="min-h-11 w-full px-3 py-2 text-left text-sm hover:bg-muted"
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
          <label className="flex min-h-11 items-center gap-2 text-sm">
            <input
              type="checkbox"
              className="size-5"
              checked={isCredit}
              onChange={(e) => setIsCredit(e.target.checked)}
              disabled={!online}
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
          {offlineProblem ? <Alert tone="info">{offlineProblem}</Alert> : null}
          {error ? <Alert tone="error">{error}</Alert> : null}
          <Button
            type="button"
            className="h-14 w-full text-lg"
            disabled={!canCharge || charging}
            onClick={charge}
          >
            {charging
              ? "Registrando…"
              : online
                ? `${t.charge} S/ ${preview?.total ?? "0.00"}`
                : `${t.saveOffline} S/ ${preview?.total ?? "0.00"}`}
          </Button>
        </Card>
      </div>
    </div>
  );
}
