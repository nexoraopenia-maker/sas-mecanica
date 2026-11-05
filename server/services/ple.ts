import { z } from "zod";
import { buildZip } from "@/lib/ple/zip";
import { requirePermission, requireTenantId, type AuthUser } from "@/lib/auth/can";
import { Prisma, withTenant } from "@/lib/db";
import { DomainError } from "@/lib/errors";
import { customerSnapshotSchema, documentLineSchema } from "@/lib/billing/payload";
import { DEMO_RUC, type FiscalType } from "@/lib/billing/sunat";
import { encodeAnsi, pleFile, pleFileName, type PleBook } from "@/lib/ple/format";
import { buildPurchaseRows, type PurchaseBookDoc } from "@/lib/ple/compras";
import { buildSalesRows, type SaleBookDoc } from "@/lib/ple/ventas";
import { validateRow } from "@/lib/ple/spec";
import { startOfLimaDay } from "@/lib/reports/period";
import { isValidRuc, normalizeDocument } from "@/lib/workshop/documents";
import {
  pleBookSchema,
  pleMonthSchema,
  purchaseInvoiceSchema,
  voidPurchaseInvoiceSchema,
  type PleMonth,
  type PurchaseInvoiceInput,
} from "@/lib/validation/ple";
import { auditContextOf, recordAudit, type RequestMeta } from "./audit";

export interface PleExport {
  book: PleBook;
  fileName: string;
  content: Buffer;
  rows: number;
}

export interface PleSampleRow {
  date: string;
  document: string;
  party: string;
  total: string;
}

export interface PlePreview {
  ruc: string | null;
  isDemoRuc: boolean;
  period: PleMonth;
  sales: {
    rows: number;
    excludedPending: number;
    excludedRejected: number;
    total: string;
    /** Filas que no cumplen la estructura oficial (el archivo no se genera mientras haya alguna). */
    invalidRows: number;
    firstError: string | null;
    sample: PleSampleRow[];
  };
  purchases: {
    rows: number;
    total: string;
    invalidRows: number;
    firstError: string | null;
    sample: PleSampleRow[];
  };
}

const SAMPLE_SIZE = 8;

function validation(
  book: PleBook,
  rows: string[][],
): { invalidRows: number; firstError: string | null } {
  let invalidRows = 0;
  let firstError: string | null = null;
  rows.forEach((row, index) => {
    const errors = validateRow(book, row);
    if (errors.length === 0) return;
    invalidRows += 1;
    firstError ??= `Fila ${index + 1}: ${errors[0]}`;
  });
  return { invalidRows, firstError };
}

const D = (value: string | number | Prisma.Decimal): Prisma.Decimal => new Prisma.Decimal(value);

function monthRange(period: PleMonth): { start: Date; endExclusive: Date } {
  const pad = (n: number) => String(n).padStart(2, "0");
  const next =
    period.month === 12 ? { y: period.year + 1, m: 1 } : { y: period.year, m: period.month + 1 };
  return {
    start: startOfLimaDay(`${period.year}-${pad(period.month)}-01`),
    endExclusive: startOfLimaDay(`${next.y}-${pad(next.m)}-01`),
  };
}

function guardView(actor: AuthUser): string {
  requirePermission(actor, "accounting:ver");
  return requireTenantId(actor);
}

type Tx = Parameters<Parameters<typeof withTenant>[1]>[0];

