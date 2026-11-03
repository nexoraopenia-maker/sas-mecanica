import Link from "next/link";
import { ZodError } from "zod";
import { StockBar } from "@/components/catalog/stock-bar";
import { ProductForm } from "@/components/forms/product-form";
import { Alert } from "@/components/ui/alert";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardTitle } from "@/components/ui/card";
import { Input, Label } from "@/components/ui/input";
import { can, requirePermission } from "@/lib/auth/can";
import { requireTenantUser } from "@/lib/auth/guards";
import { CATALOG_CHIPS } from "@/lib/catalog/chips";
import { es } from "@/lib/i18n/es";
import { cn } from "@/lib/utils";
import { listCatalog, type CatalogItem } from "@/server/services/catalog";

type Params = {
  q?: string;
  tireSize?: string;
  code?: string;
  make?: string;
  model?: string;
  year?: string;
  chip?: string;
  page?: string;
};

const FILTER_KEYS = ["q", "tireSize", "code", "make", "model", "year"] as const;

function href(params: Params, override: Partial<Params>): string {
  const merged: Params = { ...params, ...override };
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(merged))
    if (value && !(key === "chip" && value === "todos") && !(key === "page" && value === "1"))
      query.set(key, value);
  const text = query.toString();
  return text ? `/app/catalog?${text}` : "/app/catalog";
}

function spec(product: CatalogItem): string {
  if (product.tire)
    return `${product.tire.size}${product.tire.loadIndex ? ` ${product.tire.loadIndex}${product.tire.speedRating ?? ""}` : ""}`;
  if (product.battery) return product.battery.label;
  if (product.lubricant) return product.lubricant.viscosity;
  if (product.part?.oemCode) return `OEM ${product.part.oemCode}`;
  return "";
}

