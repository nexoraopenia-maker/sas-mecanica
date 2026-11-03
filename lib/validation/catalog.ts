import { z } from "zod";
import { CATALOG_CHIP_IDS } from "@/lib/catalog/chips";
import { parseDot, parseTireSize } from "@/lib/inventory/tire";

const text = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .refine((value) => !value.includes("\u0000"), "El texto contiene caracteres no válidos");
const money = z.coerce
  .number()
  .min(0)
  .max(100_000_000)
  .transform((value) => value.toFixed(4));
const optionalMoney = money.optional();

const sku = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9][A-Z0-9._-]{1,39}$/, "SKU inválido (2–40 caracteres: letras, números, . _ -)");

const base = {
  sku,
  barcode: text(40).optional(),
  name: text(200).min(2, "Ingresa el nombre del producto"),
  description: text(1000).optional(),
  brand: text(80).optional(),
  categoryId: z.uuid().optional(),
  unit: text(10).default("UND"),
  salePrice: money,
  lastPurchaseCost: optionalMoney,
  taxAffectation: z.enum(["TAXED", "EXEMPT", "UNAFFECTED"]).default("TAXED"),
  warrantyPolicyId: z.uuid().optional(),
  isActive: z.boolean().default(true),
};

export const compatibilitySchema = z
  .object({
    make: text(60).min(1),
    model: text(60).min(1),
    yearFrom: z.coerce.number().int().min(1950).max(2100).optional(),
    yearTo: z.coerce.number().int().min(1950).max(2100).optional(),
    engine: text(60).optional(),
  })
  .refine(
    (c) => c.yearFrom === undefined || c.yearTo === undefined || c.yearFrom <= c.yearTo,
    "El año inicial no puede superar al final",
  );

export const equivalenceSchema = z.object({
  code: text(60).min(2),
  brand: text(60).optional(),
  type: z.enum(["OEM", "ALTERNATIVE"]).default("ALTERNATIVE"),
});

/** Medida: acepta `size` ("205/55 R16") o los tres campos por separado. */
const tireDetail = z
  .object({
    size: z.string().optional(),
    width: z.coerce.number().int().min(125).max(405).optional(),
    aspectRatio: z.coerce.number().int().min(25).max(95).optional(),
    rimDiameter: z.coerce.number().min(10).max(30).optional(),
    loadIndex: z.coerce.number().int().min(50).max(140).optional(),
    speedRating: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z]{1,2}\d?$/, "Índice de velocidad inválido")
      .optional(),
    design: text(80).optional(),
    season: text(30).optional(),
    runFlat: z.boolean().default(false),
    rackLocation: text(40).optional(),
  })
  .transform((value, ctx) => {
    const fromText = value.size ? parseTireSize(value.size) : null;
    if (value.size && !fromText)
      ctx.addIssue({
        code: "custom",
        message: "Medida de llanta inválida (ej.: 205/55 R16)",
        path: ["size"],
      });
    const width = fromText?.width ?? value.width;
    const aspectRatio = fromText?.aspectRatio ?? value.aspectRatio;
    const rimDiameter = fromText?.rimDiameter ?? value.rimDiameter;
    if (width === undefined || aspectRatio === undefined || rimDiameter === undefined) {
      ctx.addIssue({
        code: "custom",
        message: "Indica ancho, perfil y aro de la llanta",
        path: ["size"],
      });
      return z.NEVER;
    }
    const { size: _size, ...rest } = value;
    return { ...rest, width, aspectRatio, rimDiameter };
  });

const batteryDetail = z.object({
  voltage: z.coerce.number().int().min(6).max(48).default(12),
  capacityAh: z.coerce.number().int().min(1).max(500),
  ccaA: z.coerce.number().int().min(1).max(3000),
  polarity: z.enum(["LEFT_POSITIVE", "RIGHT_POSITIVE"]),
  terminalType: text(40).optional(),
  technology: text(40).optional(),
});

