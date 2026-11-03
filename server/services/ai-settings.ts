import { randomBytes } from "node:crypto";
import { can, requirePermission, requireTenantId, type AuthUser } from "@/lib/auth/can";
import { consumeRateLimit, withTenant, type TenantTx } from "@/lib/db";
import { getEnv } from "@/lib/env";
import { ConflictError, RateLimitError } from "@/lib/errors";
import { decryptSecret, encryptSecret, maskSecret, secretHint } from "@/lib/security/crypto";
import { assertPublicUrl, UnsafeUrlError } from "@/lib/security/net";
import {
  aiSettingsSchema,
  automationSwitchesSchema,
  channelSettingsSchema,
  testMessageSchema,
  type AiSettingsInput,
  type AutomationSwitchesInput,
  type ChannelSettingsInput,
  type TestMessageInput,
} from "@/lib/validation/settings";
import {
  isAllowedSmtpPort,
  sendEmail,
  sendWhatsApp,
  ChannelError,
  type SmtpConfig,
  type WhatsAppConfig,
} from "@/server/integrations/channels";
import { auditContextOf, recordAudit, type RequestMeta } from "./audit";
import { getAiUsage, type AiUsage } from "./ai-usage";

const context = (tenantId: string, field: "openai" | "whatsapp" | "inbound" | "smtp") =>
  `tenant:${tenantId}:${field}`;

export interface TenantSecrets {
  openaiKey: string | null;
  whatsapp: WhatsAppConfig | null;
  smtp: SmtpConfig | null;
  inboundSecret: string | null;
}

/**
 * Descifra las credenciales del tenant. USO INTERNO de los servicios que las necesitan
 * (agente, envíos, webhooks): nada de esto se devuelve a la UI ni se escribe en logs.
 */
export async function loadTenantSecrets(tx: TenantTx, tenantId: string): Promise<TenantSecrets> {
  const key = getEnv().ENCRYPTION_KEY;
  const s = await tx.tenantSettings.findFirst();
  if (!s) return { openaiKey: null, whatsapp: null, smtp: null, inboundSecret: null };
  return {
    openaiKey: s.openaiApiKeyEncrypted
      ? decryptSecret(s.openaiApiKeyEncrypted, key, context(tenantId, "openai"))
      : null,
    whatsapp:
      s.whatsappProvider && s.whatsappWebhookUrl
        ? {
            provider: s.whatsappProvider,
            url: s.whatsappWebhookUrl,
            apiKey: s.whatsappApiKeyEncrypted
              ? decryptSecret(s.whatsappApiKeyEncrypted, key, context(tenantId, "whatsapp"))
              : null,
          }
        : null,
    smtp:
      s.smtpHost && s.smtpPort && s.smtpFromAddress
        ? {
            host: s.smtpHost,
            port: s.smtpPort,
            secure: s.smtpSecure,
            user: s.smtpUser,
            password: s.smtpPasswordEncrypted
              ? decryptSecret(s.smtpPasswordEncrypted, key, context(tenantId, "smtp"))
              : null,
            from: s.smtpFromAddress,
          }
        : null,
    inboundSecret: s.whatsappInboundSecretEncrypted
      ? decryptSecret(s.whatsappInboundSecretEncrypted, key, context(tenantId, "inbound"))
      : null,
  };
}

export interface AiSettingsView {
  model: string;
  tone: string | null;
  mode: "DRAFT_APPROVAL" | "AUTOMATIC";
  monthlyTokenCap: number | null;
  monthlyCostCapUsd: number | null;
  maxOrderAmount: number | null;
  maxQtyPerSku: number | null;
  maxOrdersPerDay: number;
  hasApiKey: boolean;
  /** `••••••••abcd`: solo los últimos 4 caracteres. */
  apiKeyMasked: string | null;
  usage: AiUsage;
}

const num = (value: { toString(): string } | null): number | null =>
  value === null ? null : Number(value.toString());

export async function getAiSettings(actor: AuthUser): Promise<AiSettingsView> {
  requirePermission(actor, "ai_agent:ver");
  return withTenant(requireTenantId(actor), async (tx) => {
    const s = await tx.tenantSettings.findFirstOrThrow();
    return {
      model: s.aiModel,
      tone: s.aiTone,
      mode: s.aiMode,
      monthlyTokenCap: s.aiMonthlyTokenCap,
      monthlyCostCapUsd: num(s.aiMonthlyCostCapUsd),
      maxOrderAmount: num(s.aiMaxOrderAmount),
      maxQtyPerSku: num(s.aiMaxQtyPerSku),
      maxOrdersPerDay: s.aiMaxOrdersPerDay,
      hasApiKey: Boolean(s.openaiApiKeyEncrypted),
      apiKeyMasked: s.openaiApiKeyHint ? maskSecret(`xxxx${s.openaiApiKeyHint}`) : null,
      usage: await getAiUsage(tx),
    };
  });
}

