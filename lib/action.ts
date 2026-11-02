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

/** Ejecuta la lógica de una acción convirtiendo errores de dominio/validación en estado de formulario. */
export async function runAction(fn: () => Promise<ActionState | void>): Promise<ActionState> {
  let state: ActionState;
  try {
    state = (await fn()) ?? {};
  } catch (error) {
    if (isRedirectError(error)) throw error;
    if (error instanceof ZodError) {
      state = { error: error.issues[0]?.message ?? "Datos inválidos" };
    } else {
      const mapped = toDomainError(error);
      if (mapped instanceof RateLimitError) {
        state = { error: `${mapped.message} (reintenta en ${mapped.retryAfterSeconds} s)` };
      } else if (mapped instanceof DomainError) {
        state = { error: mapped.message };
      } else {
        logger.error({ err: error }, "error inesperado en Server Action");
        state = { error: "Ocurrió un error inesperado. Inténtalo de nuevo." };
      }
    }
  }
  // redirect() lanza NEXT_REDIRECT: debe llamarse fuera del try/catch.
  if (state.redirectTo) redirect(state.redirectTo);
  return state;
}

export function field(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === "string" ? value : "";
}
