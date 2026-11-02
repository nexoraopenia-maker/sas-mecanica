import { Prisma } from "./generated/client.ts";

export interface ModelMeta {
  /** Columna que acota el modelo al tenant. `null` = catálogo global (solo lectura). */
  scopeField: "tenantId" | "id" | null;
  softDelete: boolean;
}

type FieldEnum = Record<string, string>;

function fieldsOf(model: string): string[] {
  const holder: Record<string, unknown> = Prisma;
  const fieldEnum = holder[`${model}ScalarFieldEnum`] as FieldEnum | undefined;
  return fieldEnum ? Object.values(fieldEnum) : [];
}

/** Metadatos derivados del schema: si se agrega un modelo con `tenantId`/`deletedAt`, queda cubierto sin tocar código. */
function buildRegistry(): ReadonlyMap<string, ModelMeta> {
  const registry = new Map<string, ModelMeta>();
  for (const model of Object.values(Prisma.ModelName)) {
    const fields = fieldsOf(model);
    const scopeField = fields.includes("tenantId") ? "tenantId" : model === "Tenant" ? "id" : null;
    registry.set(model, { scopeField, softDelete: fields.includes("deletedAt") });
  }
  return registry;
}

const registry = buildRegistry();

export function getModelMeta(model: string): ModelMeta {
  const meta = registry.get(model);
  if (!meta) throw new Error(`Modelo desconocido: ${model}`);
  return meta;
}

export function allModelMetas(): ReadonlyMap<string, ModelMeta> {
  return registry;
}
