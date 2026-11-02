import { z } from "zod";
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
