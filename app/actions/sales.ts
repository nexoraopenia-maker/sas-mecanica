"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { runAction, field, type ActionState } from "@/lib/action";
import { requireTenantUser } from "@/lib/auth/guards";
import { DomainError, toDomainError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { getRequestMeta } from "@/lib/http";
import {
  issueDebitNote,
  retryDocument,
  resendDocument,
  updateInvoiceSettings,
} from "@/server/services/billing";
import { addCashMovement, closeCashSession, openCashSession } from "@/server/services/cash";
import { searchProducts } from "@/server/services/catalog";
import { searchCustomers } from "@/server/services/customers";
import {
  convertQuoteToSale,
  convertQuoteToWorkOrder,
  createQuote,
  setQuoteStatus,
} from "@/server/services/quotes";
import { collectReceivable } from "@/server/services/receivables";
import { setRoleDiscountLimit } from "@/server/services/roles";
import {
  convertWorkOrderToSale,
  createSale,
  previewSale,
  returnSale,
  voidSale,
} from "@/server/services/sales";
import { findVehicleByPlate } from "@/server/services/vehicles";
import { z } from "zod";

const opt = (formData: FormData, name: string): string | undefined =>
  field(formData, name).trim() || undefined;
const checked = (formData: FormData, name: string): boolean => formData.get(name) === "on";

/** Los errores de las consultas del mostrador se devuelven como texto; nunca se filtra un error crudo. */
function messageOf(error: unknown): string {
  if (error instanceof z.ZodError) return error.issues[0]?.message ?? "Datos inválidos";
  const mapped = toDomainError(error);
  if (mapped instanceof DomainError) return mapped.message;
  logger.error({ err: error }, "error inesperado en una consulta del mostrador");
  return "Ocurrió un error inesperado. Inténtalo de nuevo.";
}

// ---------------------------------------------------------------------------
// Consultas del mostrador (las llama el cliente mientras el cajero trabaja)
// ---------------------------------------------------------------------------

export interface PosProduct {
  id: string;
  sku: string;
  name: string;
  kind: string;
  brand: string | null;
  salePrice: string;
  stock: number | null;
  trackingMode: "NONE" | "LOT" | "SERIAL";
  isStocked: boolean;
}

export async function posSearchAction(query: {
  q?: string;
  tireSize?: string;
  make?: string;
  model?: string;
}): Promise<{ products: PosProduct[]; error?: string }> {
  try {
    const user = await requireTenantUser();
    const products = await searchProducts(user, {
      q: query.q?.trim() || undefined,
      tireSize: query.tireSize?.trim() || undefined,
      vehicle: query.make?.trim()
        ? { make: query.make.trim(), model: query.model?.trim() || undefined }
        : undefined,
      limit: 30,
    });
    return {
      products: products.map((p) => ({
        id: p.id,
        sku: p.sku,
        name: p.name,
        kind: p.kind,
        brand: p.brand,
        salePrice: p.salePrice,
        stock: p.stock ?? null,
        trackingMode: p.trackingMode,
        isStocked: p.isStocked,
      })),
    };
  } catch (error) {
    return { products: [], error: messageOf(error) };
  }
}

export async function posCustomerSearchAction(q: string): Promise<{
  customers: Array<{
    id: string;
    name: string;
    docType: string;
    docNumber: string | null;
    plates: string[];
  }>;
  error?: string;
}> {
  try {
    const rows = await searchCustomers(await requireTenantUser(), q, 8);
    return {
      customers: rows.map((c) => ({
        id: c.id,
        name: c.name,
        docType: c.docType,
        docNumber: c.docNumber,
        plates: c.vehicles.map((v) => v.plate),
      })),
    };
  } catch (error) {
    return { customers: [], error: messageOf(error) };
  }
}

/** Placa → cliente y vehículo, para facturar al dueño y buscar repuestos compatibles. */
export async function posPlateAction(plate: string): Promise<{
  found: null | {
    vehicleId: string;
    plate: string;
    make: string | null;
    model: string | null;
    customer: { id: string; name: string; docType: string; docNumber: string | null };
  };
  error?: string;
}> {
  try {
    const vehicle = await findVehicleByPlate(await requireTenantUser(), plate);
    if (!vehicle) return { found: null };
    return {
      found: {
        vehicleId: vehicle.id,
        plate: vehicle.plate,
        make: vehicle.make,
        model: vehicle.model,
        customer: {
          id: vehicle.customer.id,
          name: vehicle.customer.name,
          docType: vehicle.customer.docType,
          docNumber: vehicle.customer.docNumber,
        },
      },
    };
  } catch (error) {
    return { found: null, error: messageOf(error) };
  }
}

export async function posPreviewAction(items: unknown): Promise<{
  totals?: { subtotal: string; tax: string; total: string; discount: string };
  lines?: Array<{ lineTotal: string; unitPrice: string }>;
  error?: string;
}> {
  try {
    const result = await previewSale(await requireTenantUser(), items as never);
    return {
      totals: {
        subtotal: result.totals.subtotal,
        tax: result.totals.tax,
        total: result.totals.total,
        discount: result.totals.discount,
      },
      lines: result.lines.map((l) => ({ lineTotal: l.lineTotal, unitPrice: l.unitPrice })),
    };
  } catch (error) {
    return { error: messageOf(error) };
  }
}

/** Cobra y registra la venta. El cliente manda una clave de idempotencia: un doble clic no vende dos veces. */
export async function createSaleAction(payload: unknown): Promise<ActionState> {
  return runAction(async () => {
    const result = await createSale(
      await requireTenantUser(),
      payload as never,
      await getRequestMeta(),
    );
    revalidatePath("/app/sales");
    return { redirectTo: `/app/sales/${result.id}?nueva=1` };
  });
}

// ---------------------------------------------------------------------------
// Caja
// ---------------------------------------------------------------------------

export async function openCashAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  return runAction(async () => {
    await openCashSession(
      await requireTenantUser(),
      { openingAmount: field(formData, "openingAmount") || "0" },
      await getRequestMeta(),
    );
    revalidatePath("/app/cash");
    revalidatePath("/app/pos");
    return { redirectTo: "/app/pos" };
  });
}