async function loadSalesDocs(tx: Tx, period: PleMonth) {
  const { start, endExclusive } = monthRange(period);
  const docs = await tx.fiscalDocument.findMany({
    where: { issueDate: { gte: start, lt: endExclusive } },
    include: {
      related: { select: { type: true, series: true, correlative: true, issueDate: true } },
    },
  });
  const saleIds = docs.map((d) => d.saleId).filter((id): id is string => id !== null);
  const payments = saleIds.length
    ? await tx.salePayment.groupBy({
        by: ["saleId", "method"],
        where: { saleId: { in: saleIds } },
        _sum: { amount: true },
      })
    : [];
  const bySale = new Map<string, { cash: Prisma.Decimal; other: Prisma.Decimal }>();
  for (const p of payments) {
    const entry = bySale.get(p.saleId) ?? { cash: D(0), other: D(0) };
    const amount = D(p._sum.amount ?? 0);
    if (p.method === "CASH") entry.cash = entry.cash.plus(amount);
    else entry.other = entry.other.plus(amount);
    bySale.set(p.saleId, entry);
  }
  let excludedPending = 0;
  let excludedRejected = 0;
  const book: SaleBookDoc[] = [];
  for (const doc of docs) {
    if (doc.status === "PENDING") {
      excludedPending += 1;
      continue;
    }
    if (doc.status === "REJECTED") {
      excludedRejected += 1;
      continue;
    }
    const pay = doc.saleId ? bySale.get(doc.saleId) : undefined;
    book.push({
      type: doc.type as FiscalType,
      state: doc.status === "VOIDED" ? "VOIDED" : "ACCEPTED",
      series: doc.series,
      correlative: doc.correlative,
      issueDate: doc.issueDate,
      buyer: customerSnapshotSchema.parse(doc.customerSnapshot).buyer,
      lines: z.array(documentLineSchema).parse(doc.itemsSnapshot),
      related: doc.related
        ? {
            type: doc.related.type as FiscalType,
            series: doc.related.series,
            correlative: doc.related.correlative,
            issueDate: doc.related.issueDate,
          }
        : null,
      paidWithBankMethod: !!pay && pay.cash.lte(0) && pay.other.gte(doc.total),
    });
  }
  return { book, excludedPending, excludedRejected };
}

async function loadPurchaseDocs(tx: Tx, period: PleMonth): Promise<PurchaseBookDoc[]> {
  const rows = await tx.purchaseInvoice.findMany({
    where: { period: period.year * 100 + period.month, deletedAt: null },
  });
  return rows.map((r) => ({
    docTypeCode: r.docTypeCode,
    series: r.series,
    number: r.number,
    issueDate: r.issueDate,
    dueDate: r.dueDate,
    supplier:
      r.supplierDocNumber && r.supplierName
        ? { docType: r.supplierDocType, docNumber: r.supplierDocNumber, name: r.supplierName }
        : null,
    taxedBase: r.taxedBase.toFixed(2),
    igv: r.igv.toFixed(2),
    exemptTotal: r.exemptTotal.toFixed(2),
    total: r.total.toFixed(2),
    givesTaxCredit: r.givesTaxCredit,
    paidWithBankMethod: r.paidWithBankMethod,
    related:
      r.relatedDocTypeCode && r.relatedSeries && r.relatedNumber && r.relatedIssueDate
        ? {
            docTypeCode: r.relatedDocTypeCode,
            series: r.relatedSeries,
            number: r.relatedNumber,
            issueDate: r.relatedIssueDate,
          }
        : null,
  }));
}

/** Resumen del mes para la pantalla: cuántas filas saldrán y qué comprobantes quedan fuera. */
export async function previewPle(actor: AuthUser, input: unknown): Promise<PlePreview> {
  const tenantId = guardView(actor);
  const period = pleMonthSchema.parse(input);
  return withTenant(tenantId, async (tx) => {
    const [tenant, sales, purchases] = await Promise.all([
      tx.tenant.findFirstOrThrow({ select: { taxId: true } }),
      loadSalesDocs(tx, period),
      loadPurchaseDocs(tx, period),
    ]);
    const salesTotal = sales.book.reduce(
      (acc, d) =>
        d.state === "VOIDED"
          ? acc
          : acc.plus(
              d.lines
                .reduce((s, l) => s.plus(l.total), D(0))
                .times(d.type === "NOTA_CREDITO" ? -1 : 1),
            ),
      D(0),
    );
    const salesRows = buildSalesRows(sales.book, period.year, period.month);
    const purchaseRows = buildPurchaseRows(purchases, period.year, period.month);
    // Columnas del libro: ventas = fecha(4), tipo(6), serie(7), número(8), comprador(12), total(25);
    // compras = fecha(4), tipo(6), serie(7), número(9), proveedor(13), total(24).
    const pick = (row: string[], n: number) => row[n - 1] ?? "";
    return {
      ruc: tenant.taxId,
      isDemoRuc: tenant.taxId === DEMO_RUC,
      period,
      sales: {
        rows: sales.book.length,
        excludedPending: sales.excludedPending,
        excludedRejected: sales.excludedRejected,
        total: salesTotal.toFixed(2),
        ...validation("14.1", salesRows),
        sample: salesRows.slice(0, SAMPLE_SIZE).map((row) => ({
          date: pick(row, 4),
          document: `${pick(row, 6)} ${pick(row, 7)}-${pick(row, 8)}`,
          party: pick(row, 12) || "—",
          total: pick(row, 25),
        })),
      },
      purchases: {
        rows: purchases.length,
        total: purchases.reduce((acc, p) => acc.plus(p.total), D(0)).toFixed(2),
        ...validation("8.1", purchaseRows),
        sample: purchaseRows.slice(0, SAMPLE_SIZE).map((row) => ({
          date: pick(row, 4),
          document: `${pick(row, 6)} ${pick(row, 7)}-${pick(row, 9)}`,
          party: pick(row, 13) || "—",
          total: pick(row, 24),
        })),
      },
    };
  });
}

