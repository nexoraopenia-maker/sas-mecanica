export interface TireSize {
  width: number;
  aspectRatio: number;
  rimDiameter: number;
}

/**
 * Interpreta una medida de llanta escrita de varias formas:
 * "205/55 R16", "205/55R16", "205-55-16", "205 55 16", "2055516", "205/55 R16.5".
 */
export function parseTireSize(input: string): TireSize | null {
  const text = input.trim().toUpperCase();
  const separated = /^(\d{3})\s*[/\-\s]\s*(\d{2})\s*[-\sR]*\s*(\d{2}(?:[.,]5)?)$/.exec(text);
  const compact = /^(\d{3})(\d{2})(\d{2})$/.exec(text);
  const match = separated ?? compact;
  if (!match) return null;
  const width = Number(match[1]);
  const aspectRatio = Number(match[2]);
  const rimDiameter = Number((match[3] ?? "").replace(",", "."));
  if (
    width < 125 ||
    width > 405 ||
    aspectRatio < 25 ||
    aspectRatio > 95 ||
    rimDiameter < 10 ||
    rimDiameter > 30
  )
    return null;
  return { width, aspectRatio, rimDiameter };
}

export function formatTireSize(size: TireSize): string {
  return `${size.width}/${size.aspectRatio} R${size.rimDiameter}`;
}

export interface ParsedDot {
  week: number;
  year: number;
  /** Lunes de la semana de fabricación (UTC). */
  manufacturedAt: Date;
}

const DOT_PATTERN = /^(0[1-9]|[1-4]\d|5[0-3])(\d{2})$/;

/**
 * DOT = semana (01–53) + año (2 dígitos) de fabricación, p. ej. "2423" = semana 24 de 2023.
 * Rechaza fechas futuras (más de una semana adelante) y anteriores al 2000.
 */
export function parseDot(dot: string, now: Date = new Date()): ParsedDot | null {
  const match = DOT_PATTERN.exec(dot.trim());
  if (!match) return null;
  const week = Number(match[1]);
  const year = 2000 + Number(match[2]);
  // Semana ISO: la semana 1 contiene el 4 de enero.
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const jan4Day = (jan4.getUTCDay() + 6) % 7; // lunes = 0
  const manufacturedAt = new Date(Date.UTC(year, 0, 4 - jan4Day + (week - 1) * 7));
  if (manufacturedAt.getTime() > now.getTime() + 7 * 86_400_000) return null;
  return { week, year, manufacturedAt };
}

/** Antigüedad de una llanta en años (decimal), contada desde la semana de fabricación. */
export function tireAgeYears(manufacturedAt: Date, now: Date = new Date()): number {
  return (now.getTime() - manufacturedAt.getTime()) / (365.25 * 86_400_000);
}

export function isTireTooOld(
  manufacturedAt: Date | null,
  maxAgeYears: number,
  now: Date = new Date(),
): boolean {
  return manufacturedAt !== null && tireAgeYears(manufacturedAt, now) > maxAgeYears;
}
