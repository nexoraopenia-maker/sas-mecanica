import { can, requirePermission, requireTenantId, type AuthUser } from "@/lib/auth/can";
import { withTenant, type TenantTx } from "@/lib/db";
import { VIOLATION_LABELS, type GuardrailViolation } from "@/lib/ai/guardrails";
import { ConflictError, NotFoundError } from "@/lib/errors";
import { approveDraftSchema } from "@/lib/validation/purchasing";
import { z } from "zod";
import { auditContextOf, recordAudit, type AuditContext, type RequestMeta } from "./audit";
import { dispatchOrderToSupplier, insertPurchaseOrder } from "./purchasing";

const violationList = (value: unknown): GuardrailViolation[] =>
  Array.isArray(value)
    ? (value.filter(
        (v): v is GuardrailViolation => typeof v === "string" && v in VIOLATION_LABELS,
      ) as GuardrailViolation[])
    : [];

export interface ApprovedDraft {
  purchaseOrderId: string;
  number: number;
  delivery: string;
  replayed: boolean;
}

/**
 * "Aprobar y enviar": crea la orden de compra (Solicitado), la envía al proveedor y cierra el
 * borrador. Atómico e idempotente: el borrador se RECLAMA con un UPDATE condicional, así dos
 * clics (o dos aprobadores) generan una sola orden. Si el borrador excede algún guardrail,
 * exige la confirmación humana explícita.
 */
export async function approveDraftInTx(
  tx: TenantTx,
  params: {
    draftId: string;
    approvedById: string | null;
    confirmViolations: boolean;
    auto: boolean;
    context: AuditContext;
  },
): Promise<ApprovedDraft> {
  const draft = await tx.aiOrderDraft.findFirst({
    where: { id: params.draftId },
    include: { items: true, supplier: { select: { isActive: true, name: true } } },
  });
  if (!draft) throw new NotFoundError("Borrador");
  if ((draft.status === "SENT" || draft.status === "APPROVED") && draft.purchaseOrderId) {
    const existing = await tx.purchaseOrder.findFirstOrThrow({
      where: { id: draft.purchaseOrderId },
    });
    return {
      purchaseOrderId: existing.id,
      number: existing.number,
      delivery: "REPLAY",
      replayed: true,
    };
  }
  if (draft.status !== "PENDING")
    throw new ConflictError(
      "DRAFT_STATE",
      `El borrador ya fue ${draft.status === "REJECTED" ? "rechazado" : "procesado"}`,
    );

  const violations = violationList(draft.guardrailViolations);
  if (violations.length > 0) {
    if (params.auto)
      throw new ConflictError(
        "CONFIRMATION_REQUIRED",
        "Un pedido con guardrails excedidos nunca se envía automáticamente",
      );
    if (!params.confirmViolations) {
      throw new ConflictError(
        "CONFIRMATION_REQUIRED",
        `Requiere tu confirmación: ${violations.map((v) => VIOLATION_LABELS[v]).join("; ")}`,
      );
    }
  }
  if (!draft.supplier.isActive)
    throw new ConflictError("SUPPLIER_INACTIVE", "El proveedor ya no está activo");

  const claimed = await tx.aiOrderDraft.updateMany({
    where: { id: draft.id, status: "PENDING" },
    data: { status: "APPROVED", decidedById: params.approvedById, decidedAt: new Date() },
  });
  if (claimed.count !== 1) {
    const current = await tx.aiOrderDraft.findFirstOrThrow({ where: { id: draft.id } });
    if (current.purchaseOrderId) {
      const existing = await tx.purchaseOrder.findFirstOrThrow({
        where: { id: current.purchaseOrderId },
      });
      return {
        purchaseOrderId: existing.id,
        number: existing.number,
        delivery: "REPLAY",
        replayed: true,
      };
    }
    throw new ConflictError("DRAFT_STATE", "El borrador ya fue procesado");
  }

  const warehouse =
    (await tx.warehouse.findFirst({ where: { isDefault: true, isActive: true } })) ??
    (await tx.warehouse.findFirst({ where: { isActive: true }, orderBy: { code: "asc" } }));
  if (!warehouse) throw new NotFoundError("Almacén");
  const order = await insertPurchaseOrder(tx, {
    supplierId: draft.supplierId,
    warehouseId: warehouse.id,
    items: draft.items.map((item) => ({
      productId: item.productId,
      quantity: item.quantity.toString(),
      unitCost: item.unitPrice.toString(),
    })),
    origin: "AI",
    status: "REQUESTED",
    idempotencyKey: `po-${draft.idempotencyKey}`,
    aiRunId: draft.aiRunId,
    createdById: params.approvedById,
    approvedById: params.approvedById,
  });
  const intro = draft.messageDraft.split("\n")[0];
  const sent = await dispatchOrderToSupplier(tx, order.id, intro);
  await tx.aiOrderDraft.update({
    where: { id: draft.id },
    data: { status: "SENT", purchaseOrderId: order.id },
  });
  await recordAudit(tx, params.context, {
    action: params.auto ? "ai.order_auto_sent" : "ai.order_approved",
    entityType: "ai_order_draft",
    entityId: draft.id,
    after: {
      purchaseOrderId: order.id,
      number: order.number,
      total: order.total.toString(),
      supplier: draft.supplier.name,
      delivery: sent.status,
    },
    ...(violations.length > 0
      ? { reason: `Guardrails confirmados por un humano: ${violations.join(", ")}` }
      : {}),
  });
  return {
    purchaseOrderId: order.id,
    number: order.number,
    delivery: sent.status,
    replayed: false,
  };
}

