import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { AuthUser } from "@/lib/auth/can";
import { isValidEan13 } from "@/lib/barcode";
import type { PrismaClient } from "@/lib/db/generated/client.ts";
import {
  ExtractionError,
  setInvoiceExtractorForTests,
  type ExtractionOutput,
} from "@/server/integrations/invoice-extractor";
import { updateAiSettings } from "@/server/services/ai-settings";
import {
  createProduct,
  getLabelProducts,
  listLabelCandidates,
  prepareLabelProducts,
  updateProduct,
} from "@/server/services/catalog";
import { confirmCatalogImport, extractInvoiceFile } from "@/server/services/catalog-import";
import { provisionDemo } from "@/server/services/demo";
import { configureAuthCache, resolveSession } from "@/server/services/session-resolver";
import { meta } from "../helpers/auth.ts";
import { adminClient } from "../helpers/db.ts";
import {
  inventoryWorld,
  key,
  make,
  plain,
  tire,
  type InventoryWorld,
} from "../helpers/inventory.ts";

const enc = (text: string) => new TextEncoder().encode(text);
const PDF = enc("%PDF-1.7 factura de compra");
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

const ublFor = (
  lines: Array<{ sku?: string; name: string; qty: number; price: number }>,
) => `<?xml version="1.0"?>
<Invoice xmlns:cac="x" xmlns:cbc="y">
  <cbc:ID>F001-00000555</cbc:ID>
  <cbc:IssueDate>2026-10-30</cbc:IssueDate>
  <cbc:DocumentCurrencyCode>PEN</cbc:DocumentCurrencyCode>
  <cac:AccountingSupplierParty><cac:Party>
    <cac:PartyIdentification><cbc:ID>20123456786</cbc:ID></cac:PartyIdentification>
    <cac:PartyLegalEntity><cbc:RegistrationName>Distribuidora Test SAC</cbc:RegistrationName></cac:PartyLegalEntity>
  </cac:Party></cac:AccountingSupplierParty>
${lines
  .map(
    (line, index) => `  <cac:InvoiceLine>
    <cbc:ID>${index + 1}</cbc:ID>
    <cbc:InvoicedQuantity unitCode="NIU">${line.qty}</cbc:InvoicedQuantity>
    <cbc:LineExtensionAmount>${(line.qty * line.price).toFixed(2)}</cbc:LineExtensionAmount>
    <cac:Item><cbc:Description>${line.name}</cbc:Description>${
      line.sku
        ? `<cac:SellersItemIdentification><cbc:ID>${line.sku}</cbc:ID></cac:SellersItemIdentification>`
        : ""
    }</cac:Item>
    <cac:Price><cbc:PriceAmount>${line.price}</cbc:PriceAmount></cac:Price>
  </cac:InvoiceLine>`,
  )
  .join("\n")}
</Invoice>`;

