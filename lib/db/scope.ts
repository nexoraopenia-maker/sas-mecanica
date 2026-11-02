import { CrossTenantError, HardDeleteForbiddenError } from "@/lib/errors";
import { getModelMeta } from "./models.ts";

type Obj = Record<string, unknown>;

export interface ScopeInput {
  tenantId: string;
  includeDeleted: boolean;
}

const READ_FILTERED = new Set([
  "findFirst",
  "findFirstOrThrow",
  "findMany",
  "count",
  "aggregate",
  "groupBy",
]);
const READ_UNIQUE = new Set(["findUnique", "findUniqueOrThrow"]);
const UPDATE_MANY = new Set(["updateMany", "updateManyAndReturn"]);
const CREATE_MANY = new Set(["createMany", "createManyAndReturn"]);

function isObj(value: unknown): value is Obj {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asObj(value: unknown): Obj {
  return isObj(value) ? value : {};
}

/** Filtro acotado: `AND` conserva el filtro del llamador y le suma el scope (no se puede "escapar" con OR). */
function scopeFilter(
  where: unknown,
  scopeField: string,
  input: ScopeInput,
  softDelete: boolean,
): Obj {
  const clauses: Obj[] = [];
  if (isObj(where)) clauses.push(where);
  clauses.push({ [scopeField]: input.tenantId });
  if (softDelete && !input.includeDeleted) clauses.push({ deletedAt: null });
  return { AND: clauses };
}

/** `where` único: se agregan claves (Prisma permite filtros extra en WhereUniqueInput). */
function scopeUnique(
  where: unknown,
  scopeField: string,
  input: ScopeInput,
  softDelete: boolean,
): Obj {
  const base = { ...asObj(where) };
  const given = base[scopeField];
  if (given !== undefined && given !== input.tenantId) {
    throw new CrossTenantError(`${scopeField} distinto al del contexto en el filtro`);
  }
  base[scopeField] = input.tenantId;
  if (softDelete && !input.includeDeleted && base.deletedAt === undefined) base.deletedAt = null;
  return base;
}

function scopeCreateData(data: unknown, input: ScopeInput): Obj {
  const row = { ...asObj(data) };
  if ("tenant" in row) {
    throw new CrossTenantError("No se puede asignar la relación `tenant`: lo fija el contexto");
  }
  if (row.tenantId !== undefined && row.tenantId !== input.tenantId) {
    throw new CrossTenantError("tenantId distinto al del contexto en los datos a crear");
  }
  row.tenantId = input.tenantId;
  return row;
}

function assertUpdateData(data: unknown, input: ScopeInput): Obj {
  const row = { ...asObj(data) };
  if ("tenant" in row) throw new CrossTenantError("No se puede reasignar la relación `tenant`");
  if (row.tenantId !== undefined) {
    const value = row.tenantId;
    const same = value === input.tenantId || (isObj(value) && value.set === input.tenantId);
    if (!same) throw new CrossTenantError("No se puede mover un registro a otro tenant");
  }
  return row;
}

/**
 * Reescribe los argumentos de una operación de Prisma para acotarla al tenant
 * (y excluir borrados lógicos). Función pura: no toca la BD, es testeable sola.
 * Falla cerrado ante operaciones desconocidas.
 */
export function scopeOperation(
  model: string,
  operation: string,
  args: unknown,
  input: ScopeInput,
): Obj {
  const meta = getModelMeta(model);
  const out = { ...asObj(args) };
  const { scopeField, softDelete } = meta;

  if (scopeField === null) {
    if (READ_FILTERED.has(operation) || READ_UNIQUE.has(operation)) return out;
    throw new CrossTenantError(`${model} es un catálogo global de solo lectura`);
  }

  // `Tenant` (scope por id): lectura y edición de datos de contacto de la propia empresa.
  if (scopeField === "id") {
    if (READ_FILTERED.has(operation))
      return { ...out, where: scopeFilter(out.where, "id", input, softDelete) };
    if (READ_UNIQUE.has(operation) || operation === "update") {
      const next: Obj = { ...out, where: scopeUnique(out.where, "id", input, softDelete) };
      if (operation === "update") next.data = assertUpdateData(out.data, input);
      return next;
    }
    throw new CrossTenantError(
      `Operación ${operation} no permitida sobre ${model} desde el contexto de tenant`,
    );
  }

  if (READ_FILTERED.has(operation)) {
    return { ...out, where: scopeFilter(out.where, scopeField, input, softDelete) };
  }
  if (READ_UNIQUE.has(operation)) {
    return { ...out, where: scopeUnique(out.where, scopeField, input, softDelete) };
  }
  if (operation === "create") {
    return { ...out, data: scopeCreateData(out.data, input) };
  }
  if (CREATE_MANY.has(operation)) {
    const rows = Array.isArray(out.data) ? out.data : [out.data];
    return { ...out, data: rows.map((row) => scopeCreateData(row, input)) };
  }
  if (operation === "update") {
    return {
      ...out,
      where: scopeUnique(out.where, scopeField, input, softDelete),
      data: assertUpdateData(out.data, input),
    };
  }
  if (UPDATE_MANY.has(operation)) {
    return {
      ...out,
      where: scopeFilter(out.where, scopeField, input, softDelete),
      data: assertUpdateData(out.data, input),
    };
  }
  if (operation === "upsert") {
    return {
      ...out,
      where: scopeUnique(out.where, scopeField, input, softDelete),
      create: scopeCreateData(out.create, input),
      update: assertUpdateData(out.update, input),
    };
  }
  if (operation === "delete" || operation === "deleteMany") {
    if (softDelete) throw new HardDeleteForbiddenError(model);
    return operation === "delete"
      ? { ...out, where: scopeUnique(out.where, scopeField, input, false) }
      : { ...out, where: scopeFilter(out.where, scopeField, input, false) };
  }

  throw new CrossTenantError(
    `Operación no soportada en el contexto de tenant: ${model}.${operation}`,
  );
}

/** Datos para borrar lógicamente: `tx.product.update({ where, data: softDeleteData() })`. */
export function softDeleteData(): { deletedAt: Date } {
  return { deletedAt: new Date() };
}
