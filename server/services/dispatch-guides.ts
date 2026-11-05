import { requirePermission, requireTenantId, type AuthUser } from "@/lib/auth/can";
import { nextSequence, withTenant, type TenantTx } from "@/lib/db";
import { ConflictError, NotFoundError } from "@/lib/errors";
import { formatDocumentNumber } from "@/lib/billing/sunat";
import { DISPATCH_MODE_CODE, DISPATCH_REASON_CODE, normalizePlate } from "@/lib/dispatch/sunat";
import {
  createDispatchGuideSchema,
  voidDispatchGuideSchema,
  type CreateDispatchGuideInput,
} from "@/lib/validation/dispatch";
import { normalizeDocument } from "@/lib/workshop/documents";
import {
  buildDispatchProvider,
  type DispatchPayload,
} from "@/server/integrations/dispatch-provider";
import { auditContextOf, recordAudit, type RequestMeta } from "./audit";
import { issuerOf } from "./billing";

const DOC_TYPE = "GRE";

export interface DispatchGuideSummary {
  id: string;
  number: string;
  issueDate: Date;
  transferDate: Date;
  reason: string;
  recipientName: string;
  status: "PENDING" | "ACCEPTED" | "REJECTED" | "VOIDED";
  grossWeightKg: string;
}

/**
 * Emite una Guía de Remisión Electrónica remitente: valida lo que exige SUNAT, toma el correlativo de la
 * serie y la envía al proveedor. Una guía no mueve stock (las transferencias se registran en Inventario).
 * Con proveedor simulado (demo/sandbox) queda aceptada; con un OSE real queda pendiente de envío.
 */
export async function createDispatchGuide(
  actor: AuthUser,
  input: CreateDispatchGuideInput,
  meta: RequestMeta = {},
) {
  requirePermission(actor, "billing:crear");
  const data = createDispatchGuideSchema.parse(input);
  const tenantId = requireTenantId(actor);

  return withTenant(tenantId, async (tx) => {
    const issuer = await issuerOf(tx);
    const tenant = await tx.tenant.findFirstOrThrow({ select: { isDemo: true } });
    const settings = await tx.tenantSettings.findFirstOrThrow({
      select: { invoiceProvider: true },
    });

    const recipientDoc = normalizeDocument(data.recipientDocType, data.recipientDocNumber);
    if (data.reason === "TRANSFER_BETWEEN_ESTABLISHMENTS" && recipientDoc !== issuer.ruc)
      throw new ConflictError(
        "GRE_TRANSFER_RECIPIENT",
        "En un traslado entre establecimientos el destinatario debe ser tu propia empresa (tu RUC)",
      );

    if (
      data.saleId &&
      !(await tx.sale.findFirst({ where: { id: data.saleId }, select: { id: true } }))
    )
      throw new NotFoundError("Venta");
    if (
      data.transferId &&
      !(await tx.stockTransfer.findFirst({ where: { id: data.transferId }, select: { id: true } }))
    )
      throw new NotFoundError("Transferencia");

    const productIds = [
      ...new Set(data.items.flatMap((item) => (item.productId ? [item.productId] : []))),
    ];
    const products = await tx.product.findMany({
      where: { id: { in: productIds } },
      select: { id: true, sku: true },
    });
    if (products.length !== productIds.length) throw new NotFoundError("Producto");
    const skuOf = new Map(products.map((product) => [product.id, product.sku]));

    const issueDate = data.issueDate ?? new Date();
    const correlative = await nextSequence(tx, DOC_TYPE, data.series);
    const isPublic = data.transportMode === "PUBLIC";
    const plate = data.vehiclePlate ? normalizePlate(data.vehiclePlate) : null;

    const payload: DispatchPayload = {
      issuerRuc: issuer.ruc,
      series: data.series,
      correlative,
      issueDate: issueDate.toISOString().slice(0, 10),
      transferDate: data.transferDate.toISOString().slice(0, 10),
      reasonCode: DISPATCH_REASON_CODE[data.reason],
      reasonNote: data.reasonNote ?? null,
      transportModeCode: DISPATCH_MODE_CODE[data.transportMode],
      grossWeightKg: data.grossWeightKg,
      packages: data.packages ?? null,
      origin: { address: data.originAddress, ubigeo: data.originUbigeo },
      destination: { address: data.destinationAddress, ubigeo: data.destinationUbigeo },
      recipient: {
        docType: data.recipientDocType,
        docNumber: recipientDoc,
        name: data.recipientName,
      },
      carrier: isPublic
        ? {
            ruc: normalizeDocument("RUC", data.carrierDocNumber ?? ""),
            name: data.carrierName ?? "",
          }
        : null,
      driver: isPublic
        ? null
        : {
            dni: data.driverDocNumber ?? "",
            name: data.driverName ?? "",
            license: data.driverLicense?.replace(/[\s-]/g, "").toUpperCase() ?? null,
          },
      vehiclePlate: plate,
      items: data.items.map((item) => ({
        description: item.description,
        sku: item.sku ?? (item.productId ? (skuOf.get(item.productId) ?? null) : null),
        unit: item.unit,
        quantity: item.quantity,
      })),
    };

    // Con un OSE real todavía no hay adaptador de GRE: la guía queda registrada y pendiente de envío.
    const simulated = tenant.isDemo || settings.invoiceProvider === "SIMULATED";
    const outcome = simulated ? await buildDispatchProvider().submit(payload) : null;

    const guide = await tx.dispatchGuide.create({
      data: {
        series: data.series,
        correlative,
        issueDate,
        transferDate: data.transferDate,
        reason: data.reason,
        reasonNote: data.reasonNote ?? null,
        transportMode: data.transportMode,
        carrierDocType: isPublic ? "RUC" : null,
        carrierDocNumber: payload.carrier?.ruc ?? null,
        carrierName: payload.carrier?.name ?? null,
        driverDocNumber: payload.driver?.dni ?? null,
        driverName: payload.driver?.name ?? null,
        driverLicense: payload.driver?.license ?? null,
        vehiclePlate: plate,
        grossWeightKg: data.grossWeightKg,
        packages: data.packages ?? null,
        originAddress: data.originAddress,
        originUbigeo: data.originUbigeo,
        destinationAddress: data.destinationAddress,
        destinationUbigeo: data.destinationUbigeo,
        recipientDocType: data.recipientDocType,
        recipientDocNumber: recipientDoc,
        recipientName: data.recipientName,
        saleId: data.saleId ?? null,
        transferId: data.transferId ?? null,
        relatedDocument: data.relatedDocument ?? null,
        status: outcome ? outcome.outcome : "PENDING",
        providerRef: outcome?.providerRef ?? null,
        hash: outcome?.hash ?? null,
        errorMessage: outcome?.outcome === "REJECTED" ? (outcome.message ?? outcome.code) : null,
        createdById: actor.userId,
        items: {
          create: data.items.map((item, index) => ({
            productId: item.productId ?? null,
            description: item.description,
            sku: payload.items[index]?.sku ?? null,
            unit: item.unit,
            quantity: item.quantity,
          })),
        },
      },
    });
    await recordAudit(tx, auditContextOf(actor, meta), {
      action: "dispatch_guide.created",
      entityType: "dispatch_guide",
      entityId: guide.id,
      after: {
        number: formatDocumentNumber(guide.series, guide.correlative),
        reason: guide.reason,
        transportMode: guide.transportMode,
        status: guide.status,
        items: data.items.length,
        grossWeightKg: guide.grossWeightKg.toString(),
      },
    });
    return {
      id: guide.id,
      number: formatDocumentNumber(guide.series, guide.correlative),
      status: guide.status,
    };
  });
}

