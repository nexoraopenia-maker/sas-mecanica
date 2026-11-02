import type { PleBook } from "./format";

/** Cómo se valida el contenido de un campo. */
type Kind =
  | { type: "period" }
  | { type: "cuo" }
  | { type: "correlative" }
  | { type: "date" }
  | { type: "code"; values: readonly string[] }
  | { type: "alnum"; max: number }
  | { type: "text"; max: number }
  | { type: "money" }
  | { type: "fx" }
  | { type: "fixed"; length: number; digits?: boolean };

export interface FieldSpec {
  n: number;
  label: string;
  kind: Kind;
  /** `true`, `false` o una regla que depende de los demás campos de la fila. */
  required: boolean | ((f: (n: number) => string) => boolean);
}

/** Tabla 10 (tipo de comprobante) que este exportador sabe generar/aceptar. */
export const SALES_DOC_TYPES = ["01", "03", "07", "08"] as const;
export const PURCHASE_DOC_TYPES = ["00", "01", "02", "03", "04", "07", "08", "12", "14"] as const;
/** Tabla 2 (tipo de documento de identidad). */
export const IDENTITY_TYPES = ["0", "1", "4", "6", "7", "A"] as const;
const NOTE_TYPES = ["07", "08"];

const money = (n: number, label: string, required = false): FieldSpec => ({
  n,
  label,
  kind: { type: "money" },
  required,
});
const empty = (n: number, label: string, kind: Kind): FieldSpec => ({
  n,
  label,
  kind,
  required: false,
});

export const VENTAS_14_1: FieldSpec[] = [
  { n: 1, label: "Periodo", kind: { type: "period" }, required: true },
  { n: 2, label: "CUO (número correlativo del mes)", kind: { type: "cuo" }, required: true },
  {
    n: 3,
    label: "Número correlativo del asiento contable",
    kind: { type: "correlative" },
    required: true,
  },
  {
    n: 4,
    label: "Fecha de emisión del comprobante",
    kind: { type: "date" },
    required: (f) => f(35) !== "2",
  },
  empty(5, "Fecha de vencimiento o pago", { type: "date" }),
  {
    n: 6,
    label: "Tipo de comprobante (Tabla 10)",
    kind: { type: "code", values: SALES_DOC_TYPES },
    required: true,
  },
  { n: 7, label: "Serie del comprobante", kind: { type: "alnum", max: 20 }, required: true },
  { n: 8, label: "Número del comprobante", kind: { type: "alnum", max: 20 }, required: true },
  empty(9, "Número final (consolidado)", { type: "alnum", max: 20 }),
  {
    n: 10,
    label: "Tipo de documento de identidad del cliente (Tabla 2)",
    kind: { type: "code", values: IDENTITY_TYPES },
    required: (f) => f(35) !== "2" && !NOTE_TYPES.includes(f(6)),
  },
  {
    n: 11,
    label: "Número de documento de identidad del cliente",
    kind: { type: "alnum", max: 15 },
    required: (f) => f(35) !== "2" && !NOTE_TYPES.includes(f(6)),
  },
  {
    n: 12,
    label: "Apellidos y nombres, denominación o razón social",
    kind: { type: "text", max: 100 },
    required: (f) => f(35) !== "2" && !NOTE_TYPES.includes(f(6)),
  },
  money(13, "Valor facturado de la exportación"),
  money(14, "Base imponible de la operación gravada"),
  money(15, "Descuento de la base imponible"),
  money(16, "IGV y/o IPM"),
  money(17, "Descuento del IGV y/o IPM"),
  money(18, "Importe total de la operación exonerada"),
  money(19, "Importe total de la operación inafecta"),
  money(20, "ISC"),
  money(21, "Base imponible gravada con IVAP"),
  money(22, "IVAP"),
  money(23, "ICBPER"),
  money(24, "Otros conceptos, tributos y cargos"),
  money(25, "Importe total del comprobante"),
  empty(26, "Código de la moneda (Tabla 4)", { type: "fixed", length: 3 }),
  { n: 27, label: "Tipo de cambio", kind: { type: "fx" }, required: (f) => f(26) !== "" },
  {
    n: 28,
    label: "Fecha del comprobante que se modifica",
    kind: { type: "date" },
    required: (f) => NOTE_TYPES.includes(f(6)) && f(35) !== "2",
  },
  {
    n: 29,
    label: "Tipo del comprobante que se modifica",
    kind: { type: "code", values: ["01", "03", "12", "14"] },
    required: (f) => NOTE_TYPES.includes(f(6)) && f(35) !== "2",
  },
  {
    n: 30,
    label: "Serie del comprobante que se modifica",
    kind: { type: "alnum", max: 20 },
    required: (f) => NOTE_TYPES.includes(f(6)) && f(35) !== "2",
  },
  {
    n: 31,
    label: "Número del comprobante que se modifica",
    kind: { type: "alnum", max: 20 },
    required: (f) => NOTE_TYPES.includes(f(6)) && f(35) !== "2",
  },
  empty(32, "Identificación del contrato o proyecto", { type: "text", max: 12 }),
  empty(33, "Error tipo 1: inconsistencia en el tipo de cambio", { type: "code", values: ["1"] }),
  empty(34, "Comprobante cancelado con medio de pago", { type: "code", values: ["1"] }),
  {
    n: 35,
    label: "Estado que identifica la oportunidad de la anotación",
    kind: { type: "code", values: ["0", "1", "2", "8", "9"] },
    required: true,
  },
];

