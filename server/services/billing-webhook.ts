import { consumeRateLimit } from "@/lib/db";
import { logger } from "@/lib/logger";
import { GatewayError, getGateway } from "@/server/integrations/payments";
import { applyGatewayEvent } from "./subscription-billing";

export const MAX_BILLING_WEBHOOK_BYTES = 256 * 1024;

export interface BillingWebhookResult {
  status: number;
  body: { ok: boolean; error?: string; outcome?: string };
}

/**
 * Entrada de los webhooks de la pasarela de cobro. Orden de defensas: tamaño → tasa por IP →
 * pasarela configurada → firma (cuerpo CRUDO) → aplicar de forma idempotente.
 * 4xx = no reintentar (firma mala, evento mal formado); 5xx = la pasarela debe reintentar.
 */
export async function handleBillingWebhook(params: {
  gateway: string;
  rawBody: string;
  headers: Record<string, string | null>;
  query: URLSearchParams;
  ip?: string;
  nowMs?: number;
}): Promise<BillingWebhookResult> {
  if (Buffer.byteLength(params.rawBody) > MAX_BILLING_WEBHOOK_BYTES)
    return { status: 413, body: { ok: false, error: "payload_too_large" } };
  const limit = await consumeRateLimit("billing-webhook:ip", params.ip ?? "unknown", 600, 60);
  if (!limit.allowed) return { status: 429, body: { ok: false, error: "rate_limited" } };

  const adapter = getGateway();
  // La ruta debe coincidir con la pasarela activa: un endpoint de otra pasarela no existe.
  if (!adapter || adapter.id.toLowerCase() !== params.gateway.toLowerCase())
    return { status: 404, body: { ok: false, error: "not_found" } };

  try {
    const parsed = await adapter.parseWebhook({
      rawBody: params.rawBody,
      headers: params.headers,
      query: params.query,
      nowMs: params.nowMs ?? Date.now(),
    });
    if (!parsed.ok) {
      logger.warn(
        { gateway: adapter.id, reason: parsed.reason, ip: params.ip },
        "webhook de cobro rechazado",
      );
      return {
        status: parsed.reason === "malformed" ? 400 : 401,
        body: {
          ok: false,
          error: parsed.reason === "malformed" ? "malformed" : "invalid_signature",
        },
      };
    }
    const outcome = await applyGatewayEvent(adapter.id, parsed.event);
    return { status: 200, body: { ok: true, outcome } };
  } catch (error) {
    if (error instanceof GatewayError && !error.retryable) {
      logger.error({ err: error, gateway: adapter.id }, "no se pudo procesar el webhook de cobro");
      return { status: 400, body: { ok: false, error: "gateway_error" } };
    }
    logger.error({ err: error, gateway: adapter.id }, "error procesando el webhook de cobro");
    return { status: 500, body: { ok: false, error: "internal_error" } };
  }
}