export async function listDispatchGuides(actor: AuthUser): Promise<DispatchGuideSummary[]> {
  requirePermission(actor, "billing:ver");
  return withTenant(requireTenantId(actor), async (tx) => {
    const rows = await tx.dispatchGuide.findMany({
      orderBy: [{ createdAt: "desc" }],
      take: 100,
    });
    return rows.map((row) => ({
      id: row.id,
      number: formatDocumentNumber(row.series, row.correlative),
      issueDate: row.issueDate,
      transferDate: row.transferDate,
      reason: row.reason,
      recipientName: row.recipientName,
      status: row.status,
      grossWeightKg: row.grossWeightKg.toString(),
    }));
  });
}

export async function getDispatchGuide(actor: AuthUser, guideId: string) {
  requirePermission(actor, "billing:ver");
  return withTenant(requireTenantId(actor), async (tx) => {
    const guide = await tx.dispatchGuide.findFirst({
      where: { id: guideId },
      include: { items: true },
    });
    if (!guide) throw new NotFoundError("Guía de remisión");
    const tenant = await tx.tenant.findFirstOrThrow({
      select: { legalName: true, tradeName: true, taxId: true, isDemo: true },
    });
    return {
      ...guide,
      number: formatDocumentNumber(guide.series, guide.correlative),
      issuer: { name: tenant.tradeName ?? tenant.legalName, ruc: tenant.taxId },
    };
  });
}

/** Anula una guía que aún no fue anulada (queda el registro y el motivo en auditoría). */
export async function voidDispatchGuide(
  actor: AuthUser,
  input: { guideId: string; reason: string },
  meta: RequestMeta = {},
) {
  requirePermission(actor, "billing:editar");
  const data = voidDispatchGuideSchema.parse(input);
  return withTenant(requireTenantId(actor), async (tx) => {
    const guide = await tx.dispatchGuide.findFirst({ where: { id: data.guideId } });
    if (!guide) throw new NotFoundError("Guía de remisión");
    if (guide.status === "VOIDED")
      throw new ConflictError("GRE_ALREADY_VOIDED", "La guía ya está anulada");
    await tx.dispatchGuide.update({
      where: { id: guide.id },
      data: { status: "VOIDED", voidedAt: new Date(), voidReason: data.reason },
    });
    await recordAudit(tx, auditContextOf(actor, meta), {
      action: "dispatch_guide.voided",
      entityType: "dispatch_guide",
      entityId: guide.id,
      before: { status: guide.status },
      after: { status: "VOIDED", reason: data.reason },
    });
    return { id: guide.id };
  });
}

