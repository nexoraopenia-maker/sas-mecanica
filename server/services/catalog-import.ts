import { randomUUID } from "node:crypto";
import { estimateCostUsd } from "@/lib/ai/pricing";
import { requirePermission, requireTenantId, type AuthUser } from "@/lib/auth/can";
import { withTenant } from "@/lib/db";
import { ConflictError, DomainError, NotFoundError } from "@/lib/errors";
import {
  confirmImportSchema,
  detectImportFileKind,
  ImportFileError,
  MAX_IMPORT_BYTES,
  parseUblInvoice,
  suggestSku,
  type ConfirmImportInput,
  type ExtractedInvoice,
  type ImportKind,
} from "@/lib/catalog/invoice-import";
import { buildInvoiceExtractor, ExtractionError } from "@/server/integrations/invoice-extractor";
import { auditContextOf, recordAudit, type RequestMeta } from "./audit";
import { loadTenantSecrets } from "./ai-settings";
import { getAiUsage } from "./ai-usage";
import { createProduct } from "./catalog";
import { registerStockIn } from "./inventory";
import { resolveAiPolicy } from "./messaging";

export type ImportMode = "XML" | "AI" | "SIMULATED";

export interface ReviewRow {
  key: string;
  sku: string;
  name: string;
  barcode: string | null;
  quantity: number;
  unitCost: number;
  kind: ImportKind;
  /** Producto del catálogo que ya existe con ese SKU o código de barras. */
  match: { productId: string; sku: string; name: string; trackedStock: boolean } | null;
}

export interface ImportPreview {
  mode: ImportMode;
  supplierName: string | null;
  supplierRuc: string | null;
  reference: string | null;
  issueDate: string | null;
  currency: string | null;
  rows: ReviewRow[];
}

const SKU_PATTERN = /^[A-Z0-9][A-Z0-9._-]{1,39}$/;

function toImportError(error: unknown): never {
  if (error instanceof ImportFileError || error instanceof ExtractionError)
    throw new ConflictError("IMPORT_FILE", error.message);
  throw error;
}

/**
 * Lee un comprobante de compra y arma la tabla de revisión. NO guarda nada en el catálogo ni en el stock:
 * eso ocurre solo cuando la persona confirma (`confirmCatalogImport`).
 * - XML de SUNAT: se lee localmente, sin IA.
 * - PDF o foto: extracción con IA (plan con «IA de inventario»); en demo o sin conexión usa el modo simulado.
 */
