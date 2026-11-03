import { requirePermission, requireTenantId, type AuthUser } from "@/lib/auth/can";
import { nextSequence, Prisma, withTenant, type TenantTx } from "@/lib/db";
import { getEnv } from "@/lib/env";
import { ConflictError, NotFoundError } from "@/lib/errors";
import {
  buildPayload,
  customerSnapshotSchema,
  documentLineSchema,
  totalsOfLines,
  type DocumentLine,
  type Issuer,
} from "@/lib/billing/payload";
import { billingMessages } from "@/lib/billing/messages";
import {
  CREDIT_NOTE_REASONS,
  DEBIT_NOTE_REASONS,
  DEMO_RUC,
  formatDocumentNumber,
  seriesMatchesType,
  type Buyer,
  type FiscalType,
} from "@/lib/billing/sunat";
import { decryptSecret, encryptSecret, maskSecret, secretHint } from "@/lib/security/crypto";
import { assertPublicUrl, UnsafeUrlError } from "@/lib/security/net";
import {
  invoiceSettingsSchema,
  SERIES_KEYS,
  debitNoteSchema,
  type DebitNoteInput,
  type InvoiceSettingsInput,
} from "@/lib/validation/sales";
import { z } from "zod";
import {
  buildInvoiceProvider,
  InvoiceProviderError,
  type InvoiceProvider,
} from "@/server/integrations/invoicing";
import { auditContextOf, recordAudit, type RequestMeta } from "./audit";
import { companyName, notifyCustomer } from "./customer-notify";
import { listOperationalTenantIds } from "./inventory-maintenance";
import { logger } from "@/lib/logger";

const invoiceContext = (tenantId: string) => `tenant:${tenantId}:invoice`;
const MAX_ATTEMPTS = 8;
/** Espera tras cada intento fallido (minutos): 1, 5, 15, 60, 180, 360, 720. */
const BACKOFF_MINUTES = [1, 5, 15, 60, 180, 360, 720];
/** Tiempo que un envío "reserva" el comprobante: evita que el job y la venta lo manden a la vez. */
const LEASE_MINUTES = 5;

const D = (value: string | number | Prisma.Decimal): Prisma.Decimal => new Prisma.Decimal(value);

// ---------------------------------------------------------------------------
// Datos del emisor y del comprador
// ---------------------------------------------------------------------------

export async function issuerOf(tx: TenantTx): Promise<Issuer> {
  const tenant = await tx.tenant.findFirstOrThrow({
    select: { legalName: true, tradeName: true, taxId: true, address: true, isDemo: true },
  });
  if (!tenant.taxId && tenant.isDemo) {
    return {
      ruc: DEMO_RUC,
      name: tenant.legalName,
      tradeName: tenant.tradeName,
      address: tenant.address,
    };
  }
  if (!tenant.taxId) {
    throw new ConflictError(
      "ISSUER_RUC",
      "Configura el RUC de la empresa antes de emitir comprobantes",
    );
  }
  return {
    ruc: tenant.taxId,
    name: tenant.legalName,
    tradeName: tenant.tradeName,
    address: tenant.address,
  };
}

export function buyerOf(
  customer: {
    docType: Buyer["docType"];
    docNumber: string | null;
    name: string;
    address: string | null;
  } | null,
): Buyer | null {
  if (!customer || !customer.docNumber) return null;
  return {
    docType: customer.docType,
    docNumber: customer.docNumber,
    name: customer.name,
    address: customer.address,
  };
}

export async function taxContextOf(tx: TenantTx) {
  const s = await tx.tenantSettings.findFirstOrThrow({
    select: { taxRate: true, pricesIncludeTax: true },
  });
  return { taxRate: s.taxRate.toString(), pricesIncludeTax: s.pricesIncludeTax };
}

// ---------------------------------------------------------------------------
// Creación (dentro de la transacción de la venta/devolución)
// ---------------------------------------------------------------------------

