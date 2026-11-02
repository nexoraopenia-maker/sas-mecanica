import { z } from "zod";
import { getEnv } from "@/lib/env";
import {
  signStripeStyle,
  verifyMercadoPago,
  verifyStripeStyle,
  type SignatureResult,
} from "@/lib/saas/gateway-signatures";

export type GatewayId = "STRIPE" | "MERCADOPAGO" | "SIMULATED";

/** Error de la pasarela: transitorio (red, 5xx, 429) se reintenta; el resto exige revisar la configuración. */
export class GatewayError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "GatewayError";
  }
}

export interface CheckoutRequest {
  /** Id de nuestro `SubscriptionPayment`: viaja como referencia y es lo único con lo que se acepta un pago. */
  paymentId: string;
  amount: string;
  currency: string;
  description: string;
  customerEmail: string;
  gatewayCustomerId: string | null;
  /** Guardar el método de pago para cobrar las renovaciones sin intervención (si la pasarela lo permite). */
  saveMethod: boolean;
  successUrl: string;
  cancelUrl: string;
}

export interface ChargeRequest {
  paymentId: string;
  amount: string;
  currency: string;
  description: string;
  gatewayCustomerId: string;
  paymentMethodId: string;
  idempotencyKey: string;
}

export interface ChargeResult {
  status: "SUCCEEDED" | "FAILED";
  gatewayPaymentId: string | null;
  failureCode: string | null;
  failureMessage: string | null;
}

/** Evento ya verificado y normalizado: lo único que el resto del sistema conoce de una pasarela. */
export interface GatewayEvent {
  /** Id estable del evento (idempotencia). */
  id: string;
  type: "PAYMENT_SUCCEEDED" | "PAYMENT_FAILED" | "IGNORED";
  /** Id de nuestro SubscriptionPayment, tal como lo enviamos al crear el cobro. */
  paymentId: string | null;
  gatewayPaymentId: string | null;
  gatewayCustomerId: string | null;
  paymentMethodId: string | null;
  amount: string | null;
  currency: string | null;
  failureCode: string | null;
  failureMessage: string | null;
}

export type ParsedWebhook =
  | { ok: true; event: GatewayEvent }
  | { ok: false; reason: Exclude<SignatureResult, "ok"> | "malformed" };

export interface WebhookInput {
  rawBody: string;
  headers: Record<string, string | null>;
  query: URLSearchParams;
  nowMs: number;
}

export interface PaymentGatewayAdapter {
  readonly id: GatewayId;
  /** ¿Puede cobrar una renovación con el método guardado, sin que el cliente intervenga? */
  readonly supportsAutoCharge: boolean;
  createCheckout(request: CheckoutRequest): Promise<{ url: string; sessionId: string }>;
  charge?(request: ChargeRequest): Promise<ChargeResult>;
  /** Verifica la firma con el cuerpo CRUDO y devuelve el evento normalizado. */
  parseWebhook(input: WebhookInput): Promise<ParsedWebhook>;
}

export interface GatewayDeps {
  fetch: (input: string, init: RequestInit) => Promise<Response>;
}

const realDeps: GatewayDeps = { fetch: (input, init) => fetch(input, init) };

const cents = (amount: string): number => Math.round(Number(amount) * 100);
const fromCents = (value: number): string => (value / 100).toFixed(2);

async function send(
  deps: GatewayDeps,
  url: string,
  init: RequestInit,
): Promise<{ status: number; json: unknown }> {
  let response: Response;
  try {
    response = await deps.fetch(url, {
      ...init,
      redirect: "error",
      signal: AbortSignal.timeout(20_000),
    });
  } catch (error) {
    throw new GatewayError(
      `No se pudo contactar a la pasarela: ${error instanceof Error ? error.name : "error de red"}`,
      true,
    );
  }
  if (response.status >= 500 || response.status === 429 || response.status === 408) {
    throw new GatewayError(`La pasarela respondió ${response.status}`, true);
  }
  let json: unknown = null;
  try {
    json = await response.json();
  } catch {
    json = null;
  }
  return { status: response.status, json };
}

// ---------------------------------------------------------------------------
// Stripe
// ---------------------------------------------------------------------------

const stripeObject = z.object({
  id: z.string(),
  amount: z.number().optional(),
  currency: z.string().optional(),
  customer: z.string().nullish(),
  payment_method: z.string().nullish(),
  metadata: z.record(z.string(), z.string()).nullish(),
  last_payment_error: z
    .object({ code: z.string().nullish(), message: z.string().nullish() })
    .nullish(),
});
const stripeEvent = z.object({
  id: z.string(),
  type: z.string(),
  data: z.object({ object: stripeObject }),
});

