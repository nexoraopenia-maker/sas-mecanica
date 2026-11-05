"use client";

import Link from "next/link";
import { startTransition, useActionState, useRef, useState } from "react";
import {
  confirmImportAction,
  extractInvoiceAction,
  type ImportPreviewState,
  type ImportResultState,
} from "@/app/actions/catalog";
import { Alert } from "@/components/ui/alert";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input, Label, Select } from "@/components/ui/input";
import { IMPORT_KINDS, type ImportKind } from "@/lib/catalog/invoice-import";
import { es } from "@/lib/i18n/es";
import type { ImportPreview, ReviewRow } from "@/server/services/catalog-import";

interface EditableRow {
  key: string;
  include: boolean;
  sku: string;
  name: string;
  barcode: string | null;
  kind: ImportKind;
  quantity: string;
  unitCost: string;
  salePrice: string;
  match: ReviewRow["match"];
}

const SKU = /^[A-Z0-9][A-Z0-9._-]{1,39}$/;

function toEditable(rows: ReviewRow[]): EditableRow[] {
  return rows.map((row) => ({
    key: row.key,
    include: !row.match?.trackedStock,
    sku: row.sku,
    name: row.name,
    barcode: row.barcode,
    kind: row.kind,
    quantity: String(row.quantity),
    unitCost: String(row.unitCost),
    salePrice: "",
    match: row.match,
  }));
}

function rowProblem(row: EditableRow): "badRow" | "needPrice" | null {
  const quantity = Number(row.quantity);
  const cost = Number(row.unitCost);
  if (!SKU.test(row.sku.trim().toUpperCase()) || row.name.trim().length < 2) return "badRow";
  if (!(quantity > 0) || !Number.isFinite(cost) || cost < 0) return "badRow";
  if (!row.match && !(Number(row.salePrice) > 0)) return "needPrice";
  return null;
}