export default async function CatalogPage({ searchParams }: { searchParams: Promise<Params> }) {
  const user = await requireTenantUser();
  requirePermission(user, "catalog:ver");
  const params = await searchParams;
  const c = es.catalog;
  const chip = CATALOG_CHIPS.find((item) => item.id === params.chip)?.id ?? "todos";
  const canSeeCost = can(user, "purchasing:ver_costos_compra");

  let result: Awaited<ReturnType<typeof listCatalog>> | null = null;
  let filterError: string | null = null;
  try {
    result = await listCatalog(user, {
      q: params.q || undefined,
      tireSize: params.tireSize || undefined,
      code: params.code || undefined,
      make: params.make || undefined,
      model: params.model || undefined,
      year: params.year || undefined,
      chip,
      page: params.page || undefined,
    });
  } catch (error) {
    if (!(error instanceof ZodError)) throw error;
    filterError = c.tireSizeHint;
  }
  const hasFilters = FILTER_KEYS.some((key) => params[key]) || chip !== "todos";

  return (
    <>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-2xl font-semibold">{c.title}</h1>
        {result ? (
          <p className="text-sm text-muted-foreground" data-testid="catalog-total">
            {result.total} {c.results}
          </p>
        ) : null}
      </div>

      <Card>
        <form className="grid gap-4 sm:grid-cols-2" role="search">
          {chip !== "todos" ? <input type="hidden" name="chip" value={chip} /> : null}
          <div className="sm:col-span-2">
            <Label htmlFor="q">{c.search}</Label>
            <Input id="q" name="q" defaultValue={params.q} placeholder={c.searchPlaceholder} />
          </div>
          <div>
            <Label htmlFor="tireSize">{c.tireSize}</Label>
            <Input
              id="tireSize"
              name="tireSize"
              defaultValue={params.tireSize}
              placeholder="205/55 R16"
            />
          </div>
          <div>
            <Label htmlFor="code">{c.code}</Label>
            <Input id="code" name="code" defaultValue={params.code} />
          </div>
          <div>
            <Label htmlFor="make">{c.vehicleMake}</Label>
            <Input id="make" name="make" defaultValue={params.make} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="model">{c.vehicleModel}</Label>
              <Input id="model" name="model" defaultValue={params.model} />
            </div>
            <div>
              <Label htmlFor="year">{c.vehicleYear}</Label>
              <Input id="year" name="year" type="number" defaultValue={params.year} />
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-3 sm:col-span-2">
            <Button type="submit">{c.search}</Button>
            {hasFilters ? (
              <Link href="/app/catalog" className={buttonVariants({ variant: "ghost" })}>
                {c.clearFilters}
              </Link>
            ) : null}
          </div>
        </form>
      </Card>

      <nav aria-label={c.chipsLabel} className="flex flex-wrap gap-2">
        {CATALOG_CHIPS.map((item) => {
          const active = item.id === chip;
          return (
            <Link
              key={item.id}
              href={href(params, { chip: item.id, page: undefined })}
              aria-current={active ? "true" : undefined}
              data-testid={`chip-${item.id}`}
              className={cn(
                "inline-flex min-h-10 items-center rounded-full border px-4 text-sm font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
                active
                  ? "border-primary bg-primary/15 text-foreground"
                  : "border-border text-muted-foreground hover:bg-muted hover:text-foreground",
              )}
            >
              {item.label}
            </Link>
          );
        })}
      </nav>

      {filterError ? (
        <Alert tone="error">{filterError}</Alert>
      ) : result && result.items.length === 0 ? (
        <Card className="space-y-3 text-center" data-testid="catalog-empty">
          {result.filtered ? (
            <>
              <p className="text-lg font-medium">{c.noResults}</p>
              <p className="text-sm text-muted-foreground">{c.noResultsHint}</p>
              <Link
                href="/app/catalog"
                className={cn(buttonVariants({ variant: "outline" }), "mx-auto")}
              >
                {c.clearFilters}
              </Link>
            </>
          ) : (
            <>
              <p className="text-lg font-medium">{c.emptyTitle}</p>
              <p className="text-sm text-muted-foreground">{c.emptyHint}</p>
              {can(user, "catalog:crear") ? (
                <a href="#nuevo-producto" className={cn(buttonVariants(), "mx-auto")}>
                  {c.emptyCta}
                </a>
              ) : null}
            </>
          )}
        </Card>
      ) : result ? (
        <>
          <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3" data-testid="catalog-list">
            {result.items.map((product) => (
              <li key={product.id}>
                <Card className="flex h-full flex-col gap-3" data-testid="product-card">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="font-medium">{product.name}</p>
                      <p className="text-sm text-muted-foreground">
                        {product.sku} · {product.categoryName ?? c.kinds[product.kind]}
                        {product.brand ? ` · ${product.brand}` : ""}
                      </p>
                    </div>
                    <p className="shrink-0 text-lg font-semibold">
                      S/ {Number(product.salePrice).toFixed(2)}
                    </p>
                  </div>
                  {spec(product) ? <p className="text-sm">{spec(product)}</p> : null}
                  {canSeeCost ? (
                    <p className="text-sm text-muted-foreground" data-testid="product-cost">
                      {product.lastPurchaseCost ? (
                        <>
                          {c.cost}: S/ {Number(product.lastPurchaseCost).toFixed(2)} · {c.margin}{" "}
                          <span
                            className={cn(
                              "whitespace-nowrap font-medium",
                              Number(product.marginPercent) < 0 ? "text-danger" : "text-foreground",
                            )}
                          >
                            {product.marginPercent === null || product.marginPercent === undefined
                              ? "—"
                              : `${product.marginPercent} %`}
                          </span>
                        </>
                      ) : (
                        c.noCost
                      )}
                    </p>
                  ) : null}
                  <div className="mt-auto">
                    {product.stockInfo ? (
                      <StockBar info={product.stockInfo} unit={product.unit} testId="stock-light" />
                    ) : !product.isStocked ? (
                      <p className="text-sm text-muted-foreground">{c.noStockControl}</p>
                    ) : null}
                  </div>
                </Card>
              </li>
            ))}
          </ul>
          {result.pageCount > 1 ? (
            <nav
              aria-label="Paginación"
              className="flex items-center justify-between gap-3"
              data-testid="catalog-pager"
            >
              {result.page > 1 ? (
                <Link
                  href={href(params, { page: String(result.page - 1) })}
                  className={buttonVariants({ variant: "outline" })}
                  rel="prev"
                >
                  {c.previous}
                </Link>
              ) : (
                <span />
              )}
              <p className="text-sm text-muted-foreground">
                {c.pageOf} {result.page} / {result.pageCount}
              </p>
              {result.page < result.pageCount ? (
                <Link
                  href={href(params, { page: String(result.page + 1) })}
                  className={buttonVariants({ variant: "outline" })}
                  rel="next"
                >
                  {c.next}
                </Link>
              ) : (
                <span />
              )}
            </nav>
          ) : null}
        </>
      ) : null}

      {can(user, "catalog:crear") ? (
        <Card id="nuevo-producto">
          <CardTitle>{c.newProduct}</CardTitle>
          <ProductForm canSeeCost={canSeeCost} />
        </Card>
      ) : null}
    </>
  );
}
