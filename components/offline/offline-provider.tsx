"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { clearPrivateCaches } from "@/components/pwa/pwa-register";
import {
  clearSnapshot,
  IdbOutboxStore,
  loadSnapshot,
  offlineSupported,
  saveSnapshot,
} from "@/lib/offline/idb";
import {
  countEntries,
  discardFailed,
  enqueueSale,
  entriesOf,
  flushOutbox,
  pruneSynced,
  recoverStuck,
  retryFailed,
  type OutboxCounts,
  type OutboxEntry,
  type OutboxOwner,
} from "@/lib/offline/outbox";
import { isSnapshotStale, withPendingStock } from "@/lib/offline/snapshot";
import { sendOutboxEntry } from "@/lib/offline/sync-client";
import { LocalCatalog } from "@/lib/pos/search";
import type { PosProduct, PosSnapshot, PosTaxContext } from "@/lib/pos/types";

interface OfflineContextValue {
  /** Hay conexión según el navegador (puede haber red sin internet: por eso el envío igual se reintenta). */
  online: boolean;
  supported: boolean;
  entries: OutboxEntry[];
  counts: OutboxCounts;
  syncing: boolean;
  authRequired: boolean;
  /** Catálogo y tasa de IGV guardados en el dispositivo (null si aún no se descargaron). */
  catalog: LocalCatalog | null;
  tax: PosTaxContext | null;
  snapshotAt: string | null;
  searchLocal: (query: string, limit?: number) => PosProduct[];
  enqueue: (
    sale: Record<string, unknown> & { idempotencyKey: string },
    summary: OutboxEntry["summary"],
  ) => Promise<OutboxEntry>;
  syncNow: () => Promise<void>;
  retry: (id: string) => Promise<void>;
  discard: (id: string) => Promise<void>;
}

const OfflineContext = createContext<OfflineContextValue | null>(null);

export function useOffline(): OfflineContextValue {
  const value = useContext(OfflineContext);
  if (!value) throw new Error("useOffline debe usarse dentro de OfflineProvider");
  return value;
}

/** Conexión según el navegador, como fuente externa (sin estado duplicado ni efectos). */
function subscribeOnline(listener: () => void): () => void {
  window.addEventListener("online", listener);
  window.addEventListener("offline", listener);
  return () => {
    window.removeEventListener("online", listener);
    window.removeEventListener("offline", listener);
  };
}

export function useOnline(): boolean {
  return useSyncExternalStore(
    subscribeOnline,
    () => navigator.onLine,
    () => true,
  );
}

const WARM_KEY = "mecania-pos-warm";
const WARM_EVERY_MS = 6 * 3_600_000;
/** Mismo nombre que en public/sw.js. */
const PAGES_CACHE = "mecania-pages-v1";

/**
 * Pide el HTML del mostrador (como documento) para que el service worker lo guarde y se pueda abrir sin
 * conexión. Espera a que el worker controle la página (en la primera visita se activa un instante después)
 * y repite como máximo cada 6 horas, siempre que la copia siga guardada.
 */
async function warmPosPage(): Promise<void> {
  if (!("serviceWorker" in navigator) || !("caches" in window)) return;
  try {
    const cache = await caches.open(PAGES_CACHE);
    const cached = Boolean(await cache.match("/app/pos", { ignoreVary: true }));
    const last = Number(localStorage.getItem(WARM_KEY) ?? 0);
    if (cached && Date.now() - last < WARM_EVERY_MS) return;
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller)
      await new Promise<void>((resolve) => {
        navigator.serviceWorker.addEventListener("controllerchange", () => resolve(), {
          once: true,
        });
        setTimeout(resolve, 5000);
      });
    if (!navigator.serviceWorker.controller) return;
    await fetch("/app/pos", { credentials: "same-origin", headers: { accept: "text/html" } });
    localStorage.setItem(WARM_KEY, String(Date.now()));
  } catch {
    // Sin red o sin almacenamiento: se intentará en la próxima visita.
  }
}

const SYNC_INTERVAL_MS = 30_000;
const SNAPSHOT_RETRY_MS = 15 * 60_000;

/**
 * Estado de conexión, cola de ventas pendientes y catálogo local del mostrador. Se monta una sola vez para
 * toda el área privada: sincroniza sola al volver la conexión y avisa cuántas ventas esperan.
 */