// ---------------------------------------------------------------------------
// Borradores desde una venta o una transferencia
// ---------------------------------------------------------------------------

export interface GuideDraft {
  reason: "SALE" | "TRANSFER_BETWEEN_ESTABLISHMENTS";
  saleId?: string;
  transferId?: string;
  relatedDocument?: string;
  originAddress: string;
  destinationAddress: string;
  recipientDocType: "DNI" | "RUC" | "CE" | "PASSPORT" | "OTHER";
  recipientDocNumber: string;
  recipientName: string;
  items: Array<{
    productId?: string;
    description: string;
    sku?: string;
    quantity: string;
    unit: string;
  }>;
}

async function tenantAddress(tx: TenantTx) {
  const tenant = await tx.tenant.findFirstOrThrow({
    select: { legalName: true, taxId: true, address: true },
  });
  return tenant;
}

/** Datos de una venta para precargar la guía (el usuario completa transporte, peso y UBIGEO). */
export async function draftFromSale(actor: AuthUser, saleId: string): Promise<GuideDraft> {
  requirePermission(actor, "billing:ver");
  return withTenant(requireTenantId(actor), async (tx) => {
    const sale = await tx.sale.findFirst({
      where: { id: saleId, status: "COMPLETED" },
      include: {
        items: { include: { product: { select: { sku: true, isStocked: true } } } },
        customer: true,
        branch: { select: { address: true } },
      },
    });
    if (!sale) throw new NotFoundError("Venta");
    const tenant = await tenantAddress(tx);
    return {
      reason: "SALE",
      saleId: sale.id,
      relatedDocument: `Venta N.º ${sale.number}`,
      originAddress: sale.branch.address ?? tenant.address ?? "",
      destinationAddress: sale.customer?.address ?? "",
      recipientDocType: sale.customer?.docType ?? "DNI",
      recipientDocNumber: sale.customer?.docNumber ?? "",
      recipientName: sale.customer?.name ?? "",
      items: sale.items
        .filter((item) => item.product?.isStocked !== false)
        .map((item) => ({
          productId: item.productId ?? undefined,
          description: item.description,
          sku: item.product?.sku ?? undefined,
          quantity: item.quantity.toString(),
          unit: "UND",
        })),
    };
  });
}

/** Datos de una transferencia entre almacenes para precargar la guía (el destinatario es la propia empresa). */
export async function draftFromTransfer(actor: AuthUser, transferId: string): Promise<GuideDraft> {
  requirePermission(actor, "billing:ver");
  return withTenant(requireTenantId(actor), async (tx) => {
    const transfer = await tx.stockTransfer.findFirst({
      where: { id: transferId },
      include: {
        items: { include: { product: { select: { name: true, sku: true } } } },
        fromWarehouse: { include: { branch: { select: { address: true } } } },
        toWarehouse: { include: { branch: { select: { address: true } } } },
      },
    });
    if (!transfer) throw new NotFoundError("Transferencia");
    const tenant = await tenantAddress(tx);
    return {
      reason: "TRANSFER_BETWEEN_ESTABLISHMENTS",
      transferId: transfer.id,
      relatedDocument: `Transferencia N.º ${transfer.number}`,
      originAddress: transfer.fromWarehouse.branch.address ?? tenant.address ?? "",
      destinationAddress: transfer.toWarehouse.branch.address ?? tenant.address ?? "",
      recipientDocType: "RUC",
      recipientDocNumber: tenant.taxId ?? "",
      recipientName: tenant.legalName,
      items: transfer.items.map((item) => ({
        productId: item.productId,
        description: item.product.name,
        sku: item.product.sku,
        quantity: item.qtyRequested.toString(),
        unit: "UND",
      })),
    };
  });
}

/** Ventas y transferencias recientes para elegir el origen de la guía. */
export async function listGuideSources(actor: AuthUser) {
  requirePermission(actor, "billing:ver");
  return withTenant(requireTenantId(actor), async (tx) => {
    const [sales, transfers] = await Promise.all([
      tx.sale.findMany({
        where: { status: "COMPLETED" },
        orderBy: { createdAt: "desc" },
        take: 20,
        select: { id: true, number: true, total: true, customer: { select: { name: true } } },
      }),
      tx.stockTransfer.findMany({
        where: { status: { in: ["REQUESTED", "IN_TRANSIT"] } },
        orderBy: { createdAt: "desc" },
        take: 20,
        select: {
          id: true,
          number: true,
          fromWarehouse: { select: { name: true } },
          toWarehouse: { select: { name: true } },
        },
      }),
    ]);
    return {
      sales: sales.map((sale) => ({
        id: sale.id,
        label: `N.º ${sale.number} · ${sale.customer?.name ?? "Cliente varios"} · S/ ${Number(sale.total).toFixed(2)}`,
      })),
      transfers: transfers.map((transfer) => ({
        id: transfer.id,
        label: `N.º ${transfer.number} · ${transfer.fromWarehouse.name} → ${transfer.toWarehouse.name}`,
      })),
    };
  });
}
