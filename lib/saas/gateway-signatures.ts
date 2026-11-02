import { createHmac, timingSafeEqual } from "node:crypto";

/** Tolerancia anti-replay de las firmas con marca de tiempo (5 minutos), igual que recomienda cada pasarela. */
export const GATEWAY_TOLERANCE_MS = 300_000;

export type SignatureResult = "ok" | "missing" | "stale" | "invalid";

function safeEqualHex(expected: string, received: string): boolean {
  const a = Buffer.from(expected);
  const b = Buffer.from(received);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Firma al estilo Stripe: `HMAC-SHA256(secreto, "<t>.<cuerpo crudo>")` en hex. */
export function signStripeStyle(secret: string, timestampSeconds: number, rawBody: string): string {
  return createHmac("sha256", secret).update(`${timestampSeconds}.${rawBody}`).digest("hex");
}

/** `Stripe-Signature: t=1614265330,v1=<hex>[,v1=<hex>][,v0=<hex>]`. Solo cuenta v1; cualquiera de ellos válido basta. */
export function verifyStripeStyle(params: {
  secret: string;
  header: string | null;
  rawBody: string;
  nowMs: number;
}): SignatureResult {
  if (!params.header) return "missing";
  const parts = params.header.split(",").map((part) => part.trim().split("=") as [string, string]);
  const t = parts.find(([key]) => key === "t")?.[1];
  const signatures = parts.filter(([key]) => key === "v1").map(([, value]) => value);
  if (!t || !/^\d{9,13}$/.test(t) || signatures.length === 0) return "invalid";
  if (Math.abs(params.nowMs - Number(t) * 1000) > GATEWAY_TOLERANCE_MS) return "stale";
  const expected = signStripeStyle(params.secret, Number(t), params.rawBody);
  return signatures.some((signature) => safeEqualHex(expected, signature)) ? "ok" : "invalid";
}

/** Plantilla firmada de Mercado Pago: `id:<data.id>;request-id:<x-request-id>;ts:<ts>;` omitiendo lo que falte. */
export function mercadoPagoManifest(p: {
  dataId: string | null;
  requestId: string | null;
  ts: string;
}): string {
  // Si el id es alfanumérico, Mercado Pago lo firma en minúsculas.
  const id = p.dataId && /^[a-z0-9]+$/i.test(p.dataId) ? p.dataId.toLowerCase() : p.dataId;
  return `${id ? `id:${id};` : ""}${p.requestId ? `request-id:${p.requestId};` : ""}ts:${p.ts};`;
}

export function signMercadoPago(secret: string, manifest: string): string {
  return createHmac("sha256", secret).update(manifest).digest("hex");
}

/** `x-signature: ts=<ms>,v1=<hex>`. */
export function verifyMercadoPago(params: {
  secret: string;
  header: string | null;
  requestId: string | null;
  dataId: string | null;
  nowMs: number;
}): SignatureResult {
  if (!params.header) return "missing";
  const parts = Object.fromEntries(
    params.header.split(",").map((part) => part.trim().split("=") as [string, string]),
  );
  const ts = parts.ts;
  const v1 = parts.v1;
  if (!ts || !v1 || !/^\d{9,13}$/.test(ts)) return "invalid";
  const tsMs = ts.length > 11 ? Number(ts) : Number(ts) * 1000;
  if (Math.abs(params.nowMs - tsMs) > GATEWAY_TOLERANCE_MS) return "stale";
  const expected = signMercadoPago(
    params.secret,
    mercadoPagoManifest({ dataId: params.dataId, requestId: params.requestId, ts }),
  );
  return safeEqualHex(expected, v1) ? "ok" : "invalid";
}
