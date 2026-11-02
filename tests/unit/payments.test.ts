import { describe, expect, it } from "vitest";
import {
  signMercadoPago,
  signStripeStyle,
  mercadoPagoManifest,
} from "@/lib/saas/gateway-signatures";
import {
  GatewayError,
  MercadoPagoGateway,
  SimulatedGateway,
  StripeGateway,
  type CheckoutRequest,
  type GatewayDeps,
} from "@/server/integrations/payments";

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const now = Date.parse("2026-11-10T12:00:00Z");
const t = Math.floor(now / 1000);

function deps(respond: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl: GatewayDeps = {
    fetch: async (url, init) => (calls.push({ url, init }), respond(url, init)),
  };
  return { impl, calls };
}

const checkout: CheckoutRequest = {
  paymentId: "0198aaaa-bbbb-7ccc-8ddd-eeeeffff0001",
  amount: "149.00",
  currency: "PEN",
  description: "Suscripción Pro",
  customerEmail: "dueno@taller.pe",
  gatewayCustomerId: null,
  saveMethod: true,
  successUrl: "https://app.test/ok",
  cancelUrl: "https://app.test/no",
};

describe("Stripe", () => {
  const secret = "whsec_unit";
  const event = (type: string, object: Record<string, unknown>) =>
    JSON.stringify({ id: `evt_${type}`, type, data: { object } });
  const parse = (gateway: StripeGateway, raw: string, signature?: string) =>
    gateway.parseWebhook({
      rawBody: raw,
      headers: { "stripe-signature": signature ?? `t=${t},v1=${signStripeStyle(secret, t, raw)}` },
      query: new URLSearchParams(),
      nowMs: now,
    });

  it("crea el Checkout con el id de nuestro cobro, monto en céntimos y tarjeta guardada", async () => {
    const { impl, calls } = deps(() =>
      json(200, { id: "cs_1", url: "https://checkout.stripe.com/c/pay/cs_1" }),
    );
    const gateway = new StripeGateway({ secretKey: "sk_test", webhookSecret: secret }, impl);
    expect(await gateway.createCheckout(checkout)).toEqual({
      url: "https://checkout.stripe.com/c/pay/cs_1",
      sessionId: "cs_1",
    });
    const body = new URLSearchParams(String(calls[0]?.init.body));
    expect(calls[0]?.url).toBe("https://api.stripe.com/v1/checkout/sessions");
    expect(body.get("line_items[0][price_data][unit_amount]")).toBe("14900");
    expect(body.get("line_items[0][price_data][currency]")).toBe("pen");
    expect(body.get("metadata[payment_id]")).toBe(checkout.paymentId);
    expect(body.get("payment_intent_data[metadata][payment_id]")).toBe(checkout.paymentId);
    expect(body.get("payment_intent_data[setup_future_usage]")).toBe("off_session");
    expect((calls[0]?.init.headers as Record<string, string>).authorization).toBe("Bearer sk_test");
    expect((calls[0]?.init.headers as Record<string, string>)["idempotency-key"]).toBe(
      `checkout-${checkout.paymentId}`,
    );
  });

  it("cobra una renovación fuera de sesión; distingue éxito, rechazo del banco y fallo transitorio", async () => {
    const request = {
      paymentId: checkout.paymentId,
      amount: "149.00",
      currency: "PEN",
      description: "Renovación",
      gatewayCustomerId: "cus_1",
      paymentMethodId: "pm_1",
      idempotencyKey: "renewal-1",
    };
    const sent = deps(() => json(200, { id: "pi_1", status: "succeeded" }));
    const ok = new StripeGateway({ secretKey: "sk", webhookSecret: secret }, sent.impl);
    expect(await ok.charge(request)).toMatchObject({
      status: "SUCCEEDED",
      gatewayPaymentId: "pi_1",
    });
    const charged = new URLSearchParams(String(sent.calls[0]?.init.body));
    expect(charged.get("off_session")).toBe("true");
    expect(charged.get("confirm")).toBe("true");
    expect(charged.get("amount")).toBe("14900");
    expect(charged.get("customer")).toBe("cus_1");
    expect(charged.get("metadata[payment_id]")).toBe(request.paymentId);
    expect((sent.calls[0]?.init.headers as Record<string, string>)["idempotency-key"]).toBe(
      "renewal-1",
    );
    const declined = new StripeGateway(
      { secretKey: "sk", webhookSecret: secret },
      deps(() =>
        json(402, {
          error: {
            code: "card_declined",
            message: "Tu tarjeta fue rechazada",
            payment_intent: { id: "pi_2" },
          },
        }),
      ).impl,
    );
    expect(await declined.charge(request)).toMatchObject({
      status: "FAILED",
      failureCode: "card_declined",
      gatewayPaymentId: "pi_2",
    });
    const sca = new StripeGateway(
      { secretKey: "sk", webhookSecret: secret },
      deps(() => json(200, { id: "pi_3", status: "requires_action" })).impl,
    );
    expect(await sca.charge(request)).toMatchObject({
      status: "FAILED",
      failureCode: "requires_action",
    });
    const down = new StripeGateway(
      { secretKey: "sk", webhookSecret: secret },
      deps(() => json(503, {})).impl,
    );
    await expect(down.charge(request)).rejects.toMatchObject({ retryable: true });
    const badKey = new StripeGateway(
      { secretKey: "sk", webhookSecret: secret },
      deps(() => json(401, {})).impl,
    );
    await expect(badKey.charge(request)).rejects.toBeInstanceOf(GatewayError);
  });

  it("normaliza payment_intent.succeeded/payment_failed y toma el id del cobro de metadata", async () => {
    const gateway = new StripeGateway({ secretKey: "sk", webhookSecret: secret });
    const paid = await parse(
      gateway,
      event("payment_intent.succeeded", {
        id: "pi_9",
        amount: 14900,
        currency: "pen",
        customer: "cus_9",
        payment_method: "pm_9",
        metadata: { payment_id: checkout.paymentId },
      }),
    );
    expect(paid).toMatchObject({
      ok: true,
      event: {
        type: "PAYMENT_SUCCEEDED",
        paymentId: checkout.paymentId,
        amount: "149.00",
        currency: "PEN",
        gatewayCustomerId: "cus_9",
        paymentMethodId: "pm_9",
        id: "evt_payment_intent.succeeded",
      },
    });
    const failed = await parse(
      gateway,
      event("payment_intent.payment_failed", {
        id: "pi_8",
        amount: 14900,
        currency: "pen",
        metadata: { payment_id: checkout.paymentId },
        last_payment_error: { code: "card_declined", message: "Rechazada" },
      }),
    );
    expect(failed).toMatchObject({
      ok: true,
      event: { type: "PAYMENT_FAILED", failureCode: "card_declined" },
    });
    expect(await parse(gateway, event("customer.created", { id: "cus_1" }))).toMatchObject({
      ok: true,
      event: { type: "IGNORED" },
    });
  });

  it("rechaza firma inválida, mal formada y cuerpos que no son eventos", async () => {
    const gateway = new StripeGateway({ secretKey: "sk", webhookSecret: secret });
    const raw = event("payment_intent.succeeded", { id: "pi_1" });
    expect(await parse(gateway, raw, `t=${t},v1=${"a".repeat(64)}`)).toEqual({
      ok: false,
      reason: "invalid",
    });
    expect(await parse(gateway, "no es json")).toEqual({ ok: false, reason: "malformed" });
    expect(await parse(gateway, JSON.stringify({ hola: "mundo" }))).toEqual({
      ok: false,
      reason: "malformed",
    });
  });
});

