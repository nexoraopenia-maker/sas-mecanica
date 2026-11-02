/** Errores de dominio. Los servicios los lanzan; las Server Actions los convierten a Result. */
export class DomainError extends Error {
  readonly code: string;
  readonly details: Record<string, unknown> | undefined;

  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.details = details;
  }
}

export class InsufficientStockError extends DomainError {
  constructor(
    message = "Stock insuficiente para completar la operación",
    details?: Record<string, unknown>,
  ) {
    super("INSUFFICIENT_STOCK", message, details);
  }
}

export class PermissionDeniedError extends DomainError {
  constructor(permission: string) {
    super("PERMISSION_DENIED", `No tienes permiso para esta acción (${permission})`, {
      permission,
    });
  }
}

export class PlanLimitError extends DomainError {
  constructor(limit: string, max: number) {
    super("PLAN_LIMIT", `Tu plan permite un máximo de ${max} (${limit})`, { limit, max });
  }
}

/** Se intentó consultar la BD sin `withTenant()`. */
export class TenantContextError extends DomainError {
  constructor(
    message = "Operación de base de datos fuera de un contexto de tenant (usa withTenant)",
  ) {
    super("TENANT_CONTEXT_MISSING", message);
  }
}

/** Se intentó leer o escribir datos de otro tenant. */
export class CrossTenantError extends DomainError {
  constructor(message = "Acceso a datos de otro tenant bloqueado") {
    super("CROSS_TENANT", message);
  }
}

/** DELETE físico sobre una entidad con borrado lógico. */
export class HardDeleteForbiddenError extends DomainError {
  constructor(model: string) {
    super(
      "HARD_DELETE_FORBIDDEN",
      `${model} usa borrado lógico: actualiza con softDeleteData() en lugar de delete`,
      { model },
    );
  }
}

export class ModuleDisabledError extends DomainError {
  constructor(module: string) {
    super("MODULE_DISABLED", `El módulo ${module} no está incluido en tu plan`, { module });
  }
}

export class InvalidCredentialsError extends DomainError {
  constructor() {
    super("INVALID_CREDENTIALS", "Correo o contraseña incorrectos");
  }
}

export class AccountLockedError extends DomainError {
  constructor(until: Date) {
    super("ACCOUNT_LOCKED", "Cuenta bloqueada temporalmente por intentos fallidos", {
      until: until.toISOString(),
    });
  }
}

/** Tenant suspendido, cancelado, eliminado o demo vencida. */
export class TenantInactiveError extends DomainError {
  constructor(reason: "SUSPENDED" | "CANCELLED" | "EXPIRED") {
    const message =
      reason === "SUSPENDED"
        ? "La cuenta de tu empresa está suspendida. Contacta a soporte."
        : reason === "EXPIRED"
          ? "La sesión demo expiró. Inicia una nueva."
          : "La cuenta de tu empresa ya no está activa.";
    super("TENANT_INACTIVE", message, { reason });
  }
}

export class RateLimitError extends DomainError {
  constructor(readonly retryAfterSeconds: number) {
    super("RATE_LIMITED", "Demasiados intentos. Espera un momento e inténtalo de nuevo.", {
      retryAfterSeconds,
    });
  }
}

export class NotFoundError extends DomainError {
  constructor(entity: string) {
    super("NOT_FOUND", `${entity} no encontrado`, { entity });
  }
}

export class ConflictError extends DomainError {
  constructor(code: string, message: string) {
    super(code, message);
  }
}

export class InvalidTokenError extends DomainError {
  constructor() {
    super("INVALID_TOKEN", "El enlace no es válido o ya expiró");
  }
}

export class MfaError extends DomainError {
  constructor(message = "Código de verificación incorrecto") {
    super("MFA_INVALID", message);
  }
}

/**
 * Traduce excepciones levantadas por los triggers de PostgreSQL a errores de
 * dominio. Devuelve el mismo error si no reconoce ninguna.
 */
export function toDomainError(error: unknown): unknown {
  if (error instanceof DomainError) return error;
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("insufficient_stock")) {
    return new InsufficientStockError(undefined, { database: message });
  }
  return error;
}