const stripeError = z.object({
  error: z.object({
    code: z.string().nullish(),
    message: z.string().nullish(),
    payment_intent: stripeObject.partial().nullish(),
  }),
});

/**
 * Stripe. Checkout (modo pago) con tarjeta guardada para cobrar las renovaciones fuera de sesión con
 * un PaymentIntent (`off_session`). Nuestro `paymentId` viaja en `metadata` y es lo único que se
 * acepta para ubicar el cobro.
 */
export class StripeGateway implements PaymentGatewayAdapter {
  readonly id = "STRIPE" as const;
  readonly supportsAutoCharge = true;
  constructor(
    private readonly config: { secretKey: string; webhookSecret: string },
    private readonly deps: GatewayDeps = realDeps,
  ) {}

  private headers(idempotencyKey: string): Record<string, string> {
    return {
      authorization: `Bearer ${this.config.secretKey}`,
      "content-type": "application/x-www-form-urlencoded",
      "idempotency-key": idempotencyKey,
    };
  }

  async createCheckout(request: CheckoutRequest): Promise<{ url: string; sessionId: string }> {
    const body = new URLSearchParams({
      mode: "payment",
      success_url: request.successUrl,
      cancel_url: request.cancelUrl,
      client_reference_id: request.paymentId,
      "line_items[0][quantity]": "1",
      "line_items[0][price_data][currency]": request.currency.toLowerCase(),
      "line_items[0][price_data][unit_amount]": String(cents(request.amount)),
      "line_items[0][price_data][product_data][name]": request.description,
      "metadata[payment_id]": request.paymentId,
      "payment_intent_data[metadata][payment_id]": request.paymentId,
    });
    if (request.gatewayCustomerId) body.set("customer", request.gatewayCustomerId);
    else {
      body.set("customer_email", request.customerEmail);
      if (request.saveMethod) body.set("customer_creation", "always");
    }
    if (request.saveMethod) body.set("payment_intent_data[setup_future_usage]", "off_session");
    const { status, json } = await send(this.deps, "https://api.stripe.com/v1/checkout/sessions", {
      method: "POST",
      headers: this.headers(`checkout-${request.paymentId}`),
      body,
    });
    const parsed = z.object({ id: z.string(), url: z.url() }).safeParse(json);
    if (status >= 400 || !parsed.success)
      throw new GatewayError(`Stripe rechazó la creación del cobro (${status})`, false);
    return { url: parsed.data.url, sessionId: parsed.data.id };
  }

  async charge(request: ChargeRequest): Promise<ChargeResult> {
    const body = new URLSearchParams({
      amount: String(cents(request.amount)),
      currency: request.currency.toLowerCase(),
      customer: request.gatewayCustomerId,
      payment_method: request.paymentMethodId,
      off_session: "true",
      confirm: "true",
      description: request.description,
      "metadata[payment_id]": request.paymentId,
    });
    const { status, json } = await send(this.deps, "https://api.stripe.com/v1/payment_intents", {
      method: "POST",
      headers: this.headers(request.idempotencyKey),
      body,
    });
    if (status >= 400) {
      const failure = stripeError.safeParse(json);
      if (status === 401 || status === 403)
        throw new GatewayError("Stripe rechazó las credenciales", false);
      return {
        status: "FAILED",
        gatewayPaymentId: failure.success ? (failure.data.error.payment_intent?.id ?? null) : null,
        failureCode: failure.success ? (failure.data.error.code ?? "card_error") : "card_error",
        failureMessage: failure.success
          ? (failure.data.error.message ?? "Cobro rechazado")
          : "Cobro rechazado",
      };
    }
    const intent = z.object({ id: z.string(), status: z.string() }).safeParse(json);
    if (!intent.success)
      throw new GatewayError("Respuesta de Stripe con formato inesperado", false);
    return intent.data.status === "succeeded"
      ? {
          status: "SUCCEEDED",
          gatewayPaymentId: intent.data.id,
          failureCode: null,
          failureMessage: null,
        }
      : {
          status: "FAILED",
          gatewayPaymentId: intent.data.id,
          failureCode: intent.data.status,
          failureMessage: "El banco exige autenticación del titular",
        };
  }

  async parseWebhook(input: WebhookInput): Promise<ParsedWebhook> {
    const check = verifyStripeStyle({
      secret: this.config.webhookSecret,
      header: input.headers["stripe-signature"] ?? null,
      rawBody: input.rawBody,
      nowMs: input.nowMs,
    });
    if (check !== "ok") return { ok: false, reason: check };
    return parseStripeLikeEvent(input.rawBody);
  }
}