describe("Mercado Pago", () => {
  const secret = "mp_unit";
  const ts = String(now);
  const signed = (dataId: string, requestId = "req-1") => ({
    "x-signature": `ts=${ts},v1=${signMercadoPago(secret, mercadoPagoManifest({ dataId, requestId, ts }))}`,
    "x-request-id": requestId,
  });

  it("crea la preferencia con external_reference = nuestro cobro y la URL de notificaciones", async () => {
    const { impl, calls } = deps(() =>
      json(201, {
        id: "pref_1",
        init_point: "https://www.mercadopago.com.pe/checkout/v1/redirect?pref_id=pref_1",
      }),
    );
    const gateway = new MercadoPagoGateway(
      {
        accessToken: "APP_USR-x",
        webhookSecret: secret,
        notificationUrl: "https://app.test/api/webhooks/billing/mercadopago",
      },
      impl,
    );
    expect(await gateway.createCheckout(checkout)).toMatchObject({ sessionId: "pref_1" });
    const body = JSON.parse(String(calls[0]?.init.body));
    expect(body.external_reference).toBe(checkout.paymentId);
    expect(body.items[0]).toMatchObject({ unit_price: 149, currency_id: "PEN", quantity: 1 });
    expect(body.notification_url).toBe("https://app.test/api/webhooks/billing/mercadopago");
    expect(gateway.supportsAutoCharge).toBe(false);
  });

  it("verifica la firma, consulta el pago y mapea aprobado / rechazado / pendiente", async () => {
    const statuses: Record<string, unknown> = {
      "100": {
        id: 100,
        status: "approved",
        transaction_amount: 149,
        currency_id: "PEN",
        external_reference: checkout.paymentId,
      },
      "101": {
        id: 101,
        status: "rejected",
        status_detail: "cc_rejected_insufficient_amount",
        transaction_amount: 149,
        currency_id: "PEN",
        external_reference: checkout.paymentId,
      },
      "102": {
        id: 102,
        status: "in_process",
        transaction_amount: 149,
        currency_id: "PEN",
        external_reference: checkout.paymentId,
      },
    };
    const { impl, calls } = deps((url) => json(200, statuses[url.split("/").pop() ?? ""]));
    const gateway = new MercadoPagoGateway(
      { accessToken: "tok", webhookSecret: secret, notificationUrl: "https://x" },
      impl,
    );
    const run = (id: string, headers = signed(id)) =>
      gateway.parseWebhook({
        rawBody: JSON.stringify({ type: "payment", data: { id } }),
        headers,
        query: new URLSearchParams({ "data.id": id, type: "payment" }),
        nowMs: now,
      });
    expect(await run("100")).toMatchObject({
      ok: true,
      event: {
        type: "PAYMENT_SUCCEEDED",
        paymentId: checkout.paymentId,
        amount: "149.00",
        id: "mp:100:approved",
      },
    });
    expect(await run("101")).toMatchObject({
      ok: true,
      event: { type: "PAYMENT_FAILED", failureCode: "cc_rejected_insufficient_amount" },
    });
    expect(await run("102")).toMatchObject({ ok: true, event: { type: "IGNORED" } });
    expect(calls[0]?.url).toBe("https://api.mercadopago.com/v1/payments/100");
    expect((calls[0]?.init.headers as Record<string, string>).authorization).toBe("Bearer tok");
  });

  it("con firma falsa NO consulta la API ni acepta nada", async () => {
    const { impl, calls } = deps(() => json(200, {}));
    const gateway = new MercadoPagoGateway(
      { accessToken: "tok", webhookSecret: secret, notificationUrl: "https://x" },
      impl,
    );
    const forged = await gateway.parseWebhook({
      rawBody: "{}",
      headers: { "x-signature": `ts=${ts},v1=${"0".repeat(64)}`, "x-request-id": "req-1" },
      query: new URLSearchParams({ "data.id": "100", type: "payment" }),
      nowMs: now,
    });
    expect(forged).toEqual({ ok: false, reason: "invalid" });
    expect(calls).toHaveLength(0);
  });

  it("si la consulta del pago falla por la red, el error es reintentable (la pasarela reenviará)", async () => {
    const { impl } = deps(() => json(502, {}));
    const gateway = new MercadoPagoGateway(
      { accessToken: "tok", webhookSecret: secret, notificationUrl: "https://x" },
      impl,
    );
    await expect(
      gateway.parseWebhook({
        rawBody: "{}",
        headers: signed("100"),
        query: new URLSearchParams({ "data.id": "100", type: "payment" }),
        nowMs: now,
      }),
    ).rejects.toMatchObject({ retryable: true });
  });
});

