import { describe, expect, it } from "vitest";
import { csvCell, toCsv } from "@/lib/reports/csv";
import { defaultPeriod, limaDay, periodSchema, startOfLimaDay } from "@/lib/reports/period";
import {
  mercadoPagoManifest,
  signMercadoPago,
  signStripeStyle,
  verifyMercadoPago,
  verifyStripeStyle,
} from "@/lib/saas/gateway-signatures";
import {
  daysLeft,
  decideCycle,
  graceEnd,
  hasAccess,
  nextRetryAfterFailure,
  periodCoveredBy,
  type SubSnapshot,
} from "@/lib/saas/subscription";

const at = (iso: string) => new Date(`${iso}T12:00:00.000Z`);
const base = (over: Partial<SubSnapshot> = {}): SubSnapshot => ({
  status: "ACTIVE",
  currentPeriodEnd: at("2026-11-30"),
  graceEndsAt: null,
  retryCount: 0,
  nextRetryAt: null,
  cancelAtPeriodEnd: false,
  hasOpenInvoice: false,
  ...over,
});

describe("ciclo de suscripción", () => {
  it("lejos del vencimiento no hace nada; en la ventana de renovación genera el cobro una sola vez", () => {
    expect(decideCycle(base(), at("2026-11-01"))).toBe("NONE");
    expect(decideCycle(base(), at("2026-11-28"))).toBe("CREATE_INVOICE");
    expect(decideCycle(base({ hasOpenInvoice: true }), at("2026-11-28"))).toBe("NONE");
    expect(decideCycle(base({ cancelAtPeriodEnd: true }), at("2026-11-28"))).toBe("NONE");
  });

  it("al vencer sin pago entra en gracia; vencida la gracia, suspende", () => {
    expect(decideCycle(base(), at("2026-12-01"))).toBe("ENTER_GRACE");
    const grace = base({ status: "GRACE", graceEndsAt: graceEnd(at("2026-11-30")) });
    expect(decideCycle(grace, at("2026-12-03"))).toBe("NONE");
    expect(decideCycle(grace, at("2026-12-08"))).toBe("SUSPEND");
  });

  it("un cobro fallido se reintenta cuando toca, también dentro de la gracia", () => {
    const failing = base({ status: "PAST_DUE", retryCount: 1, nextRetryAt: at("2026-11-25") });
    expect(decideCycle(failing, at("2026-11-24"))).toBe("NONE");
    expect(decideCycle(failing, at("2026-11-25"))).toBe("RETRY_CHARGE");
    const inGrace = base({
      status: "GRACE",
      graceEndsAt: at("2026-12-07"),
      retryCount: 2,
      nextRetryAt: at("2026-12-03"),
    });
    expect(decideCycle(inGrace, at("2026-12-03"))).toBe("RETRY_CHARGE");
    expect(decideCycle({ ...inGrace, nextRetryAt: null }, at("2026-12-03"))).toBe("NONE");
    // Un fallo transitorio de la pasarela en una suscripción aún vigente también se reintenta.
    const transient = base({ hasOpenInvoice: true, nextRetryAt: at("2026-11-28") });
    expect(decideCycle(transient, at("2026-11-28"))).toBe("RETRY_CHARGE");
  });

  it("la cancelación se ejecuta al terminar el periodo; demo, suspendidas y canceladas no se tocan", () => {
    expect(decideCycle(base({ cancelAtPeriodEnd: true }), at("2026-12-01"))).toBe("CANCEL");
    for (const status of ["TRIALING", "SUSPENDED", "CANCELED"] as const)
      expect(decideCycle(base({ status }), at("2027-06-01"))).toBe("NONE");
  });

  it("la suspensión tiene prioridad sobre todo lo demás", () => {
    const stale = base({
      status: "GRACE",
      graceEndsAt: at("2026-12-07"),
      nextRetryAt: at("2026-12-01"),
      cancelAtPeriodEnd: true,
    });
    expect(decideCycle(stale, at("2026-12-09"))).toBe("SUSPEND");
  });

  it("los reintentos siguen la agenda configurada y se acaban", () => {
    const from = at("2026-12-01");
    expect(nextRetryAfterFailure(1, from)?.toISOString().slice(0, 10)).toBe("2026-12-02");
    expect(nextRetryAfterFailure(2, from)?.toISOString().slice(0, 10)).toBe("2026-12-04");
    expect(nextRetryAfterFailure(3, from)?.toISOString().slice(0, 10)).toBe("2026-12-06");
    expect(nextRetryAfterFailure(4, from)).toBeNull();
  });

  it("pagar a tiempo continúa el periodo; tras la suspensión arranca hoy; nunca se regala ni se pierde tiempo", () => {
    const onTime = periodCoveredBy(at("2026-11-30"), at("2026-11-27"), false);
    expect(onTime.start.toISOString().slice(0, 10)).toBe("2026-11-30");
    expect(onTime.end.toISOString().slice(0, 10)).toBe("2026-12-30");
    const inGrace = periodCoveredBy(at("2026-11-30"), at("2026-12-03"), false);
    expect(inGrace.start.toISOString().slice(0, 10)).toBe("2026-11-30");
    const suspended = periodCoveredBy(at("2026-11-30"), at("2026-12-20"), true);
    expect(suspended.start.toISOString().slice(0, 10)).toBe("2026-12-20");
    expect(suspended.end.toISOString().slice(0, 10)).toBe("2027-01-20");
  });

  it("la gracia da acceso y la suspensión no", () => {
    expect(["ACTIVE", "PAST_DUE", "GRACE", "TRIALING"].every((s) => hasAccess(s as never))).toBe(
      true,
    );
    expect(hasAccess("SUSPENDED")).toBe(false);
    expect(hasAccess("CANCELED")).toBe(false);
    expect(daysLeft(at("2026-12-05"), at("2026-12-01"))).toBe(4);
    expect(daysLeft(at("2026-11-01"), at("2026-12-01"))).toBe(0);
  });
});

