import { z } from "zod";

const LIMA_OFFSET_MS = 5 * 3_600_000;

/** Día calendario de Lima (UTC−5) como `YYYY-MM-DD`. */
export function limaDay(date: Date): string {
  return new Date(date.getTime() - LIMA_OFFSET_MS).toISOString().slice(0, 10);
}

/** Inicio (00:00 Lima) de un día `YYYY-MM-DD` como instante UTC. */
export function startOfLimaDay(day: string): Date {
  return new Date(new Date(`${day}T00:00:00.000Z`).getTime() + LIMA_OFFSET_MS);
}

export const MAX_REPORT_DAYS = 400;

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Fecha inválida (AAAA-MM-DD)");

/** Rango de un reporte: desde/hasta INCLUSIVE, en días de Lima, con un máximo para no cargar la base. */
export const periodSchema = z
  .object({ from: day, to: day })
  .refine((p) => p.from <= p.to, {
    message: "La fecha inicial no puede ser posterior a la final",
    path: ["from"],
  })
  .refine(
    (p) =>
      (startOfLimaDay(p.to).getTime() - startOfLimaDay(p.from).getTime()) / 86_400_000 <
      MAX_REPORT_DAYS,
    {
      message: `El rango máximo es de ${MAX_REPORT_DAYS} días`,
      path: ["to"],
    },
  )
  .transform((p) => ({
    ...p,
    start: startOfLimaDay(p.from),
    endExclusive: new Date(startOfLimaDay(p.to).getTime() + 86_400_000),
  }));
export type Period = z.output<typeof periodSchema>;

/** Rango por defecto: del primer día del mes en curso a hoy (hora de Lima). */
export function defaultPeriod(now: Date = new Date()): { from: string; to: string } {
  const today = limaDay(now);
  return { from: `${today.slice(0, 8)}01`, to: today };
}