export interface PendingDocumentInput {
  type: FiscalType;
  saleId: string;
  saleReturnId?: string | null;
  related?: { id: string; type: FiscalType; series: string; correlative: number } | null;
  /** Clave única de emisión: reintentar la misma operación no emite dos comprobantes. */
  docKey: string;
  series: string;
  lines: DocumentLine[];
  buyer: Buyer | null;
  isCredit: boolean;
  note?: { reasonCode: string; reason: string } | null;
  issueDate: Date;
}

/** Crea el comprobante en estado PENDING con su correlativo. El envío al OSE ocurre después, fuera de la transacción. */
export async function createPendingDocument(tx: TenantTx, input: PendingDocumentInput) {
  const existing = await tx.fiscalDocument.findFirst({ where: { docKey: input.docKey } });
  if (existing) return existing;
  const totals = totalsOfLines(input.lines);
  // Defensa en profundidad: la serie configurada debe corresponder al tipo (B### boletas, F### facturas).
  if (!seriesMatchesType(input.type, input.series, input.related?.type))
    throw new ConflictError(
      "SERIES_MISMATCH",
      `La serie ${input.series} no corresponde a este comprobante: revisa Configuración → Facturación`,
    );
  const correlative = await nextSequence(tx, input.type, input.series);
  return tx.fiscalDocument.create({
    data: {
      saleId: input.saleId,
      saleReturnId: input.saleReturnId ?? null,
      relatedDocumentId: input.related?.id ?? null,
      docKey: input.docKey,
      type: input.type,
      series: input.series,
      correlative,
      issueDate: input.issueDate,
      currency: "PEN",
      customerSnapshot: { buyer: input.buyer, isCredit: input.isCredit },
      itemsSnapshot: input.lines,
      noteReasonCode: input.note?.reasonCode ?? null,
      noteReason: input.note?.reason ?? null,
      subtotal: totals.subtotal,
      taxTotal: totals.tax,
      total: totals.total,
    },
  });
}

// ---------------------------------------------------------------------------
// Proveedor y configuración
// ---------------------------------------------------------------------------

const storedConfigSchema = z.object({ baseUrl: z.string(), token: z.string().nullable() });

/** Proveedor del tenant. Una cuenta demo siempre usa el simulado: nunca toca un OSE real. */
async function loadProvider(tx: TenantTx, tenantId: string): Promise<InvoiceProvider | null> {
  const [tenant, settings] = await Promise.all([
    tx.tenant.findFirstOrThrow({ select: { isDemo: true } }),
    tx.tenantSettings.findFirstOrThrow(),
  ]);
  if (tenant.isDemo || settings.invoiceProvider === "SIMULATED")
    return buildInvoiceProvider({ kind: "SIMULATED" });
  if (settings.invoiceProvider === "HTTP" && settings.invoiceConfigEncrypted) {
    const config = storedConfigSchema.parse(
      JSON.parse(
        decryptSecret(
          settings.invoiceConfigEncrypted,
          getEnv().ENCRYPTION_KEY,
          invoiceContext(tenantId),
        ),
      ),
    );
    return buildInvoiceProvider({ kind: "HTTP", baseUrl: config.baseUrl, token: config.token });
  }
  return null;
}

async function seriesUsage(tx: TenantTx, series: string[]): Promise<Record<string, number>> {
  const rows = await tx.fiscalDocument.groupBy({
    by: ["series"],
    where: { series: { in: series } },
    _count: { _all: true },
  });
  return Object.fromEntries(rows.map((row) => [row.series, row._count._all]));
}

