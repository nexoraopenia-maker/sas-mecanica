/**
 * Cola de ventas sin conexión («outbox»). Lógica pura sobre un almacén abstracto (IndexedDB en el navegador,
 * memoria en las pruebas). Una venta se guarda con su clave de idempotencia: reintentar jamás duplica.
 */

export type OutboxStatus = "PENDING" | "SYNCING" | "FAILED" | "SYNCED";

export interface OutboxOwner {
  tenantId: string;
  userId: string;
}

export interface OutboxEntry extends OutboxOwner {
  /** = clave de idempotencia de la venta. */
  id: string;
  status: OutboxStatus;
  /** Cuándo se cobró en el mostrador (hora del dispositivo, ISO). */
  occurredAt: string;
  /** Datos de la venta tal como los recibe el servicio de venta. */
  sale: Record<string, unknown>;
  /** Resumen para mostrar en pantalla sin recalcular nada. */
  summary: { total: string; documentType: string; items: number };
  attempts: number;
  /** No reintentar antes de esta fecha (retroceso exponencial). */
  nextAttemptAt: string | null;
  lastError: string | null;
  errorCode: string | null;
  result: { saleId: string; documentNumber: string | null } | null;
  updatedAt: string;
}

export interface OutboxStore {
  put(entry: OutboxEntry): Promise<void>;
  get(id: string): Promise<OutboxEntry | undefined>;
  all(): Promise<OutboxEntry[]>;
  remove(id: string): Promise<void>;
}

export type SendOutcome =
  | { kind: "ok"; saleId: string; documentNumber: string | null }
  /** El servidor la rechazó por una regla de negocio: hay que revisarla, reintentar no la arregla sola. */
  | { kind: "rejected"; code: string; message: string }
  /** Falla transitoria (sin red, servidor caído, límite de peticiones): se reintenta más tarde. */
  | { kind: "retry"; reason: string }
  /** La sesión venció: se pausa hasta volver a ingresar (nada se pierde). */
  | { kind: "auth" };

const BACKOFF_SECONDS = [5, 15, 45, 120, 300];
/** Una venta «en envío» más de este tiempo se considera interrumpida (pestaña cerrada) y vuelve a la cola. */
export const STUCK_AFTER_MS = 2 * 60_000;
/** Las ventas ya sincronizadas se conservan un día para mostrarlas y luego se limpian. */
export const SYNCED_KEEP_MS = 24 * 3_600_000;

export function backoffSeconds(attempts: number): number {
  return BACKOFF_SECONDS[Math.min(Math.max(attempts, 1), BACKOFF_SECONDS.length) - 1] ?? 300;
}

const iso = (date: Date) => date.toISOString();
const isOwner = (entry: OutboxEntry, owner: OutboxOwner) =>
  entry.tenantId === owner.tenantId && entry.userId === owner.userId;

export async function enqueueSale(
  store: OutboxStore,
  params: {
    owner: OutboxOwner;
    sale: Record<string, unknown> & { idempotencyKey: string };
    summary: OutboxEntry["summary"];
    now?: Date;
  },
): Promise<OutboxEntry> {
  const now = params.now ?? new Date();
  const existing = await store.get(params.sale.idempotencyKey);
  if (existing) return existing;
  const entry: OutboxEntry = {
    ...params.owner,
    id: params.sale.idempotencyKey,
    status: "PENDING",
    occurredAt: iso(now),
    sale: params.sale,
    summary: params.summary,
    attempts: 0,
    nextAttemptAt: null,
    lastError: null,
    errorCode: null,
    result: null,
    updatedAt: iso(now),
  };
  await store.put(entry);
  return entry;
}

/** Ventas del usuario actual, de la más antigua a la más nueva. Otro usuario del mismo dispositivo no las ve. */
export async function entriesOf(store: OutboxStore, owner: OutboxOwner): Promise<OutboxEntry[]> {
  return (await store.all())
    .filter((entry) => isOwner(entry, owner))
    .sort((a, b) => a.occurredAt.localeCompare(b.occurredAt) || a.id.localeCompare(b.id));
}

export interface OutboxCounts {
  pending: number;
  failed: number;
  syncing: number;
  synced: number;
}

export function countEntries(entries: OutboxEntry[]): OutboxCounts {
  const count = (status: OutboxStatus) => entries.filter((e) => e.status === status).length;
  return {
    pending: count("PENDING"),
    failed: count("FAILED"),
    syncing: count("SYNCING"),
    synced: count("SYNCED"),
  };
}

