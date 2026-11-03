import { NextResponse } from "next/server";
import { ZodError } from "zod";
import type { AuthUser } from "@/lib/auth/can";
import {
  DomainError,
  NotFoundError,
  PermissionDeniedError,
  RateLimitError,
  toDomainError,
} from "@/lib/errors";
import { logger } from "@/lib/logger";
import { getCurrentUser } from "@/server/services/session";

/** Código HTTP por tipo de error: el cliente sin conexión distingue «reintentar» de «revisar la venta». */
export function statusOf(error: unknown): number {
  if (error instanceof ZodError) return 400;
  if (error instanceof PermissionDeniedError) return 403;
  if (error instanceof NotFoundError) return 404;
  if (error instanceof RateLimitError) return 429;
  if (error instanceof DomainError) return error.code === "TENANT_INACTIVE" ? 403 : 409;
  return 500;
}

/**
 * Envoltorio de las rutas del mostrador: exige sesión de negocio (cookie), nunca cachea y devuelve
 * errores como JSON sin filtrar detalles internos. Cada servicio vuelve a validar permisos y tenant.
 */
export async function posApi(
  handler: (user: AuthUser & { tenantId: string }) => Promise<unknown>,
): Promise<NextResponse> {
  const headers = { "cache-control": "no-store" };
  const user = await getCurrentUser();
  if (!user || !user.tenantId)
    return NextResponse.json(
      { error: "Sesión no válida", code: "UNAUTHORIZED" },
      { status: 401, headers },
    );
  try {
    return NextResponse.json(await handler({ ...user, tenantId: user.tenantId }), { headers });
  } catch (raw) {
    const error = toDomainError(raw);
    const status = statusOf(error);
    if (status === 500) {
      logger.error({ err: raw }, "error inesperado en una ruta del mostrador");
      return NextResponse.json(
        { error: "Ocurrió un error inesperado", code: "INTERNAL" },
        { status, headers },
      );
    }
    const message =
      error instanceof ZodError
        ? (error.issues[0]?.message ?? "Datos inválidos")
        : (error as Error).message;
    const code = error instanceof DomainError ? error.code : "INVALID";
    return NextResponse.json({ error: message, code }, { status, headers });
  }
}