describe("catálogo: códigos de barras, etiquetas e importación", () => {
  let admin: PrismaClient;
  let w: InventoryWorld;
  let other: InventoryWorld;
  let premium: InventoryWorld;
  let demoUser: AuthUser;

  beforeAll(async () => {
    configureAuthCache(0);
    admin = adminClient();
    w = await inventoryWorld(admin, "pro");
    other = await inventoryWorld(admin, "pro");
    premium = await inventoryWorld(admin, "enterprise");
    const demo = await provisionDemo(meta());
    const row = await admin.user.findUniqueOrThrow({ where: { id: demo.userId } });
    const user = await resolveSession({
      sub: demo.userId,
      tid: demo.tenantId,
      sv: row.sessionVersion,
      mfa: true,
    });
    if (!user) throw new Error("sin sesión demo");
    demoUser = user;
  }, 300_000);
  afterAll(async () => {
    await admin.$disconnect();
  });
  afterEach(() => setInvoiceExtractorForTests(null));

  describe("código de barras autogenerado", () => {
    it("asigna un EAN-13 interno válido, único y marcado como generado", async () => {
      const a = await make(w.admin, plain());
      const b = await make(w.admin, plain());
      expect(a.barcode).toSatisfy((code: string) => isValidEan13(code) && code.startsWith("2"));
      expect(b.barcode).not.toBe(a.barcode);
      const row = await admin.product.findUniqueOrThrow({ where: { id: a.id } });
      expect(row.barcodeGenerated).toBe(true);
    });

    it("respeta el código de fábrica y permite desactivar la generación", async () => {
      const factory = await make(w.admin, plain({ barcode: "7750001112228" }));
      expect(factory.barcode).toBe("7750001112228");
      expect(
        (await admin.product.findUniqueOrThrow({ where: { id: factory.id } })).barcodeGenerated,
      ).toBe(false);
      const none = await make(w.admin, plain({ autoBarcode: false }));
      expect(none.barcode).toBeNull();
    });

    it("no genera código para servicios", async () => {
      const service = await make(w.admin, {
        kind: "SERVICE",
        sku: `SRV-${randomUUID().slice(0, 6)}`,
        name: "Alineamiento",
        salePrice: 60,
      });
      expect(service.barcode).toBeNull();
    });

    it("editar el código a mano deja de marcarlo como generado", async () => {
      const product = await make(w.admin, plain());
      await updateProduct(
        w.admin,
        product.id,
        { barcode: `MANUAL-${randomUUID().slice(0, 6)}` },
        meta(),
      );
      const row = await admin.product.findUniqueOrThrow({ where: { id: product.id } });
      expect(row.barcodeGenerated).toBe(false);
    });

    it("salta un código interno que ya existe (tecleado a mano)", async () => {
      const first = await make(w.admin, plain());
      const next = String(Number(first.barcode?.slice(0, 12)) + 1);
      // Reserva el siguiente EAN interno a mano: el generador debe saltarlo.
      const digits = next.padStart(12, "0");
      const sum = [...digits].reduce((acc, d, i) => acc + Number(d) * (i % 2 === 0 ? 1 : 3), 0);
      const taken = `${digits}${(10 - (sum % 10)) % 10}`;
      await make(w.admin, plain({ barcode: taken }));
      const generated = await make(w.admin, plain());
      expect(generated.barcode).not.toBe(taken);
      expect(isValidEan13(generated.barcode ?? "")).toBe(true);
    });

    it("cada empresa lleva su propio correlativo", async () => {
      const a = await make(other.admin, plain());
      expect(a.barcode).toSatisfy((code: string) => isValidEan13(code));
    });
  });

  describe("stock mínimo al crear el producto", () => {
    it("crea la política manual en el almacén principal", async () => {
      const product = await make(w.admin, plain({ minStock: 5 }));
      const policy = await admin.reorderPolicy.findFirstOrThrow({
        where: { productId: product.id },
      });
      expect(policy).toMatchObject({ mode: "MANUAL", warehouseId: w.warehouseId });
      expect(policy.manualMinStock?.toString()).toBe("5");
    });

    it("no aplica a servicios y valida el valor", async () => {
      await expect(make(w.admin, plain({ minStock: -1 }))).rejects.toBeTruthy();
      const service = await make(w.admin, {
        kind: "SERVICE",
        sku: `SRV-${randomUUID().slice(0, 6)}`,
        name: "Cambio de aceite",
        salePrice: 40,
        minStock: 3,
      });
      expect(await admin.reorderPolicy.count({ where: { productId: service.id } })).toBe(0);
    });
  });

  describe("etiquetas", () => {
    it("asigna código a los que no lo tienen, conserva el resto y respeta el orden", async () => {
      const withCode = await make(w.admin, plain({ barcode: "4006381333931" }));
      const without = await make(w.admin, plain({ autoBarcode: false }));
      const labels = await prepareLabelProducts(w.admin, [without.id, withCode.id], meta());
      expect(labels.map((label) => label.id)).toEqual([without.id, withCode.id]);
      expect(labels[0]?.barcode).toSatisfy((code: string) => isValidEan13(code));
      expect(labels[0]?.barcodeGenerated).toBe(true);
      expect(labels[1]).toMatchObject({ barcode: "4006381333931", barcodeGenerated: false });
      // Idempotente: el código ya quedó guardado y no cambia.
      const again = await prepareLabelProducts(w.admin, [without.id], meta());
      expect(again[0]?.barcode).toBe(labels[0]?.barcode);
      const audits = await admin.auditLog.count({
        where: { tenantId: w.tenantId, action: "product.barcodes_generated" },
      });
      expect(audits).toBeGreaterThanOrEqual(1);
    });

    it("sin código el cajero no puede generarlo (solo ve catálogo), con código sí imprime", async () => {
      const without = await make(w.admin, plain({ autoBarcode: false }));
      await expect(prepareLabelProducts(w.cashier, [without.id], meta())).rejects.toMatchObject({
        code: "PERMISSION_DENIED",
      });
      const ready = await make(w.admin, plain());
      const labels = await prepareLabelProducts(w.cashier, [ready.id], meta());
      expect(labels).toHaveLength(1);
    });

    it("getLabelProducts omite los productos sin código y los servicios", async () => {
      const without = await make(w.admin, plain({ autoBarcode: false }));
      const ready = await make(w.admin, plain());
      const rows = await getLabelProducts(w.admin, [without.id, ready.id]);
      expect(rows.map((row) => row.id)).toEqual([ready.id]);
    });

    it("no filtra productos de otra empresa", async () => {
      const mine = await make(w.admin, plain());
      await expect(prepareLabelProducts(other.admin, [mine.id], meta())).rejects.toMatchObject({
        code: "NOT_FOUND",
      });
      expect(await getLabelProducts(other.admin, [mine.id])).toEqual([]);
      const candidates = await listLabelCandidates(other.admin, mine.name);
      expect(candidates.some((row) => row.id === mine.id)).toBe(false);
    });

    it("lista candidatos por nombre o SKU", async () => {
      const product = await make(w.admin, plain({ name: "Bujía Iridium Zeta" }));
      const rows = await listLabelCandidates(w.admin, "iridium zeta");
      expect(rows.map((row) => row.id)).toContain(product.id);
    });

    it("valida los ids", async () => {
      await expect(prepareLabelProducts(w.admin, [], meta())).rejects.toBeTruthy();
      await expect(prepareLabelProducts(w.admin, ["no-uuid"], meta())).rejects.toBeTruthy();
    });
  });

  describe("importar desde un XML de SUNAT", () => {
    it("arma la tabla de revisión y detecta los productos que ya existen", async () => {
      const existing = await make(w.admin, plain({ sku: "FIL-EXIST-1", name: "Filtro existente" }));
      const preview = await extractInvoiceFile(
        w.admin,
        {
          name: "factura.xml",
          bytes: enc(
            ublFor([
              { sku: "fil-exist-1", name: "Filtro existente", qty: 5, price: 20 },
              { sku: "NUEVO-77", name: "Producto nuevo", qty: 2, price: 8.5 },
              { name: "Sin código del proveedor", qty: 1, price: 3 },
            ]),
          ),
        },
        meta(),
      );
      expect(preview).toMatchObject({
        mode: "XML",
        supplierName: "Distribuidora Test SAC",
        supplierRuc: "20123456786",
        reference: "F001-00000555",
        issueDate: "2026-10-30",
      });
      expect(preview.rows).toHaveLength(3);
      expect(preview.rows[0]).toMatchObject({
        sku: "FIL-EXIST-1",
        quantity: 5,
        unitCost: 20,
        match: { productId: existing.id, trackedStock: false },
      });
      expect(preview.rows[1]).toMatchObject({ sku: "NUEVO-77", match: null });
      expect(preview.rows[2]?.sku).toMatch(/^SIN-CODIGO-DEL-PROVEEDOR-3$/);
      // Leer no guarda nada.
      expect(await admin.product.count({ where: { tenantId: w.tenantId, sku: "NUEVO-77" } })).toBe(
        0,
      );
    });

    it("marca como bloqueado un producto con control por lote", async () => {
      const llanta = await make(w.admin, tire());
      const preview = await extractInvoiceFile(
        w.admin,
        {
          name: "f.xml",
          bytes: enc(ublFor([{ sku: llanta.sku, name: "Llanta", qty: 4, price: 100 }])),
        },
        meta(),
      );
      expect(preview.rows[0]?.match?.trackedStock).toBe(true);
    });

    it("rechaza archivos inválidos con mensajes claros", async () => {
      await expect(
        extractInvoiceFile(w.admin, { name: "x.exe", bytes: enc("MZ ejecutable raro...") }, meta()),
      ).rejects.toMatchObject({ code: "IMPORT_FILE" });
      await expect(
        extractInvoiceFile(w.admin, { name: "x.xml", bytes: enc("<Invoice><a></b>") }, meta()),
      ).rejects.toMatchObject({ code: "IMPORT_FILE" });
      await expect(
        extractInvoiceFile(
          w.admin,
          { name: "grande.pdf", bytes: new Uint8Array(8 * 1024 * 1024 + 1) },
          meta(),
        ),
      ).rejects.toMatchObject({ code: "IMPORT_FILE" });
    });

    it("exige permisos de catálogo e inventario", async () => {
      await expect(
        extractInvoiceFile(w.cashier, { name: "f.xml", bytes: enc(ublFor([])) }, meta()),
      ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
      await expect(
        extractInvoiceFile(w.mechanic, { name: "f.xml", bytes: enc(ublFor([])) }, meta()),
      ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    });
  });

  describe("importar PDF o foto con IA", () => {
    const fakeOutput = (over: Partial<ExtractionOutput["invoice"]> = {}): ExtractionOutput => ({
      invoice: {
        supplierName: "Proveedor IA",
        supplierRuc: "20123456786",
        series: "F002",
        number: "99",
        issueDate: "2026-11-01",
        currency: "PEN",
        lines: [{ sku: "IA-001", name: "Producto leído por IA", quantity: 3, unitCost: 15 }],
        ...over,
      },
      usage: { promptTokens: 1500, completionTokens: 200 },
    });

    it("el plan sin «IA de inventario» no puede leer PDF ni fotos, pero sí XML", async () => {
      await expect(
        extractInvoiceFile(w.admin, { name: "f.pdf", bytes: PDF }, meta()),
      ).rejects.toMatchObject({ code: "AI_DISABLED" });
      await expect(
        extractInvoiceFile(w.admin, { name: "f.png", bytes: PNG }, meta()),
      ).rejects.toMatchObject({ code: "AI_DISABLED" });
    });

    it("sin clave de OpenAI pide configurarla", async () => {
      await expect(
        extractInvoiceFile(premium.admin, { name: "f.pdf", bytes: PDF }, meta()),
      ).rejects.toMatchObject({ code: "AI_NO_KEY" });
    });

    it("con clave llama al extractor, registra la corrida y el costo, y no guarda productos", async () => {
      await updateAiSettings(premium.admin, { apiKey: "sk-test-1234567890abcdef" }, meta());
      let seenModel = "";
      setInvoiceExtractorForTests((config) => {
        seenModel = config.model;
        return { name: "FAKE", extract: async () => fakeOutput() };
      });
      const preview = await extractInvoiceFile(
        premium.admin,
        { name: "factura.pdf", bytes: PDF },
        meta(),
      );
      expect(preview.mode).toBe("AI");
      expect(preview.rows[0]).toMatchObject({
        sku: "IA-001",
        quantity: 3,
        unitCost: 15,
        match: null,
      });
      expect(seenModel).toBe("gpt-4o-mini");
      const run = await admin.aiRun.findFirstOrThrow({
        where: { tenantId: premium.tenantId, kind: "OTHER" },
        orderBy: { startedAt: "desc" },
      });
      expect(run).toMatchObject({ status: "SUCCEEDED", simulated: false, promptTokens: 1500 });
      expect(Number(run.costUsd)).toBeGreaterThan(0);
      // Nunca se guarda el contenido del documento.
      expect(JSON.stringify(run.prompt)).not.toContain("factura de compra");
      expect(
        await admin.product.count({ where: { tenantId: premium.tenantId, sku: "IA-001" } }),
      ).toBe(0);
    });

    it("si el extractor falla, la corrida queda FAILED y el usuario recibe un mensaje claro", async () => {
      setInvoiceExtractorForTests(() => ({
        name: "FAKE",
        extract: async () => {
          throw new ExtractionError("La IA no devolvió datos legibles.");
        },
      }));
      await expect(
        extractInvoiceFile(premium.admin, { name: "f.png", bytes: PNG }, meta()),
      ).rejects.toMatchObject({ code: "IMPORT_FILE", message: /legibles/ });
      setInvoiceExtractorForTests(() => ({
        name: "FAKE",
        extract: async () => {
          throw new Error("503 de OpenAI con sk-secreto");
        },
      }));
      const failure = await extractInvoiceFile(
        premium.admin,
        { name: "f.png", bytes: PNG },
        meta(),
      ).then(
        () => null,
        (error: unknown) => error as { code: string; message: string },
      );
      expect(failure).toMatchObject({ code: "IMPORT_AI" });
      expect(failure?.message).not.toContain("sk-secreto");
      const failed = await admin.aiRun.count({
        where: { tenantId: premium.tenantId, kind: "OTHER", status: "FAILED" },
      });
      expect(failed).toBeGreaterThanOrEqual(2);
    });

    it("respeta el presupuesto mensual de IA", async () => {
      await admin.tenantSettings.update({
        where: { tenantId: premium.tenantId },
        data: { aiMonthlyCostCapUsd: "0.000001" },
      });
      setInvoiceExtractorForTests(() => ({ name: "FAKE", extract: async () => fakeOutput() }));
      await expect(
        extractInvoiceFile(premium.admin, { name: "f.pdf", bytes: PDF }, meta()),
      ).rejects.toMatchObject({ code: "AI_BUDGET" });
      await admin.tenantSettings.update({
        where: { tenantId: premium.tenantId },
        data: { aiMonthlyCostCapUsd: null },
      });
    });

    it("la cuenta demo usa el extractor simulado, sin clave ni consumo", async () => {
      const preview = await extractInvoiceFile(demoUser, { name: "f.pdf", bytes: PDF }, meta());
      expect(preview.mode).toBe("SIMULATED");
      expect(preview.rows.length).toBeGreaterThan(1);
      const run = await admin.aiRun.findFirstOrThrow({
        where: { tenantId: demoUser.tenantId ?? "", kind: "OTHER" },
      });
      expect(run).toMatchObject({ simulated: true, promptTokens: 0 });
      expect(Number(run.costUsd)).toBe(0);
    });
  });

  describe("confirmar la importación", () => {
    const balance = async (productId: string, warehouseId: string) =>
      Number(
        (await admin.stockBalance.findFirst({ where: { productId, warehouseId } }))?.quantity ?? 0,
      );

    it("crea productos nuevos y suma stock a los existentes por el kardex", async () => {
      const existing = await make(w.admin, plain({ sku: "IMP-EXIST", name: "Existente" }));
      const newSku = `IMP-${randomUUID().slice(0, 6)}`.toUpperCase();
      const result = await confirmCatalogImport(
        w.manager,
        {
          warehouseId: w.warehouseId,
          reference: "F001-555",
          idempotencyKey: key(),
          rows: [
            {
              sku: "IMP-EXIST",
              name: "Existente",
              quantity: 6,
              unitCost: 12,
              productId: existing.id,
            },
            {
              sku: newSku,
              name: "Pastillas importadas",
              quantity: 4,
              unitCost: 30,
              salePrice: 55,
              kind: "PART",
            },
          ],
        },
        meta(),
      );
      expect(result).toMatchObject({ created: 1, stocked: 1, failed: 0 });
      const created = await admin.product.findFirstOrThrow({
        where: { tenantId: w.tenantId, sku: newSku },
      });
      expect(created.kind).toBe("PART");
      expect(created.salePrice.toString()).toBe("55");
      expect(created.barcode).toSatisfy((code: string) => isValidEan13(code));
      expect(await balance(created.id, w.warehouseId)).toBe(4);
      expect(await balance(existing.id, w.warehouseId)).toBe(6);
      const movement = await admin.kardexMovement.findFirstOrThrow({
        where: { productId: created.id },
      });
      expect(movement).toMatchObject({ type: "PURCHASE" });
      expect(movement.unitCost?.toString()).toBe("30");
      expect(movement.reason).toContain("F001-555");
      const audit = await admin.auditLog.findFirst({
        where: { tenantId: w.tenantId, action: "catalog.import_confirmed" },
        orderBy: { occurredAt: "desc" },
      });
      expect(audit).toBeTruthy();
    });

    it("reintentar con la misma clave no duplica el stock", async () => {
      const sku = `IMP-${randomUUID().slice(0, 6)}`.toUpperCase();
      const idem = key();
      const input = {
        warehouseId: w.warehouseId,
        idempotencyKey: idem,
        rows: [{ sku, name: "Idempotente", quantity: 3, unitCost: 9, salePrice: 20 }],
      };
      await confirmCatalogImport(w.manager, input, meta());
      const second = await confirmCatalogImport(w.manager, input, meta());
      // La segunda vez el SKU ya existe: la fila falla sin tocar el stock.
      expect(second.failed).toBe(1);
      const product = await admin.product.findFirstOrThrow({
        where: { tenantId: w.tenantId, sku },
      });
      expect(await balance(product.id, w.warehouseId)).toBe(3);
      expect(await admin.kardexMovement.count({ where: { productId: product.id } })).toBe(1);
    });

    it("una fila con error no impide guardar las demás", async () => {
      const dup = await make(w.admin, plain());
      const good = `IMP-${randomUUID().slice(0, 6)}`.toUpperCase();
      const result = await confirmCatalogImport(
        w.manager,
        {
          warehouseId: w.warehouseId,
          idempotencyKey: key(),
          rows: [
            { sku: dup.sku, name: "SKU repetido", quantity: 1, unitCost: 1, salePrice: 5 },
            { sku: good, name: "Buena", quantity: 2, unitCost: 4, salePrice: 9 },
          ],
        },
        meta(),
      );
      expect(result).toMatchObject({ created: 1, failed: 1 });
      expect(result.rows[0]).toMatchObject({
        status: "ERROR",
        message: expect.stringContaining("SKU"),
      });
      expect(result.rows[1]?.status).toBe("CREATED");
    });

    it("no permite sumar stock a un producto con control por lote o serie", async () => {
      const llanta = await make(w.admin, tire());
      const result = await confirmCatalogImport(
        w.manager,
        {
          warehouseId: w.warehouseId,
          idempotencyKey: key(),
          rows: [
            { sku: llanta.sku, name: "Llanta", quantity: 1, unitCost: 1, productId: llanta.id },
          ],
        },
        meta(),
      );
      expect(result.rows[0]).toMatchObject({
        status: "ERROR",
        message: expect.stringContaining("lote o serie"),
      });
      expect(await balance(llanta.id, w.warehouseId)).toBe(0);
    });

    it("valida el almacén, los datos y los permisos", async () => {
      const base = {
        idempotencyKey: key(),
        rows: [{ sku: "ZZ-1", name: "Algo", quantity: 1, unitCost: 1, salePrice: 5 }],
      };
      await expect(
        confirmCatalogImport(w.manager, { ...base, warehouseId: randomUUID() }, meta()),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(
        confirmCatalogImport(w.manager, { ...base, warehouseId: other.warehouseId }, meta()),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(
        confirmCatalogImport(
          w.manager,
          { warehouseId: w.warehouseId, idempotencyKey: key(), rows: [] },
          meta(),
        ),
      ).rejects.toBeTruthy();
      await expect(
        confirmCatalogImport(w.cashier, { ...base, warehouseId: w.warehouseId }, meta()),
      ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    });

    it("el aislamiento por empresa impide sumar stock a un producto ajeno", async () => {
      const foreign = await make(other.admin, plain());
      const result = await confirmCatalogImport(
        w.manager,
        {
          warehouseId: w.warehouseId,
          idempotencyKey: key(),
          rows: [
            { sku: foreign.sku, name: "Ajeno", quantity: 1, unitCost: 1, productId: foreign.id },
          ],
        },
        meta(),
      );
      expect(result.rows[0]?.status).toBe("ERROR");
      expect(await balance(foreign.id, w.warehouseId)).toBe(0);
    });
  });

  describe("campos del formulario manual", () => {
    it("guarda compatibilidad con vehículos y código OEM", async () => {
      const product = await createProduct(
        w.admin,
        {
          ...plain(),
          minStock: 2,
          equivalences: [{ code: "OEM-12345", type: "OEM" }],
          compatibilities: [{ make: "Toyota", model: "Yaris", yearFrom: 2015, yearTo: 2020 }],
        },
        meta(),
      );
      expect(product.equivalences).toEqual([{ code: "OEM-12345", brand: null, type: "OEM" }]);
      expect(product.compatibilities[0]).toMatchObject({ make: "Toyota", model: "Yaris" });
    });
  });
});

void key;