export const COMPRAS_8_1: FieldSpec[] = [
  { n: 1, label: "Periodo", kind: { type: "period" }, required: true },
  { n: 2, label: "CUO (número correlativo del mes)", kind: { type: "cuo" }, required: true },
  {
    n: 3,
    label: "Número correlativo del asiento contable",
    kind: { type: "correlative" },
    required: true,
  },
  { n: 4, label: "Fecha de emisión del comprobante", kind: { type: "date" }, required: true },
  {
    n: 5,
    label: "Fecha de vencimiento o pago",
    kind: { type: "date" },
    required: (f) => f(6) === "14",
  },
  {
    n: 6,
    label: "Tipo de comprobante (Tabla 10)",
    kind: { type: "code", values: PURCHASE_DOC_TYPES },
    required: true,
  },
  empty(7, "Serie del comprobante", { type: "alnum", max: 20 }),
  empty(8, "Año de emisión de la DUA o DSI", { type: "fixed", length: 4, digits: true }),
  { n: 9, label: "Número del comprobante", kind: { type: "alnum", max: 20 }, required: true },
  empty(10, "Número final (consolidado)", { type: "alnum", max: 20 }),
  {
    n: 11,
    label: "Tipo de documento de identidad del proveedor (Tabla 2)",
    kind: { type: "code", values: IDENTITY_TYPES.filter((t) => t !== "0") },
    required: (f) => ["01", "02", "04", "07", "08"].includes(f(6)),
  },
  {
    n: 12,
    label: "Número de RUC o documento de identidad del proveedor",
    kind: { type: "alnum", max: 15 },
    required: (f) => ["01", "02", "04", "07", "08"].includes(f(6)),
  },
  {
    n: 13,
    label: "Apellidos y nombres, denominación o razón social del proveedor",
    kind: { type: "text", max: 100 },
    required: (f) => ["01", "02", "04", "07", "08"].includes(f(6)),
  },
  money(14, "Base imponible: adquisiciones gravadas que dan derecho a crédito fiscal"),
  money(15, "IGV de las adquisiciones del campo 14"),
  money(16, "Base imponible: gravadas destinadas a operaciones gravadas y no gravadas"),
  money(17, "IGV de las adquisiciones del campo 16"),
  money(18, "Base imponible: gravadas que no dan derecho a crédito fiscal"),
  money(19, "IGV de las adquisiciones del campo 18"),
  money(20, "Valor de las adquisiciones no gravadas"),
  money(21, "ISC"),
  money(22, "ICBPER"),
  money(23, "Otros conceptos, tributos y cargos"),
  money(24, "Importe total de las adquisiciones", true),
  empty(25, "Código de la moneda (Tabla 4)", { type: "fixed", length: 3 }),
  empty(26, "Tipo de cambio", { type: "fx" }),
  {
    n: 27,
    label: "Fecha del comprobante que se modifica",
    kind: { type: "date" },
    required: (f) => NOTE_TYPES.includes(f(6)),
  },
  {
    n: 28,
    label: "Tipo del comprobante que se modifica",
    kind: { type: "code", values: PURCHASE_DOC_TYPES },
    required: (f) => NOTE_TYPES.includes(f(6)),
  },
  {
    n: 29,
    label: "Serie del comprobante que se modifica",
    kind: { type: "alnum", max: 20 },
    required: (f) => NOTE_TYPES.includes(f(6)),
  },
  empty(30, "Código de la dependencia aduanera", { type: "fixed", length: 3 }),
  {
    n: 31,
    label: "Número del comprobante que se modifica",
    kind: { type: "alnum", max: 20 },
    required: (f) => NOTE_TYPES.includes(f(6)),
  },
  empty(32, "Fecha de la constancia de depósito de detracción", { type: "date" }),
  empty(33, "Número de la constancia de depósito de detracción", { type: "alnum", max: 24 }),
  empty(34, "Marca del comprobante sujeto a retención", { type: "code", values: ["1"] }),
  empty(35, "Clasificación de bienes y servicios (Tabla 30)", {
    type: "fixed",
    length: 1,
    digits: true,
  }),
  empty(36, "Identificación del contrato o proyecto", { type: "text", max: 12 }),
  empty(37, "Error tipo 1: inconsistencia en el tipo de cambio", { type: "code", values: ["1"] }),
  empty(38, "Error tipo 2: proveedores no habidos", { type: "code", values: ["1"] }),
  empty(39, "Error tipo 3: renunciaron a la exoneración del Apéndice I", {
    type: "code",
    values: ["1"],
  }),
  empty(40, "Error tipo 4: DNI con RUC en liquidaciones de compra", {
    type: "code",
    values: ["1"],
  }),
  empty(41, "Comprobante cancelado con medio de pago", { type: "code", values: ["1"] }),
  {
    n: 42,
    label: "Estado que identifica la oportunidad de la anotación",
    kind: { type: "code", values: ["0", "1", "6", "7", "9"] },
    required: true,
  },
];

