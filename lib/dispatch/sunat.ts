import type { DispatchReason, DispatchTransportMode } from "@/lib/db/enums";

/** Catálogo 20 de SUNAT: motivo de traslado. */
export const DISPATCH_REASON_CODE: Record<DispatchReason, string> = {
  SALE: "01",
  PURCHASE: "02",
  TRANSFER_BETWEEN_ESTABLISHMENTS: "04",
  OTHER: "13",
};

export const DISPATCH_REASON_LABEL: Record<DispatchReason, string> = {
  SALE: "Venta",
  PURCHASE: "Compra",
  TRANSFER_BETWEEN_ESTABLISHMENTS: "Traslado entre almacenes o sucursales",
  OTHER: "Otros",
};

/** Catálogo 18 de SUNAT: modalidad de transporte. */
export const DISPATCH_MODE_CODE: Record<DispatchTransportMode, string> = {
  PUBLIC: "01",
  PRIVATE: "02",
};

export const DISPATCH_MODE_LABEL: Record<DispatchTransportMode, string> = {
  PUBLIC: "Transporte público (empresa de transporte)",
  PRIVATE: "Transporte privado (vehículo propio)",
};

/** Serie de la GRE remitente: empieza con T (V si la emite un tercero) y 3 caracteres alfanuméricos. */
export const DEFAULT_DISPATCH_SERIES = "T001";
export const DISPATCH_SERIES_PATTERN = /^[TV][A-Z0-9]{3}$/;

export function normalizePlate(plate: string): string {
  return plate.replace(/[\s-]/g, "").toUpperCase();
}

/** Placa peruana: 6 caracteres alfanuméricos (7 en algunos vehículos especiales). */
export function isValidPlate(plate: string): boolean {
  return /^[A-Z0-9]{6,7}$/.test(normalizePlate(plate));
}

/** Código de UBIGEO del INEI: departamento, provincia y distrito (6 dígitos). */
export function isValidUbigeo(code: string): boolean {
  return /^(0[1-9]|1\d|2[0-5])\d{4}$/.test(code);
}

/** Licencia de conducir peruana: una letra y 8 dígitos (p. ej. Q12345678). */
export function isValidDriverLicense(license: string): boolean {
  return /^[A-Z]\d{8}$/.test(license.replace(/[\s-]/g, "").toUpperCase());
}