describe("firmas de las pasarelas", () => {
  const body = JSON.stringify({ id: "evt_1", type: "payment_intent.succeeded" });
  const now = Date.parse("2026-11-10T12:00:00Z");
  const t = Math.floor(now / 1000);

  it("Stripe: acepta la firma correcta, rechaza alteraciones, viejas y ausentes; ignora v0 y acepta cualquier v1", () => {
    const sig = signStripeStyle("whsec_test", t, body);
    expect(
      verifyStripeStyle({
        secret: "whsec_test",
        header: `t=${t},v1=${sig}`,
        rawBody: body,
        nowMs: now,
      }),
    ).toBe("ok");
    expect(
      verifyStripeStyle({
        secret: "whsec_test",
        header: `t=${t},v0=${"0".repeat(64)},v1=${"1".repeat(64)},v1=${sig}`,
        rawBody: body,
        nowMs: now,
      }),
    ).toBe("ok");
    expect(
      verifyStripeStyle({
        secret: "whsec_test",
        header: `t=${t},v1=${sig}`,
        rawBody: `${body} `,
        nowMs: now,
      }),
    ).toBe("invalid");
    expect(
      verifyStripeStyle({ secret: "otro", header: `t=${t},v1=${sig}`, rawBody: body, nowMs: now }),
    ).toBe("invalid");
    expect(
      verifyStripeStyle({
        secret: "whsec_test",
        header: `t=${t},v1=${sig}`,
        rawBody: body,
        nowMs: now + 301_000,
      }),
    ).toBe("stale");
    expect(
      verifyStripeStyle({ secret: "whsec_test", header: null, rawBody: body, nowMs: now }),
    ).toBe("missing");
    expect(
      verifyStripeStyle({ secret: "whsec_test", header: "basura", rawBody: body, nowMs: now }),
    ).toBe("invalid");
    // El timestamp va firmado: no se puede reutilizar un cuerpo viejo con una marca nueva.
    expect(
      verifyStripeStyle({
        secret: "whsec_test",
        header: `t=${t + 100},v1=${sig}`,
        rawBody: body,
        nowMs: now,
      }),
    ).toBe("invalid");
  });

  it("Mercado Pago: la plantilla omite lo que falta y el id alfanumérico va en minúsculas", () => {
    expect(mercadoPagoManifest({ dataId: "123456", requestId: "req-1", ts: "1700000000000" })).toBe(
      "id:123456;request-id:req-1;ts:1700000000000;",
    );
    expect(mercadoPagoManifest({ dataId: null, requestId: "req-1", ts: "1" })).toBe(
      "request-id:req-1;ts:1;",
    );
    expect(mercadoPagoManifest({ dataId: "ABC123", requestId: null, ts: "1" })).toBe(
      "id:abc123;ts:1;",
    );
  });

  it("Mercado Pago: verifica x-signature con el manifiesto firmado", () => {
    const ts = String(now);
    const v1 = signMercadoPago(
      "mp_secret",
      mercadoPagoManifest({ dataId: "999", requestId: "req-9", ts }),
    );
    const check = (over: Partial<Parameters<typeof verifyMercadoPago>[0]> = {}) =>
      verifyMercadoPago({
        secret: "mp_secret",
        header: `ts=${ts},v1=${v1}`,
        requestId: "req-9",
        dataId: "999",
        nowMs: now,
        ...over,
      });
    expect(check()).toBe("ok");
    expect(check({ dataId: "1000" })).toBe("invalid");
    expect(check({ requestId: "otro" })).toBe("invalid");
    expect(check({ secret: "x" })).toBe("invalid");
    expect(check({ nowMs: now + 400_000 })).toBe("stale");
    expect(check({ header: null })).toBe("missing");
    expect(check({ header: "ts=abc,v1=zzz" })).toBe("invalid");
  });
});

