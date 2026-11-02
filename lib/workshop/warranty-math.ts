export interface PolicyTerms {
  months: number | null;
  kilometers: number | null;
}

/** Suma meses de calendario sin desbordar (31-ene + 1 mes = 28/29-feb). */
export function addMonths(date: Date, months: number): Date {
  const result = new Date(date.getTime());
  const day = result.getUTCDate();
  result.setUTCDate(1);
  result.setUTCMonth(result.getUTCMonth() + months);
  const lastDay = new Date(
    Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0),
  ).getUTCDate();
  result.setUTCDate(Math.min(day, lastDay));
  return result;
}

export interface WarrantyWindow {
  startsAt: Date;
  expiresAt: Date | null;
  startMileage: number | null;
  expiresAtMileage: number | null;
}

/** Vigencia por fecha y/o kilometraje: la garantía acaba cuando se cumple lo PRIMERO que ocurra. */
export function computeWindow(
  startsAt: Date,
  policy: PolicyTerms,
  startMileage: number | null,
): WarrantyWindow {
  return {
    startsAt,
    expiresAt: policy.months ? addMonths(startsAt, policy.months) : null,
    startMileage,
    expiresAtMileage:
      policy.kilometers && startMileage !== null ? startMileage + policy.kilometers : null,
  };
}

export type CoverageReason = "EXPIRED_BY_DATE" | "EXPIRED_BY_MILEAGE" | "NOT_STARTED" | "VOID";

export interface Coverage {
  covered: boolean;
  reasons: CoverageReason[];
}

export const COVERAGE_LABEL: Record<CoverageReason, string> = {
  EXPIRED_BY_DATE: "La garantía venció por fecha",
  EXPIRED_BY_MILEAGE: "Se superó el kilometraje de la garantía",
  NOT_STARTED: "La garantía aún no comienza",
  VOID: "La garantía fue anulada o ya se resolvió",
};

export function coverage(
  warranty: WarrantyWindow & { status: "ACTIVE" | "EXPIRED" | "IN_CLAIM" | "VOID" },
  at: { now: Date; mileage: number | null },
): Coverage {
  const reasons: CoverageReason[] = [];
  if (warranty.status === "VOID") reasons.push("VOID");
  if (warranty.startsAt.getTime() > at.now.getTime()) reasons.push("NOT_STARTED");
  if (warranty.expiresAt && warranty.expiresAt.getTime() < at.now.getTime())
    reasons.push("EXPIRED_BY_DATE");
  if (
    warranty.expiresAtMileage !== null &&
    at.mileage !== null &&
    at.mileage > warranty.expiresAtMileage
  )
    reasons.push("EXPIRED_BY_MILEAGE");
  return { covered: reasons.length === 0, reasons };
}

export function daysUntil(date: Date, now: Date): number {
  return Math.ceil((date.getTime() - now.getTime()) / 86_400_000);
}

/** Avisos al cliente antes del vencimiento (días). */
export const WARRANTY_NOTICE_DAYS = [30, 7] as const;
