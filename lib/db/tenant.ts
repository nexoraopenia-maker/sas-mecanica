import { CrossTenantError, TenantContextError, toDomainError } from "@/lib/errors";
import { uuidSchema } from "@/lib/validation/common";
import { tenantStorage, type TenantContext } from "./context.ts";
import { getAppClient } from "./raw.ts";
import { scopeOperation } from "./scope.ts";

function buildScopedClient() {
  return getAppClient().$extends({
    name: "tenant-scope",
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          const ctx = tenantStorage.getStore();
          if (!ctx) throw new TenantContextError();
          return query(scopeOperation(model, operation, args, ctx) as typeof args);
        },
      },
    },
  });
}

type ScopedClient = ReturnType<typeof buildScopedClient>;

/** Cliente transaccional con scope de tenant. Solo se obtiene dentro de `withTenant`. */
export type TenantTx = Omit<
  ScopedClient,
  "$connect" | "$disconnect" | "$on" | "$transaction" | "$extends"
>;

let scoped: ScopedClient | undefined;

function getScopedClient(): ScopedClient {
  scoped ??= buildScopedClient();
  return scoped;
}

export interface TenantOptions {
  includeDeleted?: boolean;
  /** Tiempo máximo de la transacción (ms). Por defecto 15 000. */
  timeoutMs?: number;
  /** Espera máxima por una conexión del pool (ms). Por defecto 10 000. */
  maxWaitMs?: number;
}

/**
 * Punto de entrada ÚNICO para consultar datos de negocio.
 *
 *  - Capa 1: toda operación de modelo inyecta `tenantId` / borrado lógico.
 *  - Capa 2: `set_config('app.tenant_id', id, true)` se ejecuta en la MISMA
 *    transacción que las queries, así RLS funciona con el pooler de Supabase en
 *    modo transacción (el valor desaparece al terminar la transacción).
 *
 * Llamadas anidadas con el mismo tenant reutilizan la transacción; con otro
 * tenant lanzan `CrossTenantError`.
 */
export async function withTenant<T>(
  tenantId: string,
  fn: (tx: TenantTx) => Promise<T>,
  options: TenantOptions = {},
): Promise<T> {
  const parsed = uuidSchema.safeParse(tenantId);
  if (!parsed.success) throw new TenantContextError("tenantId inválido");
  const id = parsed.data;

  const existing = tenantStorage.getStore() as TenantContext<TenantTx> | undefined;
  if (existing) {
    if (existing.tenantId !== id) throw new CrossTenantError("withTenant anidado con otro tenant");
    return await fn(existing.tx);
  }

  try {
    return await getScopedClient().$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.tenant_id', ${id}, true)`;
        const context: TenantContext<TenantTx> = {
          tenantId: id,
          includeDeleted: options.includeDeleted ?? false,
          tx,
        };
        // `await` dentro de run(): las promesas de Prisma son perezosas y deben
        // ejecutarse mientras el contexto de tenant sigue activo.
        return await tenantStorage.run(context as TenantContext<never>, async () => await fn(tx));
      },
      { timeout: options.timeoutMs ?? 15_000, maxWait: options.maxWaitMs ?? 10_000 },
    );
  } catch (error) {
    throw toDomainError(error);
  }
}
