import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "@/lib/db/generated/client.ts";
import { validateRow } from "@/lib/ple/spec";
import { createSale } from "@/server/services/sales";
import {
  exportPle,
  listPurchaseInvoices,
  previewPle,
  registerPurchaseInvoice,
  voidPurchaseInvoice,
} from "@/server/services/ple";
import { configureAuthCache } from "@/server/services/session-resolver";
import { adminClient } from "../helpers/db.ts";
import { meta } from "../helpers/auth.ts";
import { make, plain } from "../helpers/inventory.ts";
import {
  openCash,
  posWorld,
  rucCustomer,
  saleKey,
  stockUp,
  type PosWorld,
} from "../helpers/pos.ts";

const RUC = "20100070970";

/** RUC válido (módulo 11) y único por ejecución para el RUC emisor del tenant. */
function issuerRuc(): string {
  const prefix = `20${Math.floor(10_000_000 + Math.random() * 89_999_999)}`;
  const factors = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
  const sum = factors.reduce((acc, f, i) => acc + f * Number(prefix[i]), 0);
  return `${prefix}${(11 - (sum % 11)) % 10}`;
}
const ISSUER = issuerRuc();
const OTHER_ISSUER = issuerRuc();
const LIMA_NOW = new Date(Date.now() - 5 * 3_600_000);
const YEAR = LIMA_NOW.getUTCFullYear();
const MONTH = LIMA_NOW.getUTCMonth() + 1;
const TODAY = LIMA_NOW.toISOString().slice(0, 10);

const invoice = (over: Record<string, unknown> = {}) => ({
  docTypeCode: "01" as const,
  series: "F777",
  number: String(Math.floor(Math.random() * 1e7)),
  issueDate: TODAY,
  supplierDocNumber: RUC,
  supplierName: "Repuestos del Sur SAC",
  taxedBase: "100.00",
  igv: "18.00",
  ...over,
});

const text = (file: { content: Buffer }) => file.content.toString("latin1");

