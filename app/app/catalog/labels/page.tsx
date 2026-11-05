import Link from "next/link";
import { prepareLabelsAction } from "@/app/actions/catalog";
import { LabelSheet } from "@/components/catalog/label-sheet";
import { PrintButton } from "@/components/catalog/print-button";
import { Alert } from "@/components/ui/alert";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input, Label, Select } from "@/components/ui/input";
import { requirePermission } from "@/lib/auth/can";
import { requireTenantUser } from "@/lib/auth/guards";
import {
  LABEL_FORMATS,
  LABEL_FORMAT_IDS,
  labelParamsSchema,
  MAX_LABEL_COPIES,
} from "@/lib/catalog/labels";
import { es } from "@/lib/i18n/es";
import { getLabelProducts, listLabelCandidates } from "@/server/services/catalog";

type Search = {
  ids?: string | string[];
  copies?: string;
  format?: string;
  q?: string;
  error?: string;
};

export default async function LabelsPage({ searchParams }: { searchParams: Promise<Search> }) {
  const user = await requireTenantUser();
  requirePermission(user, "catalog:ver");
  const search = await searchParams;
  const l = es.labels;
  const parsed = labelParamsSchema.safeParse({
    ids: search.ids,
    copies: search.copies,
    format: search.format,
  });
  const params = parsed.success ? parsed.data : { ids: [], copies: 1, format: "50x25" as const };

  if (params.ids.length > 0) {
    const products = await getLabelProducts(user, params.ids);
    return (
      <>
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h1 className="text-2xl font-semibold">{l.title}</h1>
          <Link href="/app/catalog/labels" className={buttonVariants({ variant: "outline" })}>
            {l.change}
          </Link>
        </div>
        {products.length === 0 ? (
          <Alert tone="error">{l.empty}</Alert>
        ) : (
          <>
            <Card className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-sm text-muted-foreground">{l.printHint}</p>
              <PrintButton label={l.print} />
            </Card>
            <h2 className="text-lg font-medium">{l.sheetTitle}</h2>
            <LabelSheet products={products} copies={params.copies} format={params.format} />
          </>
        )}
      </>
    );
  }

  const candidates = await listLabelCandidates(user, search.q);
  return (
    <>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-2xl font-semibold">{l.title}</h1>
        <Link href="/app/catalog" className={buttonVariants({ variant: "ghost" })}>
          {l.back}
        </Link>
      </div>
      <p className="text-sm text-muted-foreground">{l.subtitle}</p>
      {search.error === "empty" ? <Alert tone="error">{l.noSelection}</Alert> : null}

      <Card>
        <form className="flex flex-wrap items-end gap-3" role="search">
          <div className="min-w-56 flex-1">
            <Label htmlFor="q">{l.search}</Label>
            <Input id="q" name="q" defaultValue={search.q} placeholder={l.searchPlaceholder} />
          </div>
          <Button type="submit" variant="outline">
            {l.searchSubmit}
          </Button>
        </form>
      </Card>

      <form action={prepareLabelsAction} className="space-y-4">
        <Card className="space-y-2">
          {candidates.length === 0 ? (
            <p className="text-sm text-muted-foreground">{l.noCandidates}</p>
          ) : (
            <ul className="divide-y divide-border" data-testid="label-candidates">
              {candidates.map((product) => (
                <li key={product.id}>
                  <label className="flex min-h-12 items-center gap-3 text-sm">
                    <input
                      type="checkbox"
                      name="ids"
                      value={product.id}
                      className="size-5"
                      aria-label={`${l.select} ${product.name}`}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block font-medium">{product.name}</span>
                      <span className="text-muted-foreground">{product.sku}</span>
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {product.barcode ?? l.noBarcode}
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card className="grid gap-4 sm:grid-cols-3">
          <div>
            <Label htmlFor="copies">{l.copies}</Label>
            <Input
              id="copies"
              name="copies"
              type="number"
              min={1}
              max={MAX_LABEL_COPIES}
              defaultValue={1}
            />
          </div>
          <div>
            <Label htmlFor="format">{l.format}</Label>
            <Select id="format" name="format" defaultValue="50x25">
              {LABEL_FORMAT_IDS.map((id) => (
                <option key={id} value={id}>
                  {LABEL_FORMATS[id].label}
                </option>
              ))}
            </Select>
          </div>
          <div className="flex items-end">
            <Button type="submit" className="w-full">
              {l.prepare}
            </Button>
          </div>
        </Card>
      </form>
    </>
  );
}
