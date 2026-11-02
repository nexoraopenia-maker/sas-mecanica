import { addMonths } from "@/lib/workshop/warranty-math";

export type SubStatus = "TRIALING" | "ACTIVE" | "PAST_DUE" | "GRACE" | "SUSPENDED" | "CANCELED";

export interface BillingConfig {
  /** Días de acceso tras vencer el periodo sin pago, antes de suspender. */
  graceDays: number;
  /** Días de espera entre cobros automáticos fallidos: [1, 3, 5] = reintenta 1, 3 y 5 días después. */
  retryDays: readonly number[];
  /** Cuántos días antes del vencimiento se genera el cobro de la renovación. */
  renewalLeadDays: number;
}

export const DEFAULT_BILLING_CONFIG: BillingConfig = {
  graceDays: 7,
  retryDays: [1, 3, 5],
  renewalLeadDays: 3,
};

export interface SubSnapshot {
  status: SubStatus;
  currentPeriodEnd: Date | null;
  graceEndsAt: Date | null;
  retryCount: number;
  nextRetryAt: Date | null;
  cancelAtPeriodEnd: boolean;
  /** ¿Existe ya un cobro PENDING para el periodo que viene? */
  hasOpenInvoice: boolean;
}

export type CycleAction =
  "NONE" | "CREATE_INVOICE" | "RETRY_CHARGE" | "ENTER_GRACE" | "SUSPEND" | "CANCEL";

const DAY = 86_400_000;

/**
 * Qué toca hacer con una suscripción AHORA. Una sola acción por pasada, por prioridad:
 * suspender > cancelar > entrar en gracia > reintentar cobro > generar el cobro de renovación.
 * Es pura: el motor la ejecuta y vuelve a evaluar en la siguiente pasada.
 */
export function decideCycle(
  sub: SubSnapshot,
  now: Date,
  config: BillingConfig = DEFAULT_BILLING_CONFIG,
): CycleAction {
  if (sub.status === "TRIALING" || sub.status === "CANCELED" || sub.status === "SUSPENDED")
    return "NONE";
  const end = sub.currentPeriodEnd;
  if (!end) return "NONE";
  const ended = now.getTime() >= end.getTime();

  if (sub.status === "GRACE" && sub.graceEndsAt && now.getTime() >= sub.graceEndsAt.getTime())
    return "SUSPEND";
  if (ended && sub.cancelAtPeriodEnd) return "CANCEL";
  if (ended && sub.status !== "GRACE") return "ENTER_GRACE";
  const retryDue =
    sub.nextRetryAt !== null &&
    sub.nextRetryAt.getTime() <= now.getTime() &&
    sub.retryCount < config.retryDays.length + 1;
  // También en ACTIVE: un cobro automático que falló por la red debe reintentarse sin esperar a que venza el periodo.
  if (retryDue) return "RETRY_CHARGE";
  const inRenewalWindow = !ended && now.getTime() >= end.getTime() - config.renewalLeadDays * DAY;
  if (sub.status === "ACTIVE" && inRenewalWindow && !sub.cancelAtPeriodEnd && !sub.hasOpenInvoice)
    return "CREATE_INVOICE";
  return "NONE";
}

/** Fin de la gracia: el periodo vencido más los días configurados. */
export function graceEnd(periodEnd: Date, config: BillingConfig = DEFAULT_BILLING_CONFIG): Date {
  return new Date(periodEnd.getTime() + config.graceDays * DAY);
}

/** Próximo reintento tras el fallo número `failures` (1 = primer fallo). null = ya no hay más reintentos automáticos. */
export function nextRetryAfterFailure(
  failures: number,
  from: Date,
  config: BillingConfig = DEFAULT_BILLING_CONFIG,
): Date | null {
  const wait = config.retryDays[failures - 1];
  return wait === undefined ? null : new Date(from.getTime() + wait * DAY);
}

/**
 * Periodo que cubre un pago. Pagar a tiempo (antes de terminar el periodo o dentro de la gracia)
 * continúa donde terminó el anterior: no se regala ni se pierde tiempo. Pagar tras suspensión
 * arranca hoy.
 */
export function periodCoveredBy(
  previousEnd: Date | null,
  paidAt: Date,
  wasSuspended: boolean,
): { start: Date; end: Date } {
  const continues = previousEnd !== null && !wasSuspended;
  const start = continues && previousEnd ? previousEnd : paidAt;
  return { start, end: addMonths(start, 1) };
}

/** ¿El acceso a la plataforma está permitido en este estado? (La gracia sí; la suspensión no.) */
export function hasAccess(status: SubStatus): boolean {
  return (
    status === "TRIALING" || status === "ACTIVE" || status === "PAST_DUE" || status === "GRACE"
  );
}

/** Días completos que faltan para una fecha (0 si ya pasó). */
export function daysLeft(until: Date, now: Date): number {
  return Math.max(0, Math.ceil((until.getTime() - now.getTime()) / DAY));
}
