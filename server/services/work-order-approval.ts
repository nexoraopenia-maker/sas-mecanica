import { generateToken, hashToken } from "@/lib/auth/secure-token";
import { requirePermission, requireTenantId, type AuthUser } from "@/lib/auth/can";
import { consumeRateLimit, findWorkOrderByTokenHash, withTenant, type TenantTx } from "@/lib/db";
import { getEnv } from "@/lib/env";
import { ConflictError, InvalidTokenError, RateLimitError } from "@/lib/errors";
import { buildStoragePath } from "@/lib/security/storage-path";
import {
  approvalDecisionSchema,
  personApprovalSchema,
  type ApprovalDecisionInput,
  type PersonApprovalInput,
} from "@/lib/validation/workshop";
import { MAX_SIGNATURE_BYTES, sniffImage } from "@/lib/workshop/image";
import { messages } from "@/lib/workshop/messages";
import { BUCKETS, getStorage } from "@/server/integrations/storage";
import { auditContextOf, recordAudit, type RequestMeta } from "./audit";
import { companyName, notifyCustomer, type NotifyResult } from "./customer-notify";
import { changeStatus, loadOrder, recalcTotals } from "./work-orders";

export const APPROVAL_LINK_DAYS = 7;

/**
 * Presupuesto a aprobar por el cliente. Se manda por enlace (token de un solo uso, solo su hash
 * en BD) o se firma en el taller. Cada RONDA se aprueba por separado: lo ya aprobado no cambia.
 */
export async function requestApproval(
  actor: AuthUser,
  workOrderId: string,
  meta: RequestMeta = {},
  now: Date = new Date(),
): Promise<{ link: string; notified: NotifyResult; expiresAt: Date }> {
  requirePermission(actor, "workshop:editar");
  const { token, hash } = generateToken();
  const expiresAt = new Date(now.getTime() + APPROVAL_LINK_DAYS * 86_400_000);
  return withTenant(requireTenantId(actor), async (tx) => {
    const order = await loadOrder(tx, actor, workOrderId);
    if (
      !["DIAGNOSING", "AWAITING_APPROVAL", "RECEIVED", "IN_REPAIR", "AWAITING_PARTS"].includes(
        order.status,
      )
    )
      throw new ConflictError("WO_STATE", "En este estado no se puede pedir aprobación");
    const pending = await tx.workOrderItem.count({
      where: { workOrderId, approvalStatus: "PENDING" },
    });
    if (pending === 0)
      throw new ConflictError("NOTHING_TO_APPROVE", "No hay trabajos pendientes de aprobar");
    if (order.status !== "AWAITING_APPROVAL")
      await changeStatus(tx, order, "AWAITING_APPROVAL", {
        userId: actor.userId,
        note: "Presupuesto enviado al cliente",
      });
    await tx.workOrder.update({
      where: { id: workOrderId },
      data: { approvalTokenHash: hash, approvalTokenExpiresAt: expiresAt },
    });
    const total = (await recalcTotals(tx, workOrderId)).total;
    const link = `${getEnv().APP_URL.replace(/\/$/, "")}/aprobar/${token}`;
    const notified = await notifyCustomer(tx, {
      customerId: order.customerId,
      key: `wo-approval:${workOrderId}:${order.currentApprovalRound}:${hash.slice(0, 12)}`,
      relatedType: "work_order",
      relatedId: workOrderId,
      body: messages.approvalRequest({
        customer: order.customer.name,
        company: await companyName(tx),
        plate: order.vehicle.plate,
        total,
        link,
      }),
    });
    await recordAudit(tx, auditContextOf(actor, meta), {
      action: "workorder.approval_requested",
      entityType: "work_order",
      entityId: workOrderId,
      after: { round: order.currentApprovalRound, expiresAt, notified },
    });
    return { link, notified, expiresAt };
  });
}

async function resolveToken(token: string, now: Date) {
  const row = await findWorkOrderByTokenHash(hashToken(token));
  if (!row || !row.approvalTokenExpiresAt || row.approvalTokenExpiresAt <= now)
    throw new InvalidTokenError();
  return row;
}

