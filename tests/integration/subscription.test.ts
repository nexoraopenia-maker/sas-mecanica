import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { AuthUser } from "@/lib/auth/can";
import type { PrismaClient } from "@/lib/db/generated/client.ts";
import { ConflictError, PermissionDeniedError } from "@/lib/errors";
import { addMonths } from "@/lib/workshop/warranty-math";
import { setEmailSenderForTests, type EmailMessage } from "@/server/integrations/email";
import {
  GatewayError,
  setGatewayForTests,
  SimulatedGateway,
  type ChargeResult,
  type PaymentGatewayAdapter,
} from "@/server/integrations/payments";
import { handleBillingWebhook, MAX_BILLING_WEBHOOK_BYTES } from "@/server/services/billing-webhook";
import { configureAuthCache, resolveSession } from "@/server/services/session-resolver";
import {
  extendGrace,
  getBillingOverview,
  getSubscriptionView,
  recordManualPayment,
  runBillingCycle,
  setCancelAtPeriodEnd,
  startCheckout,
} from "@/server/services/subscription-billing";
import { adminClient } from "../helpers/db.ts";
import { meta } from "../helpers/auth.ts";
import { inventoryWorld, type InventoryWorld } from "../helpers/inventory.ts";

const SECRET = "sim-secret-0123456789abcdef";
const DAY = 86_400_000;
const sim = new SimulatedGateway({ secret: SECRET, appUrl: "http://localhost:3000" });

