import { ProductForm } from "@/components/forms/product-form";
import { Button } from "@/components/ui/button";
import { Card, CardTitle } from "@/components/ui/card";
import { Input, Label } from "@/components/ui/input";
import { can, requirePermission } from "@/lib/auth/can";
import { requireTenantUser } from "@/lib/auth/guards";
import { es } from "@/lib/i18n/es";
import { searchProducts } from "@/server/services/catalog";

type Params = {
  q?: string;
  tireSize?: string;
  code?: string;
  make?: string;
  model?: string;
  year?: string;
};

export default async function CatalogPage({ searchParams }: { searchParams: Promise<Params> }) {
  const user = await requireTenantUser();
  requirePermission(user, "catalog:ver");
  const params = await searchParams;
  const c = es.catalog;
  const products = await searchProducts(user, {
    q: params.q || undefined,
    tireSize: params.tireSize || undefined,
    code: params.code || undefined,
    vehicle: params.make
      ? { make: params.make, model: params.model || undefined, year: params.year || undefined }
      : undefined,
    limit: 100,
  }).catch(() => null);

  return (
    <>
      <h1 className="text-2xl font-semibold">{c.title}</h1>
      <Card>
        <form className="grid gap-4 sm:grid-cols-2" role="search">
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
          <Button type="submit" className="sm:col-span-2 sm:w-fit">
            {c.search}
          </Button>
        </form>
      </Card>

      {products === null ? (
        <p role="alert" className="text-destructive">
          {c.tireSizeHint}
        </p>
      ) : products.length === 0 ? (
        <p className="text-muted-foreground">{c.noResults}</p>
      ) : (
        <ul className="space-y-3">
          {products.map((product) => (
            <li key={product.id}>
              <Card className="space-y-1">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <p className="font-medium">{product.name}</p>
                    <p className="text-sm text-muted-foreground">
                      {product.sku} · {c.kinds[product.kind]}
                      {product.brand ? ` · ${product.brand}` : ""}
                    </p>
                  </div>
                  <p className="text-lg font-semibold">S/ {Number(product.salePrice).toFixed(2)}</p>
                </div>
                <p className="text-sm">
                  {product.tire
                    ? `${product.tire.size}${product.tire.loadIndex ? ` ${product.tire.loadIndex}${product.tire.speedRating ?? ""}` : ""}`
                    : null}
                  {product.battery ? product.battery.label : null}
                  {product.lubricant ? product.lubricant.viscosity : null}
                  {product.part?.oemCode ? `OEM ${product.part.oemCode}` : null}
                </p>
                <p className="text-sm text-muted-foreground">
                  {c.tracking[product.trackingMode]}
                  {product.stock !== undefined ? ` · ${c.stock}: ${product.stock}` : ""}
                  {product.lastPurchaseCost
                    ? ` · ${c.cost}: S/ ${Number(product.lastPurchaseCost).toFixed(2)}`
                    : ""}
                </p>
              </Card>
            </li>
          ))}
        </ul>
      )}

      {can(user, "catalog:crear") ? (
        <Card>
          <CardTitle>{c.newProduct}</CardTitle>
          <ProductForm canSeeCost={can(user, "purchasing:ver_costos_compra")} />
        </Card>
      ) : null}
    </>
  );
}
