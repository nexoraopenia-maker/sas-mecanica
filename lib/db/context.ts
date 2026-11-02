import { AsyncLocalStorage } from "node:async_hooks";

export interface TenantContext<Tx> {
  tenantId: string;
  /** Si es true, los `find*` no excluyen filas con borrado lógico (restauraciones, auditoría). */
  includeDeleted: boolean;
  tx: Tx;
}

/** Contexto del tenant de la transacción en curso. Solo `withTenant` lo establece. */
export const tenantStorage = new AsyncLocalStorage<TenantContext<never>>();