/** Vista pública (sin sesión) del presupuesto pendiente. Muestra precios de venta, nunca costos. */
export async function getApprovalView(
  token: string,
  ip: string | undefined,
  now: Date = new Date(),
) {
  const limit = await consumeRateLimit("wo-approval:ip", ip ?? "unknown", 60, 600);
  if (!limit.allowed) throw new RateLimitError(limit.retryAfterSeconds);
  const row = await resolveToken(token, now);
  return withTenant(row.tenantId, async (tx) => {
    const order = await tx.workOrder.findFirst({
      where: { id: row.id },
      include: {
        vehicle: { select: { plate: true, make: true, model: true } },
        customer: { select: { name: true } },
      },
    });
    if (!order || order.status !== "AWAITING_APPROVAL") throw new InvalidTokenError();
    const items = await tx.workOrderItem.findMany({
      where: { workOrderId: order.id, approvalStatus: "PENDING" },
      orderBy: { createdAt: "asc" },
    });
    return {
      company: await companyName(tx),
      number: order.number,
      customer: order.customer.name,
      plate: order.vehicle.plate,
      vehicle: [order.vehicle.make, order.vehicle.model].filter(Boolean).join(" "),
      diagnosis: order.diagnosis,
      expiresAt: row.approvalTokenExpiresAt,
      items: items.map((item) => ({
        id: item.id,
        type: item.type,
        description: item.description,
        quantity: item.quantity.toString(),
        unitPrice: item.unitPrice.toString(),
        discount: item.discount.toString(),
        taxed: item.taxAffectation === "TAXED",
      })),
      taxRate: (
        await tx.tenantSettings.findFirstOrThrow({ select: { taxRate: true } })
      ).taxRate.toString(),
    };
  });
}

/** Aplica la decisión sobre los ítems PENDING de la ronda actual (la parte no rechazada se aprueba). */
async function applyDecision(
  tx: TenantTx,
  orderId: string,
  decision: "APPROVE" | "REJECT",
  rejectedIds: string[],
  who: { userId: string | null; name: string; method: string; ip?: string; signatureUrl?: string },
  now: Date,
) {
  const order = await tx.workOrder.findFirstOrThrow({ where: { id: orderId } });
  if (order.status !== "AWAITING_APPROVAL")
    throw new ConflictError("WO_STATE", "El presupuesto ya no está pendiente de aprobación");
  const pending = await tx.workOrderItem.findMany({
    where: { workOrderId: orderId, approvalStatus: "PENDING" },
  });
  if (pending.length === 0)
    throw new ConflictError("NOTHING_TO_APPROVE", "No hay trabajos pendientes de aprobar");
  const pendingIds = new Set(pending.map((item) => item.id));
  if (rejectedIds.some((id) => !pendingIds.has(id)))
    throw new ConflictError(
      "ITEM_INVALID",
      "Un ítem indicado no pertenece al presupuesto pendiente",
    );
  const rejected = decision === "REJECT" ? pending.map((item) => item.id) : rejectedIds;
  const approved = pending.filter((item) => !rejected.includes(item.id)).map((item) => item.id);
  if (rejected.length)
    await tx.workOrderItem.updateMany({
      where: { id: { in: rejected }, approvalStatus: "PENDING" },
      data: { approvalStatus: "REJECTED" },
    });
  if (approved.length)
    await tx.workOrderItem.updateMany({
      where: { id: { in: approved }, approvalStatus: "PENDING" },
      data: { approvalStatus: "APPROVED" },
    });
  const totals = await recalcTotals(tx, orderId);
  // El enlace es de un solo uso: se invalida al decidir.
  await tx.workOrder.update({
    where: { id: orderId },
    data: {
      approvalTokenHash: null,
      approvalTokenExpiresAt: null,
      ...(approved.length
        ? {
            approvedAt: now,
            approvalMethod: who.method,
            approvedByName: who.name,
            approvalIp: who.ip ?? null,
            ...(who.signatureUrl ? { signatureUrl: who.signatureUrl } : {}),
          }
        : {}),
    },
  });
  const anyApproved =
    approved.length > 0 ||
    (await tx.workOrderItem.count({
      where: { workOrderId: orderId, approvalStatus: "APPROVED" },
    })) > 0;
  const needsParts =
    anyApproved &&
    (await tx.workOrderItem.count({
      where: {
        workOrderId: orderId,
        type: "PART",
        approvalStatus: "APPROVED",
        partStatus: "REQUESTED",
      },
    })) > 0;
  const next = !anyApproved ? "DIAGNOSING" : needsParts ? "AWAITING_PARTS" : "IN_REPAIR";
  await changeStatus(tx, order, next, {
    userId: who.userId,
    note: `${decision === "APPROVE" ? "Aprobado" : "Rechazado"} por ${who.name} (${who.method})`,
  });
  return { order, approved: approved.length, rejected: rejected.length, total: totals.total };
}

