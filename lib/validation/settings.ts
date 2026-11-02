import { z } from "zod";

const nullableNumber = (max: number) => z.coerce.number().min(0).max(max).nullable();

/** Configuración del agente de compras. Todos los campos son opcionales: se actualiza solo lo enviado. */
export const aiSettingsSchema = z.object({
  /** Se cifra con AES-256-GCM; jamás se devuelve. Vacío/ausente = conservar la actual. */
  apiKey: z
    .string()
    .trim()
    .regex(/^sk-[A-Za-z0-9_-]{16,}$/, "La clave de OpenAI no tiene el formato esperado (sk-...)")
    .optional(),
  clearApiKey: z.boolean().default(false),
  model: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9._:-]{3,60}$/, "Nombre de modelo inválido")
    .optional(),
  tone: z.string().trim().max(300).nullable().optional(),
  mode: z.enum(["DRAFT_APPROVAL", "AUTOMATIC"]).optional(),
  monthlyTokenCap: z.coerce.number().int().min(0).max(1_000_000_000).nullable().optional(),
  monthlyCostCapUsd: nullableNumber(1_000_000).optional(),
  maxOrderAmount: nullableNumber(100_000_000).optional(),
  maxQtyPerSku: nullableNumber(10_000_000).optional(),
  maxOrdersPerDay: z.coerce.number().int().min(0).max(1000).optional(),
});
export type AiSettingsInput = z.input<typeof aiSettingsSchema>;

export const channelSettingsSchema = z.object({
  whatsappProvider: z.enum(["N8N", "EVOLUTION", "BUSINESS"]).nullable().optional(),
  whatsappWebhookUrl: z
    .string()
    .trim()
    .max(500)
    .refine((value) => value === "" || /^https:\/\//i.test(value), "El webhook debe usar HTTPS")
    .nullable()
    .optional(),
  whatsappApiKey: z.string().trim().min(8).max(500).optional(),
  clearWhatsappApiKey: z.boolean().default(false),
  /** Genera un secreto nuevo para firmar los webhooks entrantes; se muestra una sola vez. */
  rotateInboundSecret: z.boolean().default(false),
  smtpHost: z.string().trim().max(200).nullable().optional(),
  smtpPort: z.coerce.number().int().min(1).max(65535).nullable().optional(),
  smtpSecure: z.boolean().optional(),
  smtpUser: z.string().trim().max(200).nullable().optional(),
  smtpPassword: z.string().min(1).max(500).optional(),
  clearSmtpPassword: z.boolean().default(false),
  smtpFromAddress: z.string().trim().max(200).nullable().optional(),
});
export type ChannelSettingsInput = z.input<typeof channelSettingsSchema>;

export const testMessageSchema = z.object({
  channel: z.enum(["WHATSAPP", "EMAIL"]),
  to: z.string().trim().min(5).max(200),
});
export type TestMessageInput = z.input<typeof testMessageSchema>;