export const LAYOUTS: Record<PleBook, FieldSpec[]> = { "14.1": VENTAS_14_1, "8.1": COMPRAS_8_1 };

function validDate(value: string): boolean {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(value);
  if (!m) return false;
  const [d, mo, y] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d;
}

function checkKind(kind: Kind, value: string): string | null {
  switch (kind.type) {
    case "period": {
      const m = /^(\d{4})(\d{2})00$/.exec(value);
      return m && Number(m[2]) >= 1 && Number(m[2]) <= 12
        ? null
        : "debe ser AAAAMM00 con mes 01–12";
    }
    case "cuo":
      return value.length <= 40 && !value.includes("&") && /^[A-Za-z0-9\-]+$/.test(value)
        ? null
        : "hasta 40 caracteres alfanuméricos, sin «&»";
    case "correlative":
      return /^[AMC][A-Za-z0-9\-]{1,9}$/.test(value)
        ? null
        : "de 2 a 10 caracteres y el primero debe ser A, M o C";
    case "date":
      return validDate(value) ? null : "debe ser una fecha DD/MM/AAAA válida";
    case "code":
      return kind.values.includes(value) ? null : `valor no permitido (${kind.values.join(", ")})`;
    case "alnum":
      return value.length <= kind.max && /^[A-Za-z0-9\-/]+$/.test(value)
        ? null
        : `hasta ${kind.max} caracteres alfanuméricos`;
    case "text":
      return value.length <= kind.max ? null : `hasta ${kind.max} caracteres`;
    case "money":
      return /^-?\d{1,12}(\.\d{1,2})?$/.test(value)
        ? null
        : "hasta 12 enteros y 2 decimales, sin comas de miles";
    case "fx":
      return /^\d\.\d{3}$/.test(value) && Number(value) > 0 ? null : "formato #.### y positivo";
    case "fixed":
      return value.length === kind.length && (!kind.digits || /^\d+$/.test(value))
        ? null
        : `debe tener exactamente ${kind.length} caracteres`;
  }
}

/**
 * Valida UNA fila contra la estructura oficial: cantidad de campos, obligatoriedad (incluida la condicional),
 * formato y longitud de cada campo, y la regla de que ningún campo puede traer palotes ni saltos de línea.
 * Devuelve los errores legibles (vacío = fila válida).
 */
export function validateRow(book: PleBook, row: string[]): string[] {
  const layout = LAYOUTS[book];
  if (row.length !== layout.length)
    return [`La fila tiene ${row.length} campos y el formato ${book} exige ${layout.length}`];
  const get = (n: number): string => row[n - 1] ?? "";
  const errors: string[] = [];
  for (const spec of layout) {
    const value = get(spec.n);
    if (/[|\r\n]/.test(value)) {
      errors.push(`Campo ${spec.n} (${spec.label}): no puede contener palotes ni saltos de línea`);
      continue;
    }
    const required = typeof spec.required === "function" ? spec.required(get) : spec.required;
    if (value === "") {
      if (required) errors.push(`Campo ${spec.n} (${spec.label}): es obligatorio`);
      continue;
    }
    const problem = checkKind(spec.kind, value);
    if (problem) errors.push(`Campo ${spec.n} (${spec.label}): ${problem}`);
  }
  if (book === "8.1" && errors.length === 0) {
    const sum = [14, 15, 16, 17, 18, 19, 20, 21, 22, 23].reduce(
      (acc, n) => acc + Math.round(Number(get(n) || "0") * 100),
      0,
    );
    if (sum !== Math.round(Number(get(24)) * 100))
      errors.push("Campo 24: el total debe ser la suma de los campos 14 al 23");
    if (Number(get(14)) < 0 !== Number(get(15)) < 0 && Number(get(15)) !== 0)
      errors.push("Campo 15: el IGV debe tener el mismo signo que su base (campo 14)");
  }
  return errors;
}