/** Aprobación del cliente por enlace. Sin sesión: toda la defensa es el token + límite por IP. */
export async function decideByToken(
  input: ApprovalDecisionInput,
  meta: RequestMeta = {},
  now: Date = new Date(),
) {
  const data = approvalDecisionSchema.parse(input);
  const limit = await consumeRateLimit("wo-approval:ip", meta.ip ?? "unknown", 60, 600);
  if (!limit.allowed) throw new RateLimitError(limit.retryAfterSeconds);
  const row = await resolveToken(data.token, now);
  return withTenant(row.tenantId, async (tx) => {
    const result = await applyDecision(
      tx,
      row.id,
      data.decision,
      data.rejectedItemIds,
      { userId: null, name: data.name, method: "LINK", ip: meta.ip },
      now,
    );
    await recordAudit(
      tx,
      {
        actorType: "SYSTEM",
        actorUserId: null,
        ip: meta.ip,
        userAgent: meta.userAgent,
      },
      {
        action: data.decision === "APPROVE" ? "workorder.approved" : "workorder.rejected",
        entityType: "work_order",
        entityId: row.id,
        after: {
          by: data.name,
          method: "LINK",
          approved: result.approved,
          rejected: result.rejected,
          total: result.total,
        },
      },
    );
    await tx.notification.createMany({
      data: [
        {
          kind: "workorder.approval",
          severity: data.decision === "APPROVE" ? "INFO" : "WARNING",
          title: `OT #${result.order.number}: cliente ${data.decision === "APPROVE" ? "aprobó" : "rechazó"} el presupuesto`,
          body: `${data.name} · ${result.approved} aprobado(s), ${result.rejected} rechazado(s)`,
          data: { workOrderId: row.id },
          dedupeKey: `wo-decision:${row.id}:${result.order.currentApprovalRound}`,
        },
      ],
      skipDuplicates: true,
    });
    return { approved: result.approved, rejected: result.rejected };
  });
}

/** Aprobación en el taller: el cliente firma en pantalla; la firma se guarda como imagen privada. */
export async function approveInPerson(
  actor: AuthUser,
  input: PersonApprovalInput,
  meta: RequestMeta = {},
  now: Date = new Date(),
) {
  requirePermission(actor, "workshop:editar");
  const data = personApprovalSchema.parse(input);
  const match = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(data.signatureDataUrl);
  if (!match?.[1]) throw new ConflictError("SIGNATURE_INVALID", "La firma debe ser una imagen PNG");
  const bytes = Buffer.from(match[1], "base64");
  if (bytes.length < 100 || bytes.length > MAX_SIGNATURE_BYTES || sniffImage(bytes) !== "image/png")
    throw new ConflictError("SIGNATURE_INVALID", "La firma no es válida o es demasiado grande");
  const tenantId = requireTenantId(actor);
  return withTenant(tenantId, async (tx) => {
    const order = await loadOrder(tx, actor, data.workOrderId);
    const path = buildStoragePath(
      tenantId,
      "signatures",
      order.id,
      `${order.currentApprovalRound}-${generateToken().hash.slice(0, 16)}.png`,
    );
    const result = await applyDecision(
      tx,
      order.id,
      "APPROVE",
      data.rejectedItemIds,
      {
        userId: actor.userId,
        name: data.name,
        method: "SIGNATURE",
        ip: meta.ip,
        signatureUrl: path,
      },
      now,
    );
    await getStorage().put(BUCKETS.photos, path, bytes, "image/png");
    await recordAudit(tx, auditContextOf(actor, meta), {
      action: "workorder.approved",
      entityType: "work_order",
      entityId: order.id,
      after: {
        by: data.name,
        method: "SIGNATURE",
        approved: result.approved,
        rejected: result.rejected,
        total: result.total,
      },
    });
    return { approved: result.approved, rejected: result.rejected };
  });
}
