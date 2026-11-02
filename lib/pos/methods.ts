/** Medios de pago. Módulo sin dependencias de servidor: también lo usa el mostrador (navegador). */
export const PAYMENT_METHODS = ["CASH", "CARD", "TRANSFER", "YAPE", "PLIN", "OTHER"] as const;
export type Method = (typeof PAYMENT_METHODS)[number];

export const METHOD_LABEL: Record<Method, string> = {
  CASH: "Efectivo",
  CARD: "Tarjeta",
  TRANSFER: "Transferencia",
  YAPE: "Yape",
  PLIN: "Plin",
  OTHER: "Otro",
};
