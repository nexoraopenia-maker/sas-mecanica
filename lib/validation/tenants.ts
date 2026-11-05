import { z } from "zod";
import { passwordSchema } from "@/lib/auth/password";
import { MODULE_GROUP_IDS } from "@/lib/modules";
import { isValidRuc } from "@/lib/workshop/documents";
import { emailSchema } from "./auth";

const text = (max: number) => z.string().trim().max(max);

export const createTenantSchema = z.object({
  legalName: text(200).min(2, "Ingresa la razón social"),
  tradeName: text(200).optional(),
  taxIdType: z.string().trim().min(2).max(10).default("RUC"),
  taxId: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9-]{6,20}$/, "RUC/NIT inválido"),
  country: z.string().trim().length(2).toUpperCase().default("PE"),
  currency: z.string().trim().length(3).toUpperCase().default("PEN"),
  timezone: z.string().trim().min(3).max(60).default("America/Lima"),
  address: text(300).optional(),
  phone: text(40).optional(),
  contactName: text(120).optional(),
  contactEmail: emailSchema.optional(),
  planCode: z.string().trim().min(2).max(40),
  adminName: text(120).min(2, "Ingresa el nombre del administrador"),
  adminEmail: emailSchema,
});

export type CreateTenantInput = z.input<typeof createTenantSchema>;

export const tenantReasonSchema = z.object({
  tenantId: z.uuid(),
  reason: text(300).min(5, "Indica el motivo (mínimo 5 caracteres)"),
});

export const planLimitsSchema = z.object({
  planId: z.uuid(),
  priceMonthly: z.coerce.number().min(0).max(1_000_000),
  maxBranches: z.coerce.number().int().min(1).nullable(),
  maxUsers: z.coerce.number().int().min(1).nullable(),
  maxWarehouses: z.coerce.number().int().min(1).nullable(),
  monthlyAiTokens: z.coerce.number().int().min(0).nullable(),
});

const businessTypeSchema = z.enum(["AUTOPARTS", "WORKSHOP", "MIXED"], { error: "Rubro inválido" });

/** RUC peruano opcional: vacío = «aún sin facturación electrónica»; si viene, debe ser válido (11 dígitos, módulo 11). */
const optionalRuc = z
  .string()
  .trim()
  .optional()
  .transform((value) => (value ? value : undefined))
  .refine(
    (value) => value === undefined || isValidRuc(value),
    "El RUC no es válido (11 dígitos con dígito verificador)",
  );

/**
 * Alta rápida: lo mínimo para entregar la cuenta ya. Sin RUC ni conexión a SUNAT; el acceso se entrega con una
 * contraseña temporal (se genera sola si no se escribe una) que el cliente debe cambiar al entrar.
 */
export const createTenantQuickSchema = z.object({
  legalName: text(200).min(2, "Ingresa el nombre o la razón social"),
  tradeName: text(200).optional(),
  taxId: optionalRuc,
  contactEmail: emailSchema.optional(),
  planCode: z.string().trim().min(2).max(40),
  businessType: businessTypeSchema.default("MIXED"),
  /** Casillas de módulos; sin indicar se usa el preajuste del rubro. */
  groups: z.array(z.enum(MODULE_GROUP_IDS as [string, ...string[]])).optional(),
  adminName: text(120).min(2, "Ingresa el nombre del administrador"),
  adminEmail: emailSchema,
  tempPassword: passwordSchema.optional(),
});
export type CreateTenantQuickInput = z.input<typeof createTenantQuickSchema>;

export const updateTenantModulesSchema = z.object({
  tenantId: z.uuid(),
  businessType: businessTypeSchema,
  groups: z.array(z.enum(MODULE_GROUP_IDS as [string, ...string[]])),
  reason: text(300).min(5, "Indica el motivo (mínimo 5 caracteres)"),
});
export type UpdateTenantModulesInput = z.input<typeof updateTenantModulesSchema>;

/** Datos fiscales que se completan después del alta: RUC oficial y correo corporativo (ambos opcionales por separado). */
export const updateTenantFiscalSchema = z
  .object({
    tenantId: z.uuid(),
    taxId: optionalRuc,
    corporateEmail: emailSchema.optional(),
    reason: text(300).min(5, "Indica el motivo (mínimo 5 caracteres)"),
  })
  .refine((v) => v.taxId !== undefined || v.corporateEmail !== undefined, {
    message: "Indica el RUC o el correo corporativo",
    path: ["taxId"],
  });
export type UpdateTenantFiscalInput = z.input<typeof updateTenantFiscalSchema>;

export const resetTenantAdminPasswordSchema = z.object({
  tenantId: z.uuid(),
  reason: text(300).min(5, "Indica el motivo (mínimo 5 caracteres)"),
  tempPassword: passwordSchema.optional(),
});
export type ResetTenantAdminPasswordInput = z.input<typeof resetTenantAdminPasswordSchema>;
