import { can, requirePermission, requireTenantId, type AuthUser } from "@/lib/auth/can";
import { Prisma, withTenant, type TenantTx } from "@/lib/db";
import { ConflictError, NotFoundError, PermissionDeniedError } from "@/lib/errors";
import { reconcile, summarizeSession, type Method, type SessionSummary } from "@/lib/pos/cash";
import {
  cashMovementSchema,
  closeCashSchema,
  openCashSchema,
  type CloseCashInput,
} from "@/lib/validation/sales";
import type { z } from "zod";
import { auditContextOf, recordAudit, type RequestMeta } from "./audit";

const D = (value: string | number | Prisma.Decimal): Prisma.Decimal => new Prisma.Decimal(value);

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

/** Sucursal de trabajo del usuario: la pedida, su sucursal por defecto o la principal. */
export async function resolveBranchId(
  tx: TenantTx,
  actor: AuthUser,
  requested?: string,
): Promise<string> {
  if (requested) {
    const branch = await tx.branch.findFirst({ where: { id: requested, isActive: true } });
    if (!branch) throw new NotFoundError("Sucursal");
    return branch.id;
  }
  const user = await tx.user.findFirst({
    where: { id: actor.userId },
    select: { defaultBranchId: true },
  });
  if (user?.defaultBranchId) return user.defaultBranchId;
  const main =
    (await tx.branch.findFirst({ where: { isMain: true, isActive: true } })) ??
    (await tx.branch.findFirst({ where: { isActive: true }, orderBy: { createdAt: "asc" } }));
  if (!main) throw new NotFoundError("Sucursal");
  return main.id;
}

/**
 * Caja abierta del usuario, bloqueada con `FOR SHARE`: vender y cobrar caben en paralelo, pero el
 * cierre (`FOR UPDATE`) espera a que terminen y luego ninguna venta nueva entra a una caja cerrada.
 */
export async function lockOpenSession(tx: TenantTx, actor: AuthUser, branchId?: string) {
  const resolved = await resolveBranchId(tx, actor, branchId);
  const found = await tx.cashSession.findFirst({
    where: { openKey: `${actor.userId}:${resolved}`, status: "OPEN" },
    select: { id: true },
  });
  if (!found) throw new ConflictError("NO_CASH_SESSION", "Abre la caja antes de vender o cobrar");
  await tx.$queryRaw`SELECT id FROM cash_sessions WHERE id = ${found.id}::uuid FOR SHARE`;
  const session = await tx.cashSession.findFirst({ where: { id: found.id, status: "OPEN" } });
  if (!session) throw new ConflictError("NO_CASH_SESSION", "La caja se cerró; ábrela de nuevo");
  return session;
}

export async function summaryOf(tx: TenantTx, sessionId: string): Promise<SessionSummary> {
  const [session, payments, movements] = await Promise.all([
    tx.cashSession.findFirstOrThrow({ where: { id: sessionId } }),
    tx.salePayment.findMany({
      where: { cashSessionId: sessionId },
      select: { method: true, amount: true },
    }),
    tx.cashMovement.findMany({ where: { sessionId }, select: { type: true, amount: true } }),
  ]);
  return summarizeSession(
    session.openingAmount.toFixed(2),
    payments.map((p) => ({ method: p.method as Method, amount: p.amount.toFixed(2) })),
    movements.map((m) => ({ type: m.type, amount: m.amount.toFixed(2) })),
  );
}

export async function openCashSession(
  actor: AuthUser,
  input: z.input<typeof openCashSchema>,
  meta: RequestMeta = {},
) {
  requirePermission(actor, "cash:crear");
  const data = openCashSchema.parse(input);
  return withTenant(requireTenantId(actor), async (tx) => {
    const branchId = await resolveBranchId(tx, actor, data.branchId);
    try {
      const session = await tx.cashSession.create({
        data: {
          branchId,
          openedById: actor.userId,
          openingAmount: data.openingAmount,
          openKey: `${actor.userId}:${branchId}`,
        },
      });
      await recordAudit(tx, auditContextOf(actor, meta), {
        action: "cash.opened",
        entityType: "cash_session",
        entityId: session.id,
        after: { branchId, openingAmount: data.openingAmount },
      });
      return { id: session.id };
    } catch (error) {
      if (isUniqueViolation(error))
        throw new ConflictError("CASH_ALREADY_OPEN", "Ya tienes una caja abierta en esta sucursal");
      throw error;
    }
  });
}

export async function getCurrentSession(actor: AuthUser) {
  requirePermission(actor, "cash:ver");
  return withTenant(requireTenantId(actor), async (tx) => {
    const branchId = await resolveBranchId(tx, actor);
    const session = await tx.cashSession.findFirst({
      where: { openKey: `${actor.userId}:${branchId}`, status: "OPEN" },
      include: { branch: { select: { name: true } } },
    });
    if (!session) return null;
    const [summary, movements] = await Promise.all([
      summaryOf(tx, session.id),
      tx.cashMovement.findMany({
        where: { sessionId: session.id },
        orderBy: { createdAt: "desc" },
        take: 50,
      }),
    ]);
    return {
      id: session.id,
      branchId,
      branchName: session.branch.name,
      openedAt: session.openedAt,
      summary,
      movements: movements.map((m) => ({
        id: m.id,
        type: m.type,
        amount: m.amount.toFixed(2),
        reason: m.reason,
        createdAt: m.createdAt,
      })),
    };
  });
}

