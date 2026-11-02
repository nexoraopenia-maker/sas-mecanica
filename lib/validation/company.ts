import { z } from "zod";

const text = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .refine((value) => !value.includes("\u0000"), "El texto contiene caracteres no válidos");

const optionalText = (max: number) =>
  text(max)
    .transform((value) => (value === "" ? null : value))
    .nullable()
    .optional();

const optionalEmail = z
  .string()
  .trim()
  .toLowerCase()
  .max(254)
  .transform((value) => (value === "" ? null : value))
  .pipe(z.email("Correo inválido").nullable())
  .optional();

/** Perfil de la empresa. El RUC solo cambia si todavía no se emitió ningún comprobante (lo comprueba el servicio). */
export const companyProfileSchema = z.object({
  legalName: text(200).min(2, "Ingresa la razón social"),
  tradeName: optionalText(120),
  // La validez del RUC (dígito verificador) se comprueba solo cuando CAMBIA: reenviar el actual no debe fallar.
  taxId: z
    .string()
    .trim()
    .transform((value) => (value === "" ? null : value))
    .refine((value) => value === null || /^\d{11}$/.test(value), "El RUC tiene 11 dígitos")
    .nullable()
    .optional(),
  address: optionalText(300),
  phone: optionalText(30),
  contactName: optionalText(120),
  contactEmail: optionalEmail,
  billingEmail: optionalEmail,
});
export type CompanyProfileInput = z.input<typeof companyProfileSchema>;

/** Parámetros operativos por empresa. Los límites evitan valores absurdos que romperían cálculos. */
export const operationsSchema = z.object({
  taxName: text(20).min(1, "Indica el nombre del impuesto"),
  /** Tasa como fracción: 0.18 = 18 %. */
  taxRate: z.coerce
    .number("La tasa debe ser un número")
    .min(0, "La tasa debe estar entre 0 % y 50 %")
    .max(0.5, "La tasa debe estar entre 0 % y 50 %"),
  pricesIncludeTax: z.boolean(),
  ticketWidthMm: z.coerce
    .number()
    .refine((v) => v === 58 || v === 80, "El ticket es de 58 o 80 mm"),
  tireMaxAgeYears: z.coerce
    .number()
    .int("Usa años enteros")
    .min(1, "Entre 1 y 15 años")
    .max(15, "Entre 1 y 15 años"),
  allowNegativeStock: z.boolean(),
  rotationWindowDays: z.coerce
    .number()
    .int("Usa días enteros")
    .min(7, "La ventana de rotación va de 7 a 180 días")
    .max(180, "La ventana de rotación va de 7 a 180 días"),
  deadStockDays: z.coerce
    .number()
    .int("Usa días enteros")
    .min(7, "El stock muerto va de 7 a 730 días")
    .max(730, "El stock muerto va de 7 a 730 días"),
  aiMinutesSavedPerLine: z.coerce
    .number()
    .int("Usa minutos enteros")
    .min(0, "Entre 0 y 240 minutos")
    .max(240, "Entre 0 y 240 minutos"),
  staffHourlyCost: z.coerce
    .number("Costo por hora inválido")
    .min(0, "El costo por hora no puede ser negativo")
    .max(10_000, "Costo por hora demasiado alto"),
  usdExchangeRate: z.coerce
    .number("Tipo de cambio inválido")
    .min(0.01, "El tipo de cambio debe ser mayor que 0")
    .max(1000, "Tipo de cambio demasiado alto"),
});
export type OperationsInput = z.input<typeof operationsSchema>;
