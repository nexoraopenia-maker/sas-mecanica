import { describe, expect, it } from "vitest";
import {
  backoffSeconds,
  countEntries,
  discardFailed,
  enqueueSale,
  entriesOf,
  flushOutbox,
  MemoryOutboxStore,
  pruneSynced,
  recoverStuck,
  retryFailed,
  SYNCED_KEEP_MS,
  STUCK_AFTER_MS,
  type OutboxOwner,
  type SendOutcome,
} from "@/lib/offline/outbox";
import { withPendingStock } from "@/lib/offline/snapshot";
import type { PosProduct } from "@/lib/pos/types";

const OWNER: OutboxOwner = { tenantId: "t1", userId: "u1" };
const T0 = new Date("2026-11-03T15:00:00.000Z");
const sale = (key: string, items: Array<{ productId: string; quantity: string }> = []) => ({
  idempotencyKey: key,
  documentType: "BOLETA",
  items,
});
const summary = { total: "118.00", documentType: "BOLETA", items: 1 };
const ok: SendOutcome = { kind: "ok", saleId: "sale-1", documentNumber: "B001-00000001" };

async function seeded(keys: string[]) {
  const store = new MemoryOutboxStore();
  for (const [i, key] of keys.entries())
    await enqueueSale(store, {
      owner: OWNER,
      sale: sale(key),
      summary,
      now: new Date(T0.getTime() + i * 1000),
    });
  return store;
}

describe("cola de ventas sin conexión", () => {
  it("guarda la venta con su clave de idempotencia y no la duplica", async () => {
    const store = new MemoryOutboxStore();
    const first = await enqueueSale(store, { owner: OWNER, sale: sale("k1"), summary, now: T0 });
    const again = await enqueueSale(store, {
      owner: OWNER,
      sale: sale("k1"),
      summary,
      now: new Date(T0.getTime() + 5000),
    });
    expect(first).toMatchObject({
      id: "k1",
      status: "PENDING",
      attempts: 0,
      occurredAt: T0.toISOString(),
    });
    expect(again.occurredAt).toBe(first.occurredAt);
    expect(await store.all()).toHaveLength(1);
  });

  it("un usuario no ve ni envía las ventas de otro en el mismo dispositivo", async () => {
    const store = await seeded(["k1"]);
    await enqueueSale(store, {
      owner: { tenantId: "t1", userId: "u2" },
      sale: sale("k2"),
      summary,
    });
    await enqueueSale(store, {
      owner: { tenantId: "t2", userId: "u1" },
      sale: sale("k3"),
      summary,
    });
    expect((await entriesOf(store, OWNER)).map((e) => e.id)).toEqual(["k1"]);
    const sent: string[] = [];
    await flushOutbox({ store, owner: OWNER, send: async (e) => (sent.push(e.id), ok) });
    expect(sent).toEqual(["k1"]);
    expect((await store.get("k2"))?.status).toBe("PENDING");
    expect((await store.get("k3"))?.status).toBe("PENDING");
  });

  it("envía en orden y marca como sincronizadas las aceptadas", async () => {
    const store = await seeded(["a", "b", "c"]);
    const order: string[] = [];
    const result = await flushOutbox({
      store,
      owner: OWNER,
      send: async (e) => (order.push(e.id), ok),
    });
    expect(order).toEqual(["a", "b", "c"]);
    expect(result).toEqual({ synced: 3, failed: 0, retry: 0, authRequired: false });
    const entries = await entriesOf(store, OWNER);
    expect(
      entries.every((e) => e.status === "SYNCED" && e.result?.documentNumber === "B001-00000001"),
    ).toBe(true);
    expect(countEntries(entries)).toEqual({ pending: 0, failed: 0, syncing: 0, synced: 3 });
  });

  it("una venta rechazada pasa a «revisar» y no frena a las demás", async () => {
    const store = await seeded(["a", "b"]);
    const result = await flushOutbox({
      store,
      owner: OWNER,
      send: async (e) =>
        e.id === "a"
          ? { kind: "rejected", code: "NO_OPEN_CASH", message: "No tienes una caja abierta" }
          : ok,
    });
    expect(result).toMatchObject({ synced: 1, failed: 1 });
    expect(await store.get("a")).toMatchObject({
      status: "FAILED",
      errorCode: "NO_OPEN_CASH",
      lastError: "No tienes una caja abierta",
      attempts: 1,
    });
    expect((await store.get("b"))?.status).toBe("SYNCED");
  });

  it("una falla transitoria reintenta con retroceso y detiene la tanda", async () => {
    const store = await seeded(["a", "b"]);
    const sent: string[] = [];
    const result = await flushOutbox({
      store,
      owner: OWNER,
      now: () => T0,
      send: async (e) => (sent.push(e.id), { kind: "retry", reason: "Sin conexión" }),
    });
    expect(sent).toEqual(["a"]);
    expect(result).toMatchObject({ retry: 1, synced: 0 });
    const a = await store.get("a");
    expect(a).toMatchObject({ status: "PENDING", attempts: 1, lastError: "Sin conexión" });
    expect(a?.nextAttemptAt).toBe(new Date(T0.getTime() + 5000).toISOString());
    // Antes de la fecha de reintento no se vuelve a enviar; después sí.
    const early = await flushOutbox({
      store,
      owner: OWNER,
      now: () => new Date(T0.getTime() + 1000),
      send: async () => ok,
    });
    expect(early.synced).toBe(0);
    const later = await flushOutbox({
      store,
      owner: OWNER,
      now: () => new Date(T0.getTime() + 6000),
      send: async () => ok,
    });
    expect(later.synced).toBe(2);
  });

  it("una excepción al enviar cuenta como falla transitoria (nunca pierde la venta)", async () => {
    const store = await seeded(["a"]);
    await flushOutbox({
      store,
      owner: OWNER,
      send: async () => {
        throw new Error("boom");
      },
    });
    expect(await store.get("a")).toMatchObject({
      status: "PENDING",
      lastError: "boom",
      attempts: 1,
    });
  });

  it("si la sesión venció se pausa sin gastar intentos", async () => {
    const store = await seeded(["a", "b"]);
    const result = await flushOutbox({ store, owner: OWNER, send: async () => ({ kind: "auth" }) });
    expect(result.authRequired).toBe(true);
    expect(await store.get("a")).toMatchObject({ status: "PENDING", attempts: 0 });
    expect((await store.get("b"))?.status).toBe("PENDING");
  });

  it("el retroceso crece y tiene tope", () => {
    expect([1, 2, 3, 4, 5, 6, 20].map(backoffSeconds)).toEqual([5, 15, 45, 120, 300, 300, 300]);
  });

  it("recupera lo que quedó «enviando» por una pestaña cerrada, sin duplicar", async () => {
    const store = await seeded(["a"]);
    const entry = await store.get("a");
    if (!entry) throw new Error("falta");
    await store.put({ ...entry, status: "SYNCING", updatedAt: T0.toISOString() });
    expect(await recoverStuck(store, OWNER, new Date(T0.getTime() + STUCK_AFTER_MS - 1000))).toBe(
      0,
    );
    expect(await recoverStuck(store, OWNER, new Date(T0.getTime() + STUCK_AFTER_MS + 1000))).toBe(
      1,
    );
    expect((await store.get("a"))?.status).toBe("PENDING");
  });

  it("reintentar solo aplica a rechazadas y descartar también; una pendiente nunca se borra a mano", async () => {
    const store = await seeded(["a", "b"]);
    await flushOutbox({
      store,
      owner: OWNER,
      send: async (e) =>
        e.id === "a"
          ? { kind: "rejected", code: "X", message: "m" }
          : { kind: "retry", reason: "r" },
    });
    expect(await discardFailed(store, "b")).toBe(false); // pendiente: no se puede descartar
    expect(await retryFailed(store, "b")).toBe(false);
    expect(await retryFailed(store, "a")).toBe(true);
    expect(await store.get("a")).toMatchObject({ status: "PENDING", attempts: 0, lastError: null });
    await flushOutbox({
      store,
      owner: OWNER,
      send: async () => ({ kind: "rejected", code: "X", message: "m" }),
    });
    expect(await discardFailed(store, "a")).toBe(true);
    expect(await store.get("a")).toBeUndefined();
  });

  it("limpia lo sincronizado después de un día", async () => {
    const store = await seeded(["a"]);
    await flushOutbox({ store, owner: OWNER, now: () => T0, send: async () => ok });
    await pruneSynced(store, OWNER, new Date(T0.getTime() + SYNCED_KEEP_MS - 1000));
    expect(await store.get("a")).toBeDefined();
    await pruneSynced(store, OWNER, new Date(T0.getTime() + SYNCED_KEEP_MS + 1000));
    expect(await store.get("a")).toBeUndefined();
  });
});