export async function cashMovementAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  return runAction(async () => {
    await addCashMovement(
      await requireTenantUser(),
      {
        type: field(formData, "type") === "INCOME" ? "INCOME" : "EXPENSE",
        amount: field(formData, "amount"),
        reason: field(formData, "reason"),
      },
      await getRequestMeta(),
    );
    revalidatePath("/app/cash");
    return { message: "Movimiento registrado." };
  });
}

export async function closeCashAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  return runAction(async () => {
    const counted: Record<string, string> = { CASH: field(formData, "CASH") };
    for (const method of ["CARD", "TRANSFER", "YAPE", "PLIN", "OTHER"]) {
      const value = opt(formData, method);
      if (value !== undefined) counted[method] = value;
    }
    const result = await closeCashSession(
      await requireTenantUser(),
      {
        sessionId: field(formData, "sessionId"),
        counted: counted as never,
        notes: opt(formData, "notes"),
      },
      await getRequestMeta(),
    );
    revalidatePath("/app/cash");
    return { redirectTo: `/app/cash?cerrada=1&dif=${encodeURIComponent(result.totalDifference)}` };
  });
}

// ---------------------------------------------------------------------------
// Ventas: anular, devolver, facturar una OT
// ---------------------------------------------------------------------------

export async function voidSaleAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  return runAction(async () => {
    const id = field(formData, "saleId");
    await voidSale(
      await requireTenantUser(),
      { saleId: id, reason: field(formData, "reason") },
      await getRequestMeta(),
    );
    revalidatePath(`/app/sales/${id}`);
    return { redirectTo: `/app/sales/${id}?anulada=1` };
  });
}

export async function returnSaleAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  return runAction(async () => {
    const id = field(formData, "saleId");
    const items = [...formData.entries()]
      .filter(
        ([name, value]) =>
          name.startsWith("qty_") && typeof value === "string" && Number(value) > 0,
      )
      .map(([name, value]) => ({
        saleItemId: name.slice(4),
        quantity: String(value),
        restock: formData.get(`restock_${name.slice(4)}`) === "on",
      }));
    const result = await returnSale(
      await requireTenantUser(),
      {
        saleId: id,
        idempotencyKey: field(formData, "idempotencyKey"),
        reason: field(formData, "reason"),
        resolution: field(formData, "resolution") === "CREDIT_NOTE" ? "CREDIT_NOTE" : "REFUND",
        refundMethod: (field(formData, "refundMethod") || "CASH") as "CASH",
        items,
      },
      await getRequestMeta(),
    );
    revalidatePath(`/app/sales/${id}`);
    return { redirectTo: `/app/sales/${id}?devolucion=${result.number}` };
  });
}