/** Cambia la configuración del agente. La clave se cifra y los cambios se auditan SIN secretos. */
export async function updateAiSettings(
  actor: AuthUser,
  input: AiSettingsInput,
  meta: RequestMeta = {},
): Promise<void> {
  requirePermission(actor, "ai_agent:editar");
  const tenantId = requireTenantId(actor);
  const data = aiSettingsSchema.parse(input);
  if (data.mode === "AUTOMATIC") requirePermission(actor, "ai_agent:autorizar_pedidos_ia");

  await withTenant(tenantId, async (tx) => {
    const before = await tx.tenantSettings.findFirstOrThrow();
    const patch: Record<string, unknown> = {};
    if (data.model !== undefined) patch.aiModel = data.model;
    if (data.tone !== undefined) patch.aiTone = data.tone || null;
    if (data.mode !== undefined) patch.aiMode = data.mode;
    if (data.monthlyTokenCap !== undefined) patch.aiMonthlyTokenCap = data.monthlyTokenCap;
    if (data.monthlyCostCapUsd !== undefined)
      patch.aiMonthlyCostCapUsd =
        data.monthlyCostCapUsd === null ? null : data.monthlyCostCapUsd.toString();
    if (data.maxOrderAmount !== undefined)
      patch.aiMaxOrderAmount = data.maxOrderAmount === null ? null : data.maxOrderAmount.toString();
    if (data.maxQtyPerSku !== undefined)
      patch.aiMaxQtyPerSku = data.maxQtyPerSku === null ? null : data.maxQtyPerSku.toString();
    if (data.maxOrdersPerDay !== undefined) patch.aiMaxOrdersPerDay = data.maxOrdersPerDay;
    if (data.apiKey) {
      patch.openaiApiKeyEncrypted = encryptSecret(
        data.apiKey,
        getEnv().ENCRYPTION_KEY,
        context(tenantId, "openai"),
      );
      patch.openaiApiKeyHint = secretHint(data.apiKey);
    } else if (data.clearApiKey) {
      patch.openaiApiKeyEncrypted = null;
      patch.openaiApiKeyHint = null;
    }
    const after = await tx.tenantSettings.update({ where: { id: before.id }, data: patch });
    const snapshot = (s: typeof before) => ({
      model: s.aiModel,
      tone: s.aiTone,
      mode: s.aiMode,
      tokenCap: s.aiMonthlyTokenCap,
      costCapUsd: num(s.aiMonthlyCostCapUsd),
      maxOrderAmount: num(s.aiMaxOrderAmount),
      maxQtyPerSku: num(s.aiMaxQtyPerSku),
      maxOrdersPerDay: s.aiMaxOrdersPerDay,
      apiKey: s.openaiApiKeyEncrypted ? `••••${s.openaiApiKeyHint ?? ""}` : null,
    });
    await recordAudit(tx, auditContextOf(actor, meta), {
      action: "ai.settings_changed",
      entityType: "tenant_settings",
      entityId: before.id,
      before: snapshot(before),
      after: snapshot(after),
    });
  });
}

export interface ChannelSettingsView {
  whatsappProvider: "N8N" | "EVOLUTION" | "BUSINESS" | null;
  whatsappWebhookUrl: string | null;
  whatsappApiKeyMasked: string | null;
  hasInboundSecret: boolean;
  smtpHost: string | null;
  smtpPort: number | null;
  smtpSecure: boolean;
  smtpUser: string | null;
  smtpPasswordMasked: string | null;
  smtpFromAddress: string | null;
}

export async function getChannelSettings(actor: AuthUser): Promise<ChannelSettingsView> {
  requirePermission(actor, "settings:ver");
  return withTenant(requireTenantId(actor), async (tx) => {
    const s = await tx.tenantSettings.findFirstOrThrow();
    return {
      whatsappProvider: s.whatsappProvider,
      whatsappWebhookUrl: s.whatsappWebhookUrl,
      whatsappApiKeyMasked: s.whatsappApiKeyHint ? maskSecret(`xxxx${s.whatsappApiKeyHint}`) : null,
      hasInboundSecret: Boolean(s.whatsappInboundSecretEncrypted),
      smtpHost: s.smtpHost,
      smtpPort: s.smtpPort,
      smtpSecure: s.smtpSecure,
      smtpUser: s.smtpUser,
      smtpPasswordMasked: s.smtpPasswordHint ? maskSecret(`xxxx${s.smtpPasswordHint}`) : null,
      smtpFromAddress: s.smtpFromAddress,
    };
  });
}

/**
 * Configura WhatsApp (webhook de n8n / Evolution / Business) y SMTP. Valida que el destino
 * sea público (anti-SSRF). Si se rota el secreto entrante, se devuelve UNA sola vez.
 */