export async function getInvoiceSettings(actor: AuthUser) {
  requirePermission(actor, "billing:ver");
  const tenantId = requireTenantId(actor);
  return withTenant(tenantId, async (tx) => {
    const s = await tx.tenantSettings.findFirstOrThrow();
    let baseUrl: string | null = null;
    let tokenMask: string | null = null;
    if (s.invoiceConfigEncrypted) {
      const config = storedConfigSchema.parse(
        JSON.parse(
          decryptSecret(
            s.invoiceConfigEncrypted,
            getEnv().ENCRYPTION_KEY,
            invoiceContext(tenantId),
          ),
        ),
      );
      baseUrl = config.baseUrl;
      tokenMask = config.token ? maskSecret(config.token) : null;
    }
    return {
      provider: (s.invoiceProvider ?? "NONE") as "NONE" | "SIMULATED" | "HTTP",
      baseUrl,
      tokenMask,
      boletaSeries: s.boletaSeries,
      facturaSeries: s.facturaSeries,
      creditNoteBoletaSeries: s.creditNoteBoletaSeries,
      creditNoteFacturaSeries: s.creditNoteFacturaSeries,
      debitNoteBoletaSeries: s.debitNoteBoletaSeries,
      debitNoteFacturaSeries: s.debitNoteFacturaSeries,
      saleNoteSeries: s.saleNoteSeries,
      defaultCreditDays: s.defaultCreditDays,
      cashTolerance: s.cashTolerance.toString(),
      ticketWidthMm: s.ticketWidthMm,
      /** Comprobantes ya emitidos por cada serie vigente (para avisar antes de cambiarla). */
      seriesInUse: await seriesUsage(
        tx,
        SERIES_KEYS.map((key) => s[key]),
      ),
    };
  });
}

export async function updateInvoiceSettings(
  actor: AuthUser,
  input: InvoiceSettingsInput,
  meta: RequestMeta = {},
): Promise<void> {
  requirePermission(actor, "billing:editar");
  const data = invoiceSettingsSchema.parse(input);
  const tenantId = requireTenantId(actor);
  let encrypted: string | null | undefined;
  if (data.provider === "HTTP") {
    try {
      await assertPublicUrl(data.baseUrl ?? "");
    } catch (error) {
      if (error instanceof UnsafeUrlError) throw new ConflictError("INVOICE_URL", error.message);
      throw new ConflictError("INVOICE_URL", "No se pudo validar la URL del proveedor");
    }
  }
  await withTenant(tenantId, async (tx) => {
    const current = await tx.tenantSettings.findFirstOrThrow();
    // Cambiar una serie que ya emitió comprobantes exige confirmación explícita.
    const changed = SERIES_KEYS.filter((name) => current[name] !== data[name]);
    const usage = await seriesUsage(
      tx,
      changed.map((name) => current[name]),
    );
    const inUse = changed.filter((name) => (usage[current[name]] ?? 0) > 0);
    if (inUse.length > 0 && !data.confirmSeriesChange) {
      const name = inUse[0] as (typeof SERIES_KEYS)[number];
      const count = usage[current[name]] ?? 0;
      throw new ConflictError(
        "SERIES_IN_USE",
        `La serie ${current[name]} ya emitió ${count} comprobante(s). Si la cambias por ${data[name]}, los nuevos comprobantes empezarán en el correlativo 1. Marca la confirmación para continuar`,
      );
    }
    const key = getEnv().ENCRYPTION_KEY;
    if (data.provider !== "HTTP") {
      encrypted = null;
    } else {
      const previous = current.invoiceConfigEncrypted
        ? storedConfigSchema.parse(
            JSON.parse(
              decryptSecret(current.invoiceConfigEncrypted, key, invoiceContext(tenantId)),
            ),
          )
        : null;
      const token = data.clearToken ? null : data.token || previous?.token || null;
      encrypted = encryptSecret(
        JSON.stringify({ baseUrl: data.baseUrl, token }),
        key,
        invoiceContext(tenantId),
      );
    }
    await tx.tenantSettings.update({
      where: { id: current.id },
      data: {
        invoiceProvider: data.provider === "NONE" ? null : data.provider,
        invoiceConfigEncrypted: encrypted ?? null,
        boletaSeries: data.boletaSeries,
        facturaSeries: data.facturaSeries,
        creditNoteBoletaSeries: data.creditNoteBoletaSeries,
        creditNoteFacturaSeries: data.creditNoteFacturaSeries,
        debitNoteBoletaSeries: data.debitNoteBoletaSeries,
        debitNoteFacturaSeries: data.debitNoteFacturaSeries,
        saleNoteSeries: data.saleNoteSeries,
        defaultCreditDays: data.defaultCreditDays,
        cashTolerance: data.cashTolerance,
        ...(data.ticketWidthMm !== undefined ? { ticketWidthMm: data.ticketWidthMm } : {}),
      },
    });
    await recordAudit(tx, auditContextOf(actor, meta), {
      action: "billing.settings_changed",
      entityType: "tenant_settings",
      entityId: current.id,
      before: {
        provider: current.invoiceProvider,
        ticketWidthMm: current.ticketWidthMm,
        ...Object.fromEntries(SERIES_KEYS.map((name) => [name, current[name]])),
      },
      // Nunca se audita el token: solo si cambió y sus últimos 4 caracteres.
      after: {
        provider: data.provider,
        ticketWidthMm: data.ticketWidthMm ?? current.ticketWidthMm,
        ...Object.fromEntries(SERIES_KEYS.map((name) => [name, data[name]])),
        seriesChangeConfirmed: inUse.length > 0 ? true : undefined,
        tokenHint: data.token ? secretHint(data.token) : undefined,
      },
    });
  });
}

