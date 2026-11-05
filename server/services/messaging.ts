import type { MessageChannel, TenantTx } from "@/lib/db";
import { DEMO_AI_TOKEN_CAP } from "./platform-seed";
import { effectiveModules } from "./limits";

export interface OutboundInput {
  channel: MessageChannel;
  toAddress: string;
  subject?: string;
  body: string;
  idempotencyKey: string;
  relatedType?: string;
  relatedId?: string;
}

/**
 * Encola un mensaje a cliente/proveedor. En una cuenta demo queda SIMULATED y
 * nunca llega a un adaptador real. Idempotente por `idempotencyKey`.
 */
export async function enqueueOutbound(tx: TenantTx, input: OutboundInput) {
  const existing = await tx.outboundMessage.findFirst({
    where: { idempotencyKey: input.idempotencyKey },
  });
  if (existing) return existing;
  const tenant = await tx.tenant.findFirstOrThrow({ select: { isDemo: true } });
  return tx.outboundMessage.create({
    data: {
      channel: input.channel,
      toAddress: input.toAddress,
      subject: input.subject ?? null,
      body: input.body,
      idempotencyKey: input.idempotencyKey,
      relatedType: input.relatedType ?? null,
      relatedId: input.relatedId ?? null,
      status: tenant.isDemo ? "SIMULATED" : "PENDING",
      sentAt: tenant.isDemo ? new Date() : null,
    },
  });
}

export interface AiPolicy {
  /** El plan y los módulos del tenant permiten el agente de compras. */
  enabled: boolean;
  /** Demo: respuestas controladas, sin llamar a OpenAI. */
  simulated: boolean;
  /** Tope mensual de tokens (null = sin tope). En demo nunca supera DEMO_AI_TOKEN_CAP. */
  monthlyTokenCap: number | null;
}

/** Política de IA que la Fase 4 debe respetar antes de cada llamada. */
export async function resolveAiPolicy(tx: TenantTx): Promise<AiPolicy> {
  const tenant = await tx.tenant.findFirstOrThrow({ include: { plan: true, settings: true } });
  const modules = effectiveModules(
    tenant.plan,
    tenant.settings?.enabledModules ?? [],
    tenant.settings?.disabledModules ?? [],
  );
  const enabled = tenant.plan.aiPurchasingAgent && modules.includes("AI_AGENT");
  const configured = tenant.settings?.aiMonthlyTokenCap ?? tenant.plan.monthlyAiTokens;
  if (tenant.isDemo) {
    return {
      enabled,
      simulated: true,
      monthlyTokenCap: Math.min(configured ?? DEMO_AI_TOKEN_CAP, DEMO_AI_TOKEN_CAP),
    };
  }
  return { enabled, simulated: false, monthlyTokenCap: configured };
}
