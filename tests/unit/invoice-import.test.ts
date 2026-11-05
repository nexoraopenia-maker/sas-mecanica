import { describe, expect, it } from "vitest";
import {
  confirmImportSchema,
  detectImportFileKind,
  ImportFileError,
  importRowSchema,
  imageMime,
  parseUblInvoice,
  parseXml,
  suggestSku,
} from "@/lib/catalog/invoice-import";

const UBL = `<?xml version="1.0" encoding="UTF-8"?>
<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"
  xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2"
  xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2">
  <!-- comentario -->
  <cbc:ID>F001-00000123</cbc:ID>
  <cbc:IssueDate>2026-10-30</cbc:IssueDate>
  <cbc:DocumentCurrencyCode>PEN</cbc:DocumentCurrencyCode>
  <cac:AccountingSupplierParty>
    <cac:Party>
      <cac:PartyIdentification><cbc:ID schemeID="6">20123456786</cbc:ID></cac:PartyIdentification>
      <cac:PartyLegalEntity><cbc:RegistrationName><![CDATA[Repuestos Andes & Hijos S.A.C.]]></cbc:RegistrationName></cac:PartyLegalEntity>
    </cac:Party>
  </cac:AccountingSupplierParty>
  <cac:InvoiceLine>
    <cbc:ID>1</cbc:ID>
    <cbc:InvoicedQuantity unitCode="NIU">12.00</cbc:InvoicedQuantity>
    <cbc:LineExtensionAmount currencyID="PEN">222.00</cbc:LineExtensionAmount>
    <cac:Item>
      <cbc:Description>Filtro de aceite &quot;Premium&quot;</cbc:Description>
      <cac:SellersItemIdentification><cbc:ID>FIL-001</cbc:ID></cac:SellersItemIdentification>
      <cac:StandardItemIdentification><cbc:ID>7750001112228</cbc:ID></cac:StandardItemIdentification>
    </cac:Item>
    <cac:Price><cbc:PriceAmount currencyID="PEN">18.50</cbc:PriceAmount></cac:Price>
  </cac:InvoiceLine>
  <cac:InvoiceLine>
    <cbc:ID>2</cbc:ID>
    <cbc:InvoicedQuantity unitCode="NIU">3</cbc:InvoicedQuantity>
    <cbc:LineExtensionAmount currencyID="PEN">90.00</cbc:LineExtensionAmount>
    <cac:Item><cbc:Description>Pastillas de freno</cbc:Description></cac:Item>
  </cac:InvoiceLine>
</Invoice>`;

describe("lector del XML UBL de SUNAT", () => {
  it("extrae proveedor, comprobante y líneas", () => {
    const invoice = parseUblInvoice(UBL);
    expect(invoice).toMatchObject({
      supplierName: "Repuestos Andes & Hijos S.A.C.",
      supplierRuc: "20123456786",
      series: "F001",
      number: "00000123",
      issueDate: "2026-10-30",
      currency: "PEN",
    });
    expect(invoice.lines).toHaveLength(2);
    expect(invoice.lines[0]).toMatchObject({
      sku: "FIL-001",
      barcode: "7750001112228",
      name: 'Filtro de aceite "Premium"',
      quantity: 12,
      unitCost: 18.5,
      unit: "NIU",
    });
  });

  it("calcula el costo unitario desde el importe de la línea si no hay precio", () => {
    expect(parseUblInvoice(UBL).lines[1]).toMatchObject({ quantity: 3, unitCost: 30, sku: null });
  });

  it("rechaza DTD y entidades (XXE / billion laughs)", () => {
    const evil = `<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a "boom">]><Invoice><ID>&a;</ID></Invoice>`;
    expect(() => parseUblInvoice(evil)).toThrow(ImportFileError);
    expect(() => parseXml(evil)).toThrow(/DTD/);
  });

  it("rechaza XML mal formado, vacío o que no es factura", () => {
    expect(() => parseUblInvoice("<Invoice><a></b></Invoice>")).toThrow(ImportFileError);
    expect(() => parseUblInvoice("<Invoice>")).toThrow(ImportFileError);
    expect(() => parseUblInvoice("<CreditNote></CreditNote>")).toThrow(/factura o boleta/);
    expect(() => parseUblInvoice("<Invoice><ID>F001-1</ID></Invoice>")).toThrow(/líneas/);
  });

  it("rechaza líneas con cantidad o precio inválidos", () => {
    const bad = UBL.replace("12.00", "-5");
    expect(() => parseUblInvoice(bad)).toThrow(/inválidos/);
  });

  it("limita la profundidad del documento", () => {
    const deep = `${"<a>".repeat(60)}${"</a>".repeat(60)}`;
    expect(() => parseXml(deep)).toThrow(/profundo/);
  });
});