export async function updateChannelSettings(
  actor: AuthUser,
  input: ChannelSettingsInput,
  meta: RequestMeta = {},
): Promise<{ inboundSecret: string | null }> {
  requirePermission(actor, "settings:editar");
  const tenantId = requireTenantId(actor);
  const data = channelSettingsSchema.parse(input);

  if (data.whatsappWebhookUrl) {
    try {
      await assertPublicUrl(data.whatsappWebhookUrl);
    } catch (error) {
      if (error instanceof UnsafeUrlError) throw new ConflictError("UNSAFE_URL", error.message);
      throw error;
    }
  }
  if (data.smtpPort !== undefined && data.smtpPort !== null && !isAllowedSmtpPort(data.smtpPort)) {
    throw new ConflictError("SMTP_PORT", "Puerto SMTP no permitido (usa 25, 465, 587 o 2525)");
  }

  const key = getEnv().ENCRYPTION_KEY;
  let inboundSecret: string | null = null;
  await withTenant(tenantId, async (tx) => {
    const before = await tx.tenantSettings.findFirstOrThrow();
    const patch: Record<string, unknown> = {};
    if (data.whatsappProvider !== undefined) patch.whatsappProvider = data.whatsappProvider;
    if (data.whatsappWebhookUrl !== undefined)
      patch.whatsappWebhookUrl = data.whatsappWebhookUrl || null;
    if (data.whatsappApiKey) {
      patch.whatsappApiKeyEncrypted = encryptSecret(
        data.whatsappApiKey,
        key,
        context(tenantId, "whatsapp"),
      );
      patch.whatsappApiKeyHint = secretHint(data.whatsappApiKey);
    } else if (data.clearWhatsappApiKey) {
      patch.whatsappApiKeyEncrypted = null;
      patch.whatsappApiKeyHint = null;
    }
    if (data.rotateInboundSecret) {
      inboundSecret = randomBytes(32).toString("base64url");
      patch.whatsappInboundSecretEncrypted = encryptSecret(
        inboundSecret,
        key,
        context(tenantId, "inbound"),
      );
    }
    if (data.smtpHost !== undefined) patch.smtpHost = data.smtpHost || null;
    if (data.smtpPort !== undefined) patch.smtpPort = data.smtpPort;
    if (data.smtpSecure !== undefined) patch.smtpSecure = data.smtpSecure;
    if (data.smtpUser !== undefined) patch.smtpUser = data.smtpUser || null;
    if (data.smtpFromAddress !== undefined) patch.smtpFromAddress = data.smtpFromAddress || null;
    if (data.smtpPassword) {
      patch.smtpPasswordEncrypted = encryptSecret(
        data.smtpPassword,
        key,
        context(tenantId, "smtp"),
      );
      patch.smtpPasswordHint = secretHint(data.smtpPassword);
    } else if (data.clearSmtpPassword) {
      patch.smtpPasswordEncrypted = null;
      patch.smtpPasswordHint = null;
    }
    const after = await tx.tenantSettings.update({ where: { id: before.id }, data: patch });
    const snapshot = (s: typeof before) => ({
      whatsappProvider: s.whatsappProvider,
      whatsappWebhookUrl: s.whatsappWebhookUrl,
      whatsappApiKey: s.whatsappApiKeyHint ? `••••${s.whatsappApiKeyHint}` : null,
      inboundSecret: s.whatsappInboundSecretEncrypted ? "configurado" : null,
      smtpHost: s.smtpHost,
      smtpPort: s.smtpPort,
      smtpUser: s.smtpUser,
      smtpPassword: s.smtpPasswordHint ? `••••${s.smtpPasswordHint}` : null,
      smtpFromAddress: s.smtpFromAddress,
    });
    await recordAudit(tx, auditContextOf(actor, meta), {
      action: "channels.settings_changed",
      entityType: "tenant_settings",
      entityId: before.id,
      before: snapshot(before),
      after: snapshot({
        ...after,
        whatsappInboundSecretEncrypted: after.whatsappInboundSecretEncrypted,
      }),
    });
  });
  return { inboundSecret };
}

export interface TestMessageResult {
  status: "SENT" | "SIMULATED" | "FAILED";
  detail: string;
}