function parseStripeLikeEvent(rawBody: string): ParsedWebhook {
  let json: unknown;
  try {
    json = JSON.parse(rawBody);
  } catch {
    return { ok: false, reason: "malformed" };
  }
  const parsed = stripeEvent.safeParse(json);
  if (!parsed.success) return { ok: false, reason: "malformed" };
  const { id, type, data } = parsed.data;
  const object = data.object;
  const base = {
    id,
    paymentId: object.metadata?.payment_id ?? null,
    gatewayPaymentId: object.id,
    gatewayCustomerId: object.customer ?? null,
    paymentMethodId: object.payment_method ?? null,
    amount: object.amount === undefined ? null : fromCents(object.amount),
    currency: object.currency?.toUpperCase() ?? null,
    failureCode: null,
    failureMessage: null,
  };
  if (type === "payment_intent.succeeded")
    return { ok: true, event: { ...base, type: "PAYMENT_SUCCEEDED" } };
  if (type === "payment_intent.payment_failed") {
    return {
      ok: true,
      event: {
        ...base,
        type: "PAYMENT_FAILED",
        failureCode: object.last_payment_error?.code ?? "payment_failed",
        failureMessage: object.last_payment_error?.message ?? "Pago rechazado",
      },
    };
  }
  return { ok: true, event: { ...base, type: "IGNORED" } };
}

// ---------------------------------------------------------------------------
// Mercado Pago
// ---------------------------------------------------------------------------

const mpPayment = z.object({
  id: z.union([z.number(), z.string()]),
  status: z.string(),
  status_detail: z.string().nullish(),
  transaction_amount: z.number().nullish(),
  currency_id: z.string().nullish(),
  external_reference: z.string().nullish(),
});

/**
 * Mercado Pago (Checkout Pro): un enlace de pago por periodo; no guarda tarjeta, así que cada
 * renovación se paga desde el enlace. La notificación solo trae el id del pago: el estado real y la
 * referencia se consultan a la API (tras validar la firma `x-signature`).
 */
export class MercadoPagoGateway implements PaymentGatewayAdapter {
  readonly id = "MERCADOPAGO" as const;
  readonly supportsAutoCharge = false;
  constructor(
    private readonly config: {
      accessToken: string;
      webhookSecret: string;
      notificationUrl: string;
    },
    private readonly deps: GatewayDeps = realDeps,
  ) {}

  async createCheckout(request: CheckoutRequest): Promise<{ url: string; sessionId: string }> {
    const { status, json } = await send(
      this.deps,
      "https://api.mercadopago.com/checkout/preferences",
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.config.accessToken}`,
          "content-type": "application/json",
          "x-idempotency-key": `checkout-${request.paymentId}`,
        },
        body: JSON.stringify({
          items: [
            {
              title: request.description,
              quantity: 1,
              unit_price: Number(request.amount),
              currency_id: request.currency,
            },
          ],
          external_reference: request.paymentId,
          payer: { email: request.customerEmail },
          back_urls: {
            success: request.successUrl,
            failure: request.cancelUrl,
            pending: request.successUrl,
          },
          auto_return: "approved",
          notification_url: this.config.notificationUrl,
          metadata: { payment_id: request.paymentId },
        }),
      },
    );
    const parsed = z.object({ id: z.string(), init_point: z.url() }).safeParse(json);
    if (status >= 400 || !parsed.success)
      throw new GatewayError(`Mercado Pago rechazó la creación del cobro (${status})`, false);
    return { url: parsed.data.init_point, sessionId: parsed.data.id };
  }

  async parseWebhook(input: WebhookInput): Promise<ParsedWebhook> {
    let body: unknown = null;
    try {
      body = JSON.parse(input.rawBody);
    } catch {
      body = null;
    }
    const bodyId = z
      .object({
        data: z.object({ id: z.union([z.string(), z.number()]) }).optional(),
        type: z.string().optional(),
      })
      .safeParse(body);
    // El id firmado es el de la query (`data.id`); si no viene, el del cuerpo.
    const dataId =
      input.query.get("data.id") ??
      (bodyId.success && bodyId.data.data ? String(bodyId.data.data.id) : null);
    const check = verifyMercadoPago({
      secret: this.config.webhookSecret,
      header: input.headers["x-signature"] ?? null,
      requestId: input.headers["x-request-id"] ?? null,
      dataId,
      nowMs: input.nowMs,
    });
    if (check !== "ok") return { ok: false, reason: check };

    const topic = input.query.get("type") ?? (bodyId.success ? bodyId.data.type : undefined);
    const ignored = (id: string): ParsedWebhook => ({
      ok: true,
      event: {
        id,
        type: "IGNORED",
        paymentId: null,
        gatewayPaymentId: dataId,
        gatewayCustomerId: null,
        paymentMethodId: null,
        amount: null,
        currency: null,
        failureCode: null,
        failureMessage: null,
      },
    });
    if (topic !== "payment" || !dataId) return ignored(`mp-ignored:${dataId ?? "sin-id"}`);

    const { status, json } = await send(
      this.deps,
      `https://api.mercadopago.com/v1/payments/${encodeURIComponent(dataId)}`,
      { method: "GET", headers: { authorization: `Bearer ${this.config.accessToken}` } },
    );
    const payment = mpPayment.safeParse(json);
    if (status >= 400 || !payment.success)
      throw new GatewayError(
        `No se pudo consultar el pago en Mercado Pago (${status})`,
        status >= 500,
      );
    const p = payment.data;
    const eventId = `mp:${p.id}:${p.status}`;
    const base = {
      id: eventId,
      paymentId: p.external_reference ?? null,
      gatewayPaymentId: String(p.id),
      gatewayCustomerId: null,
      paymentMethodId: null,
      amount:
        p.transaction_amount === null || p.transaction_amount === undefined
          ? null
          : p.transaction_amount.toFixed(2),
      currency: p.currency_id ?? null,
      failureCode: null,
      failureMessage: null,
    };
    if (p.status === "approved") return { ok: true, event: { ...base, type: "PAYMENT_SUCCEEDED" } };
    if (p.status === "rejected" || p.status === "cancelled")
      return {
        ok: true,
        event: {
          ...base,
          type: "PAYMENT_FAILED",
          failureCode: p.status_detail ?? p.status,
          failureMessage: "Pago rechazado por Mercado Pago",
        },
      };
    return ignored(eventId);
  }
}