export async function approveDraft(
  actor: AuthUser,
  input: z.input<typeof approveDraftSchema>,
  meta: RequestMeta = {},
): Promise<ApprovedDraft> {
  requirePermission(actor, "ai_agent:autorizar_pedidos_ia");
  requirePermission(actor, "purchasing:crear");
  const data = approveDraftSchema.parse(input);
  return withTenant(requireTenantId(actor), (tx) =>
    approveDraftInTx(tx, {
      draftId: data.draftId,
      approvedById: actor.userId,
      confirmViolations: data.confirmViolations,
      auto: false,
      context: auditContextOf(actor, meta),
    }),
  );
}

export async function rejectDraft(
  actor: AuthUser,
  draftId: string,
  reason: string,
  meta: RequestMeta = {},
): Promise<void> {
  requirePermission(actor, "ai_agent:autorizar_pedidos_ia");
  const cleaned = z.string().trim().min(5, "Indica el motivo del rechazo").max(300).parse(reason);
  await withTenant(requireTenantId(actor), async (tx) => {
    const result = await tx.aiOrderDraft.updateMany({
      where: { id: draftId, status: "PENDING" },
      data: { status: "REJECTED", decidedById: actor.userId, decidedAt: new Date() },
    });
    if (result.count !== 1) throw new ConflictError("DRAFT_STATE", "El borrador ya fue procesado");
    await recordAudit(tx, auditContextOf(actor, meta), {
      action: "ai.order_rejected",
      entityType: "ai_order_draft",
      entityId: draftId,
      reason: cleaned,
    });
  });
}

/** Bandeja de IA: borradores con proveedor, líneas, justificación y guardrails excedidos. */
export async function listDrafts(actor: AuthUser, status: "PENDING" | "ALL" = "PENDING") {
  requirePermission(actor, "ai_agent:ver");
  const canSeeCost = can(actor, "purchasing:ver_costos_compra");
  const rows = await withTenant(requireTenantId(actor), (tx) =>
    tx.aiOrderDraft.findMany({
      where: status === "PENDING" ? { status: "PENDING" } : {},
      include: {
        supplier: { select: { name: true, aiWhitelisted: true } },
        items: { include: { product: { select: { sku: true, name: true } } } },
        aiRun: { select: { model: true, simulated: true, startedAt: true } },
      },
      orderBy: { createdAt: "desc" },
      take: 100,
    }),
  );
  return rows.map((draft) => ({
    id: draft.id,
    status: draft.status,
    supplier: draft.supplier.name,
    supplierId: draft.supplierId,
    whitelisted: draft.supplier.aiWhitelisted,
    requiresHuman: draft.requiresHuman,
    violations: violationList(draft.guardrailViolations),
    message: draft.messageDraft,
    createdAt: draft.createdAt,
    simulated: draft.aiRun.simulated,
    model: draft.aiRun.model,
    purchaseOrderId: draft.purchaseOrderId,
    ...(canSeeCost ? { total: draft.total.toString(), currency: draft.currency } : {}),
    items: draft.items.map((item) => ({
      productId: item.productId,
      sku: item.product.sku,
      name: item.product.name,
      quantity: item.quantity.toString(),
      rationale: item.rationale,
      ...(canSeeCost ? { unitPrice: item.unitPrice.toString() } : {}),
    })),
  }));
}

/** Historial de corridas del agente: prompt, respuesta, tokens y costo (auditable). */
export async function listRuns(actor: AuthUser, limit = 20) {
  requirePermission(actor, "ai_agent:ver");
  const rows = await withTenant(requireTenantId(actor), (tx) =>
    tx.aiRun.findMany({ orderBy: { startedAt: "desc" }, take: limit }),
  );
  return rows.map((run) => ({
    id: run.id,
    kind: run.kind,
    status: run.status,
    model: run.model,
    simulated: run.simulated,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    promptTokens: run.promptTokens,
    completionTokens: run.completionTokens,
    costUsd: run.costUsd.toString(),
    error: run.error,
    sentMessage: run.sentMessage,
  }));
}
