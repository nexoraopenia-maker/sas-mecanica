import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { parseEnv } from "@/lib/env";

const valid = {
  DATABASE_URL: "postgresql://sas_app:pw@localhost:5432/sas",
  ADMIN_DATABASE_URL: "postgresql://postgres:pw@localhost:5432/sas",
  ENCRYPTION_KEY: randomBytes(32).toString("base64"),
  SESSION_SECRET: randomBytes(32).toString("base64url"),
  APP_URL: "http://localhost:3000",
};

describe("validación de entorno", () => {
  it("acepta una configuración válida y aplica defaults", () => {
    const env = parseEnv(valid);
    expect(env.NODE_ENV).toBe("development");
    expect(env.LOG_LEVEL).toBe("info");
  });

  it("falla rápido y nombra la variable faltante", () => {
    expect(() => parseEnv({ ...valid, DATABASE_URL: undefined })).toThrow(/DATABASE_URL/);
  });

  it("rechaza una ENCRYPTION_KEY que no sea de 32 bytes", () => {
    expect(() => parseEnv({ ...valid, ENCRYPTION_KEY: "abc" })).toThrow(/ENCRYPTION_KEY/);
  });

  it("en producción exige captcha, SMTP y Storage", () => {
    expect(() => parseEnv({ ...valid, NODE_ENV: "production" })).toThrow(/TURNSTILE_SECRET_KEY/);
    const prod = {
      ...valid,
      NODE_ENV: "production",
      TURNSTILE_SECRET_KEY: "s",
      NEXT_PUBLIC_TURNSTILE_SITE_KEY: "k",
      SMTP_URL: "smtp://a:b@h:25",
    };
    expect(() => parseEnv(prod)).toThrow(/SUPABASE_URL/);
    expect(() =>
      parseEnv({ ...prod, SUPABASE_URL: "https://x.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "k" }),
    ).not.toThrow();
    // El disco local es solo para pruebas/CI: se acepta de forma explícita.
    expect(() => parseEnv({ ...prod, STORAGE_DRIVER: "local" })).not.toThrow();
  });

  it("la pasarela de cobro exige sus credenciales y «simulated» no existe en producción", () => {
    expect(() => parseEnv({ ...valid, BILLING_GATEWAY: "stripe" })).toThrow(/STRIPE_SECRET_KEY/);
    expect(() =>
      parseEnv({
        ...valid,
        BILLING_GATEWAY: "stripe",
        STRIPE_SECRET_KEY: "sk",
        STRIPE_WEBHOOK_SECRET: "whsec",
      }),
    ).not.toThrow();
    expect(() =>
      parseEnv({ ...valid, BILLING_GATEWAY: "mercadopago", MERCADOPAGO_ACCESS_TOKEN: "t" }),
    ).toThrow(/MERCADOPAGO_WEBHOOK_SECRET/);
    expect(() => parseEnv({ ...valid, BILLING_GATEWAY: "simulated" })).toThrow(
      /BILLING_SIMULATED_SECRET/,
    );
    const prod = {
      ...valid,
      NODE_ENV: "production",
      TURNSTILE_SECRET_KEY: "s",
      NEXT_PUBLIC_TURNSTILE_SITE_KEY: "k",
      SMTP_URL: "smtp://a:b@h:25",
      STORAGE_DRIVER: "local",
      BILLING_GATEWAY: "simulated",
      BILLING_SIMULATED_SECRET: "x".repeat(16),
    };
    expect(() => parseEnv(prod)).toThrow(/simulated/);
    expect(() => parseEnv({ ...valid, BILLING_RETRY_DAYS: "1;3" })).toThrow(/BILLING_RETRY_DAYS/);
    expect(parseEnv({ ...valid }).BILLING_GRACE_DAYS).toBe(7);
  });

  it("una variable opcional vacía (como en .env.example) se trata como no definida", () => {
    const env = parseEnv({
      ...valid,
      SMTP_URL: "",
      TURNSTILE_SECRET_KEY: "  ",
      STRIPE_SECRET_KEY: "",
      SUPABASE_URL: "",
    });
    expect(env.SMTP_URL).toBeUndefined();
    expect(env.BILLING_GATEWAY).toBe("none");
    // Una variable obligatoria vacía sigue siendo un error.
    expect(() => parseEnv({ ...valid, SESSION_SECRET: "" })).toThrow(/SESSION_SECRET/);
  });

  it("el 2FA del SuperAdmin es obligatorio por defecto y solo se apaga fuera de producción", () => {
    expect(parseEnv({ ...valid }).SUPERADMIN_REQUIRE_2FA).toBe("true");
    expect(parseEnv({ ...valid, SUPERADMIN_REQUIRE_2FA: "false" }).SUPERADMIN_REQUIRE_2FA).toBe(
      "false",
    );
    expect(() => parseEnv({ ...valid, SUPERADMIN_REQUIRE_2FA: "no" })).toThrow(
      /SUPERADMIN_REQUIRE_2FA/,
    );
    const prod = {
      ...valid,
      NODE_ENV: "production",
      TURNSTILE_SECRET_KEY: "s",
      NEXT_PUBLIC_TURNSTILE_SITE_KEY: "k",
      SMTP_URL: "smtp://a:b@h:25",
      STORAGE_DRIVER: "local",
    };
    expect(parseEnv({ ...prod, SUPERADMIN_REQUIRE_2FA: "false" }).SUPERADMIN_REQUIRE_2FA).toBe(
      "false",
    );
    expect(() => parseEnv({ ...prod })).not.toThrow();
  });

  it("rechaza una SESSION_SECRET corta", () => {
    expect(() => parseEnv({ ...valid, SESSION_SECRET: "corta" })).toThrow(/SESSION_SECRET/);
  });

  it("rechaza niveles de log desconocidos", () => {
    expect(() => parseEnv({ ...valid, LOG_LEVEL: "ruidoso" })).toThrow(/LOG_LEVEL/);
  });
});