// ---------------------------------------------------------------------------
// Envío al OSE/PSE (fuera de cualquier transacción larga)
// ---------------------------------------------------------------------------

export type DispatchResult = "ACCEPTED" | "REJECTED" | "RETRY" | "NO_PROVIDER" | "SKIPPED";

async function payloadOf(tx: TenantTx, documentId: string) {
  const doc = await tx.fiscalDocument.findFirst({
    where: { id: documentId },
    include: { related: true },
  });
  if (!doc) throw new NotFoundError("Comprobante");
  const lines = z.array(documentLineSchema).parse(doc.itemsSnapshot);
  const snapshot = customerSnapshotSchema.parse(doc.customerSnapshot);
  const issuer = await issuerOf(tx);
  const type = doc.type as FiscalType;
  return {
    doc,
    payload: buildPayload(
      {
        type,
        series: doc.series,
        correlative: doc.correlative,
        issueDate: doc.issueDate,
        currency: doc.currency,
        isCredit: snapshot.isCredit,
        buyer: snapshot.buyer,
        lines,
        totals: totalsOfLines(lines),
        related: doc.related
          ? {
              type: doc.related.type as FiscalType,
              series: doc.related.series,
              correlative: doc.related.correlative,
            }
          : null,
        note: doc.noteReasonCode
          ? { reasonCode: doc.noteReasonCode, reason: doc.noteReason ?? "" }
          : null,
      },
      issuer,
    ),
  };
}

/**
 * Envía UN comprobante. Reserva el comprobante (lease) en una transacción corta, llama al proveedor
 * SIN transacción abierta y guarda el resultado. Si el proceso muere a mitad, el lease vence y se
 * reintenta; el proveedor es idempotente por serie-correlativo.
 */