/** Ingreso o egreso de efectivo (gastos menores, cambio, retiro). Un egreso no puede dejar la caja en negativo. */
export async function addCashMovement(
  actor: AuthUser,
  input: z.input<typeof cashMovementSchema>,
  meta: RequestMeta = {},
) {
  requirePermission(actor, "cash:crear");
  const data = cashMovementSchema.parse(input);
  return withTenant(requireTenantId(actor), async (tx) => {
    const session = await lockOpenSession(tx, actor);
    if (data.type === "EXPENSE") {
      const summary = await summaryOf(tx, session.id);
      if (D(summary.expectedCash).lt(data.amount))
        throw new ConflictError(
          "CASH_INSUFFICIENT",
          `No hay suficiente efectivo en caja (S/ ${summary.expectedCash})`,
        );
    }
    const movement = await tx.cashMovement.create({
      data: {
        sessionId: session.id,
        type: data.type,
        amount: data.amount,
        reason: data.reason,
        createdById: actor.userId,
      },
    });
    await recordAudit(tx, auditContextOf(actor, meta), {
      action: data.type === "INCOME" ? "cash.income" : "cash.expense",
      entityType: "cash_session",
      entityId: session.id,
      after: { movementId: movement.id, amount: data.amount, reason: data.reason },
    });
    return { id: movement.id };
  });
}

/**
 * Arqueo y cierre. Bloquea la caja con `FOR UPDATE` (espera a las ventas en curso), compara el
 * conteo físico con lo registrado por medio de pago y guarda el detalle. Una diferencia de efectivo
 * mayor a la tolerancia del tenant exige una nota; siempre queda auditada y se avisa al dueño.
 */
export async function closeCashSession(
  actor: AuthUser,
  input: CloseCashInput,
  meta: RequestMeta = {},
) {
  requirePermission(actor, "cash:cerrar_caja");
  const data = closeCashSchema.parse(input);
  return withTenant(requireTenantId(actor), async (tx) => {
    await tx.$queryRaw`SELECT id FROM cash_sessions WHERE id = ${data.sessionId}::uuid FOR UPDATE`;
    const session = await tx.cashSession.findFirst({ where: { id: data.sessionId } });
    if (!session) throw new NotFoundError("Caja");
    if (session.status !== "OPEN")
      throw new ConflictError("CASH_CLOSED", "La caja ya está cerrada");
    if (session.openedById !== actor.userId && !can(actor, "cash:editar"))
      throw new PermissionDeniedError("cash:editar");

    const summary = await summaryOf(tx, session.id);
    const counted = Object.fromEntries(
      Object.entries(data.counted).filter(([, v]) => v !== undefined),
    ) as Partial<Record<Method, string>>;
    const result = reconcile(summary, counted);
    const settings = await tx.tenantSettings.findFirstOrThrow({ select: { cashTolerance: true } });
    const notes = data.notes?.trim() ?? "";
    if (D(result.cashDifference).abs().gt(settings.cashTolerance) && notes.length < 5) {
      throw new ConflictError(
        "CASH_DIFFERENCE_NOTES",
        `Hay una diferencia de efectivo de S/ ${result.cashDifference}. Explica el motivo en las notas para cerrar.`,
      );
    }
    await tx.cashSession.update({
      where: { id: session.id },
      data: {
        status: "CLOSED",
        closedById: actor.userId,
        closedAt: new Date(),
        openKey: null,
        expectedAmount: summary.expectedCash,
        countedAmount: result.lines.CASH.counted,
        difference: result.cashDifference,
        closingBreakdown: { summary, lines: result.lines, totalDifference: result.totalDifference },
        notes: notes || null,
      },
    });
    await recordAudit(tx, auditContextOf(actor, meta), {
      action: "cash.closed",
      entityType: "cash_session",
      entityId: session.id,
      after: {
        expectedCash: summary.expectedCash,
        countedCash: result.lines.CASH.counted,
        cashDifference: result.cashDifference,
      },
      ...(notes ? { reason: notes } : {}),
    });
    if (!D(result.totalDifference).isZero()) {
      await tx.notification.createMany({
        data: [
          {
            kind: "cash.difference",
            severity: D(result.cashDifference).abs().gt(settings.cashTolerance)
              ? "WARNING"
              : "INFO",
            title: `Cierre de caja con diferencia: S/ ${result.totalDifference}`,
            body: notes || null,
            data: { sessionId: session.id },
            dedupeKey: `cash-diff:${session.id}`,
          },
        ],
        skipDuplicates: true,
      });
    }
    return { summary, ...result };
  });
}

export async function listCashSessions(actor: AuthUser, limit = 30) {
  requirePermission(actor, "cash:ver");
  const all = can(actor, "cash:editar");
  return withTenant(requireTenantId(actor), async (tx) => {
    const rows = await tx.cashSession.findMany({
      where: all ? {} : { openedById: actor.userId },
      include: { openedBy: { select: { name: true } }, branch: { select: { name: true } } },
      orderBy: { openedAt: "desc" },
      take: limit,
    });
    return rows.map((s) => ({
      id: s.id,
      status: s.status,
      branch: s.branch.name,
      openedBy: s.openedBy.name,
      openedAt: s.openedAt,
      closedAt: s.closedAt,
      opening: s.openingAmount.toFixed(2),
      expected: s.expectedAmount?.toFixed(2) ?? null,
      counted: s.countedAmount?.toFixed(2) ?? null,
      difference: s.difference?.toFixed(2) ?? null,
    }));
  });
}