/** Devuelve a la cola lo que quedó «en envío» por una pestaña cerrada; el servidor evita duplicados. */
export async function recoverStuck(
  store: OutboxStore,
  owner: OutboxOwner,
  now: Date = new Date(),
): Promise<number> {
  let recovered = 0;
  for (const entry of await entriesOf(store, owner)) {
    if (entry.status !== "SYNCING") continue;
    if (now.getTime() - Date.parse(entry.updatedAt) < STUCK_AFTER_MS) continue;
    await store.put({ ...entry, status: "PENDING", updatedAt: iso(now) });
    recovered += 1;
  }
  return recovered;
}

/** Quita lo sincronizado hace más de un día. */
export async function pruneSynced(
  store: OutboxStore,
  owner: OutboxOwner,
  now: Date = new Date(),
): Promise<void> {
  for (const entry of await entriesOf(store, owner))
    if (entry.status === "SYNCED" && now.getTime() - Date.parse(entry.updatedAt) > SYNCED_KEEP_MS)
      await store.remove(entry.id);
}

export interface FlushResult {
  synced: number;
  failed: number;
  retry: number;
  /** La sesión venció: se detuvo el envío. */
  authRequired: boolean;
}

/**
 * Envía en orden las ventas pendientes del usuario. Una a la vez (el orden importa para la caja y los
 * correlativos). Una falla transitoria detiene la tanda para no martillar un servidor caído.
 */
export async function flushOutbox(params: {
  store: OutboxStore;
  owner: OutboxOwner;
  send: (entry: OutboxEntry) => Promise<SendOutcome>;
  now?: () => Date;
}): Promise<FlushResult> {
  const clock = params.now ?? (() => new Date());
  const result: FlushResult = { synced: 0, failed: 0, retry: 0, authRequired: false };
  await recoverStuck(params.store, params.owner, clock());
  for (const entry of await entriesOf(params.store, params.owner)) {
    if (entry.status !== "PENDING") continue;
    // Una venta anterior que espera su reintento frena a las siguientes: el orden importa (caja y correlativos).
    if (entry.nextAttemptAt && Date.parse(entry.nextAttemptAt) > clock().getTime()) break;
    await params.store.put({ ...entry, status: "SYNCING", updatedAt: iso(clock()) });
    let outcome: SendOutcome;
    try {
      outcome = await params.send(entry);
    } catch (error) {
      outcome = { kind: "retry", reason: error instanceof Error ? error.message : "Error de red" };
    }
    const now = clock();
    if (outcome.kind === "ok") {
      await params.store.put({
        ...entry,
        status: "SYNCED",
        result: { saleId: outcome.saleId, documentNumber: outcome.documentNumber },
        lastError: null,
        errorCode: null,
        nextAttemptAt: null,
        updatedAt: iso(now),
      });
      result.synced += 1;
    } else if (outcome.kind === "rejected") {
      await params.store.put({
        ...entry,
        status: "FAILED",
        attempts: entry.attempts + 1,
        lastError: outcome.message,
        errorCode: outcome.code,
        nextAttemptAt: null,
        updatedAt: iso(now),
      });
      result.failed += 1;
    } else if (outcome.kind === "auth") {
      await params.store.put({ ...entry, status: "PENDING", updatedAt: iso(now) });
      result.authRequired = true;
      break;
    } else {
      const attempts = entry.attempts + 1;
      await params.store.put({
        ...entry,
        status: "PENDING",
        attempts,
        lastError: outcome.reason,
        nextAttemptAt: iso(new Date(now.getTime() + backoffSeconds(attempts) * 1000)),
        updatedAt: iso(now),
      });
      result.retry += 1;
      break;
    }
  }
  return result;
}

/** El cajero decide reintentar una venta rechazada (p. ej. tras abrir la caja). */
export async function retryFailed(
  store: OutboxStore,
  id: string,
  now: Date = new Date(),
): Promise<boolean> {
  const entry = await store.get(id);
  if (!entry || entry.status !== "FAILED") return false;
  await store.put({
    ...entry,
    status: "PENDING",
    attempts: 0,
    nextAttemptAt: null,
    lastError: null,
    errorCode: null,
    updatedAt: iso(now),
  });
  return true;
}

/** Descartar solo es posible para ventas rechazadas: una pendiente nunca se borra a mano. */
export async function discardFailed(store: OutboxStore, id: string): Promise<boolean> {
  const entry = await store.get(id);
  if (!entry || entry.status !== "FAILED") return false;
  await store.remove(id);
  return true;
}

/** Almacén en memoria (pruebas y entornos sin IndexedDB). */
export class MemoryOutboxStore implements OutboxStore {
  private readonly rows = new Map<string, OutboxEntry>();
  async put(entry: OutboxEntry) {
    this.rows.set(entry.id, structuredClone(entry));
  }
  async get(id: string) {
    const row = this.rows.get(id);
    return row ? structuredClone(row) : undefined;
  }
  async all() {
    return [...this.rows.values()].map((row) => structuredClone(row));
  }
  async remove(id: string) {
    this.rows.delete(id);
  }
}