export async function dispatchDocument(
  tenantId: string,
  documentId: string,
  now: Date = new Date(),
): Promise<DispatchResult> {
  const prepared = await withTenant(tenantId, async (tx) => {
    const provider = await loadProvider(tx, tenantId);
    if (!provider) return "NO_PROVIDER" as const;
    const claimed = await tx.fiscalDocument.updateMany({
      where: {
        id: documentId,
        status: "PENDING",
        attempts: { lt: MAX_ATTEMPTS },
        OR: [{ nextRetryAt: null }, { nextRetryAt: { lte: now } }],
      },
      data: {
        nextRetryAt: new Date(now.getTime() + LEASE_MINUTES * 60_000),
        attempts: { increment: 1 },
      },
    });
    if (claimed.count !== 1) return "SKIPPED" as const;
    const { payload, doc } = await payloadOf(tx, documentId);
    return { provider, payload, attempts: doc.attempts };
  });
  if (prepared === "NO_PROVIDER" || prepared === "SKIPPED") return prepared;

  let outcome: Awaited<ReturnType<InvoiceProvider["submit"]>> | null = null;
  let failure: InvoiceProviderError | null = null;
  try {
    outcome = await prepared.provider.submit(prepared.payload);
  } catch (error) {
    failure =
      error instanceof InvoiceProviderError
        ? error
        : new InvoiceProviderError("Error inesperado del proveedor", true);
    if (!(error instanceof InvoiceProviderError))
      logger.error({ err: error, tenantId, documentId }, "falló el envío del comprobante");
  }

  return withTenant(tenantId, async (tx) => {
    const doc = await tx.fiscalDocument.findFirstOrThrow({ where: { id: documentId } });
    const number = formatDocumentNumber(doc.series, doc.correlative);
    if (outcome?.outcome === "ACCEPTED") {
      await tx.fiscalDocument.update({
        where: { id: documentId },
        data: {
          status: "ACCEPTED",
          providerRef: outcome.providerRef,
          hash: outcome.hash,
          xmlUrl: outcome.xmlUrl,
          pdfUrl: outcome.pdfUrl,
          cdrUrl: outcome.cdrUrl,
          errorMessage: null,
          nextRetryAt: null,
          sentAt: now,
        },
      });
      return "ACCEPTED" as const;
    }
    if (outcome?.outcome === "REJECTED" || (failure && !failure.retryable)) {
      const message = outcome
        ? `${outcome.code ?? ""}: ${outcome.message ?? "Rechazado"}`.trim()
        : (failure?.message ?? "Rechazado");
      await tx.fiscalDocument.update({
        where: { id: documentId },
        data: { status: "REJECTED", errorMessage: message.slice(0, 500), nextRetryAt: null },
      });
      await tx.notification.createMany({
        data: [
          {
            kind: "billing.rejected",
            severity: "CRITICAL",
            title: `Comprobante ${number} rechazado`,
            body: message.slice(0, 300),
            data: { documentId },
            dedupeKey: `doc-rejected:${documentId}:${doc.attempts}`,
          },
        ],
        skipDuplicates: true,
      });
      return "REJECTED" as const;
    }
    const exhausted = doc.attempts >= MAX_ATTEMPTS;
    const wait = BACKOFF_MINUTES[Math.min(doc.attempts - 1, BACKOFF_MINUTES.length - 1)] ?? 720;
    await tx.fiscalDocument.update({
      where: { id: documentId },
      data: {
        errorMessage: (failure?.message ?? "Error de envío").slice(0, 500),
        nextRetryAt: exhausted ? null : new Date(now.getTime() + wait * 60_000),
      },
    });
    if (exhausted) {
      await tx.notification.createMany({
        data: [
          {
            kind: "billing.stuck",
            severity: "CRITICAL",
            title: `No se pudo enviar el comprobante ${number}`,
            body: "Se agotaron los reintentos automáticos. Revisa la configuración y reintenta manualmente.",
            data: { documentId },
            dedupeKey: `doc-stuck:${documentId}`,
          },
        ],
        skipDuplicates: true,
      });
    }
    return "RETRY" as const;
  });
}

export interface DispatchSummary {
  sent: number;
  rejected: number;
  retry: number;
}

/** Envía los comprobantes pendientes de UN tenant que ya toca (job y botón «Reintentar pendientes»). */
export async function dispatchPendingForTenant(
  tenantId: string,
  now: Date = new Date(),
  limit = 50,
): Promise<DispatchSummary> {
  const ids = await withTenant(tenantId, async (tx) =>
    (
      await tx.fiscalDocument.findMany({
        where: {
          status: "PENDING",
          attempts: { lt: MAX_ATTEMPTS },
          OR: [{ nextRetryAt: null }, { nextRetryAt: { lte: now } }],
        },
        select: { id: true },
        orderBy: { createdAt: "asc" },
        take: limit,
      })
    ).map((row) => row.id),
  );
  const summary: DispatchSummary = { sent: 0, rejected: 0, retry: 0 };
  for (const id of ids) {
    const result = await dispatchDocument(tenantId, id, now);
    if (result === "ACCEPTED") summary.sent += 1;
    else if (result === "REJECTED") summary.rejected += 1;
    else if (result === "RETRY") summary.retry += 1;
  }
  return summary;
}