describe("exportador PLE (14.1 y 8.1)", () => {
  let admin: PrismaClient;
  let w: PosWorld;
  let other: PosWorld;
  let customer: Awaited<ReturnType<typeof rucCustomer>> | undefined;

  const sellFactura = async (paymentMethod: "CASH" | "YAPE" = "CASH") => {
    const p = await make(w.admin, plain({ salePrice: 118 }));
    await stockUp(w, p.id, "10");
    customer ??= await rucCustomer(w.cashier, { docNumber: RUC });
    const sale = await createSale(
      w.cashier,
      {
        idempotencyKey: saleKey(),
        documentType: "FACTURA",
        customerId: customer.id,
        items: [{ productId: p.id, quantity: "1" }],
        payments: [{ method: paymentMethod, amount: "118" }],
      } as never,
      meta(),
    );
    return admin.fiscalDocument.findFirstOrThrow({ where: { saleId: sale.id } });
  };

  beforeAll(async () => {
    configureAuthCache(0);
    admin = adminClient();
    w = await posWorld(admin);
    other = await posWorld(admin);
    await admin.tenant.update({ where: { id: w.tenantId }, data: { taxId: ISSUER } });
    await admin.tenant.update({ where: { id: other.tenantId }, data: { taxId: OTHER_ISSUER } });
    await openCash(w.cashier);
    await openCash(other.cashier);
  }, 240_000);
  afterAll(async () => {
    await admin.$disconnect();
  });

  it("solo exporta comprobantes aceptados; los pendientes y rechazados quedan fuera y se avisan", async () => {
    const pending = await sellFactura();
    const accepted = await sellFactura("YAPE");
    const rejected = await sellFactura();
    await admin.fiscalDocument.update({ where: { id: accepted.id }, data: { status: "ACCEPTED" } });
    await admin.fiscalDocument.update({ where: { id: rejected.id }, data: { status: "REJECTED" } });
    // El proveedor simulado acepta al instante: se fuerza el estado de cada comprobante.
    await admin.fiscalDocument.update({ where: { id: pending.id }, data: { status: "PENDING" } });

    const preview = await previewPle(w.admin, { year: YEAR, month: MONTH });
    expect(preview.sales).toMatchObject({ rows: 1, excludedPending: 1, excludedRejected: 1 });
    expect(preview.ruc).toBe(ISSUER);

    const file = await exportPle(w.admin, { book: "14.1", year: YEAR, month: MONTH });
    expect(file.rows).toBe(1);
    expect(file.fileName).toBe(
      `LE${ISSUER}${YEAR}${String(MONTH).padStart(2, "0")}001401000011` + "11.TXT",
    );
    const lines = text(file).split("\r\n").filter(Boolean);
    expect(lines).toHaveLength(1);
    const fields = lines[0]!.split("|");
    expect(fields).toHaveLength(36);
    expect(validateRow("14.1", fields.slice(0, 35))).toEqual([]);
    expect(fields[5]).toBe("01");
    expect(fields[24]).toBe("118.00");
    // Pagado completamente con Yape: indicador de medio de pago bancarizado.
    expect(fields[33]).toBe("1");
  });

  it("un mes sin movimientos genera archivo vacío con indicador de contenido 0", async () => {
    const file = await exportPle(w.admin, { book: "14.1", year: 2020, month: 1 });
    expect(file.rows).toBe(0);
    expect(file.content).toHaveLength(0);
    expect(file.fileName).toBe(`LE${ISSUER}202001001401000010` + "11.TXT");
  });

  it("registra comprobantes de compra, los exporta y valida cada fila", async () => {
    const a = await registerPurchaseInvoice(w.admin, invoice(), meta());
    await registerPurchaseInvoice(w.admin, invoice({ givesTaxCredit: false }), meta());
    expect(
      (await listPurchaseInvoices(w.admin, { year: YEAR, month: MONTH })).map((i) => i.id),
    ).toContain(a.id);

    const file = await exportPle(w.admin, { book: "8.1", year: YEAR, month: MONTH });
    expect(file.rows).toBe(2);
    expect(file.fileName).toContain("08010000");
    for (const line of text(file).split("\r\n").filter(Boolean)) {
      const fields = line.split("|");
      expect(fields).toHaveLength(43);
      expect(validateRow("8.1", fields.slice(0, 42))).toEqual([]);
    }
    const audit = await admin.auditLog.count({
      where: { tenantId: w.tenantId, action: "ple.purchase_invoice.register" },
    });
    expect(audit).toBe(2);
  });

  it("no permite registrar dos veces el mismo comprobante de compra", async () => {
    const dup = invoice({ number: "DUP-1" });
    await registerPurchaseInvoice(w.admin, dup, meta());
    await expect(registerPurchaseInvoice(w.admin, dup, meta())).rejects.toMatchObject({
      code: "PLE_DUPLICATE",
    });
  });

  it("anular saca el comprobante del libro y deja el motivo en la auditoría", async () => {
    const created = await registerPurchaseInvoice(w.admin, invoice({ number: "VOID-1" }), meta());
    await voidPurchaseInvoice(w.admin, { id: created.id, reason: "Registrado por error" }, meta());
    expect(
      (await listPurchaseInvoices(w.admin, { year: YEAR, month: MONTH })).map((i) => i.id),
    ).not.toContain(created.id);
    const entry = await admin.auditLog.findFirstOrThrow({
      where: { tenantId: w.tenantId, action: "ple.purchase_invoice.void", entityId: created.id },
    });
    expect(entry.reason).toBe("Registrado por error");
    // Se puede volver a registrar tras anular (índice único parcial).
    await expect(
      registerPurchaseInvoice(w.admin, invoice({ number: "VOID-1" }), meta()),
    ).resolves.toBeTruthy();
  });

  it("rechaza datos inválidos: IGV inconsistente y RUC con dígito verificador malo", async () => {
    await expect(
      registerPurchaseInvoice(w.admin, invoice({ igv: "1.00" }), meta()),
    ).rejects.toThrow(/IGV/);
    await expect(
      registerPurchaseInvoice(w.admin, invoice({ supplierDocNumber: "20100070971" }), meta()),
    ).rejects.toThrow(/RUC/);
  });

  it("aislamiento multi-tenant: otro negocio no ve ni exporta comprobantes ajenos", async () => {
    const mine = await exportPle(w.admin, { book: "8.1", year: YEAR, month: MONTH });
    expect(mine.rows).toBeGreaterThan(0);
    const theirs = await exportPle(other.admin, { book: "8.1", year: YEAR, month: MONTH });
    expect(theirs.rows).toBe(0);
    expect((await previewPle(other.admin, { year: YEAR, month: MONTH })).sales.rows).toBe(0);
    expect(theirs.fileName).toContain(OTHER_ISSUER);
    expect(await listPurchaseInvoices(other.admin, { year: YEAR, month: MONTH })).toEqual([]);
    const stolen = await admin.purchaseInvoice.findFirstOrThrow({
      where: { tenantId: w.tenantId },
    });
    await expect(
      voidPurchaseInvoice(other.admin, { id: stolen.id, reason: "intento ajeno" }, meta()),
    ).rejects.toMatchObject({ code: "PLE_NOT_FOUND" });
  });

  it("permisos: sin reportes:ver no se exporta; sin compras:crear no se registra", async () => {
    await expect(
      exportPle(w.mechanic, { book: "14.1", year: YEAR, month: MONTH }),
    ).rejects.toMatchObject({
      code: "PERMISSION_DENIED",
    });
    await expect(previewPle(w.mechanic, { year: YEAR, month: MONTH })).rejects.toMatchObject({
      code: "PERMISSION_DENIED",
    });
    await expect(registerPurchaseInvoice(w.mechanic, invoice(), meta())).rejects.toMatchObject({
      code: "PERMISSION_DENIED",
    });
  });

  it("valida el periodo y el libro; exige RUC válido del emisor", async () => {
    await expect(exportPle(w.admin, { book: "9.9", year: YEAR, month: MONTH })).rejects.toThrow();
    await expect(exportPle(w.admin, { book: "14.1", year: YEAR, month: 13 })).rejects.toThrow();
    await admin.tenant.update({ where: { id: other.tenantId }, data: { taxId: "20100066604" } });
    await expect(
      exportPle(other.admin, { book: "14.1", year: YEAR, month: MONTH }),
    ).rejects.toMatchObject({
      code: "PLE_RUC",
    });
  });
});