export async function convertWorkOrderAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  return runAction(async () => {
    const isCredit = field(formData, "terms") === "CREDIT";
    // Al contado, un monto vacío significa «el total de la orden»; a crédito, vacío = todo a crédito (anticipo opcional).
    const amount = field(formData, "amount").trim() || (isCredit ? "" : field(formData, "total"));
    const days = field(formData, "creditDays").trim();
    const result = await convertWorkOrderToSale(
      await requireTenantUser(),
      {
        workOrderId: field(formData, "workOrderId"),
        idempotencyKey: field(formData, "idempotencyKey"),
        documentType: (field(formData, "documentType") || "BOLETA") as "BOLETA",
        isCredit,
        ...(isCredit && days ? { creditDays: days as never } : {}),
        payments:
          amount && Number(amount) > 0
            ? [{ method: (field(formData, "method") || "CASH") as "CASH", amount }]
            : [],
      },
      await getRequestMeta(),
    );
    revalidatePath("/app/workshop");
    revalidatePath("/app/receivables");
    return { redirectTo: `/app/sales/${result.id}?nueva=1` };
  });
}

// ---------------------------------------------------------------------------
// Cotizaciones
// ---------------------------------------------------------------------------

export async function createQuoteAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  return runAction(async () => {
    const items = [];
    for (let i = 0; i < 8; i += 1) {
      const productId = opt(formData, `productId_${i}`);
      const description = opt(formData, `description_${i}`);
      if (!productId && !description) continue;
      items.push({
        productId,
        description,
        quantity: field(formData, `quantity_${i}`) || "1",
        unitPrice: productId ? undefined : opt(formData, `unitPrice_${i}`),
        discount: opt(formData, `discount_${i}`) ?? "0",
        isLabor: checked(formData, `labor_${i}`),
      });
    }
    const created = await createQuote(
      await requireTenantUser(),
      {
        customerId: opt(formData, "customerId"),
        vehicleId: opt(formData, "vehicleId"),
        validDays: field(formData, "validDays") || "7",
        notes: opt(formData, "notes"),
        items,
      },
      await getRequestMeta(),
    );
    revalidatePath("/app/quotes");
    return { redirectTo: `/app/quotes/${created.id}` };
  });
}

export async function quoteStatusAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  return runAction(async () => {
    const id = field(formData, "quoteId");
    const status = field(formData, "status");
    await setQuoteStatus(
      await requireTenantUser(),
      id,
      status === "ACCEPTED" ? "ACCEPTED" : status === "REJECTED" ? "REJECTED" : "SENT",
      await getRequestMeta(),
    );
    revalidatePath(`/app/quotes/${id}`);
    return { message: "Estado actualizado." };
  });
}

export async function quoteToSaleAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  return runAction(async () => {
    const lines = [...formData.entries()]
      .filter(
        ([name, value]) =>
          name.startsWith("serials_") && typeof value === "string" && value.trim() !== "",
      )
      .map(([name, value]) => ({
        quoteItemId: name.slice(8),
        serials: String(value)
          .split(/\r?\n/)
          .map((s) => s.trim())
          .filter(Boolean),
      }));
    const amount = field(formData, "amount");
    const result = await convertQuoteToSale(
      await requireTenantUser(),
      {
        quoteId: field(formData, "quoteId"),
        idempotencyKey: field(formData, "idempotencyKey"),
        documentType: (field(formData, "documentType") || "BOLETA") as "BOLETA",
        isCredit: checked(formData, "isCredit"),
        payments:
          amount && Number(amount) > 0
            ? [{ method: (field(formData, "method") || "CASH") as "CASH", amount }]
            : [],
        lines,
      },
      await getRequestMeta(),
    );
    revalidatePath("/app/quotes");
    return { redirectTo: `/app/sales/${result.id}?nueva=1` };
  });
}