/** Botón "enviar prueba": prueba el canal real. En demo es simulado y nunca sale un mensaje. */
export async function sendTestMessage(
  actor: AuthUser,
  input: TestMessageInput,
  meta: RequestMeta = {},
): Promise<TestMessageResult> {
  requirePermission(actor, "settings:editar");
  const tenantId = requireTenantId(actor);
  const data = testMessageSchema.parse(input);
  const limit = await consumeRateLimit("channel-test", tenantId, 5, 600);
  if (!limit.allowed) throw new RateLimitError(limit.retryAfterSeconds);

  const { isDemo, secrets } = await withTenant(tenantId, async (tx) => ({
    isDemo: (await tx.tenant.findFirstOrThrow({ select: { isDemo: true } })).isDemo,
    secrets: await loadTenantSecrets(tx, tenantId),
  }));
  const body = "Mensaje de prueba de Mecania: tu canal está bien configurado.";
  let result: TestMessageResult;
  if (isDemo) {
    result = {
      status: "SIMULATED",
      detail: "Cuenta demo: el envío es simulado y no sale ningún mensaje real.",
    };
  } else {
    try {
      if (data.channel === "WHATSAPP") {
        if (!secrets.whatsapp)
          throw new ChannelError("Configura primero el webhook de WhatsApp", false);
        await sendWhatsApp(secrets.whatsapp, {
          to: data.to,
          body,
          idempotencyKey: `test-${Date.now()}`,
        });
      } else {
        if (!secrets.smtp) throw new ChannelError("Configura primero el SMTP", false);
        await sendEmail(secrets.smtp, {
          to: data.to,
          subject: "Prueba de correo — Mecania",
          text: body,
        });
      }
      result = { status: "SENT", detail: "Mensaje de prueba enviado." };
    } catch (error) {
      result = {
        status: "FAILED",
        detail: error instanceof ChannelError ? error.message : "No se pudo enviar la prueba.",
      };
    }
  }
  await withTenant(tenantId, (tx) =>
    recordAudit(tx, auditContextOf(actor, meta), {
      action: "channels.test_sent",
      entityType: "tenant_settings",
      after: { channel: data.channel, status: result.status },
    }),
  );
  return result;
}

export interface AutomationSwitches {
  aiAgentEnabled: boolean;
  whatsappNoticesEnabled: boolean;
  humanApproval: boolean;
}

export async function getAutomationSwitches(actor: AuthUser): Promise<AutomationSwitches> {
  if (!can(actor, "settings:ver") && !can(actor, "ai_agent:ver"))
    requirePermission(actor, "settings:ver");
  return withTenant(requireTenantId(actor), async (tx) => {
    const s = await tx.tenantSettings.findFirstOrThrow({
      select: { aiAgentEnabled: true, whatsappNoticesEnabled: true, aiMode: true },
    });
    return {
      aiAgentEnabled: s.aiAgentEnabled,
      whatsappNoticesEnabled: s.whatsappNoticesEnabled,
      humanApproval: s.aiMode === "DRAFT_APPROVAL",
    };
  });
}

/**
 * Interruptores de agente, avisos por WhatsApp y aprobación humana. Cada uno exige su permiso en el
 * servidor: encender el envío automático (sin aprobación) pide además autorizar pedidos de IA.
 */
export async function updateAutomationSwitches(
  actor: AuthUser,
  input: AutomationSwitchesInput,
  meta: RequestMeta = {},
): Promise<void> {
  const data = automationSwitchesSchema.parse(input);
  const tenantId = requireTenantId(actor);
  if (data.aiAgentEnabled !== undefined) requirePermission(actor, "ai_agent:editar");
  if (data.whatsappNoticesEnabled !== undefined) requirePermission(actor, "settings:editar");
  if (data.humanApproval !== undefined) {
    requirePermission(actor, "ai_agent:editar");
    if (data.humanApproval === false) requirePermission(actor, "ai_agent:autorizar_pedidos_ia");
  }
  await withTenant(tenantId, async (tx) => {
    const before = await tx.tenantSettings.findFirstOrThrow();
    const patch = {
      ...(data.aiAgentEnabled !== undefined ? { aiAgentEnabled: data.aiAgentEnabled } : {}),
      ...(data.whatsappNoticesEnabled !== undefined
        ? { whatsappNoticesEnabled: data.whatsappNoticesEnabled }
        : {}),
      ...(data.humanApproval !== undefined
        ? { aiMode: data.humanApproval ? ("DRAFT_APPROVAL" as const) : ("AUTOMATIC" as const) }
        : {}),
    };
    if (Object.keys(patch).length === 0) return;
    await tx.tenantSettings.update({ where: { id: before.id }, data: patch });
    await recordAudit(tx, auditContextOf(actor, meta), {
      action: "ai.switches_changed",
      entityType: "tenant_settings",
      entityId: before.id,
      before: {
        aiAgentEnabled: before.aiAgentEnabled,
        whatsappNoticesEnabled: before.whatsappNoticesEnabled,
        humanApproval: before.aiMode === "DRAFT_APPROVAL",
      },
      after: {
        aiAgentEnabled: patch.aiAgentEnabled ?? before.aiAgentEnabled,
        whatsappNoticesEnabled: patch.whatsappNoticesEnabled ?? before.whatsappNoticesEnabled,
        humanApproval: (patch.aiMode ?? before.aiMode) === "DRAFT_APPROVAL",
      },
    });
  });
}
