import { describe, expect, it } from "vitest";
import type { OutboxEntry } from "@/lib/offline/outbox";
import { sendOutboxEntry } from "@/lib/offline/sync-client";

const entry: OutboxEntry = {
  id: "11111111-1111-4111-8111-111111111111",
  tenantId: "t",
  userId: "u",
  status: "SYNCING",
  occurredAt: "2026-11-03T15:00:00.000Z",
  sale: { idempotencyKey: "11111111-1111-4111-8111-111111111111" },
  summary: { total: "10.00", documentType: "BOLETA", items: 1 },
  attempts: 0,
  nextAttemptAt: null,
  lastError: null,
  errorCode: null,
  result: null,
  updatedAt: "2026-11-03T15:00:00.000Z",
};
const reply = (status: number, body: unknown) => async () =>
  new Response(JSON.stringify(body), { status });

describe("clasificación de la respuesta de sincronización", () => {
  it("200 → aceptada, con el número del comprobante", async () => {
    expect(
      await sendOutboxEntry(entry, reply(200, { saleId: "s1", documentNumber: "B001-00000007" })),
    ).toEqual({
      kind: "ok",
      saleId: "s1",
      documentNumber: "B001-00000007",
    });
  });
  it("una respuesta 200 sin saleId no se da por buena", async () => {
    expect(await sendOutboxEntry(entry, reply(200, {}))).toMatchObject({ kind: "retry" });
  });
  it("401 → sesión vencida", async () => {
    expect(await sendOutboxEntry(entry, reply(401, { code: "UNAUTHORIZED" }))).toEqual({
      kind: "auth",
    });
  });
  it.each([408, 429, 500, 502, 503, 504])("%i → reintentar", async (status) => {
    expect(await sendOutboxEntry(entry, reply(status, { error: "x" }))).toMatchObject({
      kind: "retry",
    });
  });
  it.each([400, 403, 404, 409, 413])(
    "%i → rechazada con el mensaje del servidor",
    async (status) => {
      expect(
        await sendOutboxEntry(
          entry,
          reply(status, { error: "No tienes una caja abierta", code: "NO_OPEN_CASH" }),
        ),
      ).toEqual({
        kind: "rejected",
        code: "NO_OPEN_CASH",
        message: "No tienes una caja abierta",
      });
    },
  );
  it("sin red (fetch lanza) → reintentar", async () => {
    const result = await sendOutboxEntry(entry, async () => {
      throw new TypeError("Failed to fetch");
    });
    expect(result).toEqual({ kind: "retry", reason: "Failed to fetch" });
  });
  it("manda la venta con su clave, la fecha original y la cookie de sesión", async () => {
    let captured: { url: string; init: RequestInit } | null = null;
    await sendOutboxEntry(entry, async (url, init) => {
      captured = { url, init };
      return new Response(JSON.stringify({ saleId: "s" }), { status: 200 });
    });
    const call = captured as unknown as { url: string; init: RequestInit };
    expect(call.url).toBe("/api/pos/sync");
    expect(call.init.method).toBe("POST");
    expect(call.init.credentials).toBe("same-origin");
    expect(JSON.parse(String(call.init.body))).toEqual({
      localId: entry.id,
      occurredAt: entry.occurredAt,
      sale: entry.sale,
    });
  });
});