export async function dispatchAllPending(
  now: Date = new Date(),
): Promise<{ ok: number; failed: number }> {
  let ok = 0;
  let failed = 0;
  for (const tenantId of await listOperationalTenantIds(now)) {
    try {
      await dispatchPendingForTenant(tenantId, now);
      ok += 1;
    } catch (error) {
      failed += 1;
      logger.error({ err: error, tenantId }, "falló el envío de comprobantes del tenant");
    }
  }
  return { ok, failed };
}

/** Reintento manual: un rechazo por configuración (URL/token) se corrige y se vuelve a enviar con el MISMO correlativo. */
export async function retryDocument(
  actor: AuthUser,
  documentId: string,
  meta: RequestMeta = {},
): Promise<DispatchResult> {
  requirePermission(actor, "billing:editar");
  const tenantId = requireTenantId(actor);
  await withTenant(tenantId, async (tx) => {
    const moved = await tx.fiscalDocument.updateMany({
      where: { id: documentId, status: { in: ["PENDING", "REJECTED"] } },
      data: { status: "PENDING", attempts: 0, nextRetryAt: null, errorMessage: null },
    });
    if (moved.count !== 1)
      throw new ConflictError(
        "DOC_STATE",
        "Solo se reintentan comprobantes pendientes o rechazados",
      );
    await recordAudit(tx, auditContextOf(actor, meta), {
      action: "billing.retry",
      entityType: "fiscal_document",
      entityId: documentId,
    });
  });
  return dispatchDocument(tenantId, documentId);
}

/** Reenvía el comprobante al cliente por WhatsApp (con su consentimiento). */
export async function resendDocument(actor: AuthUser, documentId: string, meta: RequestMeta = {}) {
  requirePermission(actor, "billing:crear");
  return withTenant(requireTenantId(actor), async (tx) => {
    const doc = await tx.fiscalDocument.findFirst({
      where: { id: documentId },
      include: { sale: { include: { customer: true } } },
    });
    if (!doc) throw new NotFoundError("Comprobante");
    if (doc.status !== "ACCEPTED")
      throw new ConflictError("DOC_STATE", "Solo se reenvían comprobantes aceptados");
    const customer = doc.sale?.customer;
    if (!customer)
      throw new ConflictError(
        "NO_CUSTOMER",
        "La venta no tiene un cliente al que enviar el comprobante",
      );
    const now = new Date();
    const result = await notifyCustomer(tx, {
      customerId: customer.id,
      key: `doc-share:${documentId}:${now.toISOString().slice(0, 13)}`,
      relatedType: "fiscal_document",
      relatedId: documentId,
      body: billingMessages.documentReady({
        customer: customer.name,
        company: await companyName(tx),
        number: formatDocumentNumber(doc.series, doc.correlative),
        total: `S/ ${doc.total.toFixed(2)}`,
        link: doc.pdfUrl,
      }),
    });
    if (result === "QUEUED" || result === "SIMULATED")
      await tx.fiscalDocument.update({ where: { id: documentId }, data: { lastSharedAt: now } });
    await recordAudit(tx, auditContextOf(actor, meta), {
      action: "billing.resent",
      entityType: "fiscal_document",
      entityId: documentId,
      after: { result },
    });
    return result;
  });
}

// ---------------------------------------------------------------------------
// Nota de débito
// ---------------------------------------------------------------------------

/**
 * Nota de débito sobre un comprobante ACEPTADO (intereses, penalidades, aumento de valor). Si la
 * venta tiene una cuenta por cobrar abierta, el monto se suma a lo que el cliente debe.
 */
