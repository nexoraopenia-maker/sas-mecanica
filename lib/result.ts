import { ZodError } from "zod";
import { DomainError, toDomainError } from "@/lib/errors";

/** Resultado tipado de Server Actions: nunca se lanzan errores crudos al cliente. */
export type Result<T> =
  { ok: true; data: T } | { ok: false; error: { code: string; message: string } };

export function ok<T>(data: T): Result<T> {
  return { ok: true, data };
}

export function fail(code: string, message: string): Result<never> {
  return { ok: false, error: { code, message } };
}

/** Ejecuta `fn` y convierte errores de dominio en `{ ok: false }`. Errores desconocidos se relanzan. */
export async function toResult<T>(fn: () => Promise<T>): Promise<Result<T>> {
  try {
    return ok(await fn());
  } catch (error) {
    if (error instanceof ZodError)
      return fail("VALIDATION", error.issues[0]?.message ?? "Datos inválidos");
    const mapped = toDomainError(error);
    if (mapped instanceof DomainError) return fail(mapped.code, mapped.message);
    throw mapped;
  }
}
