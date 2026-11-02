import { z } from "zod";
import {
  requirePermission,
  requireSuperAdmin,
  requireTenantId,
  type AuthUser,
} from "@/lib/auth/can";
import { Prisma, withAdmin, withPlatform, withTenant } from "@/lib/db";
import { getEnv } from "@/lib/env";
import { ConflictError, NotFoundError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { getBillingConfig } from "@/lib/saas/billing-config";
import {
  daysLeft,
  decideCycle,
  graceEnd,
  hasAccess,
  nextRetryAfterFailure,
  periodCoveredBy,
  type CycleAction,
} from "@/lib/saas/subscription";
import { addMonths } from "@/lib/workshop/warranty-math";
import { getEmailSender } from "@/server/integrations/email";
import {
  GatewayError,
  getGateway,
  type GatewayEvent,
  type GatewayId,
} from "@/server/integrations/payments";
import type { RequestMeta } from "./audit";
import { invalidateAuthCache } from "./session-resolver";

const D = (value: string | number | Prisma.Decimal): Prisma.Decimal => new Prisma.Decimal(value);

type Db = Prisma.TransactionClient;
type PaymentRow = Prisma.SubscriptionPaymentGetPayload<object>;
type SubRow = Prisma.SubscriptionGetPayload<{ include: { plan: true } }>;

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

const SYSTEM = (reason: string, tenantId: string | null) => ({ userId: null, reason, tenantId });

// ---------------------------------------------------------------------------
// Cobro de un periodo (SubscriptionPayment único por suscripción y periodo)
// ---------------------------------------------------------------------------

/** El cobro de la renovación que vence en `currentPeriodEnd`: se crea una vez y se reutiliza en cada reintento. */
async function ensureInvoice(
  db: Db,
  sub: SubRow,
  gateway: GatewayId | "MANUAL",
  now: Date,
): Promise<PaymentRow> {
  const periodStart = sub.currentPeriodEnd ?? now;
  const existing = await db.subscriptionPayment.findFirst({
    where: { subscriptionId: sub.id, periodStart },
  });
  if (existing) {
    // Si el plan cambió antes de pagar, el cobro pendiente toma el precio vigente.
    if (
      existing.status !== "PAID" &&
      !existing.gatewayPaymentId &&
      !existing.amount.eq(sub.plan.priceMonthly)
    ) {
      return db.subscriptionPayment.update({
        where: { id: existing.id },
        data: { amount: sub.plan.priceMonthly, currency: sub.plan.currency, checkoutUrl: null },
      });
    }
    return existing;
  }
  try {
    return await db.subscriptionPayment.create({
      data: {
        tenantId: sub.tenantId,
        subscriptionId: sub.id,
        gateway,
        amount: sub.plan.priceMonthly,
        currency: sub.plan.currency,
        status: "PENDING",
        attempt: 0,
        periodStart,
        periodEnd: addMonths(periodStart, 1),
      },
    });
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    return db.subscriptionPayment.findFirstOrThrow({
      where: { subscriptionId: sub.id, periodStart },
    });
  }
}

async function loadSub(db: Db, subscriptionId: string): Promise<SubRow> {
  return db.subscription.findFirstOrThrow({
    where: { id: subscriptionId },
    include: { plan: true },
  });
}

async function notifyAdmins(
  db: Db,
  tenantId: string,
  n: {
    kind: string;
    severity: "INFO" | "WARNING" | "CRITICAL";
    title: string;
    body: string;
    dedupeKey: string;
  },
): Promise<void> {
  await db.notification.createMany({
    data: [
      {
        tenantId,
        kind: n.kind,
        severity: n.severity,
        title: n.title,
        body: n.body,
        dedupeKey: n.dedupeKey,
      },
    ],
    skipDuplicates: true,
  });
}

interface MailJob {
  to: string;
  subject: string;
  text: string;
}

/** Correos pendientes: se envían DESPUÉS de confirmar la transacción (un fallo de SMTP no revierte el cobro). */
async function flush(mails: MailJob[]): Promise<void> {
  for (const mail of mails) {
    await getEmailSender()
      .send(mail)
      .catch((error: unknown) =>
        logger.error(
          { err: error, subject: mail.subject },
          "no se pudo enviar el correo de cobranza",
        ),
      );
  }
}

async function billingRecipient(db: Db, tenantId: string): Promise<string | null> {
  const tenant = await db.tenant.findFirst({
    where: { id: tenantId },
    select: { billingEmail: true, contactEmail: true, isDemo: true },
  });
  return tenant && !tenant.isDemo ? (tenant.billingEmail ?? tenant.contactEmail ?? null) : null;
}

// ---------------------------------------------------------------------------
// Aplicar el resultado de un cobro (webhook o cobro automático)
// ---------------------------------------------------------------------------

export type EventOutcome =
  "APPLIED" | "DUPLICATE" | "IGNORED" | "UNKNOWN_PAYMENT" | "MISMATCH" | "OUT_OF_SEQUENCE";

/**
 * Aplica un evento de pasarela YA VERIFICADO. El cobro se ubica por el id que nosotros enviamos
 * (nunca por datos del evento), se comprueba monto y moneda, y es idempotente por id de evento.
 */
export async function applyGatewayEvent(
  source: GatewayId | "MANUAL",
  event: GatewayEvent,
  now: Date = new Date(),
): Promise<EventOutcome> {
  if (event.type === "IGNORED") return "IGNORED";
  const paymentId = z.uuid().safeParse(event.paymentId);
  const known = paymentId.success
    ? await withPlatform((db) =>
        db.subscriptionPayment.findFirst({
          where: { id: paymentId.data },
          select: { id: true, tenantId: true },
        }),
      )
    : null;
  if (!known) {
    logger.warn({ source, eventId: event.id }, "evento de pasarela sin cobro conocido");
    return "UNKNOWN_PAYMENT";
  }
  const mails: MailJob[] = [];
  const outcome = await withAdmin(SYSTEM(`Evento de cobro ${source}`, known.tenantId), (admin) =>
    admin.$transaction(async (tx) => {
      // Idempotencia: un evento (por id) se procesa una sola vez, aunque la pasarela lo reenvíe o lleguen dos a la vez.
      try {
        await tx.webhookEvent.create({
          data: {
            tenantId: known.tenantId,
            source: `billing:${source.toLowerCase()}`,
            externalId: event.id,
            signatureValid: true,
            payload: {
              type: event.type,
              paymentId: known.id,
              gatewayPaymentId: event.gatewayPaymentId,
            },
          },
        });
      } catch (error) {
        if (isUniqueViolation(error)) return "DUPLICATE" as const;
        throw error;
      }
      const payment = await tx.subscriptionPayment.findFirstOrThrow({ where: { id: known.id } });
      const sub = await loadSub(tx, payment.subscriptionId);
      const result =
        event.type === "PAYMENT_SUCCEEDED"
          ? await applySuccess(tx, sub, payment, source, event, now, mails)
          : await applyFailure(tx, sub, payment, event, now, mails);
      await tx.webhookEvent.updateMany({
        where: { source: `billing:${source.toLowerCase()}`, externalId: event.id },
        data: { processedAt: now, error: result === "APPLIED" ? null : result.toLowerCase() },
      });
      return result;
    }),
  );
  if (outcome === "APPLIED") invalidateAuthCache();
  await flush(mails);
  return outcome;
}

async function applySuccess(
  tx: Db,
  sub: SubRow,
  payment: PaymentRow,
  source: GatewayId | "MANUAL",
  event: GatewayEvent,
  now: Date,
  mails: MailJob[],
): Promise<EventOutcome> {
  if (payment.status === "PAID") return "DUPLICATE";
  if (
    (event.amount !== null && !D(event.amount).eq(payment.amount)) ||
    (event.currency !== null && event.currency !== payment.currency)
  ) {
    await notifyAdmins(tx, sub.tenantId, {
      kind: "billing.mismatch",
      severity: "CRITICAL",
      title: "Pago con monto distinto al cobro",
      body: `Esperado ${payment.currency} ${payment.amount.toFixed(2)}; la pasarela informó ${event.currency ?? "?"} ${event.amount ?? "?"}. No se activó la suscripción: contacta a soporte.`,
      dedupeKey: `billing-mismatch:${payment.id}`,
    });
    return "MISMATCH";
  }
  const inSequence =
    sub.currentPeriodEnd !== null &&
    payment.periodStart !== null &&
    payment.periodStart.getTime() === sub.currentPeriodEnd.getTime();
  const tenant = await tx.tenant.findFirstOrThrow({ where: { id: sub.tenantId } });
  const wasSuspended = sub.status === "SUSPENDED";
  const covered = periodCoveredBy(sub.currentPeriodEnd, now, wasSuspended);

  await tx.subscriptionPayment.update({
    where: { id: payment.id },
    data: {
      status: "PAID",
      paidAt: now,
      gatewayPaymentId: event.gatewayPaymentId ?? payment.gatewayPaymentId,
      failureCode: null,
      failureMessage: null,
      checkoutUrl: null,
      ...(inSequence ? { periodEnd: covered.end } : {}),
    },
  });
  if (!inSequence) {
    // Un cobro de un periodo que ya no es el vigente: queda registrado pero no extiende nada (evita regalar tiempo).
    await notifyAdmins(tx, sub.tenantId, {
      kind: "billing.out_of_sequence",
      severity: "WARNING",
      title: "Pago de un periodo anterior",
      body: "Se registró un pago que no corresponde al periodo vigente; no se extendió la suscripción.",
      dedupeKey: `billing-oos:${payment.id}`,
    });
    return "OUT_OF_SEQUENCE";
  }
  await tx.subscription.update({
    where: { id: sub.id },
    data: {
      status: "ACTIVE",
      currentPeriodStart: covered.start,
      currentPeriodEnd: covered.end,
      graceEndsAt: null,
      retryCount: 0,
      nextRetryAt: null,
      ...(event.gatewayCustomerId ? { gatewayCustomerId: event.gatewayCustomerId } : {}),
      ...(event.paymentMethodId ? { gatewayPaymentMethodId: event.paymentMethodId } : {}),
      ...(source !== "MANUAL" ? { gateway: source } : {}),
    },
  });
  // Solo se levanta solo lo que el cobro automático suspendió; una suspensión manual del SuperAdmin se respeta.
  if (tenant.status === "SUSPENDED" && tenant.suspendedByBilling) {
    await tx.tenant.update({
      where: { id: tenant.id },
      data: {
        status: "ACTIVE",
        suspendedAt: null,
        suspendedReason: null,
        suspendedByBilling: false,
      },
    });
  }
  await tx.auditLog.create({
    data: {
      tenantId: sub.tenantId,
      actorType: source === "MANUAL" ? "SUPERADMIN" : "WEBHOOK",
      action: "subscription.payment_applied",
      entityType: "subscription",
      entityId: sub.id,
      before: { status: sub.status, periodEnd: sub.currentPeriodEnd },
      after: { status: "ACTIVE", periodEnd: covered.end, paymentId: payment.id, source },
    },
  });
  await notifyAdmins(tx, sub.tenantId, {
    kind: "billing.paid",
    severity: "INFO",
    title: "Pago de suscripción recibido",
    body: `Tu suscripción está activa hasta el ${covered.end.toISOString().slice(0, 10)}.`,
    dedupeKey: `billing-paid:${payment.id}`,
  });
  const to = await billingRecipient(tx, sub.tenantId);
  if (to)
    mails.push({
      to,
      subject: "Pago recibido — gracias",
      text: `Recibimos tu pago de ${payment.currency} ${payment.amount.toFixed(2)}. Tu suscripción está activa hasta el ${covered.end.toISOString().slice(0, 10)}.`,
    });
  return "APPLIED";
}

async function applyFailure(
  tx: Db,
  sub: SubRow,
  payment: PaymentRow,
  event: GatewayEvent,
  now: Date,
  mails: MailJob[],
): Promise<EventOutcome> {
  if (payment.status === "PAID") return "DUPLICATE";
  const config = getBillingConfig();
  const failures = sub.retryCount + 1;
  await tx.subscriptionPayment.update({
    where: { id: payment.id },
    data: {
      status: "FAILED",
      attempt: { increment: 1 },
      failureCode: event.failureCode,
      failureMessage: event.failureMessage?.slice(0, 300) ?? null,
      gatewayPaymentId: event.gatewayPaymentId ?? payment.gatewayPaymentId,
    },
  });
  const ended = sub.currentPeriodEnd !== null && sub.currentPeriodEnd.getTime() <= now.getTime();
  await tx.subscription.update({
    where: { id: sub.id },
    data: {
      retryCount: failures,
      nextRetryAt: nextRetryAfterFailure(failures, now, config),
      status: sub.status === "ACTIVE" && !ended ? "PAST_DUE" : sub.status,
    },
  });
  await notifyAdmins(tx, sub.tenantId, {
    kind: "billing.failed",
    severity: "WARNING",
    title: "No pudimos cobrar tu suscripción",
    body: `${event.failureMessage ?? "Pago rechazado"}. Actualiza tu método de pago en Suscripción.`,
    dedupeKey: `billing-failed:${payment.id}:${failures}`,
  });
  const to = await billingRecipient(tx, sub.tenantId);
  if (to)
    mails.push({
      to,
      subject: "No pudimos cobrar tu suscripción",
      text: `El cobro de ${payment.currency} ${payment.amount.toFixed(2)} fue rechazado (${event.failureMessage ?? "pago rechazado"}). Ingresa a ${getEnv().APP_URL}/app/subscription para pagar.`,
    });
  return "APPLIED";
}

// ---------------------------------------------------------------------------
// Ciclo automático (job)
// ---------------------------------------------------------------------------

export interface CycleSummary {
  invoices: number;
  charged: number;
  chargeFailed: number;
  graced: number;
  suspended: number;
  canceled: number;
  reminded: number;
}

/**
 * Recorre las suscripciones de cuentas reales y ejecuta lo que toca (ver `decideCycle`):
 * generar el cobro de renovación, cobrarlo con el método guardado o recordarlo, entrar en gracia,
 * suspender al vencer la gracia y cerrar las cancelaciones. Idempotente: puede correr cada hora.
 */
export async function runBillingCycle(
  now: Date = new Date(),
  options: { tenantId?: string } = {},
): Promise<CycleSummary> {
  const summary: CycleSummary = {
    invoices: 0,
    charged: 0,
    chargeFailed: 0,
    graced: 0,
    suspended: 0,
    canceled: 0,
    reminded: 0,
  };
  const config = getBillingConfig();
  const subs = await withPlatform((db) =>
    db.subscription.findMany({
      where: {
        status: { in: ["ACTIVE", "PAST_DUE", "GRACE"] },
        tenant: { isDemo: false, deletedAt: null },
        ...(options.tenantId ? { tenantId: options.tenantId } : {}),
      },
      select: { id: true, tenantId: true },
    }),
  );
  for (const { id, tenantId } of subs) {
    try {
      const action = await withPlatform(async (db) => {
        const sub = await db.subscription.findFirstOrThrow({ where: { id } });
        const open = sub.currentPeriodEnd
          ? await db.subscriptionPayment.findFirst({
              where: {
                subscriptionId: id,
                periodStart: sub.currentPeriodEnd,
                status: { in: ["PENDING", "FAILED"] },
              },
              select: { id: true },
            })
          : null;
        return decideCycle(
          {
            status: sub.status,
            currentPeriodEnd: sub.currentPeriodEnd,
            graceEndsAt: sub.graceEndsAt,
            retryCount: sub.retryCount,
            nextRetryAt: sub.nextRetryAt,
            cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
            hasOpenInvoice: open !== null,
          },
          now,
          config,
        );
      });
      if (action === "NONE") continue;
      await executeAction(action, id, tenantId, now, summary);
    } catch (error) {
      logger.error(
        { err: error, subscriptionId: id, tenantId },
        "falló el ciclo de cobro de una suscripción",
      );
    }
  }
  return summary;
}

async function executeAction(
  action: CycleAction,
  subscriptionId: string,
  tenantId: string,
  now: Date,
  summary: CycleSummary,
): Promise<void> {
  const gateway = getGateway();
  const mails: MailJob[] = [];
  const config = getBillingConfig();

  if (action === "SUSPEND" || action === "CANCEL") {
    await withAdmin(
      SYSTEM(
        action === "SUSPEND" ? "Suspensión por falta de pago" : "Cierre de suscripción cancelada",
        tenantId,
      ),
      (admin) =>
        admin.$transaction(async (tx) => {
          const sub = await loadSub(tx, subscriptionId);
          const billing = action === "SUSPEND";
          await tx.subscription.update({
            where: { id: subscriptionId },
            data: {
              status: billing ? "SUSPENDED" : "CANCELED",
              ...(billing ? {} : { canceledAt: now }),
            },
          });
          await tx.tenant.update({
            where: { id: tenantId },
            data: {
              status: "SUSPENDED",
              suspendedAt: now,
              suspendedReason: billing
                ? "Falta de pago de la suscripción"
                : "Suscripción cancelada",
              suspendedByBilling: billing,
            },
          });
          await tx.auditLog.create({
            data: {
              tenantId,
              actorType: "SYSTEM",
              action: billing
                ? "subscription.suspended_unpaid"
                : "subscription.canceled_at_period_end",
              entityType: "subscription",
              entityId: subscriptionId,
              before: { status: sub.status },
              after: { status: billing ? "SUSPENDED" : "CANCELED" },
            },
          });
          const to = await billingRecipient(tx, tenantId);
          if (to)
            mails.push({
              to,
              subject: billing
                ? "Tu cuenta fue suspendida por falta de pago"
                : "Tu suscripción terminó",
              text: billing
                ? `Suspendimos el acceso porque no recibimos el pago. Tus datos están a salvo: al pagar en ${getEnv().APP_URL}/app/subscription se reactiva de inmediato.`
                : "Tu suscripción terminó. Tus datos se conservan según la política de retención.",
            });
        }),
    );
    invalidateAuthCache();
    summary[action === "SUSPEND" ? "suspended" : "canceled"] += 1;
    await flush(mails);
    return;
  }

  // Estas acciones necesitan el cobro del periodo.
  const prepared = await withAdmin(SYSTEM("Ciclo de cobro de suscripciones", tenantId), (admin) =>
    admin.$transaction(async (tx) => {
      const sub = await loadSub(tx, subscriptionId);
      const invoice = await ensureInvoice(tx, sub, gateway?.id ?? "MANUAL", now);
      if (action === "ENTER_GRACE" && sub.currentPeriodEnd) {
        await tx.subscription.update({
          where: { id: subscriptionId },
          data: {
            status: "GRACE",
            graceEndsAt: graceEnd(sub.currentPeriodEnd, config),
            nextRetryAt: sub.nextRetryAt ?? now,
          },
        });
        await notifyAdmins(tx, tenantId, {
          kind: "billing.grace",
          severity: "CRITICAL",
          title: "Tu suscripción venció: periodo de gracia",
          body: `Tienes ${config.graceDays} día(s) de acceso para pagar antes de la suspensión.`,
          dedupeKey: `billing-grace:${invoice.id}`,
        });
        const to = await billingRecipient(tx, tenantId);
        if (to)
          mails.push({
            to,
            subject: "Tu suscripción venció: tienes un periodo de gracia",
            text: `No recibimos el pago. Mantienes el acceso ${config.graceDays} día(s) más; paga en ${getEnv().APP_URL}/app/subscription para evitar la suspensión.`,
          });
      }
      const fresh = await loadSub(tx, subscriptionId);
      return { sub: fresh, invoice, email: await billingRecipient(tx, tenantId) };
    }),
  );
  if (action === "CREATE_INVOICE") summary.invoices += 1;
  if (action === "ENTER_GRACE") {
    // Entrar en gracia solo cambia el estado y avisa; el calendario de reintentos sigue su curso (no se cobra de más).
    summary.graced += 1;
    await flush(mails);
    return;
  }

  const canAuto = Boolean(
    gateway?.supportsAutoCharge &&
    gateway.charge &&
    prepared.sub.gatewayCustomerId &&
    prepared.sub.gatewayPaymentMethodId,
  );
  if (
    canAuto &&
    gateway?.charge &&
    prepared.sub.gatewayCustomerId &&
    prepared.sub.gatewayPaymentMethodId
  ) {
    // El cobro a la pasarela va FUERA de cualquier transacción.
    try {
      const attempt = prepared.invoice.attempt + 1;
      const result = await gateway.charge({
        paymentId: prepared.invoice.id,
        amount: prepared.invoice.amount.toFixed(2),
        currency: prepared.invoice.currency,
        description: `Suscripción ${prepared.sub.plan.name}`,
        gatewayCustomerId: prepared.sub.gatewayCustomerId,
        paymentMethodId: prepared.sub.gatewayPaymentMethodId,
        idempotencyKey: `renewal-${prepared.invoice.id}-${attempt}`,
      });
      const outcome = await applyGatewayEvent(
        gateway.id,
        {
          id: `charge:${prepared.invoice.id}:${attempt}`,
          type: result.status === "SUCCEEDED" ? "PAYMENT_SUCCEEDED" : "PAYMENT_FAILED",
          paymentId: prepared.invoice.id,
          gatewayPaymentId: result.gatewayPaymentId,
          gatewayCustomerId: null,
          paymentMethodId: null,
          amount: result.status === "SUCCEEDED" ? prepared.invoice.amount.toFixed(2) : null,
          currency: result.status === "SUCCEEDED" ? prepared.invoice.currency : null,
          failureCode: result.failureCode,
          failureMessage: result.failureMessage,
        },
        now,
      );
      if (outcome === "APPLIED")
        summary[result.status === "SUCCEEDED" ? "charged" : "chargeFailed"] += 1;
    } catch (error) {
      if (!(error instanceof GatewayError)) throw error;
      // Fallo transitorio de la pasarela: se vuelve a intentar en una hora sin contarlo como cobro fallido.
      await withAdmin(SYSTEM("Reintento de cobro por fallo de la pasarela", tenantId), (admin) =>
        admin.subscription.update({
          where: { id: subscriptionId },
          data: { nextRetryAt: new Date(now.getTime() + 3_600_000) },
        }),
      );
      logger.warn({ err: error, tenantId }, "la pasarela no respondió; se reintenta");
    }
    return;
  }

  // Sin cobro automático: se envía el recordatorio con el enlace de pago (una vez por día y cobro).
  await withAdmin(SYSTEM("Recordatorio de pago de suscripción", tenantId), (admin) =>
    admin.$transaction(async (tx) => {
      const day = now.toISOString().slice(0, 10);
      await notifyAdmins(tx, tenantId, {
        kind: "billing.due",
        severity: "WARNING",
        title: "Tienes un pago de suscripción pendiente",
        body: `${prepared.invoice.currency} ${prepared.invoice.amount.toFixed(2)} — paga desde Suscripción.`,
        dedupeKey: `billing-due:${prepared.invoice.id}:${day}`,
      });
      // Si ya hay reintentos programados, el siguiente se deja para su fecha.
      if (action === "RETRY_CHARGE") {
        const sub = await tx.subscription.findFirstOrThrow({ where: { id: subscriptionId } });
        const failures = sub.retryCount + 1;
        await tx.subscription.update({
          where: { id: subscriptionId },
          data: { retryCount: failures, nextRetryAt: nextRetryAfterFailure(failures, now, config) },
        });
      }
    }),
  );
  summary.reminded += 1;
  if (prepared.email) {
    await flush([
      {
        to: prepared.email,
        subject: "Pago de suscripción pendiente",
        text: `Tienes un pago pendiente de ${prepared.invoice.currency} ${prepared.invoice.amount.toFixed(2)}. Págalo en ${getEnv().APP_URL}/app/subscription.`,
      },
    ]);
  }
}

// ---------------------------------------------------------------------------
// Pantalla de la empresa: ver, pagar, cancelar
// ---------------------------------------------------------------------------

export async function getSubscriptionView(actor: AuthUser, now: Date = new Date()) {
  requirePermission(actor, "settings:ver");
  const gateway = getGateway();
  return withTenant(requireTenantId(actor), async (tx) => {
    const sub = await tx.subscription.findFirst({
      orderBy: { createdAt: "desc" },
      include: { plan: true },
    });
    if (!sub) throw new NotFoundError("Suscripción");
    const tenant = await tx.tenant.findFirstOrThrow({ select: { isDemo: true } });
    const payments = await tx.subscriptionPayment.findMany({
      where: { subscriptionId: sub.id },
      orderBy: { createdAt: "desc" },
      take: 12,
    });
    const due = sub.currentPeriodEnd
      ? payments.find(
          (p) =>
            p.periodStart?.getTime() === sub.currentPeriodEnd?.getTime() && p.status !== "PAID",
        )
      : undefined;
    return {
      isDemo: tenant.isDemo,
      plan: {
        code: sub.plan.code,
        name: sub.plan.name,
        price: sub.plan.priceMonthly.toFixed(2),
        currency: sub.plan.currency,
      },
      status: sub.status,
      hasAccess: hasAccess(sub.status),
      currentPeriodEnd: sub.currentPeriodEnd,
      daysToRenewal: sub.currentPeriodEnd ? daysLeft(sub.currentPeriodEnd, now) : null,
      graceEndsAt: sub.graceEndsAt,
      graceDaysLeft: sub.graceEndsAt ? daysLeft(sub.graceEndsAt, now) : null,
      cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
      autoChargeReady: Boolean(gateway?.supportsAutoCharge && sub.gatewayPaymentMethodId),
      gateway: gateway?.id ?? null,
      canPayOnline: gateway !== null,
      dueAmount: due ? due.amount.toFixed(2) : null,
      payments: payments.map((p) => ({
        id: p.id,
        amount: p.amount.toFixed(2),
        currency: p.currency,
        status: p.status,
        paidAt: p.paidAt,
        createdAt: p.createdAt,
        periodStart: p.periodStart,
        failureMessage: p.failureMessage,
        gateway: p.gateway,
      })),
    };
  });
}

/**
 * Crea el enlace de pago del periodo pendiente. Se puede pagar dentro de la ventana de renovación o
 * cuando la suscripción ya está vencida/en gracia/suspendida; antes no hay nada que cobrar.
 */
export async function startCheckout(
  actor: AuthUser,
  now: Date = new Date(),
): Promise<{ url: string }> {
  requirePermission(actor, "settings:editar");
  const gateway = getGateway();
  if (!gateway)
    throw new ConflictError(
      "NO_GATEWAY",
      "El cobro en línea no está habilitado. Contacta a soporte para pagar por transferencia.",
    );
  const tenantId = requireTenantId(actor);
  const config = getBillingConfig();
  const data = await withTenant(tenantId, async (tx) => {
    const sub = await tx.subscription.findFirst({
      orderBy: { createdAt: "desc" },
      include: { plan: true },
    });
    if (!sub?.currentPeriodEnd) throw new NotFoundError("Suscripción");
    const tenant = await tx.tenant.findFirstOrThrow({
      select: { isDemo: true, billingEmail: true, contactEmail: true },
    });
    if (tenant.isDemo) throw new ConflictError("DEMO", "Las cuentas demo no se cobran");
    if (sub.status === "CANCELED")
      throw new ConflictError("SUB_CANCELED", "La suscripción está cancelada");
    const windowOpens = sub.currentPeriodEnd.getTime() - config.renewalLeadDays * 86_400_000;
    if (sub.status === "ACTIVE" && now.getTime() < windowOpens)
      throw new ConflictError(
        "NOTHING_DUE",
        "Tu suscripción está al día: aún no hay nada por pagar",
      );
    return { sub, email: tenant.billingEmail ?? tenant.contactEmail ?? actor.email };
  });
  const invoice = await withAdmin(SYSTEM("Crear cobro de suscripción", tenantId), (admin) =>
    admin.$transaction(async (tx) =>
      ensureInvoice(tx, await loadSub(tx, data.sub.id), gateway.id, now),
    ),
  );
  const base = getEnv().APP_URL.replace(/\/$/, "");
  const session = await gateway.createCheckout({
    paymentId: invoice.id,
    amount: invoice.amount.toFixed(2),
    currency: invoice.currency,
    description: `Suscripción ${data.sub.plan.name} — Mecania`,
    customerEmail: data.email,
    gatewayCustomerId: data.sub.gatewayCustomerId,
    saveMethod: gateway.supportsAutoCharge,
    successUrl: `${base}/app/subscription?pago=ok`,
    cancelUrl: `${base}/app/subscription?pago=cancelado`,
  });
  await withAdmin(SYSTEM("Guardar enlace de pago", tenantId), (admin) =>
    admin.subscriptionPayment.update({
      where: { id: invoice.id },
      data: { checkoutUrl: session.url, gateway: gateway.id },
    }),
  );
  return { url: session.url };
}

/** Cancelar (o reanudar) al final del periodo pagado: el acceso continúa hasta esa fecha. */
export async function setCancelAtPeriodEnd(
  actor: AuthUser,
  cancel: boolean,
  meta: RequestMeta = {},
): Promise<void> {
  requirePermission(actor, "settings:editar");
  const tenantId = requireTenantId(actor);
  // La empresa solo LEE su suscripción (RLS de solo lectura): el cambio lo hace el sistema, auditado a nombre de quien lo pidió.
  const sub = await withTenant(tenantId, (tx) =>
    tx.subscription.findFirst({ orderBy: { createdAt: "desc" } }),
  );
  if (!sub) throw new NotFoundError("Suscripción");
  if (!["ACTIVE", "PAST_DUE"].includes(sub.status))
    throw new ConflictError("SUB_STATE", "Solo se puede cancelar una suscripción vigente");
  await withAdmin(SYSTEM(`Cancelación solicitada por ${actor.email}`, tenantId), (admin) =>
    admin.$transaction(async (tx) => {
      await tx.subscription.update({ where: { id: sub.id }, data: { cancelAtPeriodEnd: cancel } });
      await tx.auditLog.create({
        data: {
          tenantId,
          actorType: "USER",
          actorUserId: actor.userId,
          action: cancel ? "subscription.cancel_requested" : "subscription.cancel_withdrawn",
          entityType: "subscription",
          entityId: sub.id,
          ip: meta.ip ?? null,
          requestId: meta.requestId ?? null,
        },
      });
    }),
  );
}

// ---------------------------------------------------------------------------
// SuperAdmin
// ---------------------------------------------------------------------------

const manualPaymentSchema = z.object({
  tenantId: z.uuid(),
  amount: z.coerce.number().positive().max(1_000_000),
  reference: z.string().trim().min(3, "Indica la referencia de la transferencia").max(120),
});

/** Registra un pago hecho fuera de la pasarela (transferencia): sigue exactamente el mismo camino que un webhook. */
export async function recordManualPayment(
  actor: AuthUser,
  input: z.input<typeof manualPaymentSchema>,
  meta: RequestMeta = {},
) {
  requireSuperAdmin(actor);
  const data = manualPaymentSchema.parse(input);
  const now = new Date();
  const invoice = await withAdmin(
    {
      userId: actor.userId,
      reason: `Pago manual: ${data.reference}`,
      tenantId: data.tenantId,
      ...(meta.ip ? { ip: meta.ip } : {}),
    },
    (admin) =>
      admin.$transaction(async (tx) => {
        const sub = await tx.subscription.findFirst({
          where: { tenantId: data.tenantId },
          orderBy: { createdAt: "desc" },
          include: { plan: true },
        });
        if (!sub?.currentPeriodEnd) throw new NotFoundError("Suscripción");
        if (sub.status === "CANCELED" || sub.status === "TRIALING")
          throw new ConflictError("SUB_STATE", "Esa suscripción no admite pagos");
        const invoice = await ensureInvoice(tx, sub, "MANUAL", now);
        if (invoice.status === "PAID")
          throw new ConflictError("ALREADY_PAID", "Ese periodo ya está pagado");
        await tx.subscriptionPayment.update({
          where: { id: invoice.id },
          data: { reference: data.reference },
        });
        return invoice;
      }),
  );
  const outcome = await applyGatewayEvent(
    "MANUAL",
    {
      // Monto y referencia forman parte del id: repetir EXACTAMENTE el mismo registro es idempotente, pero corregir un monto equivocado no queda bloqueado.
      id: `manual:${invoice.id}:${D(data.amount).toFixed(2)}:${data.reference}`,
      type: "PAYMENT_SUCCEEDED",
      paymentId: invoice.id,
      gatewayPaymentId: `manual-${invoice.id}`,
      gatewayCustomerId: null,
      paymentMethodId: null,
      amount: D(data.amount).toFixed(2),
      currency: invoice.currency,
      failureCode: null,
      failureMessage: null,
    },
    now,
  );
  if (outcome === "MISMATCH")
    throw new ConflictError(
      "AMOUNT_MISMATCH",
      `El monto no coincide con el cobro (${invoice.currency} ${invoice.amount.toFixed(2)})`,
    );
  return { paymentId: invoice.id, outcome };
}

const extendGraceSchema = z.object({
  tenantId: z.uuid(),
  days: z.coerce.number().int().min(1).max(30),
  reason: z.string().trim().min(5).max(200),
});

/** Concede más días de gracia (p. ej. a un cliente que avisó que paga mañana). Queda auditado. */
export async function extendGrace(
  actor: AuthUser,
  input: z.input<typeof extendGraceSchema>,
  meta: RequestMeta = {},
): Promise<void> {
  requireSuperAdmin(actor);
  const data = extendGraceSchema.parse(input);
  await withAdmin(
    {
      userId: actor.userId,
      reason: `Extender gracia: ${data.reason}`,
      tenantId: data.tenantId,
      ...(meta.ip ? { ip: meta.ip } : {}),
    },
    (admin) =>
      admin.$transaction(async (tx) => {
        const sub = await tx.subscription.findFirst({
          where: { tenantId: data.tenantId },
          orderBy: { createdAt: "desc" },
        });
        if (!sub) throw new NotFoundError("Suscripción");
        if (sub.status !== "GRACE" && sub.status !== "PAST_DUE")
          throw new ConflictError(
            "SUB_STATE",
            "Solo se extiende la gracia de una suscripción vencida",
          );
        const base =
          sub.graceEndsAt && sub.graceEndsAt.getTime() > Date.now() ? sub.graceEndsAt : new Date();
        const next = new Date(base.getTime() + data.days * 86_400_000);
        await tx.subscription.update({
          where: { id: sub.id },
          data: { graceEndsAt: next, status: "GRACE" },
        });
        await tx.auditLog.create({
          data: {
            tenantId: data.tenantId,
            actorType: "SUPERADMIN",
            actorUserId: actor.userId,
            action: "subscription.grace_extended",
            entityType: "subscription",
            entityId: sub.id,
            before: { graceEndsAt: sub.graceEndsAt },
            after: { graceEndsAt: next },
            reason: data.reason,
            ip: meta.ip ?? null,
          },
        });
      }),
  );
}

/** Panorama de cobranza para el panel de plataforma. */
export async function getBillingOverview(actor: AuthUser) {
  requireSuperAdmin(actor);
  return withPlatform(async (db) => {
    const [atRisk, recent] = await Promise.all([
      db.subscription.findMany({
        where: {
          status: { in: ["PAST_DUE", "GRACE", "SUSPENDED"] },
          tenant: { isDemo: false, deletedAt: null },
        },
        include: {
          tenant: { select: { id: true, legalName: true, tradeName: true } },
          plan: { select: { name: true, priceMonthly: true } },
        },
        orderBy: { currentPeriodEnd: "asc" },
        take: 100,
      }),
      db.subscriptionPayment.findMany({
        orderBy: { createdAt: "desc" },
        take: 30,
        include: {
          subscription: {
            select: { tenant: { select: { id: true, legalName: true, tradeName: true } } },
          },
        },
      }),
    ]);
    return {
      atRisk: atRisk.map((s) => ({
        tenantId: s.tenant.id,
        tenant: s.tenant.tradeName ?? s.tenant.legalName,
        plan: s.plan.name,
        price: s.plan.priceMonthly.toFixed(2),
        status: s.status,
        periodEnd: s.currentPeriodEnd,
        graceEndsAt: s.graceEndsAt,
        retryCount: s.retryCount,
      })),
      recent: recent.map((p) => ({
        id: p.id,
        tenantId: p.subscription.tenant.id,
        tenant: p.subscription.tenant.tradeName ?? p.subscription.tenant.legalName,
        amount: p.amount.toFixed(2),
        currency: p.currency,
        status: p.status,
        gateway: p.gateway,
        paidAt: p.paidAt,
        createdAt: p.createdAt,
        reference: p.reference,
      })),
    };
  });
}