describe("detección del tipo de archivo", () => {
  const bytes = (text: string) => new TextEncoder().encode(text.padEnd(16, " "));

  it("reconoce PDF, XML e imágenes por su contenido", () => {
    expect(detectImportFileKind(bytes("%PDF-1.7"))).toBe("PDF");
    expect(detectImportFileKind(bytes("﻿  <?xml version='1.0'?>"))).toBe("XML");
    expect(detectImportFileKind(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0]))).toBe(
      "IMAGE",
    );
    expect(
      detectImportFileKind(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0])),
    ).toBe("IMAGE");
    const webp = new Uint8Array(16);
    webp.set(new TextEncoder().encode("RIFF"), 0);
    webp.set(new TextEncoder().encode("WEBP"), 8);
    expect(detectImportFileKind(webp)).toBe("IMAGE");
    expect(imageMime(webp)).toBe("image/webp");
    expect(imageMime(new Uint8Array([0xff, 0xd8, 0xff]))).toBe("image/jpeg");
  });

  it("rechaza formatos no soportados y archivos vacíos", () => {
    expect(() => detectImportFileKind(bytes("MZ\u0090 ejecutable"))).toThrow(
      /Formato no soportado/,
    );
    expect(() => detectImportFileKind(new Uint8Array([1, 2]))).toThrow(/vacío/);
  });
});

describe("tabla de revisión", () => {
  it("propone un SKU legible y estable", () => {
    expect(suggestSku("Pastillas de freno Ñandú", 0)).toBe("PASTILLAS-DE-FRENO-NANDU-1");
    expect(suggestSku("!!", 4)).toBe("ITEM-5");
    expect(suggestSku("x".repeat(80), 1).length).toBeLessThanOrEqual(40);
  });

  it("un producto nuevo exige precio de venta; uno existente no", () => {
    const base = { sku: "fil-001", name: "Filtro", quantity: 2, unitCost: 10 };
    expect(importRowSchema.safeParse(base).success).toBe(false);
    expect(importRowSchema.safeParse({ ...base, salePrice: 0 }).success).toBe(false);
    const ok = importRowSchema.parse({ ...base, salePrice: 25 });
    expect(ok).toMatchObject({ sku: "FIL-001", kind: "PART" });
    expect(
      importRowSchema.safeParse({
        ...base,
        productId: "0190a1c2-0000-7000-8000-000000000001",
      }).success,
    ).toBe(true);
  });

  it("valida cantidades, costos y SKU", () => {
    const base = { sku: "FIL-001", name: "Filtro", salePrice: 5, quantity: 1, unitCost: 1 };
    expect(importRowSchema.safeParse({ ...base, quantity: 0 }).success).toBe(false);
    expect(importRowSchema.safeParse({ ...base, unitCost: -1 }).success).toBe(false);
    expect(importRowSchema.safeParse({ ...base, sku: "a b" }).success).toBe(false);
    expect(importRowSchema.safeParse({ ...base, kind: "TIRE" }).success).toBe(false);
  });

  it("la confirmación exige almacén, clave y al menos una fila", () => {
    const row = { sku: "FIL-001", name: "Filtro", salePrice: 5, quantity: 1, unitCost: 1 };
    const warehouseId = "0190a1c2-0000-7000-8000-000000000001";
    expect(
      confirmImportSchema.safeParse({ warehouseId, idempotencyKey: "clave-12345", rows: [row] })
        .success,
    ).toBe(true);
    expect(
      confirmImportSchema.safeParse({ warehouseId, idempotencyKey: "clave-12345", rows: [] })
        .success,
    ).toBe(false);
    expect(
      confirmImportSchema.safeParse({ warehouseId, idempotencyKey: "corta", rows: [row] }).success,
    ).toBe(false);
  });
});
