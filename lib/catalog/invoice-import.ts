import { z } from "zod";

/** Tamaño máximo de un comprobante a importar. */
export const MAX_IMPORT_BYTES = 8 * 1024 * 1024;
export const MAX_IMPORT_LINES = 200;

export type ImportFileKind = "XML" | "PDF" | "IMAGE";

export class ImportFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImportFileError";
  }
}

const text = (max: number) => z.string().trim().max(max);

export const extractedLineSchema = z.object({
  sku: text(40).nullish(),
  barcode: text(40).nullish(),
  name: text(200).min(1),
  quantity: z.coerce.number().positive().max(10_000_000),
  /** Costo unitario SIN IGV. */
  unitCost: z.coerce.number().min(0).max(100_000_000),
  unit: text(10).nullish(),
});
export type ExtractedLine = z.output<typeof extractedLineSchema>;

export const extractedInvoiceSchema = z.object({
  supplierName: text(200).nullish(),
  supplierRuc: text(11).nullish(),
  series: text(10).nullish(),
  number: text(20).nullish(),
  /** AAAA-MM-DD */
  issueDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullish(),
  currency: text(3).nullish(),
  lines: z.array(extractedLineSchema).max(MAX_IMPORT_LINES),
});
export type ExtractedInvoice = z.output<typeof extractedInvoiceSchema>;

/** Detecta el tipo por el contenido (no por la extensión ni el MIME que declara el navegador). */
export function detectImportFileKind(bytes: Uint8Array): ImportFileKind {
  if (bytes.length < 8) throw new ImportFileError("El archivo está vacío o dañado");
  const head = (n: number) => String.fromCharCode(...bytes.subarray(0, n));
  if (head(5) === "%PDF-") return "PDF";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "IMAGE";
  if (head(8) === "\x89PNG\r\n\x1a\n") return "IMAGE";
  if (head(4) === "RIFF" && String.fromCharCode(...bytes.subarray(8, 12)) === "WEBP")
    return "IMAGE";
  const start = new TextDecoder("utf-8").decode(bytes.subarray(0, 200)).replace(/^﻿/, "");
  if (start.trimStart().startsWith("<")) return "XML";
  throw new ImportFileError(
    "Formato no soportado. Sube un PDF, un XML de SUNAT o una foto (JPG, PNG, WebP)",
  );
}

export function imageMime(bytes: Uint8Array): "image/jpeg" | "image/png" | "image/webp" {
  if (bytes[0] === 0xff) return "image/jpeg";
  if (bytes[0] === 0x89) return "image/png";
  return "image/webp";
}

// ---------------------------------------------------------------------------
// XML (UBL 2.1 de SUNAT) — lector mínimo y seguro: sin DTD ni entidades externas.
// ---------------------------------------------------------------------------

interface XmlNode {
  name: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  text: string;
}

const MAX_XML_DEPTH = 40;
const MAX_XML_NODES = 60_000;

function decodeEntities(value: string): string {
  return value.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (_m, entity: string) => {
    if (entity === "amp") return "&";
    if (entity === "lt") return "<";
    if (entity === "gt") return ">";
    if (entity === "quot") return '"';
    if (entity === "apos") return "'";
    const code = entity.startsWith("#x") ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
  });
}

const localName = (name: string): string => name.slice(name.indexOf(":") + 1);

export function parseXml(xml: string): XmlNode {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml))
    throw new ImportFileError("El XML contiene una declaración DTD no permitida");
  const root: XmlNode = { name: "#root", attrs: {}, children: [], text: "" };
  const stack: XmlNode[] = [root];
  let index = 0;
  let nodes = 0;
  const tagPattern =
    /^<(\/?)([A-Za-z_][\w:.-]*)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/;
  while (index < xml.length) {
    const lt = xml.indexOf("<", index);
    const current = stack[stack.length - 1] as XmlNode;
    if (lt === -1) {
      current.text += decodeEntities(xml.slice(index));
      break;
    }
    if (lt > index) current.text += decodeEntities(xml.slice(index, lt));
    if (xml.startsWith("<!--", lt)) {
      const end = xml.indexOf("-->", lt + 4);
      if (end === -1) throw new ImportFileError("XML mal formado");
      index = end + 3;
      continue;
    }
    if (xml.startsWith("<![CDATA[", lt)) {
      const end = xml.indexOf("]]>", lt + 9);
      if (end === -1) throw new ImportFileError("XML mal formado");
      current.text += xml.slice(lt + 9, end);
      index = end + 3;
      continue;
    }
    if (xml.startsWith("<?", lt)) {
      const end = xml.indexOf("?>", lt + 2);
      if (end === -1) throw new ImportFileError("XML mal formado");
      index = end + 2;
      continue;
    }
    const match = tagPattern.exec(xml.slice(lt, lt + 4096));
    if (!match) throw new ImportFileError("XML mal formado");
    const [whole, closing, name, rawAttrs, selfClosing] = match as unknown as [
      string,
      string,
      string,
      string,
      string,
    ];
    index = lt + whole.length;
    if (closing) {
      if (stack.length <= 1 || (stack[stack.length - 1] as XmlNode).name !== localName(name))
        throw new ImportFileError("XML mal formado");
      stack.pop();
      continue;
    }
    nodes += 1;
    if (nodes > MAX_XML_NODES || stack.length > MAX_XML_DEPTH)
      throw new ImportFileError("El XML es demasiado grande o profundo");
    const attrs: Record<string, string> = {};
    for (const attr of rawAttrs.matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g))
      attrs[localName(attr[1] as string)] = decodeEntities((attr[2] ?? attr[3]) as string);
    const node: XmlNode = { name: localName(name), attrs, children: [], text: "" };
    current.children.push(node);
    if (!selfClosing) stack.push(node);
  }
  if (stack.length !== 1) throw new ImportFileError("XML mal formado");
  const top = root.children[0];
  if (!top) throw new ImportFileError("XML vacío");
  return top;
}