describe("pasarela simulada", () => {
  it("firma y verifica como Stripe; el checkout vuelve a la propia pantalla", async () => {
    const gateway = new SimulatedGateway({ secret: "s".repeat(20), appUrl: "https://app.test" });
    expect((await gateway.createCheckout(checkout)).url).toBe(
      `https://app.test/app/subscription?simulado=${checkout.paymentId}`,
    );
    const raw = JSON.stringify({
      id: "evt_sim",
      type: "payment_intent.succeeded",
      data: {
        object: {
          id: "pi_sim",
          amount: 14900,
          currency: "pen",
          metadata: { payment_id: checkout.paymentId },
        },
      },
    });
    const header = SimulatedGateway.sign("s".repeat(20), raw, now);
    expect(
      await gateway.parseWebhook({
        rawBody: raw,
        headers: { "stripe-signature": header },
        query: new URLSearchParams(),
        nowMs: now,
      }),
    ).toMatchObject({ ok: true, event: { type: "PAYMENT_SUCCEEDED" } });
    expect(
      await gateway.parseWebhook({
        rawBody: raw,
        headers: { "stripe-signature": header },
        query: new URLSearchParams(),
        nowMs: now + 600_000,
      }),
    ).toEqual({ ok: false, reason: "stale" });
  });
});
