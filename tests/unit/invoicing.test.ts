import { describe, expect, it } from "vitest";
import type { InvoicePayload } from "@/lib/billing/payload";
import {
  HttpInvoiceProvider,
  InvoiceProviderError,
  SimulatedInvoiceProvider,
} from "@/server/integrations/invoicing";

const payload = (over: Partial<InvoicePayload> = {}): InvoicePayload => ({
  documentTypeCode: "03",
  series: "B001",
  correlative: 7,
  issueDate: "2026-10-21",
  currency: "PEN",
  paymentTerms: "Contado",
  issuer: { ruc: "20100070970", name: "Taller SAC", tradeName: null, address: null },
  customer: { identityCode: "0", docNumber: "-", name: "CLIENTES VARIOS", address: null },
  items: [
    {
      code: null,
      description: "Servicio",
      unitCode: "ZZ",
      quantity: "1",
      unitValue: "100",
      unitPrice: "118",
      discount: "0.00",
      affectationCode: "10",
      base: "100.00",
      tax: "18.00",
      total: "118.00",
    },
  ],
  totals: {
    taxed: "100.00",
    exempt: "0.00",
    unaffected: "0.00",
    tax: "18.00",
    discount: "0.00",
    total: "118.00",
    legend: "SON: CIENTO DIECIOCHO CON 00/100 SOLES",
  },
  related: null,
  note: null,
  qr: "x",
  ...over,
});

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const publicDns = async () => ["8.8.8.8"];

function provider(
  respond: (url: string, init: RequestInit) => Promise<Response>,
  resolve = publicDns,
) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const instance = new HttpInvoiceProvider(
    { baseUrl: "https://ose.example.pe/api/", token: "secreto" },
    { fetch: async (url, init) => (calls.push({ url, init }), respond(url, init)), resolve },
  );
  return { instance, calls };
}

describe("proveedor simulado", () => {
  const sim = new SimulatedInvoiceProvider();
  it("acepta un comprobante coherente con un hash determinista", async () => {
    const a = await sim.submit(payload());
    const b = await sim.submit(payload());
    expect(a).toMatchObject({ outcome: "ACCEPTED", providerRef: "SIM-B001-7" });
    expect(a.hash).toBe(b.hash);
  });
  it("rechaza lo que SUNAT rechazaría: RUC inválido en factura, total que no cuadra, serie mala", async () => {
    expect(
      await sim.submit(
        payload({
          documentTypeCode: "01",
          customer: { identityCode: "6", docNumber: "20100070971", name: "X SAC", address: null },
        }),
      ),
    ).toMatchObject({ outcome: "REJECTED", code: "2800" });
    expect(
      await sim.submit(payload({ totals: { ...payload().totals, total: "120.00" } })),
    ).toMatchObject({ outcome: "REJECTED", code: "3030" });
    expect(await sim.submit(payload({ series: "B1" }))).toMatchObject({
      outcome: "REJECTED",
      code: "2111",
    });
  });
});

describe("adaptador HTTP del OSE/PSE", () => {
  it("envía el comprobante con token e idempotencia por serie-correlativo y mapea la aceptación", async () => {
    const { instance, calls } = provider(async () =>
      json(200, {
        status: "ACCEPTED",
        id: "abc",
        hash: "h",
        pdf_url: "https://ose.example.pe/p.pdf",
        code: 0,
      }),
    );
    const result = await instance.submit(payload());
    expect(result).toMatchObject({
      outcome: "ACCEPTED",
      providerRef: "abc",
      hash: "h",
      pdfUrl: "https://ose.example.pe/p.pdf",
    });
    expect(calls[0]?.url).toBe("https://ose.example.pe/api/documents");
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer secreto");
    expect(headers["idempotency-key"]).toBe("B001-7");
    expect(calls[0]?.init.redirect).toBe("error");
  });

  it("un rechazo con cuerpo válido es REJECTED (no reintentable por sí solo)", async () => {
    const { instance } = provider(async () =>
      json(422, { status: "REJECTED", code: "2335", message: "El documento ya existe" }),
    );
    expect(await instance.submit(payload())).toMatchObject({
      outcome: "REJECTED",
      code: "2335",
      message: "El documento ya existe",
    });
  });

  it("5xx, 429 y fallos de red son reintentables; 401/403/404 y cuerpos ilegibles no", async () => {
    for (const status of [500, 502, 503, 429, 408]) {
      const { instance } = provider(async () => json(status, {}));
      await expect(instance.submit(payload())).rejects.toMatchObject({ retryable: true });
    }
    const down = provider(async () => Promise.reject(new TypeError("fetch failed")));
    await expect(down.instance.submit(payload())).rejects.toMatchObject({ retryable: true });
    for (const status of [401, 403, 404]) {
      const { instance } = provider(async () => json(status, {}));
      await expect(instance.submit(payload())).rejects.toMatchObject({ retryable: false });
    }
    const odd = provider(async () => json(200, { hola: "mundo" }));
    await expect(odd.instance.submit(payload())).rejects.toMatchObject({ retryable: false });
  });

  it("protege contra SSRF: no llama si el host resuelve a una IP privada", async () => {
    const { instance, calls } = provider(
      async () => json(200, { status: "ACCEPTED" }),
      async () => ["10.0.0.7"],
    );
    await expect(instance.submit(payload())).rejects.toBeInstanceOf(InvoiceProviderError);
    expect(calls).toHaveLength(0);
  });
});