/** Genera el TXT del libro pedido. Todas las filas pasan por el validador de la estructura oficial antes de salir. */
export async function exportPle(
  actor: AuthUser,
  input: { book: unknown; year: unknown; month: unknown },
  meta: RequestMeta = {},
): Promise<PleExport> {
  const tenantId = guardView(actor);
  const book = pleBookSchema.parse(input.book);
  const period = pleMonthSchema.parse({ year: input.year, month: input.month });
  return withTenant(tenantId, async (tx) => {
    const tenant = await tx.tenant.findFirstOrThrow({ select: { taxId: true } });
    if (!tenant.taxId || !isValidRuc(tenant.taxId))
      throw new DomainError(
        "PLE_RUC",
        "Registra un RUC válido de la empresa en Configuración antes de exportar",
      );
    const rows =
      book === "14.1"
        ? buildSalesRows((await loadSalesDocs(tx, period)).book, period.year, period.month)
        : buildPurchaseRows(await loadPurchaseDocs(tx, period), period.year, period.month);
    const errors = rows.flatMap((row, i) =>
      validateRow(book, row).map((e) => `Fila ${i + 1}: ${e}`),
    );
    if (errors.length > 0)
      throw new DomainError(
        "PLE_INVALID",
        `El archivo no cumple la estructura SUNAT: ${errors[0]}`,
        { errors },
      );
    const file: PleExport = {
      book,
      fileName: pleFileName({
        ruc: tenant.taxId,
        year: period.year,
        month: period.month,
        book,
        hasData: rows.length > 0,
      }),
      content: encodeAnsi(pleFile(rows)),
      rows: rows.length,
    };
    // Constancia de cada descarga: quién bajó qué libro de qué mes (sin guardar el contenido).
    await recordAudit(tx, auditContextOf(actor, meta), {
      action: "ple.exported",
      entityType: "ple_book",
      after: {
        book,
        year: period.year,
        month: period.month,
        rows: rows.length,
        fileName: file.fileName,
      },
    });
    return file;
  });
}

export async function listPurchaseInvoices(actor: AuthUser, input: unknown) {
  requirePermission(actor, "accounting:ver");
  const tenantId = requireTenantId(actor);
  const period = pleMonthSchema.parse(input);
  return withTenant(tenantId, (tx) =>
    tx.purchaseInvoice.findMany({
      where: { period: period.year * 100 + period.month, deletedAt: null },
      orderBy: [{ issueDate: "asc" }, { series: "asc" }, { number: "asc" }],
    }),
  );
}

