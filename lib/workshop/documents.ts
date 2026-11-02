export type DocType = "DNI" | "RUC" | "CE" | "PASSPORT" | "OTHER";

/**
 * Dígito verificador del RUC peruano (SUNAT): módulo 11 con los factores
 * 5,4,3,2,7,6,5,4,3,2 sobre los 10 primeros dígitos.
 */
export function isValidRuc(ruc: string): boolean {
  if (!/^(10|15|16|17|20)\d{9}$/.test(ruc)) return false;
  const factors = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
  const sum = factors.reduce((acc, factor, index) => acc + factor * Number(ruc[index]), 0);
  const check = (11 - (sum % 11)) % 10;
  return check === Number(ruc[10]);
}

export function normalizeDocument(type: DocType, number: string): string {
  const cleaned = number.trim().replace(/[\s.-]/g, "");
  return type === "PASSPORT" || type === "CE" || type === "OTHER" ? cleaned.toUpperCase() : cleaned;
}

/** Devuelve el mensaje de error o null si el documento es válido para su tipo. */
export function documentError(type: DocType, number: string): string | null {
  const value = normalizeDocument(type, number);
  switch (type) {
    case "DNI":
      return /^\d{8}$/.test(value) ? null : "El DNI debe tener 8 dígitos";
    case "RUC":
      return isValidRuc(value) ? null : "RUC inválido (11 dígitos con dígito verificador)";
    case "CE":
      return /^[A-Z0-9]{9,12}$/.test(value)
        ? null
        : "El carné de extranjería debe tener entre 9 y 12 caracteres";
    case "PASSPORT":
      return /^[A-Z0-9]{6,12}$/.test(value)
        ? null
        : "El pasaporte debe tener entre 6 y 12 caracteres";
    default:
      return /^[A-Z0-9]{3,20}$/.test(value) ? null : "Documento inválido";
  }
}

/** Teléfono en dígitos con código de país; asume Perú (+51) si vienen 9 dígitos que empiezan en 9. */
export function normalizeWhatsapp(input: string): string | null {
  const digits = input.replace(/\D/g, "");
  if (/^9\d{8}$/.test(digits)) return `51${digits}`;
  return digits.length >= 10 && digits.length <= 15 ? digits : null;
}
