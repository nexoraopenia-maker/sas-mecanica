import Link from "next/link";
import { createQuoteAction } from "@/app/actions/sales";
import { ActionForm } from "@/components/forms/action-form";
import { Card, CardTitle } from "@/components/ui/card";
import { Input, Label, Select } from "@/components/ui/input";
import { can, requirePermission } from "@/lib/auth/can";
import { requireTenantUser } from "@/lib/auth/guards";
import { es } from "@/lib/i18n/es";
import { formatDate } from "@/lib/workshop/format";
import { searchProducts } from "@/server/services/catalog";
import { listQuotes } from "@/server/services/quotes";

const ROWS = 6;

export default async function QuotesPage() {
  const user = await requireTenantUser();
  requirePermission(user, "pos:ver");
  const t = es.quotes;
  const [quotes, products] = await Promise.all([
    listQuotes(user),
    can(user, "pos:crear") && can(user, "catalog:ver")
      ? searchProducts(user, { limit: 200 })
      : Promise.resolve([]),
  ]);

  return (
    <>
      <h1 className="text-2xl font-semibold">{t.title}</h1>
      {quotes.length === 0 ? <p className="text-muted-foreground">{t.none}</p> : null}
      <ul className="space-y-3">
        {quotes.map((quote) => (
          <li key={quote.id}>
            <Link href={`/app/quotes/${quote.id}`} className="block" data-testid="quote">
              <Card className="space-y-1 hover:bg-muted/40">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <p className="font-medium">
                    Cotización #{quote.number} · S/ {quote.total}
                  </p>
                  <span className="rounded-full bg-muted px-3 py-1 text-sm">
                    {t.status[quote.status as keyof typeof t.status]}
                  </span>
                </div>
                <p className="text-sm text-muted-foreground">
                  {quote.customer ?? es.pos.noCustomer} {quote.plate ? `· ${quote.plate}` : ""} ·{" "}
                  {t.validUntil} {formatDate(quote.validUntil)}
                </p>
              </Card>
            </Link>
          </li>
        ))}
      </ul>

      {can(user, "pos:crear") ? (
        <Card>
          <CardTitle>{t.newQuote}</CardTitle>
          <ActionForm action={createQuoteAction} submitLabel={t.submit} className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-3">
              <div>
                <Label htmlFor="customerId">{es.pos.customer} (ID)</Label>
                <Input id="customerId" name="customerId" placeholder="Opcional" />
              </div>
              <div>
                <Label htmlFor="vehicleId">{es.pos.vehicle} (ID)</Label>
                <Input
                  id="vehicleId"
                  name="vehicleId"
                  placeholder="Opcional, para convertir en OT"
                />
              </div>
              <div>
                <Label htmlFor="validDays">{t.validDays}</Label>
                <Input
                  id="validDays"
                  name="validDays"
                  type="number"
                  min={1}
                  max={90}
                  defaultValue={7}
                />
              </div>
            </div>
            {Array.from({ length: ROWS }, (_, i) => (
              <div
                key={i}
                className="grid gap-2 rounded-lg border border-border p-3 sm:grid-cols-6"
              >
                <div className="sm:col-span-2">
                  <Label htmlFor={`productId_${i}`}>{t.product}</Label>
                  <Select id={`productId_${i}`} name={`productId_${i}`} defaultValue="">
                    <option value="">—</option>
                    {products.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.sku} · {p.name}
                      </option>
                    ))}
                  </Select>
                </div>
                <div className="sm:col-span-2">
                  <Label htmlFor={`description_${i}`}>{t.description}</Label>
                  <Input id={`description_${i}`} name={`description_${i}`} maxLength={200} />
                </div>
                <div>
                  <Label htmlFor={`quantity_${i}`}>{es.pos.quantity}</Label>
                  <Input
                    id={`quantity_${i}`}
                    name={`quantity_${i}`}
                    inputMode="decimal"
                    defaultValue="1"
                  />
                </div>
                <div>
                  <Label htmlFor={`unitPrice_${i}`}>{t.price}</Label>
                  <Input id={`unitPrice_${i}`} name={`unitPrice_${i}`} inputMode="decimal" />
                </div>
                <div>
                  <Label htmlFor={`discount_${i}`}>{es.pos.discount}</Label>
                  <Input id={`discount_${i}`} name={`discount_${i}`} inputMode="decimal" />
                </div>
                <label className="flex items-center gap-2 pt-6 text-sm">
                  <input type="checkbox" name={`labor_${i}`} className="size-5" />
                  {t.labor}
                </label>
              </div>
            ))}
            <div>
              <Label htmlFor="notes">{t.notes}</Label>
              <Input id="notes" name="notes" maxLength={500} />
            </div>
          </ActionForm>
        </Card>
      ) : null}
    </>
  );
}