export async function quoteToWorkOrderAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  return runAction(async () => {
    const order = await convertQuoteToWorkOrder(
      await requireTenantUser(),
      {
        quoteId: field(formData, "quoteId"),
        mileageIn: field(formData, "mileageIn"),
        fuelLevelEighths: field(formData, "fuel") || "4",
      },
      await getRequestMeta(),
    );
    revalidatePath("/app/quotes");
    return { redirectTo: `/app/workshop/${order.id}` };
  });
}

// ---------------------------------------------------------------------------
// Cuentas por cobrar y facturación
// ---------------------------------------------------------------------------

export async function collectReceivableAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  return runAction(async () => {
    const result = await collectReceivable(
      await requireTenantUser(),
      {
        receivableId: field(formData, "receivableId"),
        idempotencyKey: field(formData, "idempotencyKey") || randomUUID(),
        method: (field(formData, "method") || "CASH") as "CASH",
        amount: field(formData, "amount"),
        reference: opt(formData, "reference"),
      },
      await getRequestMeta(),
    );
    revalidatePath("/app/receivables");
    return { redirectTo: `/app/receivables?cobrado=${encodeURIComponent(result.balance)}` };
  });
}

export async function retryDocumentAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  return runAction(async () => {
    const result = await retryDocument(
      await requireTenantUser(),
      field(formData, "documentId"),
      await getRequestMeta(),
    );
    revalidatePath("/app/billing");
    return {
      message:
        result === "ACCEPTED"
          ? "Comprobante aceptado."
          : result === "REJECTED"
            ? "El proveedor lo rechazó otra vez: revisa el detalle."
            : "Quedó en cola; se reintentará automáticamente.",
    };
  });
}

export async function resendDocumentAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  return runAction(async () => {
    const result = await resendDocument(
      await requireTenantUser(),
      field(formData, "documentId"),
      await getRequestMeta(),
    );
    revalidatePath("/app/billing");
    return {
      message:
        result === "QUEUED" || result === "SIMULATED"
          ? "Comprobante enviado al cliente."
          : "El cliente no tiene consentimiento o número de WhatsApp.",
    };
  });
}

export async function debitNoteAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  return runAction(async () => {
    const result = await issueDebitNote(
      await requireTenantUser(),
      {
        documentId: field(formData, "documentId"),
        idempotencyKey: field(formData, "idempotencyKey") || randomUUID(),
        reasonCode: (field(formData, "reasonCode") || "01") as "01",
        description: field(formData, "description"),
        amount: field(formData, "amount"),
      },
      await getRequestMeta(),
    );
    revalidatePath("/app/billing");
    return { message: `Nota de débito ${result.number} emitida.` };
  });
}

export async function updateInvoiceSettingsAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  return runAction(async () => {
    await updateInvoiceSettings(
      await requireTenantUser(),
      {
        provider: (field(formData, "provider") || "NONE") as "NONE",
        baseUrl: opt(formData, "baseUrl"),
        token: opt(formData, "token"),
        clearToken: checked(formData, "clearToken"),
        boletaSeries: field(formData, "boletaSeries"),
        facturaSeries: field(formData, "facturaSeries"),
        creditNoteBoletaSeries: field(formData, "creditNoteBoletaSeries"),
        creditNoteFacturaSeries: field(formData, "creditNoteFacturaSeries"),
        debitNoteBoletaSeries: field(formData, "debitNoteBoletaSeries"),
        debitNoteFacturaSeries: field(formData, "debitNoteFacturaSeries"),
        saleNoteSeries: field(formData, "saleNoteSeries"),
        defaultCreditDays: field(formData, "defaultCreditDays"),
        cashTolerance: field(formData, "cashTolerance"),
      },
      await getRequestMeta(),
    );
    revalidatePath("/app/billing");
    return { message: "Configuración de facturación guardada." };
  });
}

export async function roleDiscountAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  return runAction(async () => {
    await setRoleDiscountLimit(
      await requireTenantUser(),
      field(formData, "roleId"),
      field(formData, "percent"),
      await getRequestMeta(),
    );
    revalidatePath("/app/roles");
    return { message: "Límite de descuento guardado." };
  });
}
