import { createHmac, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { z } from "zod";
import { getEnv } from "@/lib/env";

/** Buckets privados (ver supabase/storage-policies.sql). */
export const BUCKETS = { photos: "work-order-photos", receipts: "receipts" } as const;

export interface StorageAdapter {
  put(bucket: string, path: string, bytes: Uint8Array, contentType: string): Promise<void>;
  /** URL temporal de lectura. */
  signedUrl(bucket: string, path: string, ttlSeconds: number): Promise<string>;
  /** Borra todo lo que cuelga de un prefijo (purga de tenants). Devuelve cuántos objetos eliminó. */
  deletePrefix(bucket: string, prefix: string): Promise<number>;
}

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

const encodePath = (path: string): string => path.split("/").map(encodeURIComponent).join("/");

const listSchema = z.array(z.object({ name: z.string(), id: z.string().nullable().optional() }));
const signSchema = z.object({ signedURL: z.string().optional(), signedUrl: z.string().optional() });

/** Supabase Storage por REST con la clave service_role (solo servidor). Sin SDK. */
export class SupabaseStorage implements StorageAdapter {
  constructor(
    private readonly baseUrl: string,
    private readonly serviceKey: string,
    private readonly fetchImpl: FetchLike = (input, init) => fetch(input, init),
  ) {}

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return { authorization: `Bearer ${this.serviceKey}`, apikey: this.serviceKey, ...extra };
  }

  async put(bucket: string, path: string, bytes: Uint8Array, contentType: string): Promise<void> {
    const response = await this.fetchImpl(
      `${this.baseUrl}/storage/v1/object/${bucket}/${encodePath(path)}`,
      {
        method: "POST",
        headers: this.headers({ "content-type": contentType, "x-upsert": "false" }),
        body: bytes as unknown as BodyInit,
        signal: AbortSignal.timeout(30_000),
      },
    );
    if (!response.ok)
      throw new Error(`No se pudo guardar el archivo (Storage respondió ${response.status})`);
  }

  async signedUrl(bucket: string, path: string, ttlSeconds: number): Promise<string> {
    const response = await this.fetchImpl(
      `${this.baseUrl}/storage/v1/object/sign/${bucket}/${encodePath(path)}`,
      {
        method: "POST",
        headers: this.headers({ "content-type": "application/json" }),
        body: JSON.stringify({ expiresIn: ttlSeconds }),
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (!response.ok)
      throw new Error(`No se pudo firmar la URL (Storage respondió ${response.status})`);
    const parsed = signSchema.safeParse(await response.json());
    const relative = parsed.success ? (parsed.data.signedURL ?? parsed.data.signedUrl) : undefined;
    if (!relative) throw new Error("Respuesta de firma de Storage inesperada");
    return `${this.baseUrl}/storage/v1${relative.startsWith("/") ? "" : "/"}${relative}`;
  }

  private async listAll(bucket: string, prefix: string): Promise<string[]> {
    const response = await this.fetchImpl(`${this.baseUrl}/storage/v1/object/list/${bucket}`, {
      method: "POST",
      headers: this.headers({ "content-type": "application/json" }),
      body: JSON.stringify({ prefix, limit: 1000, offset: 0 }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`No se pudo listar Storage (${response.status})`);
    const entries = listSchema.parse(await response.json());
    const files: string[] = [];
    for (const entry of entries) {
      const full = `${prefix.replace(/\/$/, "")}/${entry.name}`;
      // Las carpetas vienen sin `id`: se recorren recursivamente.
      if (entry.id) files.push(full);
      else files.push(...(await this.listAll(bucket, full)));
    }
    return files;
  }

  async deletePrefix(bucket: string, prefix: string): Promise<number> {
    const files = await this.listAll(bucket, prefix);
    for (let index = 0; index < files.length; index += 100) {
      const response = await this.fetchImpl(`${this.baseUrl}/storage/v1/object/${bucket}`, {
        method: "DELETE",
        headers: this.headers({ "content-type": "application/json" }),
        body: JSON.stringify({ prefixes: files.slice(index, index + 100) }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok)
        throw new Error(`No se pudieron borrar archivos de Storage (${response.status})`);
    }
    return files.length;
  }
}

const LOCAL_ROOT = join(process.cwd(), ".local-storage");

function localSignature(bucket: string, path: string, expires: number): string {
  return createHmac("sha256", getEnv().SESSION_SECRET)
    .update(`${bucket}|${path}|${expires}`)
    .digest("hex");
}

/** Verifica una URL firmada del disco local (la usa la ruta de desarrollo). */
export function verifyLocalSignature(
  bucket: string,
  path: string,
  expires: number,
  signature: string,
): boolean {
  if (!Number.isFinite(expires) || expires < Date.now() / 1000) return false;
  const expected = Buffer.from(localSignature(bucket, path, expires));
  const received = Buffer.from(signature);
  return expected.length === received.length && timingSafeEqual(expected, received);
}

/** Ruta absoluta dentro de la carpeta local; null si intenta salirse (path traversal). */
export function resolveLocalPath(bucket: string, path: string): string | null {
  const root = resolve(LOCAL_ROOT);
  const full = resolve(root, bucket, path);
  return full.startsWith(root + sep) ? full : null;
}

export async function readLocalFile(bucket: string, path: string): Promise<Buffer | null> {
  const full = resolveLocalPath(bucket, path);
  if (!full) return null;
  try {
    return await readFile(full);
  } catch {
    return null;
  }
}

/** Disco local: desarrollo, CI y pruebas E2E. NO es persistente en Vercel; producción usa Supabase. */
export class LocalDiskStorage implements StorageAdapter {
  async put(bucket: string, path: string, bytes: Uint8Array): Promise<void> {
    const full = resolveLocalPath(bucket, path);
    if (!full) throw new Error("Ruta de archivo no permitida");
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, bytes, { flag: "wx" });
  }

  async signedUrl(bucket: string, path: string, ttlSeconds: number): Promise<string> {
    const expires = Math.floor(Date.now() / 1000) + ttlSeconds;
    return `/api/dev-files/${bucket}/${encodePath(path)}?e=${expires}&s=${localSignature(bucket, path, expires)}`;
  }

  async deletePrefix(bucket: string, prefix: string): Promise<number> {
    const full = resolveLocalPath(bucket, prefix);
    if (!full) return 0;
    await rm(full, { recursive: true, force: true });
    return 1;
  }
}

/** En memoria, para pruebas. */
export class MemoryStorage implements StorageAdapter {
  readonly objects = new Map<string, { bytes: Uint8Array; contentType: string }>();

  async put(bucket: string, path: string, bytes: Uint8Array, contentType: string): Promise<void> {
    const key = `${bucket}/${path}`;
    if (this.objects.has(key)) throw new Error("El archivo ya existe");
    this.objects.set(key, { bytes, contentType });
  }

  async signedUrl(bucket: string, path: string, ttlSeconds: number): Promise<string> {
    return `memory://${bucket}/${path}?ttl=${ttlSeconds}`;
  }

  async deletePrefix(bucket: string, prefix: string): Promise<number> {
    let removed = 0;
    for (const key of [...this.objects.keys()]) {
      if (key.startsWith(`${bucket}/${prefix}`)) {
        this.objects.delete(key);
        removed += 1;
      }
    }
    return removed;
  }
}

let override: StorageAdapter | null = null;
let cached: StorageAdapter | undefined;

export function getStorage(): StorageAdapter {
  if (override) return override;
  const env = getEnv();
  const driver = env.STORAGE_DRIVER ?? (env.NODE_ENV === "production" ? "supabase" : "local");
  cached ??=
    driver === "supabase" && env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY
      ? new SupabaseStorage(env.SUPABASE_URL.replace(/\/$/, ""), env.SUPABASE_SERVICE_ROLE_KEY)
      : new LocalDiskStorage();
  return cached;
}

export function isLocalStorageDriver(): boolean {
  const env = getEnv();
  return (env.STORAGE_DRIVER ?? (env.NODE_ENV === "production" ? "supabase" : "local")) === "local";
}

/** Para pruebas: inyecta un almacenamiento falso. */
export function setStorageForTests(storage: StorageAdapter | null): void {
  override = storage;
}