/** Importador de comprobantes en dos pasos: leer el archivo y revisar la tabla antes de guardar. */
export function ImportWizard({ warehouses }: { warehouses: Array<{ id: string; name: string }> }) {
  const t = es.catalogImport;
  const [extracted, extractAction, extracting] = useActionState<ImportPreviewState, FormData>(
    extractInvoiceAction,
    {},
  );
  const [saved, confirmAction, saving] = useActionState<ImportResultState, FormData>(
    confirmImportAction,
    {},
  );
  // El estado de edición se reinicia con cada lectura nueva (la clave es la propia vista previa).
  const [edit, setEdit] = useState<{ source: ImportPreview | null; rows: EditableRow[] }>({
    source: null,
    rows: [],
  });
  const preview = extracted.preview ?? null;
  if (preview !== edit.source)
    setEdit({ source: preview, rows: preview ? toEditable(preview.rows) : [] });
  const rows = edit.rows;
  const [warehouseId, setWarehouseId] = useState(warehouses[0]?.id ?? "");
  const [reference, setReference] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const keyRef = useRef(crypto.randomUUID());

  const result = saved.result;
  const failedKeys = new Set(
    result?.rows.filter((r) => r.status === "ERROR").map((r) => String(r.index)),
  );
  function patch(key: string, change: Partial<EditableRow>) {
    setEdit((current) => ({
      ...current,
      rows: current.rows.map((row) => (row.key === key ? { ...row, ...change } : row)),
    }));
  }

  function submitUpload(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    startTransition(() => extractAction(data));
  }

  function submitConfirm() {
    const included = rows.filter((row) => row.include && !row.match?.trackedStock);
    if (included.length === 0) return setProblem(t.nothingSelected);
    for (const row of included) {
      const issue = rowProblem(row);
      if (issue) return setProblem(t[issue]);
    }
    setProblem(null);
    const payload = {
      warehouseId,
      reference: reference.trim() || preview?.reference || undefined,
      idempotencyKey: keyRef.current,
      rows: included.map((row) => ({
        sku: row.sku.trim().toUpperCase(),
        name: row.name.trim(),
        barcode: row.barcode ?? undefined,
        kind: row.kind,
        quantity: Number(row.quantity),
        unitCost: Number(row.unitCost),
        salePrice: row.match ? undefined : Number(row.salePrice),
        productId: row.match?.productId,
      })),
    };
    const data = new FormData();
    data.set("payload", JSON.stringify(payload));
    startTransition(() => confirmAction(data));
  }

  function retryFailed() {
    if (!result) return;
    keyRef.current = crypto.randomUUID();
    setEdit((current) => ({
      ...current,
      rows: current.rows.filter((row) => failedKeys.has(row.key)),
    }));
  }

  if (result && result.failed === 0) {
    return (
      <Card className="space-y-4" data-testid="import-result">
        <h2 className="text-lg font-semibold">{t.resultTitle}</h2>
        <p>
          {result.created} {t.created} · {result.stocked} {t.stocked}
        </p>
        <div className="flex flex-wrap gap-3">
          <Link href="/app/catalog" className={buttonVariants()}>
            {t.done}
          </Link>
          <a href="/app/catalog/import" className={buttonVariants({ variant: "outline" })}>
            {t.again}
          </a>
        </div>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      {!preview ? (
        <Card>
          <form onSubmit={submitUpload} className="space-y-4" data-testid="import-upload">
            <div>
              <Label htmlFor="file">{t.file}</Label>
              <Input
                id="file"
                name="file"
                type="file"
                accept=".pdf,.xml,application/pdf,text/xml,application/xml,image/jpeg,image/png,image/webp"
                required
                className="h-auto py-3"
              />
              <p className="mt-1 text-xs text-muted-foreground">{t.fileHint}</p>
            </div>
            {extracted.error ? <Alert tone="error">{extracted.error}</Alert> : null}
            <Button type="submit" disabled={extracting}>
              {extracting ? t.reading : t.read}
            </Button>
          </form>
        </Card>
      ) : (
        <>
          <Alert tone={preview.mode === "SIMULATED" ? "warning" : "info"} data-testid="import-mode">
            {preview.mode === "XML"
              ? t.modeXml
              : preview.mode === "AI"
                ? t.modeAi
                : t.modeSimulated}
          </Alert>
          <Card className="grid gap-3 text-sm sm:grid-cols-3">
            <p>
              <span className="text-muted-foreground">{t.supplier}: </span>
              {preview.supplierName ?? "—"} {preview.supplierRuc ? `(${preview.supplierRuc})` : ""}
            </p>
            <p>
              <span className="text-muted-foreground">{t.reference}: </span>
              {preview.reference ?? "—"}
            </p>
            <p>
              <span className="text-muted-foreground">{t.issueDate}: </span>
              {preview.issueDate ?? "—"}
            </p>
          </Card>

          <Card className="space-y-3">
            <div>
              <h2 className="text-lg font-semibold">{t.review}</h2>
              <p className="text-sm text-muted-foreground">{t.reviewHint}</p>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[56rem] text-sm" data-testid="import-table">
                <thead className="text-left text-xs text-muted-foreground">
                  <tr>
                    <th className="p-2">{t.include}</th>
                    <th className="p-2">{t.sku}</th>
                    <th className="p-2">{t.name}</th>
                    <th className="p-2">{t.kind}</th>
                    <th className="p-2">{t.quantity}</th>
                    <th className="p-2">{t.unitCost}</th>
                    <th className="p-2">{t.salePrice}</th>
                    <th className="p-2">{t.status}</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => {
                    const blocked = row.match?.trackedStock === true;
                    const error = result?.rows.find(
                      (r) => String(r.index) === row.key && r.status === "ERROR",
                    );
                    return (
                      <tr
                        key={row.key}
                        className="border-t border-border align-top"
                        data-testid="import-row"
                      >
                        <td className="p-2">
                          <input
                            type="checkbox"
                            className="size-5"
                            checked={row.include && !blocked}
                            disabled={blocked}
                            onChange={(e) => patch(row.key, { include: e.target.checked })}
                            aria-label={`${t.include} ${row.name}`}
                          />
                        </td>
                        <td className="p-2">
                          <Input
                            value={row.sku}
                            disabled={Boolean(row.match)}
                            onChange={(e) => patch(row.key, { sku: e.target.value })}
                            aria-label={`${t.sku} ${row.name}`}
                            className="h-10 w-40"
                          />
                        </td>
                        <td className="p-2">
                          <Input
                            value={row.name}
                            disabled={Boolean(row.match)}
                            onChange={(e) => patch(row.key, { name: e.target.value })}
                            aria-label={`${t.name} ${row.sku}`}
                            className="h-10 min-w-56"
                          />
                        </td>
                        <td className="p-2">
                          <Select
                            value={row.kind}
                            disabled={Boolean(row.match)}
                            onChange={(e) => patch(row.key, { kind: e.target.value as ImportKind })}
                            aria-label={`${t.kind} ${row.sku}`}
                            className="h-10"
                          >
                            {IMPORT_KINDS.map((kind) => (
                              <option key={kind} value={kind}>
                                {t.kinds[kind]}
                              </option>
                            ))}
                          </Select>
                        </td>
                        <td className="p-2">
                          <Input
                            type="number"
                            min={0}
                            step="any"
                            value={row.quantity}
                            onChange={(e) => patch(row.key, { quantity: e.target.value })}
                            aria-label={`${t.quantity} ${row.sku}`}
                            className="h-10 w-24"
                          />
                        </td>
                        <td className="p-2">
                          <Input
                            type="number"
                            min={0}
                            step="any"
                            value={row.unitCost}
                            onChange={(e) => patch(row.key, { unitCost: e.target.value })}
                            aria-label={`${t.unitCost} ${row.sku}`}
                            className="h-10 w-28"
                          />
                        </td>
                        <td className="p-2">
                          {row.match ? (
                            <span className="text-muted-foreground">—</span>
                          ) : (
                            <Input
                              type="number"
                              min={0}
                              step="0.01"
                              value={row.salePrice}
                              onChange={(e) => patch(row.key, { salePrice: e.target.value })}
                              aria-label={`${t.salePrice} ${row.sku}`}
                              className="h-10 w-28"
                            />
                          )}
                        </td>
                        <td className="p-2 text-xs">
                          {blocked ? (
                            <span className="text-warning">{t.tracked}</span>
                          ) : row.match ? (
                            <span className="text-success">{t.existing}</span>
                          ) : (
                            <span className="text-primary">{t.isNew}</span>
                          )}
                          {error?.message ? (
                            <p className="mt-1 text-danger">{error.message}</p>
                          ) : null}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Card>

          <Card className="grid gap-4 sm:grid-cols-3">
            <div>
              <Label htmlFor="warehouse">{t.warehouse}</Label>
              <Select
                id="warehouse"
                value={warehouseId}
                onChange={(e) => setWarehouseId(e.target.value)}
              >
                {warehouses.map((warehouse) => (
                  <option key={warehouse.id} value={warehouse.id}>
                    {warehouse.name}
                  </option>
                ))}
              </Select>
            </div>
            <div>
              <Label htmlFor="reference">{t.referenceInput}</Label>
              <Input
                id="reference"
                value={reference}
                placeholder={preview.reference ?? ""}
                onChange={(e) => setReference(e.target.value)}
              />
            </div>
            <div className="flex items-end gap-2">
              <Button
                type="button"
                className="flex-1"
                onClick={submitConfirm}
                disabled={saving || !warehouseId}
              >
                {saving ? t.saving : t.confirm}
              </Button>
            </div>
          </Card>
          {problem ? <Alert tone="error">{problem}</Alert> : null}
          {saved.error ? <Alert tone="error">{saved.error}</Alert> : null}
          {result && result.failed > 0 ? (
            <Alert tone="warning" data-testid="import-partial">
              {result.created} {t.created} · {result.stocked} {t.stocked} · {result.failed}{" "}
              {t.failed}{" "}
              <button type="button" className="underline" onClick={retryFailed}>
                {t.retry}
              </button>
            </Alert>
          ) : null}
        </>
      )}
    </div>
  );
}
