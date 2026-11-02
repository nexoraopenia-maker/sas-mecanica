import { z } from "zod";
import { requirePermission, requireTenantId, type AuthUser } from "@/lib/auth/can";
import {
  nextSequence,
  Prisma,
  softDeleteData,
  withTenant,
  type TenantTx,
  type WarrantySource,
} from "@/lib/db";
import { ConflictError, NotFoundError } from "@/lib/errors";
import {
  claimDecisionSchema,
  claimSchema,
  warrantyPolicySchema,
  type ClaimDecisionInput,
  type ClaimInput,
  type WarrantyPolicyInput,
} from "@/lib/validation/workshop";
import { messages } from "@/lib/workshop/messages";
import {
  computeWindow,
  coverage,
  COVERAGE_LABEL,
  daysUntil,
  WARRANTY_NOTICE_DAYS,
} from "@/lib/workshop/warranty-math";
import { auditContextOf, recordAudit, type RequestMeta } from "./audit";
import { companyName, notifyCustomer } from "./customer-notify";
import { applyMovement } from "./inventory";

// ---------------------------------------------------------------------------
// Políticas
// ---------------------------------------------------------------------------

export async function createWarrantyPolicy(
  actor: AuthUser,
  input: WarrantyPolicyInput,
  meta: RequestMeta = {},
) {
  requirePermission(actor, "warranties:crear");
  const data = warrantyPolicySchema.parse(input);
  return withTenant(requireTenantId(actor), async (tx) => {
    const policy = await tx.warrantyPolicy.create({
      data: {
        name: data.name,
        months: data.months ?? null,
        kilometers: data.kilometers ?? null,
        coversLabor: data.coversLabor,
        terms: data.terms ?? null,
      },
    });
    await recordAudit(tx, auditContextOf(actor, meta), {
      action: "warranty.policy_created",
      entityType: "warranty_policy",
      entityId: policy.id,
      after: { name: data.name, months: data.months ?? null, kilometers: data.kilometers ?? null },
    });
    return { id: policy.id };
  });
}

/** Los cambios de una política NO afectan garantías ya emitidas (cada una guarda su propia vigencia). */
export async function updateWarrantyPolicy(
  actor: AuthUser,
  policyId: string,
  input: Partial<WarrantyPolicyInput>,
  meta: RequestMeta = {},
): Promise<void> {
  requirePermission(actor, "warranties:editar");
  await withTenant(requireTenantId(actor), async (tx) => {
    const before = await tx.warrantyPolicy.findFirst({ where: { id: policyId } });
    if (!before) throw new NotFoundError("Política de garantía");
    const merged = warrantyPolicySchema.parse({
      name: before.name,
      months: before.months,
      kilometers: before.kilometers,
      coversLabor: before.coversLabor,
      terms: before.terms ?? undefined,
      ...input,
    });
    await tx.warrantyPolicy.update({
      where: { id: policyId },
      data: {
        name: merged.name,
        months: merged.months ?? null,
        kilometers: merged.kilometers ?? null,
        coversLabor: merged.coversLabor,
        terms: merged.terms ?? null,
      },
    });
    await recordAudit(tx, auditContextOf(actor, meta), {
      action: "warranty.policy_updated",
      entityType: "warranty_policy",
      entityId: policyId,
      before: {
        months: before.months,
        kilometers: before.kilometers,
        coversLabor: before.coversLabor,
      },
      after: {
        months: merged.months ?? null,
        kilometers: merged.kilometers ?? null,
        coversLabor: merged.coversLabor,
      },
    });
  });
}

export async function deleteWarrantyPolicy(
  actor: AuthUser,
  policyId: string,
  meta: RequestMeta = {},
): Promise<void> {
  requirePermission(actor, "warranties:eliminar");
  await withTenant(requireTenantId(actor), async (tx) => {
    if (!(await tx.warrantyPolicy.findFirst({ where: { id: policyId } })))
      throw new NotFoundError("Política de garantía");
    if ((await tx.product.count({ where: { warrantyPolicyId: policyId } })) > 0)
      throw new ConflictError("POLICY_IN_USE", "Hay productos que usan esta política");
    await tx.warrantyPolicy.update({ where: { id: policyId }, data: softDeleteData() });
    await recordAudit(tx, auditContextOf(actor, meta), {
      action: "warranty.policy_deleted",
      entityType: "warranty_policy",
      entityId: policyId,
    });
  });
}