describe("CSV y periodos de reportes", () => {
  it("neutraliza fórmulas, escapa comillas, separadores y saltos de línea", () => {
    expect(csvCell('=HYPERLINK("http://x")')).toBe('"\'=HYPERLINK(""http://x"")"');
    for (const evil of ["+1+1", "-2+3", "@SUM(A1)", "\tcmd"])
      expect(csvCell(evil).replace(/^"/, "")).toMatch(/^'/);
    expect(csvCell("a;b")).toBe('"a;b"');
    expect(csvCell("línea\nnueva")).toBe('"línea\nnueva"');
    expect(csvCell(null)).toBe("");
    expect(csvCell(12.5)).toBe("12.5");
    expect(csvCell(-3)).toBe("-3"); // un número negativo real no es una fórmula
  });

  it("el archivo lleva BOM UTF-8, separador «;» y CRLF", () => {
    const csv = toCsv(["Producto", "Cantidad"], [["Batería 60Ah", 2]]);
    expect(csv.startsWith("﻿")).toBe(true);
    expect(csv).toBe("﻿Producto;Cantidad\r\nBatería 60Ah;2\r\n");
  });

  it("el rango se interpreta en horario de Lima, es inclusivo y tiene tope", () => {
    expect(limaDay(new Date("2026-11-10T03:00:00Z"))).toBe("2026-11-09");
    expect(startOfLimaDay("2026-11-10").toISOString()).toBe("2026-11-10T05:00:00.000Z");
    const p = periodSchema.parse({ from: "2026-11-01", to: "2026-11-30" });
    expect(p.endExclusive.toISOString()).toBe("2026-12-01T05:00:00.000Z");
    expect(() => periodSchema.parse({ from: "2026-11-30", to: "2026-11-01" })).toThrow();
    expect(() => periodSchema.parse({ from: "2024-01-01", to: "2026-11-01" })).toThrow(/máximo/);
    expect(() => periodSchema.parse({ from: "01/11/2026", to: "2026-11-01" })).toThrow();
    expect(defaultPeriod(new Date("2026-11-10T20:00:00Z"))).toEqual({
      from: "2026-11-01",
      to: "2026-11-10",
    });
  });
});
