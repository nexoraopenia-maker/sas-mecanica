import { Prisma } from "@/lib/db";
import { PAYMENT_METHODS, type Method } from "./methods";

export { METHOD_LABEL, PAYMENT_METHODS, type Method } from "./methods";

/** `type` (no `interface`): se guarda tal cual en una columna JSON. */
export type SessionSummary = {
  opening: string;
  byMethod: Record<Method, string>;
  income: string;
  expense: string;
  /** Efectivo que debe haber en caja: apertura + cobros en efectivo (netos de devoluciones) + ingresos − egresos. */
  expectedCash: string;
};

const D = (value: string | number | Prisma.Decimal): Prisma.Decimal => new Prisma.Decimal(value);

/**
 * Resumen de una caja. Los cobros y las devoluciones son filas de `SalePayment` con signo, así que
 * el esperado por medio de pago es una suma exacta (sin ramas especiales por anulaciones).
 */
export function summarizeSession(
  opening: string,
  payments: Array<{ method: Method; amount: string }>,
  movements: Array<{ type: "INCOME" | "EXPENSE"; amount: string }>,
): SessionSummary {
  const byMethod = Object.fromEntries(PAYMENT_METHODS.map((m) => [m, D(0)])) as Record<
    Method,
    Prisma.Decimal
  >;
  for (const p of payments) byMethod[p.method] = byMethod[p.method].plus(p.amount);
  let income = D(0);
  let expense = D(0);
  for (const m of movements) {
    if (m.type === "INCOME") income = income.plus(m.amount);
    else expense = expense.plus(m.amount);
  }
  return {
    opening: D(opening).toFixed(2),
    byMethod: Object.fromEntries(PAYMENT_METHODS.map((m) => [m, byMethod[m].toFixed(2)])) as Record<
      Method,
      string
    >,
    income: income.toFixed(2),
    expense: expense.toFixed(2),
    expectedCash: D(opening).plus(byMethod.CASH).plus(income).minus(expense).toFixed(2),
  };
}

export type ReconcileLine = {
  expected: string;
  counted: string;
  difference: string;
};

/** Arqueo: contado − esperado por medio de pago (negativo = faltante). */
export function reconcile(
  summary: SessionSummary,
  counted: Partial<Record<Method, string>>,
): { lines: Record<Method, ReconcileLine>; cashDifference: string; totalDifference: string } {
  const lines = {} as Record<Method, ReconcileLine>;
  let total = D(0);
  for (const method of PAYMENT_METHODS) {
    const expected = method === "CASH" ? summary.expectedCash : summary.byMethod[method];
    // Los medios sin conteo informado se concilian contra lo registrado (no inventan diferencia).
    const value = counted[method] !== undefined ? D(counted[method] as string) : D(expected);
    const difference = value.minus(expected);
    lines[method] = {
      expected: D(expected).toFixed(2),
      counted: value.toFixed(2),
      difference: difference.toFixed(2),
    };
    total = total.plus(difference);
  }
  return { lines, cashDifference: lines.CASH.difference, totalDifference: total.toFixed(2) };
}
