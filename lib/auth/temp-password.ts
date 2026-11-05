import { randomInt } from "node:crypto";

// Sin caracteres que se confunden al dictarlos (0/O, 1/l/I).
const UPPER = "ABCDEFGHJKLMNPQRSTUVWXYZ";
const LOWER = "abcdefghijkmnpqrstuvwxyz";
const DIGITS = "23456789";
const ALL = UPPER + LOWER + DIGITS;

const pick = (set: string): string => set.charAt(randomInt(set.length));

/** Contraseña temporal de 14 caracteres (mayúsculas, minúsculas y dígitos): cumple la política y se puede dictar. */
export function generateTempPassword(length = 14): string {
  const chars = [pick(UPPER), pick(LOWER), pick(DIGITS)];
  while (chars.length < length) chars.push(pick(ALL));
  // Baraja (Fisher-Yates) para que las tres clases no queden siempre al principio.
  for (let i = chars.length - 1; i > 0; i -= 1) {
    const j = randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j] as string, chars[i] as string];
  }
  return chars.join("");
}
