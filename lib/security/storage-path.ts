import { uuidSchema } from "@/lib/validation/common";

const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Ruta de Supabase Storage siempre prefijada por tenant: `{tenantId}/a/b/c`.
 * Rechaza segmentos con `..`, `/` o caracteres raros (path traversal).
 */
export function buildStoragePath(tenantId: string, ...segments: string[]): string {
  const tenant = uuidSchema.parse(tenantId);
  if (segments.length === 0) throw new Error("La ruta de Storage necesita al menos un segmento");
  for (const segment of segments) {
    if (!SEGMENT.test(segment) || segment === "." || segment === "..") {
      throw new Error(`Segmento de ruta de Storage no válido: ${segment}`);
    }
  }
  return [tenant, ...segments].join("/");
}

export function assertStoragePathBelongsToTenant(path: string, tenantId: string): void {
  const tenant = uuidSchema.parse(tenantId);
  const [first, ...rest] = path.split("/");
  const clean = rest.length > 0 && rest.every((s) => SEGMENT.test(s) && s !== "..");
  if (first !== tenant || !clean) {
    throw new Error("La ruta de Storage no pertenece al tenant");
  }
}
