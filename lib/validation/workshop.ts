import { z } from "zod";
import {
  documentError,
  normalizeDocument,
  normalizeWhatsapp,
  type DocType,
} from "@/lib/workshop/documents";
import { isValidPlate, normalizePlate } from "@/lib/workshop/plate";
import { costSchema, quantitySchema } from "./inventory";

const text = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .refine((value) => !value.includes("\u0000"), "El texto contiene caracteres no válidos");

export const docTypeSchema = z.enum(["DNI", "RUC", "CE", "PASSPORT", "OTHER"]);

const customerFields = {
  docType: docTypeSchema.default("DNI"),
  docNumber: text(30).min(1, "Ingresa el documento"),
  name: text(200).min(2, "Ingresa el nombre o razón social"),
  email: z.string().trim().toLowerCase().max(254).pipe(z.email("Correo inválido")).optional(),
  phone: text(30).optional(),
  whatsapp: text(30).optional(),
  whatsappOptIn: z.boolean().default(true),
  address: text(300).optional(),
  notes: text(500).optional(),
};

function validateCustomer(
  value: { docType: DocType; docNumber: string; whatsapp?: string | undefined },
  ctx: z.RefinementCtx,
): void {
  const error = documentError(value.docType, value.docNumber);
  if (error) ctx.addIssue({ code: "custom", path: ["docNumber"], message: error });
  if (value.whatsapp && !normalizeWhatsapp(value.whatsapp)) {
    ctx.addIssue({
      code: "custom",
      path: ["whatsapp"],
      message: "WhatsApp inválido (ej.: 987 654 321 o +51 987 654 321)",
    });
  }
}

/** Cliente: documento validado según su tipo (DNI 8 dígitos, RUC con dígito verificador...). */
export const customerSchema = z
  .object(customerFields)
  .superRefine(validateCustomer)
  .transform((value) => ({
    ...value,
    docNumber: normalizeDocument(value.docType, value.docNumber),
    whatsapp: value.whatsapp ? (normalizeWhatsapp(value.whatsapp) ?? undefined) : undefined,
  }));
export type CustomerInput = z.input<typeof customerSchema>;

export const customerUpdateSchema = z
  .object({ ...customerFields, whatsappOptIn: z.boolean() })
  .partial()
  .superRefine((value, ctx) => {
    if (value.docNumber !== undefined)
      validateCustomer(
        { docType: value.docType ?? "DNI", docNumber: value.docNumber, whatsapp: value.whatsapp },
        ctx,
      );
    else if (value.whatsapp && !normalizeWhatsapp(value.whatsapp))
      ctx.addIssue({ code: "custom", path: ["whatsapp"], message: "WhatsApp inválido" });
  });
export type CustomerUpdateInput = z.input<typeof customerUpdateSchema>;

export const plateSchema = z
  .string()
  .transform(normalizePlate)
  .refine(isValidPlate, "Placa inválida (5 a 7 letras o números)");

const vehicleFields = {
  plate: plateSchema,
  make: text(60).optional(),
  model: text(60).optional(),
  year: z.coerce.number().int().min(1950).max(2100).optional(),
  engine: text(60).optional(),
  vin: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-HJ-NPR-Z0-9]{17}$/, "VIN inválido (17 caracteres, sin I, O ni Q)")
    .optional(),
  color: text(40).optional(),
  fuelType: text(30).optional(),
  currentMileage: z.coerce.number().int().min(0).max(3_000_000).optional(),
};

export const vehicleSchema = z.object({ customerId: z.uuid(), ...vehicleFields });
export type VehicleInput = z.input<typeof vehicleSchema>;

export const vehicleUpdateSchema = z.object({
  make: vehicleFields.make,
  model: vehicleFields.model,
  year: vehicleFields.year,
  engine: vehicleFields.engine,
  vin: vehicleFields.vin,
  color: vehicleFields.color,
  fuelType: vehicleFields.fuelType,
  currentMileage: vehicleFields.currentMileage,
  /** Permite BAJAR el kilometraje (corrección de un error de digitación); exige motivo. */
  mileageCorrectionReason: text(200).min(5).optional(),
});
export type VehicleUpdateInput = z.input<typeof vehicleUpdateSchema>;

export const checklistEntrySchema = z.object({
  category: z.enum(["INTAKE", "DAMAGE", "INVENTORY"]),
  label: text(120).min(1),
  checked: z.boolean().default(false),
  value: text(120).optional(),
  notes: text(300).optional(),
});