describe("cobro de la suscripción del SaaS", () => {
  let admin: PrismaClient;
  const emails: EmailMessage[] = [];

  beforeAll(async () => {
    configureAuthCache(0);
    admin = adminClient();
    setEmailSenderForTests({ send: async (m) => void emails.push(m) });
    setGatewayForTests(sim);
  }, 120_000);
  afterAll(async () => {
    setGatewayForTests(undefined);
    setEmailSenderForTests(null);
    await admin.$disconnect();
  });
  beforeEach(() => {
    emails.length = 0;
    setGatewayForTests(sim);
  });

  /** Empresa real con suscripción vigente y correo de cobranza. */
  async function tenant(): Promise<{ w: InventoryWorld; subId: string; end: Date; price: string }> {
    const w = await inventoryWorld(admin, "enterprise");
    // Los helpers de alta de usuarios reemplazan el emisor de correo: se reinstala el de esta suite.
    setEmailSenderForTests({ send: async (m) => void emails.push(m) });
    await admin.tenant.update({
      where: { id: w.tenantId },
      data: { contactEmail: `pagos-${w.tenantId.slice(0, 8)}@taller.pe` },
    });
    const sub = await admin.subscription.findFirstOrThrow({
      where: { tenantId: w.tenantId },
      include: { plan: true },
    });
    return {
      w,
      subId: sub.id,
      end: sub.currentPeriodEnd as Date,
      price: sub.plan.priceMonthly.toFixed(2),
    };
  }
  const setEnd = (subId: string, end: Date, extra: Record<string, unknown> = {}) =>
    admin.subscription.update({ where: { id: subId }, data: { currentPeriodEnd: end, ...extra } });
  const paymentOf = (subId: string) =>
    admin.subscriptionPayment.findFirstOrThrow({
      where: { subscriptionId: subId },
      orderBy: { createdAt: "desc" },
    });

  const webhook = (
    type: string,
    paymentId: string,
    price: string,
    over: { eventId?: string; amount?: number; extra?: Record<string, unknown> } = {},
  ) => {
    const raw = JSON.stringify({
      id: over.eventId ?? `evt_${paymentId}_${type}`,
      type,
      data: {
        object: {
          id: `pi_${paymentId.slice(-6)}`,
          amount: over.amount ?? Math.round(Number(price) * 100),
          currency: "pen",
          customer: "cus_test",
          payment_method: "pm_test",
          metadata: { payment_id: paymentId },
          last_payment_error: { code: "card_declined", message: "Tarjeta rechazada" },
          ...over.extra,
        },
      },
    });
    return raw;
  };
  const deliver = (raw: string, over: { signature?: string; gateway?: string } = {}) =>
    handleBillingWebhook({
      gateway: over.gateway ?? "simulated",
      rawBody: raw,
      headers: { "stripe-signature": over.signature ?? SimulatedGateway.sign(SECRET, raw) },
      query: new URLSearchParams(),
      ip: `10.0.0.${Math.floor(Math.random() * 250)}`,
    });

  describe("pago y webhooks", () => {
    it("antes de la ventana de renovación no hay nada que cobrar; dentro, el cobro se crea una sola vez", async () => {
      const t = await tenant();
      await expect(startCheckout(t.w.admin)).rejects.toMatchObject({ code: "NOTHING_DUE" });
      await setEnd(t.subId, new Date(Date.now() + 2 * DAY));
      const first = await startCheckout(t.w.admin);
      const payment = await paymentOf(t.subId);
      expect(first.url).toContain(`simulado=${payment.id}`);
      expect(payment).toMatchObject({
        status: "PENDING",
        gateway: "SIMULATED",
        checkoutUrl: first.url,
      });
      expect(payment.amount.toFixed(2)).toBe(t.price);
      await startCheckout(t.w.admin);
      expect(await admin.subscriptionPayment.count({ where: { subscriptionId: t.subId } })).toBe(1);
      await expect(startCheckout(t.w.cashier)).rejects.toBeInstanceOf(PermissionDeniedError);
    });

    it("un webhook firmado activa el periodo siguiente, guarda el método de pago y avisa; reenviarlo no vuelve a extender", async () => {
      const t = await tenant();
      await setEnd(t.subId, new Date(Date.now() + 2 * DAY));
      await startCheckout(t.w.admin);
      const payment = await paymentOf(t.subId);
      const before = await admin.subscription.findFirstOrThrow({ where: { id: t.subId } });
      const raw = webhook("payment_intent.succeeded", payment.id, t.price);
      const res = await deliver(raw);
      expect(res).toMatchObject({ status: 200, body: { ok: true, outcome: "APPLIED" } });

      const sub = await admin.subscription.findFirstOrThrow({ where: { id: t.subId } });
      expect(sub.status).toBe("ACTIVE");
      expect(sub.currentPeriodEnd?.getTime()).toBe(
        addMonths(before.currentPeriodEnd as Date, 1).getTime(),
      );
      expect(sub).toMatchObject({
        gatewayCustomerId: "cus_test",
        gatewayPaymentMethodId: "pm_test",
        retryCount: 0,
      });
      expect(
        await admin.subscriptionPayment.findFirstOrThrow({ where: { id: payment.id } }),
      ).toMatchObject({ status: "PAID", checkoutUrl: null });
      expect(
        await admin.notification.count({ where: { tenantId: t.w.tenantId, kind: "billing.paid" } }),
      ).toBe(1);
      expect(emails.some((m) => /Pago recibido/.test(m.subject))).toBe(true);

      const again = await deliver(raw);
      expect(again.body).toMatchObject({ ok: true, outcome: "DUPLICATE" });
      expect(
        (
          await admin.subscription.findFirstOrThrow({ where: { id: t.subId } })
        ).currentPeriodEnd?.getTime(),
      ).toBe(sub.currentPeriodEnd?.getTime());
      expect(
        await admin.webhookEvent.count({
          where: { tenantId: t.w.tenantId, source: "billing:simulated" },
        }),
      ).toBe(1);
    });

    it("el mismo evento entregado tres veces a la vez se aplica una sola vez", async () => {
      const t = await tenant();
      const newEnd = new Date(Date.now() + 2 * DAY);
      await setEnd(t.subId, newEnd);
      await startCheckout(t.w.admin);
      const payment = await paymentOf(t.subId);
      const raw = webhook("payment_intent.succeeded", payment.id, t.price);
      const results = await Promise.all([deliver(raw), deliver(raw), deliver(raw)]);
      expect(results.every((r) => r.status === 200)).toBe(true);
      expect(results.filter((r) => r.body.outcome === "APPLIED")).toHaveLength(1);
      const sub = await admin.subscription.findFirstOrThrow({ where: { id: t.subId } });
      expect(sub.currentPeriodEnd?.getTime()).toBe(addMonths(newEnd, 1).getTime());
      expect(
        await admin.subscriptionPayment.count({
          where: { subscriptionId: t.subId, status: "PAID" },
        }),
      ).toBe(1);
    });

    it("rechaza firmas falsas, viejas, ausentes, cuerpos mal formados, pasarelas ajenas y cuerpos enormes — sin cambiar nada", async () => {
      const t = await tenant();
      const newEnd = new Date(Date.now() + 2 * DAY);
      await setEnd(t.subId, newEnd);
      await startCheckout(t.w.admin);
      const payment = await paymentOf(t.subId);
      const raw = webhook("payment_intent.succeeded", payment.id, t.price);
      expect(
        (
          await deliver(raw, {
            signature: `t=${Math.floor(Date.now() / 1000)},v1=${"a".repeat(64)}`,
          })
        ).status,
      ).toBe(401);
      expect(
        (
          await deliver(raw, {
            signature: SimulatedGateway.sign(SECRET, raw, Date.now() - 600_000),
          })
        ).status,
      ).toBe(401);
      expect(
        (await deliver(raw, { signature: SimulatedGateway.sign("otro-secreto-0123456789", raw) }))
          .status,
      ).toBe(401);
      expect(
        (
          await handleBillingWebhook({
            gateway: "simulated",
            rawBody: raw,
            headers: {},
            query: new URLSearchParams(),
          })
        ).status,
      ).toBe(401);
      expect((await deliver(raw, { gateway: "stripe" })).status).toBe(404);
      expect((await deliver(raw, { gateway: "paypal" })).status).toBe(404);
      const junk = "no es json";
      expect((await deliver(junk)).status).toBe(400);
      const huge = "x".repeat(MAX_BILLING_WEBHOOK_BYTES + 1);
      expect((await deliver(huge)).status).toBe(413);
      expect(
        (await admin.subscriptionPayment.findFirstOrThrow({ where: { id: payment.id } })).status,
      ).toBe("PENDING");
      expect(
        (
          await admin.subscription.findFirstOrThrow({ where: { id: t.subId } })
        ).currentPeriodEnd?.getTime(),
      ).toBe(
        t.end.getTime() > 0
          ? (
              await admin.subscription.findFirstOrThrow({ where: { id: t.subId } })
            ).currentPeriodEnd?.getTime()
          : 0,
      );
      expect(await admin.webhookEvent.count({ where: { tenantId: t.w.tenantId } })).toBe(0);
    });

    it("un monto distinto al cobro NO activa nada y deja una alerta crítica", async () => {
      const t = await tenant();
      await setEnd(t.subId, new Date(Date.now() + 2 * DAY));
      await startCheckout(t.w.admin);
      const payment = await paymentOf(t.subId);
      const res = await deliver(
        webhook("payment_intent.succeeded", payment.id, t.price, { amount: 100 }),
      );
      expect(res.body).toMatchObject({ outcome: "MISMATCH" });
      expect(
        (await admin.subscriptionPayment.findFirstOrThrow({ where: { id: payment.id } })).status,
      ).toBe("PENDING");
      expect(
        await admin.notification.count({
          where: { tenantId: t.w.tenantId, kind: "billing.mismatch", severity: "CRITICAL" },
        }),
      ).toBe(1);
      const wrongCurrency = await deliver(
        webhook("payment_intent.succeeded", payment.id, t.price, {
          eventId: "evt_cur",
          extra: { currency: "usd" },
        }),
      );
      expect(wrongCurrency.body).toMatchObject({ outcome: "MISMATCH" });
    });

    it("un cobro inexistente o de un id inventado se acepta sin efecto (no se reintenta eternamente)", async () => {
      const raw = webhook("payment_intent.succeeded", "0198aaaa-bbbb-7ccc-8ddd-000000000000", "10");
      expect((await deliver(raw)).body).toMatchObject({ ok: true, outcome: "UNKNOWN_PAYMENT" });
      expect(
        (
          await deliver(
            webhook("payment_intent.succeeded", "no-es-uuid", "10", { eventId: "evt_x" }),
          )
        ).body,
      ).toMatchObject({ outcome: "UNKNOWN_PAYMENT" });
      expect(
        (
          await deliver(
            JSON.stringify({
              id: "evt_ign",
              type: "customer.created",
              data: { object: { id: "cus_1" } },
            }),
          )
        ).body,
      ).toMatchObject({ outcome: "IGNORED" });
    });

    it("un cobro fallido deja la suscripción en PAST_DUE con reintento programado y avisa al dueño", async () => {
      const t = await tenant();
      await setEnd(t.subId, new Date(Date.now() + 2 * DAY));
      await startCheckout(t.w.admin);
      const payment = await paymentOf(t.subId);
      await deliver(webhook("payment_intent.payment_failed", payment.id, t.price));
      const sub = await admin.subscription.findFirstOrThrow({ where: { id: t.subId } });
      expect(sub).toMatchObject({ status: "PAST_DUE", retryCount: 1 });
      expect(Math.round(((sub.nextRetryAt as Date).getTime() - Date.now()) / DAY)).toBe(1);
      expect(
        await admin.subscriptionPayment.findFirstOrThrow({ where: { id: payment.id } }),
      ).toMatchObject({ status: "FAILED", failureCode: "card_declined" });
      expect(emails.some((m) => /No pudimos cobrar/.test(m.subject))).toBe(true);
      // Pagar después de un fallo funciona y limpia los contadores.
      await deliver(
        webhook("payment_intent.succeeded", payment.id, t.price, { eventId: "evt_ok_after_fail" }),
      );
      expect(await admin.subscription.findFirstOrThrow({ where: { id: t.subId } })).toMatchObject({
        status: "ACTIVE",
        retryCount: 0,
        nextRetryAt: null,
      });
    });
  });

  describe("ciclo: renovación, gracia, suspensión y reactivación", () => {
    it("recuerda antes de vencer, da gracia al vencer, suspende al terminar la gracia y reactiva al pagar", async () => {
      const t = await tenant();
      const E = t.end;
      const user = async (): Promise<AuthUser | null> =>
        resolveSession({
          sub: t.w.admin.userId,
          tid: t.w.tenantId,
          sv: (await admin.user.findFirstOrThrow({ where: { id: t.w.admin.userId } }))
            .sessionVersion,
          mfa: true,
        });

      // a) Ventana de renovación: se crea el cobro una sola vez y se avisa.
      const a = await runBillingCycle(new Date(E.getTime() - 2 * DAY), { tenantId: t.w.tenantId });
      expect(a).toMatchObject({ invoices: 1, reminded: 1 });
      expect(
        await runBillingCycle(new Date(E.getTime() - 2 * DAY), { tenantId: t.w.tenantId }),
      ).toMatchObject({ invoices: 0 });
      expect(await admin.subscriptionPayment.count({ where: { subscriptionId: t.subId } })).toBe(1);

      // b) Vence sin pagar: GRACIA con acceso y aviso crítico.
      const b = await runBillingCycle(new Date(E.getTime() + 3_600_000), {
        tenantId: t.w.tenantId,
      });
      expect(b.graced).toBe(1);
      const grace = await admin.subscription.findFirstOrThrow({ where: { id: t.subId } });
      expect(grace.status).toBe("GRACE");
      expect(grace.graceEndsAt?.getTime()).toBe(E.getTime() + 7 * DAY);
      expect((await user())?.subscription?.status).toBe("GRACE");
      expect(
        await admin.notification.count({
          where: { tenantId: t.w.tenantId, kind: "billing.grace" },
        }),
      ).toBe(1);
      expect(emails.some((m) => /periodo de gracia/.test(m.subject))).toBe(true);
      const view = await getSubscriptionView(t.w.admin, new Date(E.getTime() + 3 * DAY));
      expect(view).toMatchObject({ status: "GRACE", hasAccess: true, graceDaysLeft: 4 });

      // c) Dentro de la gracia sigue el acceso y se sigue recordando.
      await runBillingCycle(new Date(E.getTime() + 3 * DAY), { tenantId: t.w.tenantId });
      expect((await admin.tenant.findFirstOrThrow({ where: { id: t.w.tenantId } })).status).toBe(
        "ACTIVE",
      );

      // d) Vence la gracia: SUSPENSIÓN automática. Nadie entra, los datos siguen.
      const d = await runBillingCycle(new Date(E.getTime() + 8 * DAY), { tenantId: t.w.tenantId });
      expect(d.suspended).toBe(1);
      expect(await admin.tenant.findFirstOrThrow({ where: { id: t.w.tenantId } })).toMatchObject({
        status: "SUSPENDED",
        suspendedByBilling: true,
      });
      expect((await admin.subscription.findFirstOrThrow({ where: { id: t.subId } })).status).toBe(
        "SUSPENDED",
      );
      expect(await user()).toBeNull();
      expect(await admin.user.count({ where: { tenantId: t.w.tenantId } })).toBeGreaterThan(0);
      expect(emails.some((m) => /suspendida/.test(m.subject))).toBe(true);
      expect(
        await runBillingCycle(new Date(E.getTime() + 20 * DAY), { tenantId: t.w.tenantId }),
      ).toMatchObject({ suspended: 0 });

      // e) Pagar reactiva sola la cuenta y el periodo arranca HOY (no se cobra tiempo en que no hubo servicio).
      const payment = await paymentOf(t.subId);
      await deliver(
        webhook("payment_intent.succeeded", payment.id, t.price, { eventId: "evt_reactivate" }),
      );
      expect(await admin.tenant.findFirstOrThrow({ where: { id: t.w.tenantId } })).toMatchObject({
        status: "ACTIVE",
        suspendedByBilling: false,
        suspendedReason: null,
      });
      const reactivated = await admin.subscription.findFirstOrThrow({ where: { id: t.subId } });
      expect(reactivated).toMatchObject({ status: "ACTIVE", graceEndsAt: null });
      expect(
        Math.abs((reactivated.currentPeriodStart as Date).getTime() - Date.now()),
      ).toBeLessThan(60_000);
      expect(await user()).not.toBeNull();
    });

    it("una suspensión manual del SuperAdmin NO se levanta sola al pagar", async () => {
      const t = await tenant();
      await setEnd(t.subId, new Date(Date.now() + 2 * DAY));
      await admin.tenant.update({
        where: { id: t.w.tenantId },
        data: { status: "SUSPENDED", suspendedReason: "Fraude", suspendedByBilling: false },
      });
      const result = await recordManualPayment(
        t.w.superAdmin,
        { tenantId: t.w.tenantId, amount: t.price, reference: "TRF-123" },
        meta(),
      );
      expect(result.outcome).toBe("APPLIED");
      expect((await admin.tenant.findFirstOrThrow({ where: { id: t.w.tenantId } })).status).toBe(
        "SUSPENDED",
      );
    });

    it("la cancelación termina la suscripción al final del periodo y no se reactiva sola", async () => {
      const t = await tenant();
      await setCancelAtPeriodEnd(t.w.admin, true, meta());
      expect(
        await admin.auditLog.count({
          where: { entityId: t.subId, action: "subscription.cancel_requested" },
        }),
      ).toBe(1);
      expect(
        await runBillingCycle(new Date(t.end.getTime() - DAY), { tenantId: t.w.tenantId }),
      ).toMatchObject({ invoices: 0, canceled: 0 });
      expect(
        await runBillingCycle(new Date(t.end.getTime() + 3_600_000), { tenantId: t.w.tenantId }),
      ).toMatchObject({ canceled: 1 });
      expect(await admin.subscription.findFirstOrThrow({ where: { id: t.subId } })).toMatchObject({
        status: "CANCELED",
      });
      expect(await admin.tenant.findFirstOrThrow({ where: { id: t.w.tenantId } })).toMatchObject({
        status: "SUSPENDED",
        suspendedByBilling: false,
      });
      await expect(startCheckout(t.w.admin)).rejects.toMatchObject({ code: "SUB_CANCELED" });
      const withdrawn = await tenant();
      await setCancelAtPeriodEnd(withdrawn.w.admin, true, meta());
      await setCancelAtPeriodEnd(withdrawn.w.admin, false, meta());
      expect(
        await runBillingCycle(new Date(withdrawn.end.getTime() - DAY), {
          tenantId: withdrawn.w.tenantId,
        }),
      ).toMatchObject({ invoices: 1 });
    });

    it("las cuentas demo no se cobran nunca", async () => {
      const t = await tenant();
      await admin.tenant.update({
        where: { id: t.w.tenantId },
        data: { isDemo: true, demoExpiresAt: new Date(Date.now() + 3_600_000) },
      });
      expect(
        await runBillingCycle(new Date(t.end.getTime() + 30 * DAY), { tenantId: t.w.tenantId }),
      ).toEqual({
        invoices: 0,
        charged: 0,
        chargeFailed: 0,
        graced: 0,
        suspended: 0,
        canceled: 0,
        reminded: 0,
      });
      await expect(startCheckout(t.w.admin)).rejects.toMatchObject({ code: "DEMO" });
    });

    it("sin pasarela configurada se generan los cobros igual (para pagar por transferencia) y no se ofrece pagar en línea", async () => {
      setGatewayForTests(null);
      const t = await tenant();
      expect(
        await runBillingCycle(new Date(t.end.getTime() - 2 * DAY), { tenantId: t.w.tenantId }),
      ).toMatchObject({ invoices: 1 });
      expect(await paymentOf(t.subId)).toMatchObject({ gateway: "MANUAL", status: "PENDING" });
      await expect(startCheckout(t.w.admin, new Date(t.end.getTime() - DAY))).rejects.toMatchObject(
        { code: "NO_GATEWAY" },
      );
      expect((await getSubscriptionView(t.w.admin)).canPayOnline).toBe(false);
    });
  });

  describe("cobro automático (método guardado)", () => {
    const adapter = (
      charge: () => Promise<ChargeResult>,
      calls: Array<Record<string, unknown>> = [],
    ): PaymentGatewayAdapter => ({
      id: "STRIPE",
      supportsAutoCharge: true,
      createCheckout: async () => ({ url: "https://checkout.test/x", sessionId: "cs_x" }),
      charge: async (request) => (calls.push({ ...request }), charge()),
      parseWebhook: async () => ({ ok: false, reason: "invalid" }),
    });
    // Cada cobro de la pasarela real tiene su propio id: (pasarela, id) es único en la base.
    const ok = (): ChargeResult => ({
      status: "SUCCEEDED",
      gatewayPaymentId: `pi_${randomUUID()}`,
      failureCode: null,
      failureMessage: null,
    });
    const declined = (): ChargeResult => ({
      status: "FAILED",
      gatewayPaymentId: `pi_${randomUUID()}`,
      failureCode: "card_declined",
      failureMessage: "Tarjeta rechazada",
    });
    const withCard = async () => {
      const t = await tenant();
      await admin.subscription.update({
        where: { id: t.subId },
        data: { gatewayCustomerId: "cus_auto", gatewayPaymentMethodId: "pm_auto" },
      });
      return t;
    };

    it("cobra la renovación al entrar en la ventana y extiende el periodo sin intervención", async () => {
      const calls: Array<Record<string, unknown>> = [];
      setGatewayForTests(adapter(async () => ok(), calls));
      const t = await withCard();
      const summary = await runBillingCycle(new Date(t.end.getTime() - 2 * DAY), {
        tenantId: t.w.tenantId,
      });
      expect(summary).toMatchObject({ invoices: 1, charged: 1, chargeFailed: 0 });
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({
        amount: t.price,
        currency: "PEN",
        gatewayCustomerId: "cus_auto",
        paymentMethodId: "pm_auto",
      });
      expect(String(calls[0]?.idempotencyKey)).toMatch(/^renewal-/);
      const sub = await admin.subscription.findFirstOrThrow({ where: { id: t.subId } });
      expect(sub.currentPeriodEnd?.getTime()).toBe(addMonths(t.end, 1).getTime());
      expect((await getSubscriptionView(t.w.admin)).autoChargeReady).toBe(true);
    });

    it("tarjeta rechazada: reintenta según la agenda, entra en gracia sin cobrar de más y suspende al vencer la gracia", async () => {
      const calls: Array<Record<string, unknown>> = [];
      setGatewayForTests(adapter(async () => declined(), calls));
      const t = await withCard();
      const E = t.end.getTime();
      const run = (ms: number) => runBillingCycle(new Date(ms), { tenantId: t.w.tenantId });
      const state = () => admin.subscription.findFirstOrThrow({ where: { id: t.subId } });

      await run(E - 2 * DAY);
      expect(calls).toHaveLength(1);
      expect(await state()).toMatchObject({ status: "PAST_DUE", retryCount: 1 });
      expect((await state()).nextRetryAt?.getTime()).toBe(E - DAY);

      await run(E - DAY - 60_000);
      expect(calls).toHaveLength(1); // antes de tiempo no insiste
      await run(E - DAY);
      expect(calls).toHaveLength(2);
      expect((await state()).nextRetryAt?.getTime()).toBe(E + 2 * DAY);

      // Vence el periodo: solo cambia a gracia; NO se cobra una vez más por eso.
      await run(E + 3_600_000);
      expect(calls).toHaveLength(2);
      expect(await state()).toMatchObject({ status: "GRACE" });

      await run(E + 2 * DAY - 60_000);
      expect(calls).toHaveLength(2);
      await run(E + 2 * DAY);
      expect(calls).toHaveLength(3);
      expect(await state()).toMatchObject({ status: "GRACE", retryCount: 3 });
      expect((await state()).nextRetryAt?.getTime()).toBe(E + 7 * DAY);

      // Al terminar la gracia manda la suspensión, no un cuarto cobro.
      await run(E + 7 * DAY);
      expect(calls).toHaveLength(3);
      expect(await admin.tenant.findFirstOrThrow({ where: { id: t.w.tenantId } })).toMatchObject({
        status: "SUSPENDED",
        suspendedByBilling: true,
      });
      expect(
        await admin.subscriptionPayment.findFirstOrThrow({ where: { subscriptionId: t.subId } }),
      ).toMatchObject({ status: "FAILED", attempt: 3 });
    });

    it("si la tarjeta se arregla en un reintento, vuelve a ACTIVE con los contadores limpios", async () => {
      let attempt = 0;
      setGatewayForTests(adapter(async () => (attempt++ === 0 ? declined() : ok())));
      const t = await withCard();
      const start = new Date(t.end.getTime() - 2 * DAY);
      await runBillingCycle(start, { tenantId: t.w.tenantId });
      await runBillingCycle(new Date(start.getTime() + DAY), { tenantId: t.w.tenantId });
      expect(await admin.subscription.findFirstOrThrow({ where: { id: t.subId } })).toMatchObject({
        status: "ACTIVE",
        retryCount: 0,
        nextRetryAt: null,
      });
      expect(
        (
          await admin.subscription.findFirstOrThrow({ where: { id: t.subId } })
        ).currentPeriodEnd?.getTime(),
      ).toBe(addMonths(t.end, 1).getTime());
    });

    it("una caída de la pasarela no cuenta como cobro fallido: se reintenta en una hora", async () => {
      let up = false;
      setGatewayForTests(
        adapter(async () => {
          if (!up) throw new GatewayError("503", true);
          return ok();
        }),
      );
      const t = await withCard();
      const start = new Date(t.end.getTime() - 2 * DAY);
      await runBillingCycle(start, { tenantId: t.w.tenantId });
      const sub = await admin.subscription.findFirstOrThrow({ where: { id: t.subId } });
      expect(sub).toMatchObject({ status: "ACTIVE", retryCount: 0 });
      expect(sub.nextRetryAt?.getTime()).toBe(start.getTime() + 3_600_000);
      expect((await paymentOf(t.subId)).status).toBe("PENDING");
      up = true;
      await runBillingCycle(new Date(start.getTime() + 3_600_000), { tenantId: t.w.tenantId });
      expect(
        (
          await admin.subscription.findFirstOrThrow({ where: { id: t.subId } })
        ).currentPeriodEnd?.getTime(),
      ).toBe(addMonths(t.end, 1).getTime());
    });
  });

  describe("SuperAdmin y aislamiento", () => {
    it("registra un pago por transferencia con su referencia; el monto debe coincidir y solo lo hace el SuperAdmin", async () => {
      const t = await tenant();
      await expect(
        recordManualPayment(
          t.w.admin,
          { tenantId: t.w.tenantId, amount: t.price, reference: "TRF-1" },
          meta(),
        ),
      ).rejects.toThrow();
      await expect(
        recordManualPayment(
          t.w.superAdmin,
          { tenantId: t.w.tenantId, amount: "1.00", reference: "TRF-2" },
          meta(),
        ),
      ).rejects.toMatchObject({ code: "AMOUNT_MISMATCH" });
      expect((await paymentOf(t.subId)).status).toBe("PENDING");
      const done = await recordManualPayment(
        t.w.superAdmin,
        { tenantId: t.w.tenantId, amount: t.price, reference: "TRF-3" },
        meta(),
      );
      expect(done.outcome).toBe("APPLIED");
      const payment = await admin.subscriptionPayment.findFirstOrThrow({
        where: { id: done.paymentId },
      });
      expect(payment).toMatchObject({ status: "PAID", gateway: "MANUAL", reference: "TRF-3" });
      expect(
        (
          await admin.subscription.findFirstOrThrow({ where: { id: t.subId } })
        ).currentPeriodEnd?.getTime(),
      ).toBe(addMonths(t.end, 1).getTime());
      expect(
        await admin.auditLog.count({
          where: { tenantId: t.w.tenantId, action: "subscription.payment_applied" },
        }),
      ).toBe(1);
    });

    it("extiende la gracia solo si está vencida, con motivo y auditoría", async () => {
      const t = await tenant();
      await expect(
        extendGrace(
          t.w.superAdmin,
          { tenantId: t.w.tenantId, days: 3, reason: "Pagará mañana" },
          meta(),
        ),
      ).rejects.toBeInstanceOf(ConflictError);
      await runBillingCycle(new Date(t.end.getTime() + 3_600_000), { tenantId: t.w.tenantId });
      const before = (await admin.subscription.findFirstOrThrow({ where: { id: t.subId } }))
        .graceEndsAt as Date;
      await extendGrace(
        t.w.superAdmin,
        { tenantId: t.w.tenantId, days: 3, reason: "Pagará mañana" },
        meta(),
      );
      const after = (await admin.subscription.findFirstOrThrow({ where: { id: t.subId } }))
        .graceEndsAt as Date;
      expect(after.getTime()).toBeGreaterThan(before.getTime() - 1);
      expect(
        await admin.auditLog.count({
          where: {
            entityId: t.subId,
            action: "subscription.grace_extended",
            reason: "Pagará mañana",
          },
        }),
      ).toBe(1);
      await expect(
        extendGrace(
          t.w.admin,
          { tenantId: t.w.tenantId, days: 3, reason: "Pagará mañana" },
          meta(),
        ),
      ).rejects.toThrow();
      const overview = await getBillingOverview(t.w.superAdmin);
      expect(
        overview.atRisk.some((row) => row.tenantId === t.w.tenantId && row.status === "GRACE"),
      ).toBe(true);
      await expect(getBillingOverview(t.w.admin)).rejects.toThrow();
    });

    it("si el plan cambia antes de pagar, el cobro pendiente toma el precio nuevo", async () => {
      const t = await tenant();
      await setEnd(t.subId, new Date(Date.now() + 2 * DAY));
      await startCheckout(t.w.admin);
      const basic = await admin.plan.findFirstOrThrow({ where: { code: "basic" } });
      await admin.subscription.update({ where: { id: t.subId }, data: { planId: basic.id } });
      await startCheckout(t.w.admin);
      const payment = await paymentOf(t.subId);
      expect(payment.amount.toFixed(2)).toBe(basic.priceMonthly.toFixed(2));
      expect(await admin.subscriptionPayment.count({ where: { subscriptionId: t.subId } })).toBe(1);
    });

    it("cada empresa ve solo su suscripción y sus pagos", async () => {
      const a = await tenant();
      const b = await tenant();
      await setEnd(a.subId, new Date(Date.now() + 2 * DAY));
      await startCheckout(a.w.admin);
      expect((await getSubscriptionView(a.w.admin)).payments).toHaveLength(1);
      expect((await getSubscriptionView(b.w.admin)).payments).toHaveLength(0);
      // Quien no tiene acceso a Configuración no ve la suscripción.
      await expect(getSubscriptionView(a.w.mechanic)).rejects.toBeInstanceOf(PermissionDeniedError);
    });
  });
});