const child = (node: XmlNode | undefined, name: string): XmlNode | undefined =>
  node?.children.find((item) => item.name === name);
const kids = (node: XmlNode | undefined, name: string): XmlNode[] =>
  node?.children.filter((item) => item.name === name) ?? [];
const path = (node: XmlNode | undefined, ...names: string[]): XmlNode | undefined =>
  names.reduce<XmlNode | undefined>((acc, name) => child(acc, name), node);
const value = (node: XmlNode | undefined): string | undefined => node?.text.trim() || undefined;

/** Lee una factura o boleta UBL 2.1 de SUNAT (Invoice) y devuelve proveedor, comprobante y líneas. */
export function parseUblInvoice(xml: string): ExtractedInvoice {
  const root = parseXml(xml);
  if (root.name !== "Invoice")
    throw new ImportFileError("El XML no es una factura o boleta electrónica (UBL Invoice)");
  const [series, ...rest] = (value(child(root, "ID")) ?? "").split("-");
  const party = path(root, "AccountingSupplierParty", "Party");
  const lines = kids(root, "InvoiceLine").map((line) => {
    const quantity = Number(value(child(line, "InvoicedQuantity")));
    const priceAmount = value(path(line, "Price", "PriceAmount"));
    const lineTotal = Number(value(child(line, "LineExtensionAmount")));
    const unitCost =
      priceAmount !== undefined
        ? Number(priceAmount)
        : quantity > 0 && Number.isFinite(lineTotal)
          ? Math.round((lineTotal / quantity) * 1e6) / 1e6
          : NaN;
    return {
      sku: value(path(line, "Item", "SellersItemIdentification", "ID")) ?? null,
      barcode: value(path(line, "Item", "StandardItemIdentification", "ID")) ?? null,
      name: value(path(line, "Item", "Description")) ?? value(path(line, "Item", "Name")) ?? "",
      quantity,
      unitCost,
      unit: child(line, "InvoicedQuantity")?.attrs.unitCode ?? null,
    };
  });
  if (lines.length === 0) throw new ImportFileError("El XML no tiene líneas de detalle");
  const parsed = extractedInvoiceSchema.safeParse({
    supplierName:
      value(path(party, "PartyLegalEntity", "RegistrationName")) ??
      value(path(party, "PartyName", "Name")) ??
      null,
    supplierRuc: value(path(party, "PartyIdentification", "ID")) ?? null,
    series: series || null,
    number: rest.join("-") || null,
    issueDate: value(child(root, "IssueDate")) ?? null,
    currency: value(child(root, "DocumentCurrencyCode")) ?? null,
    lines,
  });
  if (!parsed.success)
    throw new ImportFileError("El XML tiene líneas con cantidad o precio inválidos");
  return parsed.data;
}

// ---------------------------------------------------------------------------
// Tabla de revisión
// ---------------------------------------------------------------------------

/** Tipos que se pueden crear desde una factura sin pedir datos técnicos extra (lote, serie, medida...). */
export const IMPORT_KINDS = ["PART", "ACCESSORY"] as const;
export type ImportKind = (typeof IMPORT_KINDS)[number];

/** SKU propuesto cuando el comprobante no trae código: estable y legible para el mismo nombre. */
export function suggestSku(name: string, index: number): string {
  const slug = name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 28);
  return slug.length >= 2 ? `${slug}-${index + 1}` : `ITEM-${index + 1}`;
}

const money = z.coerce.number().min(0).max(100_000_000);

export const importRowSchema = z
  .object({
    sku: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z0-9][A-Z0-9._-]{1,39}$/, "SKU inválido"),
    name: text(200).min(2),
    barcode: text(40).optional(),
    brand: text(80).optional(),
    kind: z.enum(IMPORT_KINDS).default("PART"),
    quantity: z.coerce.number().positive().max(10_000_000),
    unitCost: money,
    /** Obligatorio solo si el producto es nuevo. */
    salePrice: money.optional(),
    /** Producto existente al que se le suma stock (el servidor lo vuelve a verificar). */
    productId: z.uuid().optional(),
  })
  .refine((row) => row.productId !== undefined || (row.salePrice ?? 0) > 0, {
    message: "Indica el precio de venta del producto nuevo",
    path: ["salePrice"],
  });
export type ImportRow = z.input<typeof importRowSchema>;

export const confirmImportSchema = z.object({
  warehouseId: z.uuid(),
  reference: text(80).optional(),
  idempotencyKey: z.string().trim().min(8).max(100),
  rows: z.array(importRowSchema).min(1).max(MAX_IMPORT_LINES),
});
export type ConfirmImportInput = z.input<typeof confirmImportSchema>;