export async function listWarrantyPolicies(actor: AuthUser) {
  requirePermission(actor, "warranties:ver");
  return withTenant(requireTenantId(actor), (tx) =>
    tx.warrantyPolicy.findMany({ where: { isActive: true }, orderBy: { name: "asc" } }),
  );
}

// ---------------------------------------------------------------------------
// Registro automático
// ---------------------------------------------------------------------------

export interface RegisterWarrantyInput {
  source: WarrantySource;
  customerId: string | null;
  vehicleId: string | null;
  productId: string | null;
  policyId: string;
  workOrderItemId?: string | null;
  saleItemId?: string | null;
  serialId?: string | null;
  lotId?: string | null;
  description: string;
  startsAt: Date;
  startMileage: number | null;
}

/**
 * Emite una garantía con la vigencia de su política (fecha y/o kilometraje). Idempotente por
 * línea de OT: si ya existe no crea otra. También la usará el POS (Fase 6) al vender.
 */
export async function registerWarranty(tx: TenantTx, input: RegisterWarrantyInput) {
  if (input.workOrderItemId) {
    const existing = await tx.warranty.findFirst({
      where: { workOrderItemId: input.workOrderItemId },
    });
    if (existing) return existing;
  }
  const policy = await tx.warrantyPolicy.findFirst({ where: { id: input.policyId } });
  if (!policy || (!policy.months && !policy.kilometers)) return null;
  const window = computeWindow(input.startsAt, policy, input.startMileage);
  return tx.warranty.create({
    data: {
      source: input.source,
      customerId: input.customerId,
      vehicleId: input.vehicleId,
      productId: input.productId,
      policyId: policy.id,
      workOrderItemId: input.workOrderItemId ?? null,
      saleItemId: input.saleItemId ?? null,
      serialId: input.serialId ?? null,
      lotId: input.lotId ?? null,
      description: input.description,
      coversLabor: policy.coversLabor,
      startsAt: window.startsAt,
      expiresAt: window.expiresAt,
      startMileage: window.startMileage,
      expiresAtMileage: window.expiresAtMileage,
    },
  });
}

// ---------------------------------------------------------------------------
// Consulta rápida
// ---------------------------------------------------------------------------

