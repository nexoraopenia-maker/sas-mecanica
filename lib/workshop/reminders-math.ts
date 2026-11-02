import { addMonths } from "./warranty-math";

export interface ReminderLike {
  dueDate: Date | null;
  dueMileage: number | null;
}

/** Anticipación con la que se avisa: 7 días o 500 km antes. */
export const REMINDER_LEAD_DAYS = 7;
export const REMINDER_LEAD_KM = 500;

/** Intervalos por defecto de un cambio de aceite (editables en cada recordatorio). */
export const DEFAULT_OIL_INTERVAL_KM = 5_000;
export const DEFAULT_OIL_INTERVAL_MONTHS = 6;

export function isReminderDue(
  reminder: ReminderLike,
  vehicleMileage: number | null,
  now: Date,
): boolean {
  const byDate =
    reminder.dueDate !== null &&
    reminder.dueDate.getTime() - REMINDER_LEAD_DAYS * 86_400_000 <= now.getTime();
  const byMileage =
    reminder.dueMileage !== null &&
    vehicleMileage !== null &&
    vehicleMileage >= reminder.dueMileage - REMINDER_LEAD_KM;
  return byDate || byMileage;
}

/** Próxima fecha/kilometraje a partir de un servicio realizado hoy. */
export function nextDue(
  from: { date: Date; mileage: number | null },
  interval: { months: number | null; km: number | null },
): { dueDate: Date | null; dueMileage: number | null } {
  return {
    dueDate: interval.months ? addMonths(from.date, interval.months) : null,
    dueMileage: interval.km && from.mileage !== null ? from.mileage + interval.km : null,
  };
}