/** Registra un comprobante de compra para el Registro de Compras (8.1). Rechaza duplicados del mismo proveedor. */
export async function registerPurchaseInvoice(
  actor: AuthUser,
  input: PurchaseInvoiceInput,
  meta: RequestMeta = {},
) {
  requirePermission(actor, "accounting:crear");
  const tenantId = requireTenantId(actor);
  return withTenant(tenantId, async (tx) => {
    const settings = await tx.tenantSettings.findFirstOrThrow({ select: { taxRate: true } });
    const data = purchaseInvoiceSchema.parse({ ...input, taxRate: Number(settings.taxRate) });
    let supplierName = data.supplierName;
    let supplierDocNumber = data.supplierDocNumber
      ? normalizeDocument(data.supplierDocType, data.supplierDocNumber)
      : undefined;
    if (data.supplierId) {
      const supplier = await tx.supplier.findFirst({
        where: { id: data.supplierId, deletedAt: null },
      });
      if (!supplier) throw new DomainError("PLE_SUPPLIER", "Proveedor no encontrado");
      supplierName = supplierName || supplier.name;
      supplierDocNumber = supplierDocNumber ?? supplier.taxId ?? undefined;
    }
    if (data.docTypeCode !== "00" && (!supplierDocNumber || !supplierName))
      throw new DomainError("PLE_SUPPLIER", "Indica el documento y el nombre del proveedor");
    if (data.purchaseOrderId) {
      const order = await tx.purchaseOrder.findFirst({ where: { id: data.purchaseOrderId } });
      if (!order) throw new DomainError("PLE_ORDER", "Orden de compra no encontrada");
    }
    const duplicate = await tx.purchaseInvoice.findFirst({
      where: {
        deletedAt: null,
        supplierDocNumber: supplierDocNumber ?? null,
        docTypeCode: data.docTypeCode,
        series: data.series,
        number: data.number,
      },
    });
    if (duplicate)
      throw new DomainError("PLE_DUPLICATE", "Este comprobante de compra ya está registrado");
    const [py, pm] = (data.period ?? data.issueDate.slice(0, 7)).split("-").map(Number);
    const base = D(data.taxedBase);
    const igv = D(data.igv);
    const exempt = D(data.exemptTotal);
    const created = await tx.purchaseInvoice.create({
      data: {
        supplierId: data.supplierId ?? null,
        supplierDocType: data.supplierDocType,
        supplierDocNumber: supplierDocNumber ?? null,
        supplierName: supplierName ?? null,
        docTypeCode: data.docTypeCode,
        series: data.series,
        number: data.number,
        issueDate: startOfLimaDay(data.issueDate),
        dueDate: data.dueDate ? startOfLimaDay(data.dueDate) : null,
        period: (py ?? 0) * 100 + (pm ?? 0),
        taxedBase: base,
        igv,
        exemptTotal: exempt,
        total: base.plus(igv).plus(exempt),
        givesTaxCredit: data.givesTaxCredit,
        paidWithBankMethod: data.paidWithBankMethod,
        relatedDocTypeCode: data.related?.docTypeCode ?? null,
        relatedSeries: data.related?.series ?? null,
        relatedNumber: data.related?.number ?? null,
        relatedIssueDate: data.related ? startOfLimaDay(data.related.issueDate) : null,
        purchaseOrderId: data.purchaseOrderId ?? null,
        notes: data.notes ?? null,
        createdById: actor.userId,
      },
    });
    await recordAudit(tx, auditContextOf(actor, meta), {
      action: "ple.purchase_invoice.register",
      entityType: "PurchaseInvoice",
      entityId: created.id,
      after: {
        docTypeCode: created.docTypeCode,
        series: created.series,
        number: created.number,
        total: created.total.toFixed(2),
        period: created.period,
      },
    });
    return created;
  });
}

/** Anula (borrado lógico) un comprobante de compra; el motivo queda en la bitácora inmutable. */
export async function voidPurchaseInvoice(actor: AuthUser, input: unknown, meta: RequestMeta = {}) {
  requirePermission(actor, "accounting:eliminar");
  const tenantId = requireTenantId(actor);
  const { id, reason } = voidPurchaseInvoiceSchema.parse(input);
  return withTenant(tenantId, async (tx) => {
    const found = await tx.purchaseInvoice.findFirst({ where: { id, deletedAt: null } });
    if (!found) throw new DomainError("PLE_NOT_FOUND", "Comprobante de compra no encontrado");
    await tx.purchaseInvoice.update({ where: { id }, data: { deletedAt: new Date() } });
    await recordAudit(tx, auditContextOf(actor, meta), {
      action: "ple.purchase_invoice.void",
      entityType: "PurchaseInvoice",
      entityId: id,
      before: {
        docTypeCode: found.docTypeCode,
        series: found.series,
        number: found.number,
        total: found.total.toFixed(2),
      },
      reason,
    });
  });
}

export interface PleZip {
  fileName: string;
  content: Buffer;
  rows: { sales: number; purchases: number };
}

/** Los dos libros del mes (14.1 y 8.1) en un solo ZIP, listos para entregar al contador. */
export async function exportPleZip(
  actor: AuthUser,
  input: { year: unknown; month: unknown },
  meta: RequestMeta = {},
): Promise<PleZip> {
  const sales = await exportPle(actor, { book: "14.1", ...input }, meta);
  const purchases = await exportPle(actor, { book: "8.1", ...input }, meta);
  const period = pleMonthSchema.parse(input);
  const ruc = sales.fileName.slice(2, 13);
  return {
    fileName: `PLE-${ruc}-${period.year}${String(period.month).padStart(2, "0")}.zip`,
    content: buildZip([
      { name: sales.fileName, data: sales.content },
      { name: purchases.fileName, data: purchases.content },
    ]),
    rows: { sales: sales.rows, purchases: purchases.rows },
  };
}
