import { z } from "zod";

const encryptionKey = z
  .string()
  .min(1, "ENCRYPTION_KEY es obligatoria")
  .refine((value) => Buffer.from(value, "base64").length === 32, {
    message: "ENCRYPTION_KEY debe ser 32 bytes en base64 (AES-256)",
  });

const optionalString = z.string().min(1).optional();

export const envSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    LOG_LEVEL: z
      .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
      .default("info"),
    DATABASE_URL: z.url(),
    ADMIN_DATABASE_URL: z.url(),
    ENCRYPTION_KEY: encryptionKey,
    SESSION_SECRET: z.string().min(32, "SESSION_SECRET debe tener al menos 32 caracteres"),
    APP_URL: z.url(),
    SMTP_URL: optionalString,
    SMTP_FROM: z.string().min(3).default("Mecania <no-reply@localhost>"),
    TURNSTILE_SECRET_KEY: optionalString,
    NEXT_PUBLIC_TURNSTILE_SITE_KEY: optionalString,
    INNGEST_EVENT_KEY: optionalString,
    INNGEST_SIGNING_KEY: optionalString,
    // Fotos y firmas del taller: Supabase Storage en producción; "local" (disco) solo para pruebas/CI/desarrollo.
    STORAGE_DRIVER: z.enum(["supabase", "local"]).optional(),
    SUPABASE_URL: z.url().optional(),
    SUPABASE_SERVICE_ROLE_KEY: optionalString,
    // Cobro de la suscripción del SaaS. "none" = sin cobro automático (solo pagos manuales del SuperAdmin).
    BILLING_GATEWAY: z.enum(["none", "stripe", "mercadopago", "simulated"]).default("none"),
    STRIPE_SECRET_KEY: optionalString,
    STRIPE_WEBHOOK_SECRET: optionalString,
    MERCADOPAGO_ACCESS_TOKEN: optionalString,
    MERCADOPAGO_WEBHOOK_SECRET: optionalString,
    /** Solo desarrollo/CI: firma los webhooks de la pasarela «simulated». */
    BILLING_SIMULATED_SECRET: z.string().min(16).optional(),
    // 2FA obligatorio del SuperAdmin (true por defecto). Apagarlo es una decisión temporal del dueño: ver README.
    SUPERADMIN_REQUIRE_2FA: z.enum(["true", "false"]).default("true"),
    /** WhatsApp comercial para «Activar plan» en cuentas demo (opcional; con código de país). */
    NEXT_PUBLIC_SALES_WHATSAPP: z.string().optional(),
    BILLING_GRACE_DAYS: z.coerce.number().int().min(0).max(30).default(7),
    /** Días entre cobros automáticos fallidos, separados por comas (p. ej. «1,3,5»). */
    BILLING_RETRY_DAYS: z
      .string()
      .regex(/^\d{1,2}(,\d{1,2}){0,5}$/, "Usa números separados por comas, p. ej. 1,3,5")
      .default("1,3,5"),
  })
  .superRefine((env, ctx) => {
    const gatewayKeys: Record<string, Array<keyof typeof env>> = {
      stripe: ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET"],
      mercadopago: ["MERCADOPAGO_ACCESS_TOKEN", "MERCADOPAGO_WEBHOOK_SECRET"],
      simulated: ["BILLING_SIMULATED_SECRET"],
    };
    for (const key of gatewayKeys[env.BILLING_GATEWAY] ?? []) {
      if (!env[key])
        ctx.addIssue({
          code: "custom",
          path: [key],
          message: `${key} es obligatoria con BILLING_GATEWAY=${env.BILLING_GATEWAY}`,
        });
    }
    if (env.NODE_ENV === "production" && env.BILLING_GATEWAY === "simulated") {
      ctx.addIssue({
        code: "custom",
        path: ["BILLING_GATEWAY"],
        message: "La pasarela «simulated» no puede usarse en producción",
      });
    }
    if (env.NODE_ENV !== "production") return;
    for (const key of [
      "TURNSTILE_SECRET_KEY",
      "NEXT_PUBLIC_TURNSTILE_SITE_KEY",
      "SMTP_URL",
    ] as const) {
      if (!env[key])
        ctx.addIssue({
          code: "custom",
          path: [key],
          message: `${key} es obligatoria en producción`,
        });
    }
    if ((env.STORAGE_DRIVER ?? "supabase") === "supabase") {
      for (const key of ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"] as const) {
        if (!env[key]) {
          ctx.addIssue({
            code: "custom",
            path: [key],
            message: `${key} es obligatoria en producción (STORAGE_DRIVER=local solo sirve para pruebas)`,
          });
        }
      }
    }
  });

export type Env = z.infer<typeof envSchema>;

export function parseEnv(source: Record<string, string | undefined> = process.env): Env {
  // `VARIABLE=` (vacía, como en .env.example) equivale a no definirla.
  const defined = Object.fromEntries(
    Object.entries(source).filter(([, value]) => value !== undefined && value.trim() !== ""),
  );
  const parsed = envSchema.safeParse(defined);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`)
      .join("\n");
    throw new Error(`Variables de entorno inválidas:\n${details}\nRevisa .env.example`);
  }
  return parsed.data;
}

let cached: Env | undefined;

/** Valida una sola vez; falla rápido si falta alguna variable. */
export function getEnv(): Env {
  cached ??= parseEnv();
  return cached;
}
