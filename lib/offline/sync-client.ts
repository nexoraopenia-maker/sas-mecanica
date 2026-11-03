import type { OutboxEntry, SendOutcome } from "./outbox";

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

const RETRYABLE = new Set([408, 425, 429, 500, 502, 503, 504]);

/** Envía una venta de la cola a `/api/pos/sync` y clasifica la respuesta (ver `SendOutcome`). */
export async function sendOutboxEntry(
  entry: OutboxEntry,
  fetchImpl: FetchLike = (input, init) => fetch(input, init),
  timeoutMs = 30_000,
): Promise<SendOutcome> {
  let response: Response;
  try {
    response = await fetchImpl("/api/pos/sync", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ localId: entry.id, occurredAt: entry.occurredAt, sale: entry.sale }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    return { kind: "retry", reason: error instanceof Error ? error.message : "Sin conexión" };
  }
  if (response.ok) {
    const body = (await response.json().catch(() => null)) as {
      saleId?: string;
      documentNumber?: string | null;
    } | null;
    if (!body?.saleId) return { kind: "retry", reason: "Respuesta inesperada del servidor" };
    return { kind: "ok", saleId: body.saleId, documentNumber: body.documentNumber ?? null };
  }
  if (response.status === 401) return { kind: "auth" };
  const body = (await response.json().catch(() => null)) as {
    error?: string;
    code?: string;
  } | null;
  if (RETRYABLE.has(response.status) || response.status >= 500)
    return { kind: "retry", reason: body?.error ?? `El servidor respondió ${response.status}` };
  return {
    kind: "rejected",
    code: body?.code ?? "REJECTED",
    message: body?.error ?? `El servidor rechazó la venta (${response.status})`,
  };
}