describe("stock visible sin conexión", () => {
  const product = (id: string, stock: number | null, isStocked = true): PosProduct => ({
    id,
    sku: id,
    name: id,
    barcode: null,
    kind: "PART",
    brand: null,
    salePrice: "10.00",
    stock,
    trackingMode: "NONE",
    isStocked,
    taxAffectation: "TAXED",
    codes: [],
    tire: null,
  });
  it("descuenta lo vendido en el dispositivo y todavía sin sincronizar", async () => {
    const store = new MemoryOutboxStore();
    await enqueueSale(store, {
      owner: OWNER,
      sale: sale("a", [{ productId: "p1", quantity: "2" }]),
      summary,
    });
    await enqueueSale(store, {
      owner: OWNER,
      sale: sale("b", [{ productId: "p1", quantity: "1" }]),
      summary,
    });
    await flushOutbox({
      store,
      owner: OWNER,
      send: async (e) => (e.id === "a" ? ok : { kind: "retry", reason: "x" }),
    });
    const entries = await entriesOf(store, OWNER);
    const adjusted = withPendingStock(
      [product("p1", 10), product("p2", 4), product("svc", null, false)],
      entries,
    );
    // «a» ya se sincronizó (el servidor descontó su stock); solo «b» sigue pendiente.
    expect(adjusted.find((p) => p.id === "p1")?.stock).toBe(9);
    expect(adjusted.find((p) => p.id === "p2")?.stock).toBe(4);
    expect(adjusted.find((p) => p.id === "svc")?.stock).toBeNull();
  });
});