export function OfflineProvider({
  owner,
  canSell,
  children,
}: {
  owner: OutboxOwner;
  canSell: boolean;
  children: ReactNode;
}) {
  const supported = offlineSupported();
  const store = useMemo(() => (supported ? new IdbOutboxStore() : null), [supported]);
  const online = useOnline();
  const [entries, setEntries] = useState<OutboxEntry[]>([]);
  const [syncing, setSyncing] = useState(false);
  const [authRequired, setAuthRequired] = useState(false);
  const [snapshot, setSnapshot] = useState<{ data: PosSnapshot; savedAt: string } | null>(null);
  const flushing = useRef(false);
  const lastSnapshotTry = useRef(0);
  const stableOwner = useMemo(
    () => ({ tenantId: owner.tenantId, userId: owner.userId }),
    [owner.tenantId, owner.userId],
  );

  const refresh = useCallback(async () => {
    if (!store) return;
    setEntries(await entriesOf(store, stableOwner));
  }, [store, stableOwner]);

  const syncNow = useCallback(async () => {
    if (!store || flushing.current) return;
    flushing.current = true;
    setSyncing(true);
    try {
      const run = async () => {
        const result = await flushOutbox({
          store,
          owner: stableOwner,
          send: (entry) => sendOutboxEntry(entry),
        });
        setAuthRequired(result.authRequired);
        await pruneSynced(store, stableOwner);
      };
      // Una sola pestaña envía a la vez (Web Locks); sin esa API basta la bandera local.
      if ("locks" in navigator)
        await navigator.locks.request("mecania-pos-sync", { ifAvailable: true }, async (lock) => {
          if (lock) await run();
        });
      else await run();
    } finally {
      flushing.current = false;
      setSyncing(false);
      await refresh();
    }
  }, [store, stableOwner, refresh]);

  const refreshSnapshot = useCallback(async () => {
    if (!supported || !canSell) return;
    const saved = await loadSnapshot(stableOwner).catch(() => null);
    if (saved) setSnapshot({ data: saved.snapshot, savedAt: saved.savedAt });
    if (navigator.onLine) void warmPosPage();
    const needs = !saved || isSnapshotStale(saved);
    if (!needs || !navigator.onLine) return;
    if (Date.now() - lastSnapshotTry.current < SNAPSHOT_RETRY_MS && saved) return;
    lastSnapshotTry.current = Date.now();
    try {
      const response = await fetch("/api/pos/snapshot", { credentials: "same-origin" });
      if (!response.ok) return;
      const data = (await response.json()) as PosSnapshot;
      await saveSnapshot(stableOwner, data);
      setSnapshot({ data, savedAt: new Date().toISOString() });
    } catch {
      // Sin red: se queda con la copia anterior.
    }
  }, [supported, canSell, stableOwner]);

  // Arranque: estado de conexión, cola y catálogo.
  useEffect(() => {
    if (!store) return;
    void (async () => {
      // Si en este dispositivo entró otro usuario, se borran las páginas y el catálogo del anterior.
      try {
        const current = `${stableOwner.tenantId}:${stableOwner.userId}`;
        if (localStorage.getItem("mecania-owner") !== current) {
          if (localStorage.getItem("mecania-owner") !== null) {
            await clearPrivateCaches();
            await clearSnapshot().catch(() => undefined);
          }
          localStorage.setItem("mecania-owner", current);
        }
      } catch {
        // Sin localStorage (modo privado): no hay nada que comparar.
      }
      await recoverStuck(store, stableOwner).catch(() => 0);
      await refresh().catch(() => undefined);
      await refreshSnapshot();
      if (navigator.onLine) await syncNow();
    })();
  }, [store, stableOwner, refresh, refreshSnapshot, syncNow]);

  // Conexión: al volver la red se sincroniza y se actualiza el catálogo.
  useEffect(() => {
    const goOnline = () => {
      void syncNow();
      void refreshSnapshot();
    };
    const visible = () => {
      if (document.visibilityState === "visible" && navigator.onLine) void syncNow();
    };
    window.addEventListener("online", goOnline);
    document.addEventListener("visibilitychange", visible);
    return () => {
      window.removeEventListener("online", goOnline);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [syncNow, refreshSnapshot]);

  const counts = useMemo(() => countEntries(entries), [entries]);
  const hasWork = counts.pending + counts.syncing > 0;

  // Mientras haya ventas pendientes se reintenta cada 30 s (cubre «hay red pero no internet»).
  useEffect(() => {
    if (!hasWork) return;
    const timer = setInterval(() => {
      if (navigator.onLine) void syncNow();
    }, SYNC_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [hasWork, syncNow]);

  const catalog = useMemo(() => {
    if (!snapshot) return null;
    return new LocalCatalog(withPendingStock(snapshot.data.products, entries));
  }, [snapshot, entries]);

  const enqueue = useCallback<OfflineContextValue["enqueue"]>(
    async (sale, summary) => {
      if (!store) throw new Error("Este navegador no puede guardar ventas sin conexión");
      const entry = await enqueueSale(store, { owner: stableOwner, sale, summary });
      await refresh();
      if (navigator.onLine) void syncNow();
      return entry;
    },
    [store, stableOwner, refresh, syncNow],
  );

  const retry = useCallback(
    async (id: string) => {
      if (!store) return;
      await retryFailed(store, id);
      await refresh();
      void syncNow();
    },
    [store, refresh, syncNow],
  );

  const discard = useCallback(
    async (id: string) => {
      if (!store) return;
      await discardFailed(store, id);
      await refresh();
    },
    [store, refresh],
  );

  const searchLocal = useCallback(
    (query: string, limit = 8) => catalog?.search(query, limit) ?? [],
    [catalog],
  );

  const value = useMemo<OfflineContextValue>(
    () => ({
      online,
      supported,
      entries,
      counts,
      syncing,
      authRequired,
      catalog,
      tax: snapshot?.data.tax ?? null,
      snapshotAt: snapshot?.savedAt ?? null,
      searchLocal,
      enqueue,
      syncNow,
      retry,
      discard,
    }),
    [
      online,
      supported,
      entries,
      counts,
      syncing,
      authRequired,
      catalog,
      snapshot,
      searchLocal,
      enqueue,
      syncNow,
      retry,
      discard,
    ],
  );

  return <OfflineContext.Provider value={value}>{children}</OfflineContext.Provider>;
}