// ---------------------------------------------------------------------------
// Simulada (solo desarrollo y CI)
// ---------------------------------------------------------------------------

/**
 * Pasarela falsa para desarrollo y pruebas de extremo a extremo: el «checkout» es la propia pantalla
 * de suscripción y los webhooks llevan la misma firma que Stripe, así que todo el camino real
 * (firma, idempotencia, activación) se ejercita. Prohibida en producción (ver `lib/env.ts`).
 */
export class SimulatedGateway implements PaymentGatewayAdapter {
  readonly id = "SIMULATED" as const;
  readonly supportsAutoCharge = false;
  constructor(private readonly config: { secret: string; appUrl: string }) {}

  async createCheckout(request: CheckoutRequest): Promise<{ url: string; sessionId: string }> {
    return {
      url: `${this.config.appUrl}/app/subscription?simulado=${encodeURIComponent(request.paymentId)}`,
      sessionId: `sim_${request.paymentId}`,
    };
  }

  async parseWebhook(input: WebhookInput): Promise<ParsedWebhook> {
    const check = verifyStripeStyle({
      secret: this.config.secret,
      header: input.headers["stripe-signature"] ?? null,
      rawBody: input.rawBody,
      nowMs: input.nowMs,
    });
    if (check !== "ok") return { ok: false, reason: check };
    return parseStripeLikeEvent(input.rawBody);
  }

  /** Para pruebas: arma un webhook firmado. */
  static sign(secret: string, rawBody: string, nowMs: number = Date.now()): string {
    const t = Math.floor(nowMs / 1000);
    return `t=${t},v1=${signStripeStyle(secret, t, rawBody)}`;
  }
}

// ---------------------------------------------------------------------------
// Selección
// ---------------------------------------------------------------------------

let override: PaymentGatewayAdapter | null | undefined;

/** Para pruebas: reemplaza la pasarela (undefined = usar la del entorno; null = sin pasarela). */
export function setGatewayForTests(adapter: PaymentGatewayAdapter | null | undefined): void {
  override = adapter;
}

/** La pasarela configurada por la plataforma (`BILLING_GATEWAY`), o null si el cobro automático está apagado. */
export function getGateway(): PaymentGatewayAdapter | null {
  if (override !== undefined) return override;
  const env = getEnv();
  switch (env.BILLING_GATEWAY) {
    case "stripe":
      return new StripeGateway({
        secretKey: env.STRIPE_SECRET_KEY ?? "",
        webhookSecret: env.STRIPE_WEBHOOK_SECRET ?? "",
      });
    case "mercadopago":
      return new MercadoPagoGateway({
        accessToken: env.MERCADOPAGO_ACCESS_TOKEN ?? "",
        webhookSecret: env.MERCADOPAGO_WEBHOOK_SECRET ?? "",
        notificationUrl: `${env.APP_URL.replace(/\/$/, "")}/api/webhooks/billing/mercadopago`,
      });
    case "simulated":
      return new SimulatedGateway({
        secret: env.BILLING_SIMULATED_SECRET ?? "",
        appUrl: env.APP_URL.replace(/\/$/, ""),
      });
    default:
      return null;
  }
}