export async function extractInvoiceFile(
  actor: AuthUser,
  file: { name: string; bytes: Uint8Array },
  meta: RequestMeta = {},
): Promise<ImportPreview> {
  requirePermission(actor, "catalog:crear");
  requirePermission(actor, "inventory:crear");
  const tenantId = requireTenantId(actor);
  if (file.bytes.length > MAX_IMPORT_BYTES)
    throw new ConflictError("IMPORT_FILE", "El archivo supera el máximo de 8 MB");

  let kind;
  try {
    kind = detectImportFileKind(file.bytes);
  } catch (error) {
    return toImportError(error);
  }

  let invoice: ExtractedInvoice;
  let mode: ImportMode;
  if (kind === "XML") {
    try {
      invoice = parseUblInvoice(new TextDecoder("utf-8").decode(file.bytes));
    } catch (error) {
      return toImportError(error);
    }
    mode = "XML";
  } else {
    const prepared = await withTenant(tenantId, async (tx) => {
      const policy = await resolveAiPolicy(tx);
      if (!policy.enabled)
        throw new ConflictError(
          "AI_DISABLED",
          "Leer PDF y fotos con IA es parte del plan con «IA de inventario». Puedes subir el XML del comprobante.",
        );
      const [settings, secrets] = await Promise.all([
        tx.tenantSettings.findFirstOrThrow({ select: { aiModel: true } }),
        loadTenantSecrets(tx, tenantId),
      ]);
      if (!policy.simulated && !secrets.openaiKey)
        throw new ConflictError(
          "AI_NO_KEY",
          "Configura la clave de OpenAI en Configuración → IA y canales para leer PDF y fotos",
        );
      if (!policy.simulated && (await getAiUsage(tx)).exhausted)
        throw new ConflictError(
          "AI_BUDGET",
          "Se agotó el presupuesto mensual de IA. Sube el XML del comprobante o aumenta el tope.",
        );
      const run = await tx.aiRun.create({
        data: {
          kind: "OTHER",
          status: "RUNNING",
          model: settings.aiModel,
          simulated: policy.simulated,
          // Nunca se guarda el contenido del documento: solo qué se procesó.
          prompt: { task: "invoice_import", fileKind: kind, bytes: file.bytes.length },
          idempotencyKey: `invoice-import:${randomUUID()}`,
          triggeredById: actor.userId,
        },
      });
      return {
        runId: run.id,
        model: settings.aiModel,
        simulated: policy.simulated,
        apiKey: secrets.openaiKey,
      };
    });

    const extractor = buildInvoiceExtractor({
      simulated: prepared.simulated,
      apiKey: prepared.apiKey,
      model: prepared.model,
    });
    try {
      const output = await extractor.extract({ kind, bytes: file.bytes, fileName: file.name });
      invoice = output.invoice;
      await withTenant(tenantId, (tx) =>
        tx.aiRun.update({
          where: { id: prepared.runId },
          data: {
            status: "SUCCEEDED",
            promptTokens: output.usage.promptTokens,
            completionTokens: output.usage.completionTokens,
            costUsd: prepared.simulated
              ? 0
              : estimateCostUsd(
                  prepared.model,
                  output.usage.promptTokens,
                  output.usage.completionTokens,
                ),
            finishedAt: new Date(),
          },
        }),
      );
    } catch (error) {
      await withTenant(tenantId, (tx) =>
        tx.aiRun.update({
          where: { id: prepared.runId },
          data: {
            status: "FAILED",
            error: error instanceof Error ? error.message.slice(0, 300) : "error",
            finishedAt: new Date(),
          },
        }),
      );
      if (error instanceof ExtractionError) return toImportError(error);
      throw new ConflictError(
        "IMPORT_AI",
        "No se pudo leer el documento con IA. Inténtalo de nuevo o sube el XML.",
      );
    }
    mode = prepared.simulated ? "SIMULATED" : "AI";
  }

  if (invoice.lines.length === 0)
    throw new ConflictError("IMPORT_FILE", "No se encontraron productos en el documento");

  const preview = await withTenant(tenantId, async (tx) => {
    const skus = invoice.lines
      .map((line) => line.sku?.trim().toUpperCase())
      .filter((sku): sku is string => Boolean(sku && SKU_PATTERN.test(sku)));
    const barcodes = invoice.lines
      .map((line) => line.barcode?.trim())
      .filter((code): code is string => Boolean(code));
    const existing =
      skus.length + barcodes.length === 0
        ? []
        : await tx.product.findMany({
            where: { OR: [{ sku: { in: skus } }, { barcode: { in: barcodes } }] },
            select: {
              id: true,
              sku: true,
              name: true,
              barcode: true,
              trackingMode: true,
              isStocked: true,
            },
          });
    const rows = invoice.lines.map((line, index): ReviewRow => {
      const rawSku = line.sku?.trim().toUpperCase();
      const sku = rawSku && SKU_PATTERN.test(rawSku) ? rawSku : suggestSku(line.name, index);
      const found = existing.find(
        (product) =>
          product.sku === sku || (line.barcode ? product.barcode === line.barcode.trim() : false),
      );
      return {
        key: `${index}`,
        sku: found?.sku ?? sku,
        name: line.name,
        barcode: line.barcode?.trim() || null,
        quantity: line.quantity,
        unitCost: line.unitCost,
        kind: "PART",
        match: found
          ? {
              productId: found.id,
              sku: found.sku,
              name: found.name,
              trackedStock: !found.isStocked || found.trackingMode !== "NONE",
            }
          : null,
      };
    });
    await recordAudit(tx, auditContextOf(actor, meta), {
      action: "catalog.import_extracted",
      entityType: "catalog_import",
      after: {
        mode,
        fileKind: kind,
        lines: rows.length,
        matched: rows.filter((row) => row.match).length,
      },
    });
    return rows;
  });

  return {
    mode,
    supplierName: invoice.supplierName ?? null,
    supplierRuc: invoice.supplierRuc ?? null,
    reference:
      invoice.series || invoice.number
        ? [invoice.series, invoice.number].filter(Boolean).join("-")
        : null,
    issueDate: invoice.issueDate ?? null,
    currency: invoice.currency ?? null,
    rows: preview,
  };
}