const lubricantDetail = z.object({
  viscosity: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^(\d{1,2}W-?\d{2}|ATF|CVT|SAE \d{2,3}|\d{2,3}W?)$/, "Viscosidad inválida (ej.: 5W-30)"),
  baseType: z.enum(["MINERAL", "SEMI_SYNTHETIC", "SYNTHETIC"]).optional(),
  apiSpec: text(20).optional(),
  aceaSpec: text(20).optional(),
  volumeLiters: z.coerce.number().positive().max(1000).optional(),
});

const partDetail = z.object({
  oemCode: text(60).optional(),
  partNumber: text(60).optional(),
  isOem: z.boolean().default(false),
  partCategory: text(60).optional(),
  position: text(40).optional(),
});

const extras = {
  equivalences: z.array(equivalenceSchema).max(50).default([]),
  compatibilities: z.array(compatibilitySchema).max(200).default([]),
};

/** Un producto se valida según su tipo: cada uno exige sus propios datos técnicos. */
export const createProductSchema = z.discriminatedUnion("kind", [
  z.object({ ...base, ...extras, kind: z.literal("TIRE"), tire: tireDetail }),
  z.object({ ...base, ...extras, kind: z.literal("BATTERY"), battery: batteryDetail }),
  z.object({ ...base, ...extras, kind: z.literal("LUBRICANT"), lubricant: lubricantDetail }),
  z.object({ ...base, ...extras, kind: z.literal("PART"), part: partDetail }),
  z.object({ ...base, ...extras, kind: z.literal("ACCESSORY") }),
  z.object({ ...base, ...extras, kind: z.literal("SERVICE") }),
]);

export type CreateProductInput = z.input<typeof createProductSchema>;
export type CreateProductData = z.output<typeof createProductSchema>;

export const updateProductSchema = z.object({
  name: base.name.optional(),
  description: base.description,
  brand: base.brand,
  barcode: base.barcode,
  salePrice: money.optional(),
  lastPurchaseCost: optionalMoney,
  warrantyPolicyId: z.uuid().nullable().optional(),
  categoryId: z.uuid().nullable().optional(),
  isActive: z.boolean().optional(),
});
export type UpdateProductInput = z.input<typeof updateProductSchema>;

export const productSearchSchema = z.object({
  q: text(100).optional(),
  kind: z.enum(["TIRE", "BATTERY", "LUBRICANT", "PART", "ACCESSORY", "SERVICE"]).optional(),
  /** Medida de llanta en cualquier formato. */
  tireSize: text(30).optional(),
  /** Código OEM o equivalencia. */
  code: text(60).optional(),
  vehicle: z
    .object({
      make: text(60).min(1),
      model: text(60).optional(),
      year: z.coerce.number().int().min(1950).max(2100).optional(),
    })
    .optional(),
  warehouseId: z.uuid().optional(),
  includeInactive: z.boolean().default(false),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type ProductSearchInput = z.input<typeof productSearchSchema>;

export const CATALOG_PAGE_SIZE = 12;

/** Listado paginado del catálogo (pantalla /app/catalog). La paginación y los filtros se resuelven en el servidor. */
export const catalogListSchema = z
  .object({
    q: text(100).optional(),
    tireSize: text(30).optional(),
    code: text(60).optional(),
    make: text(60).optional(),
    model: text(60).optional(),
    year: z.coerce.number().int().min(1950).max(2100).optional(),
    chip: z.enum(CATALOG_CHIP_IDS).default("todos"),
    page: z.coerce.number().int().min(1).max(100_000).default(1),
    pageSize: z.coerce.number().int().min(6).max(48).default(CATALOG_PAGE_SIZE),
  })
  .refine((value) => value.tireSize === undefined || parseTireSize(value.tireSize) !== null, {
    message: "Medida de llanta inválida (ej.: 205/55 R16)",
    path: ["tireSize"],
  });
export type CatalogListInput = z.input<typeof catalogListSchema>;

export const dotSchema = z
  .string()
  .trim()
  .refine(
    (value) => parseDot(value) !== null,
    "DOT inválido: semana (01–53) y año, p. ej. 2423, y no puede ser futuro",
  );
