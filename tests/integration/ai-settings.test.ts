import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { withTenant } from "@/lib/db";
import type { PrismaClient } from "@/lib/db/generated/client.ts";
import { PermissionDeniedError, RateLimitError } from "@/lib/errors";
import { decryptSecret } from "@/lib/security/crypto";
import { setChannelDepsForTests } from "@/server/integrations/channels";
import {
  getAiSettings,
  getChannelSettings,
  loadTenantSecrets,
  sendTestMessage,
  updateAiSettings,
  updateChannelSettings,
} from "@/server/services/ai-settings";
import { provisionDemo } from "@/server/services/demo";
import { configureAuthCache, resolveSession } from "@/server/services/session-resolver";
import { adminClient } from "../helpers/db.ts";
import { meta } from "../helpers/auth.ts";
import {
  API_KEY,
  purchasingWorld,
  uninstallFakes,
  type PurchasingWorld,
} from "../helpers/purchasing.ts";

describe("configuración de IA y canales (credenciales cifradas)", () => {
  let admin: PrismaClient;
  let w: PurchasingWorld;
  let other: PurchasingWorld;

  beforeAll(async () => {
    configureAuthCache(0);
    admin = adminClient();
    w = await purchasingWorld(admin);
    other = await purchasingWorld(admin);
  }, 180_000);
  afterEach(() => uninstallFakes());
  afterAll(async () => {
    await admin.$disconnect();
  });

  const row = (tenantId: string) => admin.tenantSettings.findUniqueOrThrow({ where: { tenantId } });

  describe("clave de OpenAI", () => {
    it("se guarda cifrada (AES-256-GCM), se muestra enmascarada y jamás se devuelve", async () => {
      await updateAiSettings(
        w.admin,
        { apiKey: API_KEY, model: "gpt-4o", tone: "Cordial y breve", maxOrdersPerDay: 4 },
        meta(),
      );
      const settings = await row(w.tenantId);
      expect(settings.openaiApiKeyEncrypted).toMatch(/^v1:/);
      expect(settings.openaiApiKeyEncrypted).not.toContain(API_KEY);
      expect(settings.openaiApiKeyEncrypted).not.toContain("sk-test");
      expect(settings.openaiApiKeyHint).toBe(API_KEY.slice(-4));
      expect(
        decryptSecret(
          settings.openaiApiKeyEncrypted ?? "",
          process.env.ENCRYPTION_KEY ?? "",
          `tenant:${w.tenantId}:openai`,
        ),
      ).toBe(API_KEY);

      const view = await getAiSettings(w.admin);
      expect(view).toMatchObject({
        hasApiKey: true,
        apiKeyMasked: `••••••••${API_KEY.slice(-4)}`,
        model: "gpt-4o",
        tone: "Cordial y breve",
        maxOrdersPerDay: 4,
        mode: "DRAFT_APPROVAL",
      });
      expect(JSON.stringify(view)).not.toContain(API_KEY);
      expect(JSON.stringify(view)).not.toContain("openaiApiKeyEncrypted");
    });

    it("el cifrado está atado al tenant: copiar el texto cifrado a otro tenant no sirve", async () => {
      await updateAiSettings(other.admin, { apiKey: "sk-otro-tenant-0123456789abc" }, meta());
      const stolen = (await row(w.tenantId)).openaiApiKeyEncrypted;
      await admin.tenantSettings.update({
        where: { tenantId: other.tenantId },
        data: { openaiApiKeyEncrypted: stolen },
      });
      await expect(
        withTenant(other.tenantId, (tx) => loadTenantSecrets(tx, other.tenantId)),
      ).rejects.toThrow();
      await updateAiSettings(other.admin, { apiKey: "sk-otro-tenant-0123456789abc" }, meta()); // restaura
      expect(
        (await withTenant(other.tenantId, (tx) => loadTenantSecrets(tx, other.tenantId))).openaiKey,
      ).toBe("sk-otro-tenant-0123456789abc");
    });

    it("la auditoría registra el cambio SIN el secreto", async () => {
      await updateAiSettings(w.admin, { monthlyTokenCap: 50_000, maxOrderAmount: 2500 }, meta());
      const logs = await admin.auditLog.findMany({
        where: { tenantId: w.tenantId, action: "ai.settings_changed" },
        orderBy: { occurredAt: "asc" },
      });
      expect(logs.length).toBeGreaterThanOrEqual(2);
      const serialized = JSON.stringify(logs);
      expect(serialized).not.toContain(API_KEY);
      expect(serialized).not.toContain("sk-test");
      const last = logs.at(-1);
      expect(last?.before).toMatchObject({
        tokenCap: null,
        maxOrderAmount: null,
        apiKey: `••••${API_KEY.slice(-4)}`,
      });
      expect(last?.after).toMatchObject({ tokenCap: 50_000, maxOrderAmount: 2500 });
      expect(last?.actorUserId).toBe(w.admin.userId);
    });

    it("conserva la clave si no se envía una nueva, y la borra con clearApiKey", async () => {
      await updateAiSettings(w.admin, { model: "gpt-4o-mini" }, meta());
      expect((await getAiSettings(w.admin)).hasApiKey).toBe(true);
      await updateAiSettings(other.admin, { clearApiKey: true }, meta());
      const view = await getAiSettings(other.admin);
      expect(view).toMatchObject({ hasApiKey: false, apiKeyMasked: null });
      expect((await row(other.tenantId)).openaiApiKeyEncrypted).toBeNull();
    });

    it("valida el formato de la clave y los topes", async () => {
      await expect(
        updateAiSettings(w.admin, { apiKey: "no-es-una-clave" }, meta()),
      ).rejects.toThrow(/sk-/);
      await expect(
        updateAiSettings(w.admin, { model: "modelo con espacios!" }, meta()),
      ).rejects.toThrow(/modelo/i);
      await expect(updateAiSettings(w.admin, { maxOrdersPerDay: -1 }, meta())).rejects.toThrow();
      await expect(updateAiSettings(w.admin, { monthlyTokenCap: -5 }, meta())).rejects.toThrow();
    });

    it("permisos: ver ≠ editar; el cajero no ve la configuración de IA", async () => {
      await expect(getAiSettings(w.manager)).resolves.toMatchObject({ hasApiKey: true });
      await expect(updateAiSettings(w.manager, { model: "gpt-4o" }, meta())).rejects.toBeInstanceOf(
        PermissionDeniedError,
      );
      await expect(getAiSettings(w.cashier)).rejects.toBeInstanceOf(PermissionDeniedError);
      await expect(updateAiSettings(w.cashier, { model: "gpt-4o" }, meta())).rejects.toBeInstanceOf(
        PermissionDeniedError,
      );
    });

    it("modo automático: solo quien puede autorizar pedidos de IA lo activa", async () => {
      await updateAiSettings(
        w.admin,
        { mode: "AUTOMATIC", maxOrderAmount: 1000, maxQtyPerSku: 50 },
        meta(),
      );
      expect((await getAiSettings(w.admin)).mode).toBe("AUTOMATIC");
      await updateAiSettings(w.admin, { mode: "DRAFT_APPROVAL" }, meta());
    });

    it("el plan sin agente de IA ni siquiera ve el módulo", async () => {
      const pro = await purchasingWorld(admin, "pro");
      await expect(getAiSettings(pro.admin)).rejects.toBeInstanceOf(PermissionDeniedError);
    });
  });

  describe("canales (WhatsApp y SMTP)", () => {
    it("guarda el webhook y las claves cifradas; muestra solo máscaras", async () => {
      const { inboundSecret } = await updateChannelSettings(
        w.admin,
        {
          whatsappProvider: "N8N",
          whatsappWebhookUrl: "https://93.184.216.34/webhook/wa",
          whatsappApiKey: "tok-whatsapp-abcdef",
          rotateInboundSecret: true,
          smtpHost: "93.184.216.34",
          smtpPort: 587,
          smtpSecure: false,
          smtpUser: "taller",
          smtpPassword: "clave-smtp-12345",
          smtpFromAddress: "Taller <pedidos@taller.pe>",
        },
        meta(),
      );
      expect(inboundSecret).toMatch(/^[\w-]{40,}$/);

      const stored = await row(w.tenantId);
      for (const column of [
        stored.whatsappApiKeyEncrypted,
        stored.smtpPasswordEncrypted,
        stored.whatsappInboundSecretEncrypted,
      ]) {
        expect(column).toMatch(/^v1:/);
      }
      expect(JSON.stringify(stored)).not.toContain("tok-whatsapp-abcdef");
      expect(JSON.stringify(stored)).not.toContain("clave-smtp-12345");
      expect(JSON.stringify(stored)).not.toContain(inboundSecret ?? "?");

      const view = await getChannelSettings(w.admin);
      expect(view).toMatchObject({
        whatsappProvider: "N8N",
        whatsappApiKeyMasked: "••••••••cdef",
        smtpPasswordMasked: "••••••••2345",
        hasInboundSecret: true,
        smtpPort: 587,
      });
      expect(JSON.stringify(view)).not.toContain("tok-whatsapp");
      expect(JSON.stringify(view)).not.toContain(inboundSecret ?? "?");

      const secrets = await withTenant(w.tenantId, (tx) => loadTenantSecrets(tx, w.tenantId));
      expect(secrets.inboundSecret).toBe(inboundSecret);
      expect(secrets.whatsapp).toEqual({
        provider: "N8N",
        url: "https://93.184.216.34/webhook/wa",
        apiKey: "tok-whatsapp-abcdef",
      });
      expect(secrets.smtp).toMatchObject({ host: "93.184.216.34", password: "clave-smtp-12345" });
    });

    it("rotar el secreto entrante genera uno nuevo y lo muestra una sola vez; auditoría sin secretos", async () => {
      const first = (await updateChannelSettings(w.admin, { rotateInboundSecret: true }, meta()))
        .inboundSecret;
      const second = (await updateChannelSettings(w.admin, { rotateInboundSecret: true }, meta()))
        .inboundSecret;
      expect(first).not.toBe(second);
      expect(
        (await updateChannelSettings(w.admin, { smtpUser: "taller2" }, meta())).inboundSecret,
      ).toBeNull();
      const logs = JSON.stringify(
        await admin.auditLog.findMany({
          where: { tenantId: w.tenantId, action: "channels.settings_changed" },
        }),
      );
      for (const secret of [first, second, "tok-whatsapp-abcdef", "clave-smtp-12345"])
        expect(logs).not.toContain(secret ?? "?");
    });

    it("rechaza destinos internos (SSRF), HTTP y puertos no SMTP", async () => {
      for (const url of [
        "https://127.0.0.1/hook",
        "https://10.0.0.5/hook",
        "https://169.254.169.254/latest",
        "https://[::1]/x",
      ]) {
        await expect(
          updateChannelSettings(w.admin, { whatsappWebhookUrl: url }, meta()),
          url,
        ).rejects.toMatchObject({ code: "UNSAFE_URL" });
      }
      await expect(
        updateChannelSettings(w.admin, { whatsappWebhookUrl: "http://93.184.216.34/hook" }, meta()),
      ).rejects.toThrow(/HTTPS/);
      await expect(
        updateChannelSettings(w.admin, { smtpPort: 6379 }, meta()),
      ).rejects.toMatchObject({ code: "SMTP_PORT" });
    });

    it("solo quien administra la configuración puede cambiar canales", async () => {
      await expect(
        updateChannelSettings(w.manager, { smtpUser: "x" }, meta()),
      ).rejects.toBeInstanceOf(PermissionDeniedError);
      await expect(getChannelSettings(w.cashier)).rejects.toBeInstanceOf(PermissionDeniedError);
    });
  });

  describe("enviar prueba", () => {
    it("envía por el canal real y reporta el resultado", async () => {
      const calls: string[] = [];
      setChannelDepsForTests({
        resolve: async () => ["93.184.216.34"],
        fetch: async (url) => (calls.push(url), new Response('{"id":"w1"}', { status: 200 })),
      });
      await expect(
        sendTestMessage(w.admin, { channel: "WHATSAPP", to: "+51 987 111 222" }, meta()),
      ).resolves.toMatchObject({ status: "SENT" });
      expect(calls).toEqual(["https://93.184.216.34/webhook/wa"]);

      const sent: unknown[] = [];
      setChannelDepsForTests({
        resolve: async () => ["93.184.216.34"],
        transportFactory: () => ({ sendMail: async (m) => (sent.push(m), { messageId: "m1" }) }),
      });
      await expect(
        sendTestMessage(w.admin, { channel: "EMAIL", to: "yo@taller.pe" }, meta()),
      ).resolves.toMatchObject({ status: "SENT" });
      expect(sent).toHaveLength(1);
    });

    it("informa el fallo sin lanzar y sin filtrar secretos", async () => {
      setChannelDepsForTests({
        resolve: async () => ["93.184.216.34"],
        fetch: async () => new Response("no", { status: 401 }),
      });
      const result = await sendTestMessage(
        w.admin,
        { channel: "WHATSAPP", to: "+51 987 111 222" },
        meta(),
      );
      expect(result).toMatchObject({
        status: "FAILED",
        detail: "El webhook de WhatsApp respondió 401",
      });
    });

    it("canal sin configurar => FAILED claro", async () => {
      const result = await sendTestMessage(
        other.admin,
        { channel: "EMAIL", to: "yo@taller.pe" },
        meta(),
      );
      expect(result).toMatchObject({
        status: "FAILED",
        detail: expect.stringContaining("Configura primero"),
      });
    });

    it("tiene rate limit (5 por 10 minutos)", async () => {
      const t = await purchasingWorld(admin);
      const results: unknown[] = [];
      for (let i = 0; i < 7; i += 1)
        results.push(
          await sendTestMessage(t.admin, { channel: "EMAIL", to: "yo@taller.pe" }, meta()).catch(
            (e: unknown) => e,
          ),
        );
      expect(results[4]).toMatchObject({ status: "FAILED" });
      expect(results[5]).toBeInstanceOf(RateLimitError);
    });

    it("en una cuenta demo es SIMULADO y no se llama a ningún adaptador", async () => {
      let called = 0;
      setChannelDepsForTests({
        resolve: async () => ["93.184.216.34"],
        fetch: async () => ((called += 1), new Response("{}")),
        transportFactory: () => ({ sendMail: async () => ((called += 1), {}) }),
      });
      const demo = await provisionDemo({ ip: `demo-${randomUUID()}` });
      const row = await admin.user.findUniqueOrThrow({ where: { id: demo.userId } });
      const user = await resolveSession({
        sub: demo.userId,
        tid: demo.tenantId,
        sv: row.sessionVersion,
        mfa: true,
      });
      if (!user) throw new Error("demo");
      for (const channel of ["WHATSAPP", "EMAIL"] as const) {
        await expect(
          sendTestMessage(user, { channel, to: "+51 987 111 222" }, meta()),
        ).resolves.toMatchObject({ status: "SIMULATED" });
      }
      expect(called).toBe(0);
    });
  });

  describe("consumo y topes", () => {
    it("suma tokens y costo del mes; las corridas simuladas no cuentan", async () => {
      const t = await purchasingWorld(admin);
      await updateAiSettings(
        t.admin,
        { apiKey: API_KEY, monthlyTokenCap: 10_000, monthlyCostCapUsd: 5 },
        meta(),
      );
      const base = {
        tenantId: t.tenantId,
        kind: "PURCHASING" as const,
        status: "SUCCEEDED" as const,
        model: "gpt-4o-mini",
        prompt: {},
      };
      await admin.aiRun.create({
        data: {
          ...base,
          promptTokens: 3000,
          completionTokens: 1000,
          costUsd: "0.5",
          idempotencyKey: randomUUID(),
        },
      });
      await admin.aiRun.create({
        data: {
          ...base,
          promptTokens: 99_999,
          completionTokens: 1,
          costUsd: "99",
          simulated: true,
          idempotencyKey: randomUUID(),
        },
      });
      await admin.aiRun.create({
        data: {
          ...base,
          promptTokens: 8000,
          completionTokens: 0,
          costUsd: "1",
          startedAt: new Date(Date.now() - 62 * 86_400_000),
          idempotencyKey: randomUUID(),
        },
      });
      const usage = (await getAiSettings(t.admin)).usage;
      expect(usage).toMatchObject({
        tokens: 4000,
        tokenCap: 10_000,
        tokensRemaining: 6000,
        exhausted: false,
      });
      expect(usage.costUsd).toBeCloseTo(0.5, 5);
      await admin.aiRun.create({
        data: {
          ...base,
          promptTokens: 6000,
          completionTokens: 0,
          costUsd: "0.1",
          idempotencyKey: randomUUID(),
        },
      });
      expect((await getAiSettings(t.admin)).usage).toMatchObject({
        tokens: 10_000,
        exhausted: true,
        tokensRemaining: 0,
      });
    });
  });
});
