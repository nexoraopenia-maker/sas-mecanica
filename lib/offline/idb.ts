import type { OutboxEntry, OutboxOwner, OutboxStore } from "./outbox";
import type { PosSnapshot } from "@/lib/pos/types";
import type { StoredSnapshot } from "./snapshot";

/** IndexedDB del mostrador: cola de ventas pendientes y copia del catálogo. Solo se usa en el navegador. */
const DB_NAME = "mecania-pos";
const DB_VERSION = 1;
const OUTBOX = "outbox";
const SNAPSHOT = "snapshot";
const SNAPSHOT_KEY = "catalog";

export function offlineSupported(): boolean {
  return typeof indexedDB !== "undefined";
}

let opened: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  if (!offlineSupported())
    return Promise.reject(new Error("Este navegador no admite almacenamiento local"));
  opened ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(OUTBOX)) db.createObjectStore(OUTBOX, { keyPath: "id" });
      if (!db.objectStoreNames.contains(SNAPSHOT)) db.createObjectStore(SNAPSHOT);
    };
    request.onsuccess = () => {
      const db = request.result;
      // Si otra pestaña pide actualizar la base, se cierra para no bloquearla.
      db.onversionchange = () => {
        db.close();
        opened = null;
      };
      resolve(db);
    };
    request.onerror = () => {
      opened = null;
      reject(request.error ?? new Error("No se pudo abrir el almacenamiento local"));
    };
  });
  return opened;
}

function run<T>(
  storeName: string,
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return open().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const tx = db.transaction(storeName, mode);
        const request = fn(tx.objectStore(storeName));
        tx.oncomplete = () => resolve(request.result);
        tx.onerror = () => reject(tx.error ?? request.error);
        tx.onabort = () => reject(tx.error ?? new Error("Operación cancelada"));
      }),
  );
}

export class IdbOutboxStore implements OutboxStore {
  put(entry: OutboxEntry): Promise<void> {
    return run(OUTBOX, "readwrite", (store) => store.put(entry)).then(() => undefined);
  }
  get(id: string): Promise<OutboxEntry | undefined> {
    return run<OutboxEntry | undefined>(OUTBOX, "readonly", (store) => store.get(id));
  }
  all(): Promise<OutboxEntry[]> {
    return run<OutboxEntry[]>(OUTBOX, "readonly", (store) => store.getAll());
  }
  remove(id: string): Promise<void> {
    return run(OUTBOX, "readwrite", (store) => store.delete(id)).then(() => undefined);
  }
}

export async function saveSnapshot(owner: OutboxOwner, snapshot: PosSnapshot): Promise<void> {
  const record: StoredSnapshot = { ...owner, snapshot, savedAt: new Date().toISOString() };
  await run(SNAPSHOT, "readwrite", (store) => store.put(record, SNAPSHOT_KEY));
}

/** Catálogo guardado de ESTE usuario; el de otro usuario o negocio del mismo dispositivo se ignora. */
export async function loadSnapshot(owner: OutboxOwner): Promise<StoredSnapshot | null> {
  const record = await run<StoredSnapshot | undefined>(SNAPSHOT, "readonly", (store) =>
    store.get(SNAPSHOT_KEY),
  );
  if (!record || record.tenantId !== owner.tenantId || record.userId !== owner.userId) return null;
  return record;
}

/** Borra la copia del catálogo (al cerrar sesión). La cola de ventas pendientes NO se borra: son ventas reales. */
export async function clearSnapshot(): Promise<void> {
  await run(SNAPSHOT, "readwrite", (store) => store.clear());
}
