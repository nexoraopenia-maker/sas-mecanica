export type Light = "GREEN" | "AMBER" | "RED";

/** Días antes del vencimiento en que la deuda pasa a ámbar y se avisa al cliente. */
export const DUE_SOON_DAYS = 3;

const DAY = 86_400_000;

/**
 * Semáforo de una cuenta por cobrar: rojo = vencida, ámbar = vence en los próximos
 * `DUE_SOON_DAYS` días (incluido hoy), verde = a tiempo.
 */
export function trafficLight(dueDate: Date, now: Date): Light {
  if (dueDate.getTime() < now.getTime()) return "RED";
  return dueDate.getTime() - now.getTime() <= DUE_SOON_DAYS * DAY ? "AMBER" : "GREEN";
}

/** Días hasta el vencimiento (negativo = ya venció). */
export function daysToDue(dueDate: Date, now: Date): number {
  return Math.ceil((dueDate.getTime() - now.getTime()) / DAY);
}

export const LIGHT_LABEL: Record<Light, string> = {
  GREEN: "A tiempo",
  AMBER: "Por vencer",
  RED: "Vencida",
};
