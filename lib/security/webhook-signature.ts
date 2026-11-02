import { createHmac, timingSafeEqual } from "node:crypto";

export const WEBHOOK_TOLERANCE_SECONDS = 300;
export const SIGNATURE_PREFIX = "sha256=";

/** Firma `HMAC-SHA256(secreto, "<timestamp>.<cuerpo crudo>")`, en hex con prefijo `sha256=`. */
export function signWebhook(secret: string, timestamp: string, rawBody: string): string {
  return (
    SIGNATURE_PREFIX + createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex")
  );
}

export type SignatureCheck = "ok" | "missing" | "stale" | "invalid";

/**
 * Verifica firma y frescura (anti-replay). El timestamp va firmado, así que un
 * atacante no puede reutilizar un cuerpo viejo con un timestamp nuevo.
 */
export function verifyWebhook(params: {
  secret: string;
  timestamp: string | null;
  signature: string | null;
  rawBody: string;
  nowMs?: number;
}): SignatureCheck {
  const { secret, timestamp, signature, rawBody } = params;
  if (!timestamp || !signature) return "missing";
  if (!/^\d{9,13}$/.test(timestamp)) return "invalid";
  // Acepta segundos o milisegundos epoch.
  const timestampMs = timestamp.length > 11 ? Number(timestamp) : Number(timestamp) * 1000;
  const now = params.nowMs ?? Date.now();
  if (Math.abs(now - timestampMs) > WEBHOOK_TOLERANCE_SECONDS * 1000) return "stale";

  const expected = Buffer.from(signWebhook(secret, timestamp, rawBody));
  const received = Buffer.from(signature);
  if (expected.length !== received.length) return "invalid";
  return timingSafeEqual(expected, received) ? "ok" : "invalid";
}