/** Recepción digital: busca el vehículo por placa o lo da de alta junto con su cliente. */
export const receptionSchema = z
  .object({
    vehicleId: z.uuid().optional(),
    plate: plateSchema.optional(),
    newCustomer: z.object(customerFields).superRefine(validateCustomer).optional(),
    customerId: z.uuid().optional(),
    newVehicle: z
      .object({
        make: vehicleFields.make,
        model: vehicleFields.model,
        year: vehicleFields.year,
        engine: vehicleFields.engine,
        color: vehicleFields.color,
      })
      .optional(),
    branchId: z.uuid().optional(),
    mileageIn: z.coerce.number().int().min(0).max(3_000_000),
    /** Confirma un kilometraje menor al registrado (posible error o tablero cambiado). */
    confirmLowerMileage: z.boolean().default(false),
    fuelLevelEighths: z.coerce.number().int().min(0).max(8),
    complaint: text(1000).min(3, "Describe el motivo del ingreso"),
    promisedAt: z.coerce.date().optional(),
    checklist: z.array(checklistEntrySchema).max(60).default([]),
  })
  .refine((value) => value.vehicleId !== undefined || value.plate !== undefined, {
    message: "Indica la placa del vehículo",
    path: ["plate"],
  });
export type ReceptionInput = z.input<typeof receptionSchema>;

export const workItemSchema = z.object({
  type: z.enum(["LABOR", "PART"]),
  productId: z.uuid().optional(),
  description: text(200).optional(),
  quantity: quantitySchema,
  /** Si se omite, se usa el precio de venta del producto. Cambiarlo exige permiso de descuentos. */
  unitPrice: costSchema.optional(),
  discount: costSchema.optional(),
  warrantyPolicyId: z.uuid().optional(),
});
export type WorkItemInput = z.input<typeof workItemSchema>;

export const approvalDecisionSchema = z.object({
  token: z.string().min(20).max(200),
  decision: z.enum(["APPROVE", "REJECT"]),
  name: text(120).min(3, "Escribe tu nombre completo"),
  /** El cliente puede aprobar solo una parte del presupuesto. */
  rejectedItemIds: z.array(z.uuid()).max(100).default([]),
});
export type ApprovalDecisionInput = z.input<typeof approvalDecisionSchema>;

export const personApprovalSchema = z.object({
  workOrderId: z.uuid(),
  name: text(120).min(3, "Escribe el nombre de quien firma"),
  signatureDataUrl: z.string().max(450_000),
  rejectedItemIds: z.array(z.uuid()).max(100).default([]),
});
export type PersonApprovalInput = z.input<typeof personApprovalSchema>;

export const deliverSchema = z.object({
  workOrderId: z.uuid(),
  mileageOut: z.coerce.number().int().min(0).max(3_000_000),
  notes: text(300).optional(),
});

export const warrantyPolicySchema = z
  .object({
    name: text(120).min(2),
    months: z.coerce.number().int().min(1).max(120).nullable().optional(),
    kilometers: z.coerce.number().int().min(100).max(1_000_000).nullable().optional(),
    coversLabor: z.boolean().default(false),
    terms: text(1000).optional(),
  })
  .refine((policy) => Boolean(policy.months) || Boolean(policy.kilometers), {
    message: "Indica una vigencia por meses y/o kilómetros",
    path: ["months"],
  });
export type WarrantyPolicyInput = z.input<typeof warrantyPolicySchema>;

export const claimSchema = z.object({
  warrantyId: z.uuid(),
  description: text(1000).min(5, "Describe la falla reportada"),
  mileage: z.coerce.number().int().min(0).max(3_000_000).optional(),
});
export type ClaimInput = z.input<typeof claimSchema>;

export const claimDecisionSchema = z
  .object({
    claimId: z.uuid(),
    decision: z.enum(["APPROVE", "REJECT"]),
    evaluation: text(1000).min(5, "Escribe el resultado de la evaluación"),
    resolution: z.enum(["REPLACEMENT", "CREDIT_NOTE"]).optional(),
    /** Aprobar un reclamo FUERA de cobertura exige este motivo (queda auditado). */
    overrideReason: text(300).min(10).optional(),
  })
  .refine((value) => value.decision === "REJECT" || value.resolution !== undefined, {
    message: "Elige la resolución: reposición o nota de crédito",
    path: ["resolution"],
  });
export type ClaimDecisionInput = z.input<typeof claimDecisionSchema>;

export const reminderSchema = z
  .object({
    vehicleId: z.uuid(),
    description: text(200).min(3),
    dueDate: z.coerce.date().optional(),
    dueMileage: z.coerce.number().int().min(0).max(3_000_000).optional(),
    intervalMonths: z.coerce.number().int().min(1).max(120).optional(),
    intervalKm: z.coerce.number().int().min(100).max(1_000_000).optional(),
  })
  .refine((value) => value.dueDate !== undefined || value.dueMileage !== undefined, {
    message: "Indica una fecha y/o un kilometraje",
    path: ["dueDate"],
  });
export type ReminderInput = z.input<typeof reminderSchema>;