export interface ImportRowResult {
  index: number;
  sku: string;
  status: "CREATED" | "STOCKED" | "ERROR";
  message: string | null;
}

export interface ImportResult {
  created: number;
  stocked: number;
  failed: number;
  rows: ImportRowResult[];
}

/**
 * Guarda la tabla ya revisada: crea los productos nuevos y registra la entrada de stock por el kardex
 * (`registerStockIn`, nunca editando saldos). Cada fila es independiente e idempotente: si una falla, las
 * demás se guardan, y reintentar con la misma clave no duplica entradas.
 */
export async function confirmCatalogImport(
  actor: AuthUser,
  input: ConfirmImportInput,
  meta: RequestMeta = {},
): Promise<ImportResult> {
  requirePermission(actor, "inventory:crear");
  const tenantId = requireTenantId(actor);
  const data = confirmImportSchema.parse(input);
  if (data.rows.some((row) => row.productId === undefined))
    requirePermission(actor, "catalog:crear");

  const warehouse = await withTenant(tenantId, (tx) =>
    tx.warehouse.findFirst({ where: { id: data.warehouseId, isActive: true } }),
  );
  if (!warehouse) throw new NotFoundError("Almacén");

  const reason = data.reference
    ? `Importación de comprobante ${data.reference}`
    : "Importación de comprobante";
  const results: ImportRowResult[] = [];
  for (const [index, row] of data.rows.entries()) {
    try {
      let productId = row.productId;
      let created = false;
      if (productId) {
        const product = await withTenant(tenantId, (tx) =>
          tx.product.findFirst({
            where: { id: productId },
            select: { isStocked: true, trackingMode: true },
          }),
        );
        if (!product) throw new NotFoundError("Producto");
        if (!product.isStocked || product.trackingMode !== "NONE")
          throw new ConflictError(
            "IMPORT_TRACKED",
            "Este producto se controla por lote o serie: ingresa su stock desde Inventario",
          );
      } else {
        const product = await createProduct(
          actor,
          {
            kind: row.kind,
            sku: row.sku,
            name: row.name,
            brand: row.brand,
            barcode: row.barcode,
            salePrice: row.salePrice ?? 0,
            ...(row.kind === "PART" ? { part: {} } : {}),
          } as Parameters<typeof createProduct>[1],
          meta,
        );
        productId = product.id;
        created = true;
      }
      await registerStockIn(
        actor,
        {
          warehouseId: data.warehouseId,
          productId,
          quantity: row.quantity,
          unitCost: row.unitCost.toFixed(4),
          type: "PURCHASE",
          reason,
          reference: data.reference,
          idempotencyKey: `${data.idempotencyKey}:${index}`,
        },
        meta,
      );
      results.push({ index, sku: row.sku, status: created ? "CREATED" : "STOCKED", message: null });
    } catch (error) {
      if (!(error instanceof DomainError)) throw error;
      results.push({ index, sku: row.sku, status: "ERROR", message: error.message });
    }
  }

  const summary = {
    created: results.filter((r) => r.status === "CREATED").length,
    stocked: results.filter((r) => r.status === "STOCKED").length,
    failed: results.filter((r) => r.status === "ERROR").length,
  };
  await withTenant(tenantId, (tx) =>
    recordAudit(tx, auditContextOf(actor, meta), {
      action: "catalog.import_confirmed",
      entityType: "catalog_import",
      after: { ...summary, warehouseId: data.warehouseId, reference: data.reference ?? null },
    }),
  );
  return { ...summary, rows: results };
}
