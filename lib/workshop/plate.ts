/** Placa en forma canónica: mayúsculas, sin espacios, guiones ni puntos (ABC-123 → ABC123). */
export function normalizePlate(input: string): string {
  return input.toUpperCase().replace(/[\s\-._]/g, "");
}

/** 5 a 7 caracteres alfanuméricos: cubre placas peruanas (ABC123, A1B234, 1234AB) y de la región. */
export function isValidPlate(plate: string): boolean {
  return /^[A-Z0-9]{5,7}$/.test(plate);
}

/** Muestra la placa con guion tras los 3 primeros caracteres cuando son 6 (ABC-123). */
export function formatPlate(plate: string): string {
  return plate.length === 6 ? `${plate.slice(0, 3)}-${plate.slice(3)}` : plate;
}