const searchSchema = z.object({
  plate: z.string().trim().max(10).optional(),
  serial: z.string().trim().max(60).optional(),
  customer: z.string().trim().max(100).optional(),
  status: z.enum(["ACTIVE", "EXPIRED", "IN_CLAIM", "VOID"]).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export async function searchWarranties(
  actor: AuthUser,
  input: z.input<typeof searchSchema> = {},
  now: Date = new Date(),
) {
  requirePermission(actor, "warranties:ver");
  const data = searchSchema.parse(input);
  const plate = data.plate?.toUpperCase().replace(/[\s\-._]/g, "");
  const rows = await withTenant(requireTenantId(actor), (tx) =>
    tx.warranty.findMany({
      where: {
        ...(data.status ? { status: data.status } : {}),
        ...(plate ? { vehicle: { plate: { contains: plate } } } : {}),
        ...(data.serial
          ? { serial: { serial: { contains: data.serial, mode: "insensitive" } } }
          : {}),
        ...(data.customer
          ? {
              customer: {
                OR: [
                  { name: { contains: data.customer, mode: "insensitive" } },
                  { docNumber: { contains: data.customer.replace(/[\s.-]/g, "") } },
                ],
              },
            }
          : {}),
      },
      include: {
        vehicle: { select: { plate: true, currentMileage: true } },
        customer: { select: { name: true } },
        serial: { select: { serial: true } },
        lot: { select: { dotCode: true } },
        claims: { select: { id: true, number: true, status: true } },
      },
      orderBy: [{ expiresAt: "asc" }],
      take: data.limit,
    }),
  );
  return rows.map((w) => {
    const check = coverage(w, { now, mileage: w.vehicle?.currentMileage ?? null });
    return {
      id: w.id,
      description: w.description,
      status: w.status,
      plate: w.vehicle?.plate ?? null,
      customer: w.customer?.name ?? null,
      serial: w.serial?.serial ?? null,
      dotCode: w.lot?.dotCode ?? null,
      startsAt: w.startsAt,
      expiresAt: w.expiresAt,
      expiresAtMileage: w.expiresAtMileage,
      coversLabor: w.coversLabor,
      daysLeft: w.expiresAt ? daysUntil(w.expiresAt, now) : null,
      covered: check.covered,
      reasons: check.reasons.map((r) => COVERAGE_LABEL[r]),
      claims: w.claims,
    };
  });
}

// ---------------------------------------------------------------------------
// Reclamos: recepción → evaluación → aprobado/rechazado → resuelto
// ---------------------------------------------------------------------------

export async function createClaim(actor: AuthUser, input: ClaimInput, meta: RequestMeta = {}) {
  requirePermission(actor, "warranties:crear");
  const data = claimSchema.parse(input);
  return withTenant(requireTenantId(actor), async (tx) => {
    const warranty = await tx.warranty.findFirst({
      where: { id: data.warrantyId },
      include: { vehicle: { select: { plate: true, currentMileage: true } } },
    });
    if (!warranty) throw new NotFoundError("Garantía");
    if (warranty.status === "VOID")
      throw new ConflictError("WARRANTY_VOID", "La garantía ya fue anulada o resuelta");
    if (warranty.status === "IN_CLAIM")
      throw new ConflictError("WARRANTY_IN_CLAIM", "Esta garantía ya tiene un reclamo en curso");

    if (
      data.mileage !== undefined &&
      warranty.vehicleId &&
      (warranty.vehicle?.currentMileage ?? 0) < data.mileage
    ) {
      await tx.vehicle.update({
        where: { id: warranty.vehicleId },
        data: { currentMileage: data.mileage },
      });
    }
    const number = await nextSequence(tx, "WC");
    const claim = await tx.warrantyClaim.create({
      data: {
        number,
        warrantyId: warranty.id,
        description: data.description,
        mileageAtClaim: data.mileage ?? warranty.vehicle?.currentMileage ?? null,
        receivedById: actor.userId,
      },
    });
    await tx.warranty.update({ where: { id: warranty.id }, data: { status: "IN_CLAIM" } });
    if (warranty.customerId) {
      await notifyCustomer(tx, {
        customerId: warranty.customerId,
        key: `claim-received:${claim.id}`,
        relatedType: "warranty_claim",
        relatedId: claim.id,
        body: messages.claimReceived({
          customer: (await tx.customer.findFirstOrThrow({ where: { id: warranty.customerId } }))
            .name,
          company: await companyName(tx),
          number,
        }),
      });
    }
    await recordAudit(tx, auditContextOf(actor, meta), {
      action: "warranty.claim_received",
      entityType: "warranty_claim",
      entityId: claim.id,
      after: { number, warrantyId: warranty.id },
    });
    return { id: claim.id, number };
  });
}

export async function startEvaluation(
  actor: AuthUser,
  claimId: string,
  meta: RequestMeta = {},
): Promise<void> {
  requirePermission(actor, "warranties:editar");
  await withTenant(requireTenantId(actor), async (tx) => {
    const moved = await tx.warrantyClaim.updateMany({
      where: { id: claimId, status: "RECEIVED" },
      data: { status: "EVALUATING", evaluatedById: actor.userId },
    });
    if (moved.count !== 1)
      throw new ConflictError("CLAIM_STATE", "El reclamo no está en estado Recibido");
    await recordAudit(tx, auditContextOf(actor, meta), {
      action: "warranty.claim_evaluating",
      entityType: "warranty_claim",
      entityId: claimId,
    });
  });
}

/**
 * Decide el reclamo. Aprobar uno FUERA de cobertura (venció por fecha o kilometraje) exige un
 * motivo explícito que queda auditado. Rechazar devuelve la garantía a su estado real.
 */
export async function decideClaim(
  actor: AuthUser,
  input: ClaimDecisionInput,
  meta: RequestMeta = {},
  now: Date = new Date(),
) {
  requirePermission(actor, "warranties:editar");
  const data = claimDecisionSchema.parse(input);
  return withTenant(requireTenantId(actor), async (tx) => {
    const claim = await tx.warrantyClaim.findFirst({
      where: { id: data.claimId, status: "EVALUATING" },
      include: { warranty: { include: { vehicle: { select: { currentMileage: true } } } } },
    });
    if (!claim) throw new ConflictError("CLAIM_STATE", "El reclamo debe estar en evaluación");
    const check = coverage(claim.warranty, {
      now,
      mileage: claim.mileageAtClaim ?? claim.warranty.vehicle?.currentMileage ?? null,
    });

    if (data.decision === "APPROVE" && !check.covered && !data.overrideReason) {
      throw new ConflictError(
        "OUT_OF_COVERAGE",
        `Fuera de cobertura: ${check.reasons.map((r) => COVERAGE_LABEL[r]).join("; ")}. Para aprobar igual indica el motivo.`,
      );
    }
    const approved = data.decision === "APPROVE";
    const updated = await tx.warrantyClaim.updateMany({
      where: { id: claim.id, status: "EVALUATING" },
      data: {
        status: approved ? "APPROVED" : "REJECTED",
        resolution: approved ? data.resolution : "NONE",
        evaluation: data.evaluation,
        evaluatedById: actor.userId,
        coverageOverrideReason: approved && !check.covered ? (data.overrideReason ?? null) : null,
        resolvedAt: approved ? null : now,
      },
    });
    if (updated.count !== 1) throw new ConflictError("CLAIM_STATE", "El reclamo ya fue decidido");
    if (!approved) {
      const stillValid =
        !claim.warranty.expiresAt || claim.warranty.expiresAt.getTime() >= now.getTime();
      await tx.warranty.update({
        where: { id: claim.warrantyId },
        data: { status: stillValid ? "ACTIVE" : "EXPIRED" },
      });
    }
    if (claim.warranty.customerId) {
      const customer = await tx.customer.findFirstOrThrow({
        where: { id: claim.warranty.customerId },
      });
      await notifyCustomer(tx, {
        customerId: customer.id,
        key: `claim-decided:${claim.id}`,
        relatedType: "warranty_claim",
        relatedId: claim.id,
        body: messages.claimResolved({
          customer: customer.name,
          company: await companyName(tx),
          number: claim.number,
          approved,
          resolution:
            data.resolution === "REPLACEMENT" ? "reposición del producto" : "nota de crédito",
        }),
      });
    }
    await recordAudit(tx, auditContextOf(actor, meta), {
      action: approved ? "warranty.claim_approved" : "warranty.claim_rejected",
      entityType: "warranty_claim",
      entityId: claim.id,
      before: { status: "EVALUATING", covered: check.covered },
      after: { status: approved ? "APPROVED" : "REJECTED", resolution: data.resolution ?? "NONE" },
      reason:
        !check.covered && approved
          ? `Aprobado fuera de cobertura: ${data.overrideReason}`
          : data.evaluation,
    });
    return {
      status: approved ? ("APPROVED" as const) : ("REJECTED" as const),
      covered: check.covered,
    };
  });
}

const resolveSchema = z.object({
  claimId: z.uuid(),
  warehouseId: z.uuid().optional(),
  replacementProductId: z.uuid().optional(),
  serials: z.array(z.string().trim().min(3).max(60)).max(20).optional(),
  lotId: z.uuid().optional(),
  creditAmount: z.coerce.number().positive().max(10_000_000).optional(),
});

/**
 * Cierra un reclamo aprobado. REPOSICIÓN: la unidad nueva sale del almacén por el kardex y hereda
 * el tiempo restante de la garantía. NOTA DE CRÉDITO: queda el monto registrado y una alerta para
 * emitirla (la emisión fiscal llega con la Fase 6). En ambos casos la garantía original se anula.
 */
export async function resolveClaim(
  actor: AuthUser,
  input: z.input<typeof resolveSchema>,
  meta: RequestMeta = {},
  now: Date = new Date(),
) {
  requirePermission(actor, "warranties:editar");
  const data = resolveSchema.parse(input);
  return withTenant(requireTenantId(actor), async (tx) => {
    const claim = await tx.warrantyClaim.findFirst({
      where: { id: data.claimId },
      include: { warranty: { include: { workOrderItem: true } } },
    });
    if (!claim) throw new NotFoundError("Reclamo");
    if (claim.status === "RESOLVED") return { status: "RESOLVED" as const, replayed: true };
    if (claim.status !== "APPROVED")
      throw new ConflictError("CLAIM_STATE", "Solo se resuelven reclamos aprobados");
    const warranty = claim.warranty;

    let replacementMovementId: string | null = null;
    let replacementWarrantyId: string | null = null;
    let creditAmount: Prisma.Decimal | null = null;

    if (claim.resolution === "REPLACEMENT") {
      requirePermission(actor, "inventory:editar");
      const productId = data.replacementProductId ?? warranty.productId;
      if (!productId)
        throw new ConflictError("REPLACEMENT_PRODUCT", "Indica el producto de reposición");
      const warehouse = data.warehouseId
        ? await tx.warehouse.findFirst({ where: { id: data.warehouseId, isActive: true } })
        : ((await tx.warehouse.findFirst({ where: { isDefault: true, isActive: true } })) ??
          (await tx.warehouse.findFirst({ where: { isActive: true }, orderBy: { code: "asc" } })));
      if (!warehouse) throw new NotFoundError("Almacén");
      const product = await tx.product.findFirstOrThrow({ where: { id: productId } });
      const quantity = warranty.workOrderItem ? warranty.workOrderItem.quantity.toString() : "1";
      const outcome = await applyMovement(tx, {
        warehouseId: warehouse.id,
        productId,
        type: "ADJUSTMENT_OUT",
        ...(product.trackingMode === "SERIAL" ? { serials: data.serials } : { quantity }),
        reason: `Reposición por garantía #${claim.number}`,
        referenceType: "warranty_claim",
        referenceId: claim.id,
        idempotencyKey: `claim-repl:${claim.id}`,
        createdById: actor.userId,
        ...(data.lotId ? { lotId: data.lotId } : {}),
      });
      const first = outcome.movements[0];
      replacementMovementId = first?.id ?? null;
      const policy = warranty.policyId
        ? await tx.warrantyPolicy.findFirst({ where: { id: warranty.policyId } })
        : null;
      if (policy) {
        // La unidad de reposición hereda el tiempo que le quedaba a la original (no se renueva).
        const created = await tx.warranty.create({
          data: {
            source: warranty.source,
            customerId: warranty.customerId,
            vehicleId: warranty.vehicleId,
            productId,
            policyId: warranty.policyId,
            serialId: first?.serialId ?? null,
            lotId: first?.lotId ?? null,
            description: `Reposición (reclamo #${claim.number}): ${warranty.description}`,
            coversLabor: warranty.coversLabor,
            startsAt: warranty.startsAt,
            expiresAt: warranty.expiresAt,
            startMileage: warranty.startMileage,
            expiresAtMileage: warranty.expiresAtMileage,
          },
        });
        replacementWarrantyId = created.id;
      }
    } else if (claim.resolution === "CREDIT_NOTE") {
      const original = warranty.workOrderItem
        ? warranty.workOrderItem.unitPrice
            .times(warranty.workOrderItem.quantity)
            .minus(warranty.workOrderItem.discount)
        : null;
      const requested =
        data.creditAmount !== undefined ? new Prisma.Decimal(data.creditAmount) : original;
      if (!requested || requested.lte(0))
        throw new ConflictError("CREDIT_AMOUNT", "Indica el monto de la nota de crédito");
      if (original && requested.gt(original))
        throw new ConflictError(
          "CREDIT_AMOUNT",
          `El monto no puede superar lo cobrado (${original.toFixed(2)})`,
        );
      creditAmount = requested;
      await tx.notification.createMany({
        data: [
          {
            kind: "warranty.credit_note_pending",
            severity: "WARNING",
            title: `Emitir nota de crédito por el reclamo #${claim.number}`,
            body: `Monto aprobado: ${requested.toFixed(2)}. La emisión fiscal se hace desde Facturación.`,
            data: { claimId: claim.id, amount: requested.toFixed(2) },
            dedupeKey: `credit-note:${claim.id}`,
          },
        ],
        skipDuplicates: true,
      });
    }

    const done = await tx.warrantyClaim.updateMany({
      where: { id: claim.id, status: "APPROVED" },
      data: {
        status: "RESOLVED",
        resolvedAt: now,
        replacementMovementId,
        replacementWarrantyId,
        creditAmount: creditAmount?.toFixed(2) ?? null,
      },
    });
    if (done.count !== 1) return { status: "RESOLVED" as const, replayed: true };
    await tx.warranty.update({ where: { id: warranty.id }, data: { status: "VOID" } });
    await recordAudit(tx, auditContextOf(actor, meta), {
      action: "warranty.claim_resolved",
      entityType: "warranty_claim",
      entityId: claim.id,
      after: {
        resolution: claim.resolution,
        replacementWarrantyId,
        creditAmount: creditAmount?.toFixed(2) ?? null,
      },
    });
    return { status: "RESOLVED" as const, replayed: false };
  });
}

export async function getClaim(actor: AuthUser, claimId: string) {
  requirePermission(actor, "warranties:ver");
  return withTenant(requireTenantId(actor), async (tx) => {
    const claim = await tx.warrantyClaim.findFirst({
      where: { id: claimId },
      include: {
        warranty: {
          include: { vehicle: { select: { plate: true } }, customer: { select: { name: true } } },
        },
      },
    });
    if (!claim) throw new NotFoundError("Reclamo");
    return { ...claim, creditAmount: claim.creditAmount?.toString() ?? null };
  });
}

export async function listClaims(
  actor: AuthUser,
  status?: "RECEIVED" | "EVALUATING" | "APPROVED" | "REJECTED" | "RESOLVED",
) {
  requirePermission(actor, "warranties:ver");
  return withTenant(requireTenantId(actor), (tx) =>
    tx.warrantyClaim.findMany({
      where: status ? { status } : {},
      include: {
        warranty: {
          select: {
            description: true,
            vehicle: { select: { plate: true } },
            customer: { select: { name: true } },
          },
        },
      },
      orderBy: { createdAt: "desc" },
      take: 100,
    }),
  );
}

// ---------------------------------------------------------------------------
// Job: vencimientos y avisos
// ---------------------------------------------------------------------------

export interface WarrantyJobSummary {
  expired: number;
  noticed: number;
}

/**
 * Marca como vencidas las garantías cuya fecha ya pasó y avisa a los clientes antes de que
 * venzan (30 y 7 días). Idempotente: cada aviso tiene clave única por garantía y plazo.
 */
export async function processWarranties(
  tx: TenantTx,
  now: Date = new Date(),
): Promise<WarrantyJobSummary> {
  const expired = await tx.warranty.updateMany({
    where: { status: "ACTIVE", expiresAt: { lt: now } },
    data: { status: "EXPIRED" },
  });
  const horizon = new Date(now.getTime() + Math.max(...WARRANTY_NOTICE_DAYS) * 86_400_000);
  const upcoming = await tx.warranty.findMany({
    where: { status: "ACTIVE", expiresAt: { gte: now, lte: horizon } },
    include: {
      vehicle: { select: { plate: true } },
      customer: { select: { id: true, name: true } },
    },
  });
  let noticed = 0;
  const company = upcoming.length > 0 ? await companyName(tx) : "";
  for (const warranty of upcoming) {
    if (!warranty.expiresAt) continue;
    const days = daysUntil(warranty.expiresAt, now);
    const bucket =
      days <= WARRANTY_NOTICE_DAYS[1] ? WARRANTY_NOTICE_DAYS[1] : WARRANTY_NOTICE_DAYS[0];
    await tx.notification.createMany({
      data: [
        {
          kind: "warranty.expiring",
          severity: bucket === 7 ? "WARNING" : "INFO",
          title: `Garantía por vencer: ${warranty.description}`,
          body: `${warranty.customer?.name ?? "Cliente"} · ${warranty.vehicle?.plate ?? "sin placa"} · vence en ${days} día(s).`,
          data: { warrantyId: warranty.id, days },
          dedupeKey: `warranty-expiring:${warranty.id}:${bucket}`,
        },
      ],
      skipDuplicates: true,
    });
    if (warranty.customer) {
      const result = await notifyCustomer(tx, {
        customerId: warranty.customer.id,
        key: `warranty-notice:${warranty.id}:${bucket}`,
        relatedType: "warranty",
        relatedId: warranty.id,
        body: messages.warrantyNotice({
          customer: warranty.customer.name,
          company,
          plate: warranty.vehicle?.plate ?? "",
          description: warranty.description,
          days,
        }),
      });
      if (result === "QUEUED" || result === "SIMULATED") noticed += 1;
    }
  }
  return { expired: expired.count, noticed };
}
