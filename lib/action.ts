import { redirect } from "next/navigation";
import { isRedirectError } from "next/dist/client/components/redirect-error";
import { ZodError } from "zod";
import { DomainError, RateLimitError, toDomainError } from "@/lib/errors";
import { logger } from "@/lib/logger";

/** Resultado de una Server Action para formularios: nunca se exponen errores crudos al cliente. */
export interface ActionState {
  error?: string;
  message?: string;
  redirectTo?: string;
}

export type FormAction = (previous: ActionState, formData: FormData) => Promise<ActionState>;

/** Mensaje seguro para mostrar al usuario (nunca el error crudo). Relanza las redirecciones de Next. */
export function actionErrorMessage(error: unknown): string {
  if (isRedirectError(error)) throw error;
  if (error instanceof ZodError) return error.issues[0]?.message ?? "Datos inválidos";
  const mapped = toDomainError(error);
  if (mapped instanceof RateLimitError)
    return `${mapped.message} (reintenta en ${mapped.retryAfterSeconds} s)`;
  if (mapped instanceof DomainError) return mapped.message;
  logger.error({ err: error }, "error inesperado en Server Action");
  return "Ocurrió un error inesperado. Inténtalo de nuevo.";
}

/** Ejecuta la lógica de una acción convirtiendo errores de dominio/validación en estado de formulario. */
export async function runAction(fn: () => Promise<ActionState | void>): Promise<ActionState> {
  let state: ActionState;
  try {
    state = (await fn()) ?? {};
  } catch (error) {
    state = { error: actionErrorMessage(error) };
  }
  // redirect() lanza NEXT_REDIRECT: debe llamarse fuera del try/catch.
  if (state.redirectTo) redirect(state.redirectTo);
  return state;
}

export function field(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === "string" ? value : "";
}
