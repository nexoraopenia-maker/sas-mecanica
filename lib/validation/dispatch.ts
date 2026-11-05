import { z } from "zod";
import {
  DEFAULT_DISPATCH_SERIES,
  DISPATCH_SERIES_PATTERN,
  isValidDriverLicense,
  isValidPlate,
  isValidUbigeo,
  normalizePlate,
} from "@/lib/dispatch/sunat";
import { documentError, normalizeDocument } from "@/lib/workshop/documents";

const text = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .refine((value) => !value.includes("\u0000"), "El texto contiene caracteres no válidos");
const optional = (max: number) =>
  z.preprocess((value) => (value === "" ? undefined : value), text(max).optional());

const dateField = z.coerce.date();
const address = text(200).min(5, "Indica la dirección completa");
const ubigeo = z
  .string()
  .trim()
  .refine(isValidUbigeo, "UBIGEO inválido (6 dígitos del INEI, p. ej. 150101)");

export const dispatchItemSchema = z.object({
  productId: z.preprocess((value) => (value === "" ? undefined : value), z.uuid().optional()),
  description: text(200).min(1, "Indica la descripción del bien"),
  sku: optional(40),
  unit: text(10).default("UND"),
  quantity: z.coerce
    .number()
    .positive("La cantidad debe ser mayor que 0")
    .max(10_000_000)
    .transform((value) => value.toFixed(4)),
});

const guideBase = z.object({
  series: z
    .string()
    .trim()
    .toUpperCase()
    .regex(DISPATCH_SERIES_PATTERN, "Serie inválida (T001: empieza con T y tiene 4 caracteres)")
    .default(DEFAULT_DISPATCH_SERIES),
  issueDate: dateField.optional(),
  transferDate: dateField,
  reason: z.enum(["SALE", "PURCHASE", "TRANSFER_BETWEEN_ESTABLISHMENTS", "OTHER"]),
  reasonNote: optional(200),
  transportMode: z.enum(["PUBLIC", "PRIVATE"]),
  // Transporte público: RUC y razón social de la empresa transportista.
  carrierDocNumber: optional(11),
  carrierName: optional(200),
  // Transporte privado: conductor (DNI) y vehículo.
  driverDocNumber: optional(8),
  driverName: optional(200),
  driverLicense: optional(12),
  vehiclePlate: optional(10),
  grossWeightKg: z.coerce
    .number()
    .positive("Indica el peso total bruto en kg")
    .max(1_000_000)
    .transform((value) => value.toFixed(3)),
  packages: z.preprocess(
    (value) => (value === "" || value === undefined ? undefined : value),
    z.coerce.number().int().min(1).max(1_000_000).optional(),
  ),
  originAddress: address,
  originUbigeo: ubigeo,
  destinationAddress: address,
  destinationUbigeo: ubigeo,
  recipientDocType: z.enum(["DNI", "RUC", "CE", "PASSPORT", "OTHER"]),
  recipientDocNumber: text(20).min(1, "Indica el documento del destinatario"),
  recipientName: text(200).min(2, "Indica el nombre o razón social del destinatario"),
  saleId: z.preprocess((value) => (value === "" ? undefined : value), z.uuid().optional()),
  transferId: z.preprocess((value) => (value === "" ? undefined : value), z.uuid().optional()),
  relatedDocument: optional(40),
  items: z.array(dispatchItemSchema).min(1, "Agrega al menos un bien").max(200),
});

/** GRE remitente: valida lo que exige SUNAT según la modalidad de transporte y el motivo. */
export const createDispatchGuideSchema = guideBase.superRefine((data, ctx) => {
  const issue = (path: string, message: string) =>
    ctx.addIssue({ code: "custom", path: [path], message });

  if (data.transportMode === "PUBLIC") {
    const ruc = normalizeDocument("RUC", data.carrierDocNumber ?? "");
    if (documentError("RUC", ruc)) issue("carrierDocNumber", "RUC del transportista inválido");
    if (!data.carrierName) issue("carrierName", "Indica la razón social del transportista");
    if (data.vehiclePlate && !isValidPlate(data.vehiclePlate))
      issue("vehiclePlate", "Placa inválida (6 o 7 caracteres)");
  } else {
    if (!data.vehiclePlate || !isValidPlate(data.vehiclePlate))
      issue("vehiclePlate", "Indica la placa del vehículo (6 o 7 caracteres)");
    if (documentError("DNI", data.driverDocNumber ?? ""))
      issue("driverDocNumber", "DNI del conductor inválido (8 dígitos)");
    if (!data.driverName) issue("driverName", "Indica el nombre del conductor");
    if (data.driverLicense && !isValidDriverLicense(data.driverLicense))
      issue("driverLicense", "Licencia inválida (una letra y 8 dígitos, p. ej. Q12345678)");
  }

  const recipientError = documentError(data.recipientDocType, data.recipientDocNumber);
  if (recipientError) issue("recipientDocNumber", recipientError);
  if (data.reason === "OTHER" && (data.reasonNote?.length ?? 0) < 3)
    issue("reasonNote", "Describe el motivo del traslado");
  if (data.reason === "TRANSFER_BETWEEN_ESTABLISHMENTS" && data.recipientDocType !== "RUC")
    issue(
      "recipientDocType",
      "En un traslado entre establecimientos el destinatario es tu propia empresa (RUC)",
    );
  const day = (date: Date) => date.toISOString().slice(0, 10);
  if (data.issueDate && day(data.transferDate) < day(data.issueDate))
    issue("transferDate", "La fecha de traslado no puede ser anterior a la de emisión");
});

export type CreateDispatchGuideInput = z.input<typeof createDispatchGuideSchema>;
export type CreateDispatchGuideData = z.output<typeof createDispatchGuideSchema>;

export const voidDispatchGuideSchema = z.object({
  guideId: z.uuid(),
  reason: z
    .string()
    .trim()
    .min(5, "Indica el motivo de la anulación (mínimo 5 caracteres)")
    .max(300),
});

export function normalizeGuidePlate(plate: string | undefined): string | null {
  return plate ? normalizePlate(plate) : null;
}