export async function issueDebitNote(
  actor: AuthUser,
  input: DebitNoteInput,
  meta: RequestMeta = {},
) {
  requirePermission(actor, "billing:editar");
  const data = debitNoteSchema.parse(input);
  const tenantId = requireTenantId(actor);
  const created = await withTenant(tenantId, async (tx) => {
    const key = `nd:${data.idempotencyKey}`;
    const replay = await tx.fiscalDocument.findFirst({ where: { docKey: key } });
    if (replay) return replay;
    const original = await tx.fiscalDocument.findFirst({ where: { id: data.documentId } });
    if (!original || !original.saleId) throw new NotFoundError("Comprobante");
    if (
      original.status !== "ACCEPTED" ||
      (original.type !== "BOLETA" && original.type !== "FACTURA")
    ) {
      throw new ConflictError(
        "DOC_STATE",
        "La nota de débito se emite sobre una boleta o factura aceptada",
      );
    }
    const ctx = await taxContextOf(tx);
    const settings = await tx.tenantSettings.findFirstOrThrow();
    const rate = D(ctx.taxRate);
    const total = D(data.amount);
    const base = ctx.pricesIncludeTax ? total.div(rate.plus(1)).toDecimalPlaces(2) : total;
    const tax = ctx.pricesIncludeTax ? total.minus(base) : base.times(rate).toDecimalPlaces(2);
    const grandTotal = base.plus(tax);
    const line: DocumentLine = {
      code: null,
      description: data.description,
      unitCode: "ZZ",
      quantity: "1",
      unitValue: base.toFixed(2),
      unitPrice: grandTotal.toFixed(2),
      discount: "0.00",
      base: base.toFixed(2),
      tax: tax.toFixed(2),
      total: grandTotal.toFixed(2),
      affectation: "TAXED",
    };
    const snapshot = customerSnapshotSchema.parse(original.customerSnapshot);
    const doc = await createPendingDocument(tx, {
      type: "NOTA_DEBITO",
      saleId: original.saleId,
      related: {
        id: original.id,
        type: original.type as FiscalType,
        series: original.series,
        correlative: original.correlative,
      },
      docKey: key,
      series:
        original.type === "FACTURA"
          ? settings.debitNoteFacturaSeries
          : settings.debitNoteBoletaSeries,
      lines: [line],
      buyer: snapshot.buyer,
      isCredit: snapshot.isCredit,
      note: { reasonCode: data.reasonCode, reason: DEBIT_NOTE_REASONS[data.reasonCode] },
      issueDate: new Date(),
    });
    const receivable = await tx.receivable.findFirst({
      where: { saleId: original.saleId, status: { in: ["OPEN", "PARTIAL", "OVERDUE"] } },
    });
    if (receivable) {
      await tx.receivable.update({
        where: { id: receivable.id },
        data: {
          total: { increment: grandTotal.toFixed(2) },
          balance: { increment: grandTotal.toFixed(2) },
        },
      });
    }
    await recordAudit(tx, auditContextOf(actor, meta), {
      action: "billing.debit_note",
      entityType: "fiscal_document",
      entityId: doc.id,
      after: { relatedTo: original.id, total: grandTotal.toFixed(2), reason: data.reasonCode },
    });
    return doc;
  });
  const result = await dispatchDocument(tenantId, created.id).catch(() => "RETRY" as const);
  return {
    id: created.id,
    number: formatDocumentNumber(created.series, created.correlative),
    dispatch: result,
  };
}

// ---------------------------------------------------------------------------
// Consulta
// ---------------------------------------------------------------------------

export async function listDocuments(
  actor: AuthUser,
  filter: { status?: "PENDING" | "ACCEPTED" | "REJECTED" | "VOIDED"; limit?: number } = {},
) {
  requirePermission(actor, "billing:ver");
  return withTenant(requireTenantId(actor), async (tx) => {
    const rows = await tx.fiscalDocument.findMany({
      where: filter.status ? { status: filter.status } : {},
      include: { sale: { select: { number: true } } },
      orderBy: [{ createdAt: "desc" }],
      take: filter.limit ?? 100,
    });
    return rows.map((d) => ({
      id: d.id,
      type: d.type,
      number: formatDocumentNumber(d.series, d.correlative),
      saleNumber: d.sale?.number ?? null,
      total: d.total.toFixed(2),
      status: d.status,
      attempts: d.attempts,
      errorMessage: d.errorMessage,
      nextRetryAt: d.nextRetryAt,
      issueDate: d.issueDate,
      pdfUrl: d.pdfUrl,
      noteReason: d.noteReason,
    }));
  });
}

export const CREDIT_REASON_LABEL = CREDIT_NOTE_REASONS;
