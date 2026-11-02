import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "@/lib/db/generated/client.ts";
import { withTenant } from "@/lib/db";
import { ConflictError, PermissionDeniedError } from "@/lib/errors";
import { setInvoiceProviderForTests } from "@/server/integrations/invoicing";
import {
  getInvoiceSettings,
  issueDebitNote,
  updateInvoiceSettings,
} from "@/server/services/billing";
import { maintainTenantBilling } from "@/server/services/billing-maintenance";
import { createVehicle } from "@/server/services/vehicles";
import {
  collectReceivable,
  listReceivables,
  processReceivables,
} from "@/server/services/receivables";
import { setRoleDiscountLimit } from "@/server/services/roles";
import {
  convertQuoteToSale,
  convertQuoteToWorkOrder,
  createQuote,
  getQuote,
  listQuotes,
  setQuoteStatus,
} from "@/server/services/quotes";
import {
  convertWorkOrderToSale,
  createSale,
  getSale,
  returnSale,
  voidSale,
} from "@/server/services/sales";
import { configureAuthCache } from "@/server/services/session-resolver";
import { decideByToken, requestApproval } from "@/server/services/work-order-approval";
import {
  addItem,
  createWorkOrder,
  getWorkOrder,
  issuePart,
  markReady,
} from "@/server/services/work-orders";
import { adminClient } from "../helpers/db.ts";
import { meta } from "../helpers/auth.ts";
import { key, make, plain } from "../helpers/inventory.ts";
import {
  dniCustomer,
  openCash,
  posWorld,
  saleKey,
  stockUp,
  type PosWorld,
} from "../helpers/pos.ts";

describe("crédito, cotizaciones, OT y configuración de facturación", () => {
  let admin: PrismaClient;
  let w: PosWorld;
  let other: PosWorld;

  beforeAll(async () => {
    configureAuthCache(0);
    admin = adminClient();
    w = await posWorld(admin);
    other = await posWorld(admin);
    await openCash(w.cashier);
    await openCash(w.admin);
  }, 240_000);
  afterAll(async () => {
    setInvoiceProviderForTests(null);
    await admin.$disconnect();
  });

  const balance = async (productId: string) =>
    Number(
      (
        await admin.stockBalance.findFirst({
          where: { tenantId: w.tenantId, productId, warehouseId: w.warehouseId },
        })
      )?.quantity ?? 0,
    );
  const product = async (price = 118) => {
    const p = await make(w.admin, plain({ salePrice: price }));
    await stockUp(w, p.id, "50");
    return p;
  };
  const creditCustomer = async (limit = 500, days = 15) => {
    const customer = await dniCustomer(w.admin);
    await admin.customer.update({
      where: { id: customer.id },
      data: { creditLimit: limit, creditDays: days },
    });
    return customer;
  };
  const creditSale = async (customerId: string, productId: string, paid: string, qty = "1") =>
    createSale(
      w.cashier,
      {
        idempotencyKey: saleKey(),
        documentType: "BOLETA",
        customerId,
        isCredit: true,
        items: [{ productId, quantity: qty }],
        payments: paid === "0" ? [] : [{ method: "CASH", amount: paid }],
      },
      meta(),
    );
  const receivableOf = (saleId: string) => admin.receivable.findFirstOrThrow({ where: { saleId } });

  describe("ventas a crédito y cuentas por cobrar", () => {
    it("exige línea de crédito y la respeta; el anticipo deja la venta PARTIAL con su deuda", async () => {
      const p = await product(118);
      const none = await dniCustomer(w.admin);
      await expect(creditSale(none.id, p.id, "0")).rejects.toMatchObject({ code: "NO_CREDIT" });
      const customer = await creditCustomer(500, 15);
      await expect(
        createSale(
          w.cashier,
          {
            idempotencyKey: saleKey(),
            isCredit: true,
            items: [{ productId: p.id, quantity: "1" }],
            payments: [],
          },
          meta(),
        ),
      ).rejects.toThrow();
      const sale = await creditSale(customer.id, p.id, "18");
      expect(sale.paymentStatus).toBe("PARTIAL");
      const receivable = await receivableOf(sale.id);
      expect(receivable).toMatchObject({ status: "PARTIAL", customerId: customer.id });
      expect(Number(receivable.total)).toBe(118);
      expect(Number(receivable.balance)).toBe(100);
      const days = Math.round((receivable.dueDate.getTime() - Date.now()) / 86_400_000);
      expect(days).toBe(15);
      await expect(creditSale(customer.id, p.id, "0", "4")).rejects.toMatchObject({
        code: "CREDIT_LIMIT",
      });
      // Un crédito sin saldo no es crédito.
      await expect(creditSale(customer.id, p.id, "118")).rejects.toMatchObject({
        code: "CREDIT_NO_BALANCE",
      });
    });

    it("cobros parciales: caja abierta, idempotentes, sin sobrepasar el saldo ni siquiera en paralelo", async () => {
      const p = await product(118);
      const customer = await creditCustomer(1000);
      const sale = await creditSale(customer.id, p.id, "0");
      const receivable = await receivableOf(sale.id);
      const pay = (amount: string, k = key(), user = w.cashier) =>
        collectReceivable(
          user,
          { receivableId: receivable.id, idempotencyKey: k, method: "YAPE", amount },
          meta(),
        );

      const k = key();
      expect(await pay("40", k)).toMatchObject({ balance: "78.00", replayed: false });
      expect(await pay("40", k)).toMatchObject({ balance: "78.00", replayed: true });
      await expect(pay("79")).rejects.toMatchObject({ code: "PAYMENT_EXCEEDS" });
      const results = await Promise.allSettled([pay("30"), pay("30"), pay("30")]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(2);
      const row = await receivableOf(sale.id);
      expect(Number(row.balance)).toBe(18);
      expect(row.status).not.toBe("PAID");
      await pay("18");
      const closed = await receivableOf(sale.id);
      expect(closed).toMatchObject({ status: "PAID" });
      expect(Number(closed.balance)).toBe(0);
      const detail = await getSale(w.cashier, sale.id);
      expect(detail).toMatchObject({ paymentStatus: "PAID", paidTotal: "118.00" });
      await expect(pay("1")).rejects.toMatchObject({ code: "RECEIVABLE_CLOSED" });
      // Sin caja abierta no se cobra.
      await expect(
        collectReceivable(
          other.cashier,
          { receivableId: receivable.id, idempotencyKey: key(), method: "CASH", amount: "1" },
          meta(),
        ),
      ).rejects.toThrow();
    });

    it("el job marca vencidas, alerta al personal y recuerda al cliente una sola vez por semana", async () => {
      const p = await product(118);
      const customer = await creditCustomer(1000, 5);
      const sale = await creditSale(customer.id, p.id, "0");
      const receivable = await receivableOf(sale.id);
      await admin.receivable.update({
        where: { id: receivable.id },
        data: { dueDate: new Date(Date.now() - 40 * 86_400_000) },
      });
      const first = await withTenant(w.tenantId, (tx) => processReceivables(tx, new Date()));
      expect(first.overdue).toBeGreaterThanOrEqual(1);
      expect((await receivableOf(sale.id)).status).toBe("OVERDUE");
      expect(
        await admin.notification.count({
          where: { tenantId: w.tenantId, dedupeKey: `receivable-overdue:${receivable.id}` },
        }),
      ).toBe(1);
      await withTenant(w.tenantId, (tx) => processReceivables(tx, new Date()));
      expect(
        await admin.outboundMessage.count({
          where: { tenantId: w.tenantId, relatedId: receivable.id },
        }),
      ).toBe(1);
      const list = await listReceivables(w.cashier, { customerId: customer.id });
      expect(list.items[0]).toMatchObject({ bucket: "D31_60" });
      expect(list.aging.D31_60).toBe("118.00");
      expect(list.totalOutstanding).toBe("118.00");
      await expect(maintainTenantBilling(w.tenantId)).resolves.toBeTruthy();
    });

    it("la devolución baja primero la deuda; anular una venta a crédito cancela la cuenta", async () => {
      const p = await product(118);
      const customer = await creditCustomer(2000);
      const sale = await creditSale(customer.id, p.id, "0", "3");
      const item = (await getSale(w.admin, sale.id)).items[0];
      const ret = await returnSale(
        w.admin,
        {
          saleId: sale.id,
          idempotencyKey: saleKey(),
          reason: "Una unidad defectuosa",
          resolution: "CREDIT_NOTE",
          items: [{ saleItemId: item?.id as string, quantity: "1" }],
        },
        meta(),
      );
      expect(ret).toMatchObject({ debtReduction: "118.00", cashRefund: "0.00" });
      expect(Number((await receivableOf(sale.id)).balance)).toBe(236);
      expect(await balance(p.id)).toBe(48);
      await voidSale(w.admin, { saleId: sale.id, reason: "Se canceló el pedido" }, meta()).catch(
        (error: unknown) => error,
      );
      // Con devoluciones previas no se anula completa.
      await expect(
        voidSale(w.admin, { saleId: sale.id, reason: "Se canceló el pedido" }, meta()),
      ).rejects.toMatchObject({ code: "SALE_HAS_RETURNS" });

      const other2 = await creditSale(customer.id, p.id, "50");
      await voidSale(w.admin, { saleId: other2.id, reason: "Pedido duplicado" }, meta());
      expect(await receivableOf(other2.id)).toMatchObject({ status: "WRITTEN_OFF" });
      expect(Number((await receivableOf(other2.id)).balance)).toBe(0);
    });

    it("la nota de débito sobre un comprobante aceptado se suma a la deuda", async () => {
      const p = await product(118);
      const customer = await creditCustomer(2000);
      const sale = await creditSale(customer.id, p.id, "0");
      const k = key();
      const note = await issueDebitNote(
        w.admin,
        {
          documentId: sale.documentId as string,
          idempotencyKey: k,
          reasonCode: "01",
          description: "Intereses por mora",
          amount: "11.80",
        },
        meta(),
      );
      expect(note.number).toMatch(/^BD01-/);
      expect(note.dispatch).toBe("ACCEPTED");
      const again = await issueDebitNote(
        w.admin,
        {
          documentId: sale.documentId as string,
          idempotencyKey: k,
          reasonCode: "01",
          description: "Intereses por mora",
          amount: "11.80",
        },
        meta(),
      );
      expect(again.id).toBe(note.id);
      const receivable = await receivableOf(sale.id);
      expect(Number(receivable.total)).toBe(129.8);
      expect(Number(receivable.balance)).toBe(129.8);
      await expect(
        issueDebitNote(
          w.cashier,
          {
            documentId: sale.documentId as string,
            idempotencyKey: key(),
            reasonCode: "01",
            description: "Otra",
            amount: "1",
          },
          meta(),
        ),
      ).rejects.toBeInstanceOf(PermissionDeniedError);
    });
  });

  describe("cotizaciones", () => {
    it("se convierte en venta respetando el precio cotizado aunque el catálogo cambie; no se convierte dos veces", async () => {
      const p = await product(100);
      const quote = await createQuote(
        w.cashier,
        {
          validDays: 7,
          items: [
            { productId: p.id, quantity: "2", discount: "10" },
            { description: "Mano de obra", quantity: "1", unitPrice: "50", isLabor: true },
          ],
        },
        meta(),
      );
      expect(quote.total).toBe("240.00");
      await admin.product.update({ where: { id: p.id }, data: { salePrice: 200 } });
      await setQuoteStatus(w.cashier, quote.id, "SENT", meta());
      const sale = await convertQuoteToSale(
        w.cashier,
        {
          quoteId: quote.id,
          idempotencyKey: saleKey(),
          documentType: "NOTA_VENTA",
          payments: [{ method: "CASH", amount: "240" }],
        },
        meta(),
      );
      expect(sale.total).toBe("240.00");
      expect(await balance(p.id)).toBe(48);
      expect((await getQuote(w.cashier, quote.id)).status).toBe("CONVERTED");
      expect((await admin.sale.findFirstOrThrow({ where: { id: sale.id } })).quoteId).toBe(
        quote.id,
      );
      await expect(
        convertQuoteToSale(
          w.cashier,
          {
            quoteId: quote.id,
            idempotencyKey: saleKey(),
            documentType: "NOTA_VENTA",
            payments: [{ method: "CASH", amount: "240" }],
          },
          meta(),
        ),
      ).rejects.toMatchObject({ code: "QUOTE_CONVERTED" });
    });

    it("el descuento de una cotización respeta el tope del rol; las vencidas no se convierten", async () => {
      const p = await product(100);
      await expect(
        createQuote(
          w.cashier,
          { items: [{ productId: p.id, quantity: "1", discount: "11" }] },
          meta(),
        ),
      ).rejects.toMatchObject({ code: "DISCOUNT_LIMIT" });
      const quote = await createQuote(
        w.cashier,
        { items: [{ productId: p.id, quantity: "1" }] },
        meta(),
      );
      await admin.quote.update({
        where: { id: quote.id },
        data: { validUntil: new Date(Date.now() - 1000) },
      });
      expect((await listQuotes(w.cashier)).find((q) => q.id === quote.id)?.status).toBe("EXPIRED");
      await expect(
        convertQuoteToSale(
          w.cashier,
          {
            quoteId: quote.id,
            idempotencyKey: saleKey(),
            documentType: "NOTA_VENTA",
            payments: [{ method: "CASH", amount: "100" }],
          },
          meta(),
        ),
      ).rejects.toMatchObject({ code: "QUOTE_EXPIRED" });
      const rejected = await createQuote(
        w.cashier,
        { items: [{ productId: p.id, quantity: "1" }] },
        meta(),
      );
      await setQuoteStatus(w.cashier, rejected.id, "REJECTED", meta());
      await expect(
        convertQuoteToSale(
          w.cashier,
          {
            quoteId: rejected.id,
            idempotencyKey: saleKey(),
            documentType: "NOTA_VENTA",
            payments: [{ method: "CASH", amount: "100" }],
          },
          meta(),
        ),
      ).rejects.toMatchObject({ code: "QUOTE_STATE" });
    });

    it("una cotización con series pide las series al convertir", async () => {
      const b = await make(
        w.admin,
        (await import("../helpers/inventory.ts")).battery({ salePrice: 400 }),
      );
      const serial = `SN-${key().slice(-8)}`;
      await stockUp(w, b.id, "1", { quantity: undefined, serials: [serial] });
      const quote = await createQuote(
        w.cashier,
        { items: [{ productId: b.id, quantity: "1" }] },
        meta(),
      );
      const input = {
        quoteId: quote.id,
        idempotencyKey: saleKey(),
        documentType: "NOTA_VENTA" as const,
        payments: [{ method: "CARD" as const, amount: "400" }],
      };
      await expect(convertQuoteToSale(w.cashier, input, meta())).rejects.toMatchObject({
        code: "SERIAL_REQUIRED",
      });
      const item = (await getQuote(w.cashier, quote.id)).items[0];
      await expect(
        convertQuoteToSale(
          w.cashier,
          { ...input, lines: [{ quoteItemId: item?.id as string, serials: [serial] }] },
          meta(),
        ),
      ).resolves.toMatchObject({ total: "400.00" });
    });

    it("se convierte en OT con los ítems ya aprobados y listos para el taller", async () => {
      const part = await product(59);
      const customer = await dniCustomer(w.admin);
      const plate = `Q${key()
        .replace(/[^a-z0-9]/gi, "")
        .slice(0, 5)
        .toUpperCase()}`;
      const vehicle = await createVehicle(
        w.admin,
        { customerId: customer.id, plate, make: "Toyota" },
        meta(),
      );
      const quote = await createQuote(
        w.admin,
        {
          customerId: customer.id,
          vehicleId: vehicle.id,
          items: [
            { productId: part.id, quantity: "2" },
            { description: "Cambio de pastillas", quantity: "1", unitPrice: "118", isLabor: true },
          ],
        },
        meta(),
      );
      await expect(
        convertQuoteToWorkOrder(w.cashier, { quoteId: quote.id, mileageIn: 1000 }, meta()),
      ).rejects.toBeInstanceOf(PermissionDeniedError);
      const order = await convertQuoteToWorkOrder(
        w.admin,
        { quoteId: quote.id, mileageIn: 1000, fuelLevelEighths: 3 },
        meta(),
      );
      const detail = await getWorkOrder(w.admin, order.id);
      expect(detail.status).toBe("AWAITING_PARTS");
      expect(detail.items.every((i) => i.approvalStatus === "APPROVED")).toBe(true);
      expect(detail.approvalMethod).toBe("QUOTE");
      expect(Number(detail.total)).toBeCloseTo(Number(quote.total), 1);
      const partItem = detail.items.find((i) => i.type === "PART");
      await expect(
        issuePart(w.manager, order.id, partItem?.id as string, {}, meta()),
      ).resolves.toMatchObject({ replayed: false });
      expect((await getQuote(w.admin, quote.id)).status).toBe("CONVERTED");
      await expect(
        convertQuoteToWorkOrder(w.admin, { quoteId: quote.id, mileageIn: 1000 }, meta()),
      ).rejects.toMatchObject({ code: "QUOTE_CONVERTED" });
    });
  });

  describe("OT → venta", () => {
    const readyOrder = async () => {
      const part = await product(40);
      const reception = await createWorkOrder(
        w.admin,
        {
          plate: `W${key()
            .replace(/[^a-z0-9]/gi, "")
            .slice(0, 5)
            .toUpperCase()}`,
          newCustomer: {
            docType: "DNI",
            docNumber: String(Math.floor(10_000_000 + Math.random() * 89_999_999)),
            name: "Cliente OT",
            whatsapp: "987654321",
            whatsappOptIn: true,
          },
          mileageIn: 1000,
          fuelLevelEighths: 4,
          complaint: "Mantenimiento general",
        },
        meta(),
      );
      const item = await addItem(
        w.admin,
        reception.id,
        { type: "PART", productId: part.id, quantity: "2" },
        meta(),
      );
      await addItem(
        w.admin,
        reception.id,
        { type: "LABOR", description: "Mano de obra", quantity: "1", unitPrice: "80" },
        meta(),
      );
      const { link } = await requestApproval(w.admin, reception.id, meta());
      await decideByToken(
        { token: link.split("/aprobar/")[1] as string, decision: "APPROVE", name: "Cliente OT" },
        meta(),
      );
      await issuePart(w.manager, reception.id, item.id, {}, meta());
      await markReady(w.admin, reception.id, meta());
      return { id: reception.id, partId: part.id };
    };

    it("factura la cuenta mixta SIN volver a descontar stock; una OT no se factura dos veces", async () => {
      const { id, partId } = await readyOrder();
      const stockAfterOt = await balance(partId);
      const detail = await getWorkOrder(w.admin, id);
      expect(detail.total).toBe("188.80");
      const sale = await convertWorkOrderToSale(
        w.admin,
        {
          workOrderId: id,
          idempotencyKey: saleKey(),
          documentType: "BOLETA",
          payments: [{ method: "CARD", amount: "188.80" }],
        },
        meta(),
      );
      expect(sale.total).toBe("188.80");
      expect(await balance(partId)).toBe(stockAfterOt);
      expect(await admin.kardexMovement.count({ where: { productId: partId, type: "SALE" } })).toBe(
        0,
      );
      const items = await admin.saleItem.findMany({ where: { saleId: sale.id } });
      const partItem = items.find((i) => i.productId === partId);
      const otMovement = await admin.workOrderItem.findFirstOrThrow({
        where: { workOrderId: id, type: "PART" },
      });
      expect(partItem?.kardexMovementId).toBe(otMovement.consumptionMovementId);
      expect(Number(partItem?.unitCost)).toBe(50);
      const saleRow = await admin.sale.findFirstOrThrow({ where: { id: sale.id } });
      expect(saleRow.workOrderId).toBe(id);
      await expect(
        convertWorkOrderToSale(
          w.admin,
          {
            workOrderId: id,
            idempotencyKey: saleKey(),
            documentType: "BOLETA",
            payments: [{ method: "CASH", amount: "188.80" }],
          },
          meta(),
        ),
      ).rejects.toMatchObject({ code: "WO_ALREADY_SOLD" });
      // Anular la venta de una OT no devuelve al stock lo que consumió la OT.
      await voidSale(w.admin, { saleId: sale.id, reason: "Cobro registrado dos veces" }, meta());
      expect(await balance(partId)).toBe(stockAfterOt);
      expect(
        await admin.kardexMovement.count({ where: { productId: partId, type: "SALE_VOID" } }),
      ).toBe(0);
    });

    it("solo se factura una OT lista o entregada y con los repuestos entregados", async () => {
      const part = await product(40);
      const reception = await createWorkOrder(
        w.admin,
        {
          plate: `X${key()
            .replace(/[^a-z0-9]/gi, "")
            .slice(0, 5)
            .toUpperCase()}`,
          newCustomer: {
            docType: "DNI",
            docNumber: String(Math.floor(10_000_000 + Math.random() * 89_999_999)),
            name: "Cliente X",
          },
          mileageIn: 10,
          fuelLevelEighths: 2,
          complaint: "Revisión",
        },
        meta(),
      );
      await addItem(
        w.admin,
        reception.id,
        { type: "PART", productId: part.id, quantity: "1" },
        meta(),
      );
      await expect(
        convertWorkOrderToSale(
          w.admin,
          {
            workOrderId: reception.id,
            idempotencyKey: saleKey(),
            documentType: "BOLETA",
            payments: [{ method: "CASH", amount: "47.20" }],
          },
          meta(),
        ),
      ).rejects.toMatchObject({ code: "WO_STATE" });
    });
  });

  describe("configuración y límites", () => {
    const settings = (over: Record<string, unknown> = {}) => ({
      provider: "HTTP",
      baseUrl: "https://8.8.8.8/api",
      token: "tok-secreto-12345",
      clearToken: false,
      boletaSeries: "B001",
      facturaSeries: "F001",
      creditNoteBoletaSeries: "BC01",
      creditNoteFacturaSeries: "FC01",
      debitNoteBoletaSeries: "BD01",
      debitNoteFacturaSeries: "FD01",
      saleNoteSeries: "NV01",
      defaultCreditDays: 30,
      cashTolerance: 1,
      ...over,
    });

    it("el token del proveedor se guarda cifrado, se muestra enmascarado y nunca se audita", async () => {
      await updateInvoiceSettings(w.admin, settings() as never, meta());
      const stored = await admin.tenantSettings.findFirstOrThrow({
        where: { tenantId: w.tenantId },
      });
      expect(stored.invoiceConfigEncrypted).toMatch(/^v1:/);
      expect(stored.invoiceConfigEncrypted).not.toContain("tok-secreto");
      const view = await getInvoiceSettings(w.admin);
      expect(view).toMatchObject({
        provider: "HTTP",
        baseUrl: "https://8.8.8.8/api",
        tokenMask: "••••••••2345",
      });
      expect(JSON.stringify(view)).not.toContain("tok-secreto");
      const audit = await admin.auditLog.findMany({
        where: { tenantId: w.tenantId, action: "billing.settings_changed" },
      });
      expect(JSON.stringify(audit)).not.toContain("tok-secreto");
      // Guardar sin token conserva el anterior.
      await updateInvoiceSettings(w.admin, settings({ token: undefined }) as never, meta());
      expect((await getInvoiceSettings(w.admin)).tokenMask).toBe("••••••••2345");
      await updateInvoiceSettings(w.admin, settings({ provider: "SIMULATED" }) as never, meta());
      expect((await getInvoiceSettings(w.admin)).baseUrl).toBeNull();
    });

    it("rechaza URLs privadas, series inválidas y a quien no tiene permiso", async () => {
      await expect(
        updateInvoiceSettings(
          w.admin,
          settings({ baseUrl: "https://10.0.0.5/api" }) as never,
          meta(),
        ),
      ).rejects.toMatchObject({ code: "INVOICE_URL" });
      await expect(
        updateInvoiceSettings(
          w.admin,
          settings({ baseUrl: "http://8.8.8.8/api" }) as never,
          meta(),
        ),
      ).rejects.toMatchObject({ code: "INVOICE_URL" });
      await expect(
        updateInvoiceSettings(w.admin, settings({ boletaSeries: "B1" }) as never, meta()),
      ).rejects.toThrow();
      await expect(
        updateInvoiceSettings(w.cashier, settings() as never, meta()),
      ).rejects.toBeInstanceOf(PermissionDeniedError);
    });

    it("una cuenta demo nunca usa un proveedor real, aunque tenga uno configurado", async () => {
      await admin.tenant.update({
        where: { id: other.tenantId },
        data: { isDemo: true, demoExpiresAt: new Date(Date.now() + 3_600_000) },
      });
      await updateInvoiceSettings(other.admin, settings() as never, meta());
      const kinds: string[] = [];
      setInvoiceProviderForTests((config) => {
        kinds.push(config.kind);
        return {
          name: "TEST",
          submit: async () => ({
            outcome: "ACCEPTED",
            providerRef: "x",
            hash: null,
            xmlUrl: null,
            pdfUrl: null,
            cdrUrl: null,
            code: "0",
            message: null,
          }),
        };
      });
      await openCash(other.cashier);
      const p = await make(other.admin, plain({ salePrice: 59 }));
      await stockUp(other, p.id, "5");
      await createSale(
        other.cashier,
        {
          idempotencyKey: saleKey(),
          documentType: "BOLETA",
          items: [{ productId: p.id, quantity: "1" }],
          payments: [{ method: "CASH", amount: "59" }],
        },
        meta(),
      );
      expect(kinds).toEqual(["SIMULATED"]);
      setInvoiceProviderForTests(null);
    });

    it("sin RUC emisor no se emite (y la venta se revierte); una demo usa un RUC ficticio", async () => {
      const w3 = await posWorld(admin);
      await admin.tenant.update({ where: { id: w3.tenantId }, data: { taxId: null } });
      await openCash(w3.cashier);
      const p = await make(w3.admin, plain({ salePrice: 59 }));
      await stockUp(w3, p.id, "5");
      const input = () => ({
        idempotencyKey: saleKey(),
        documentType: "BOLETA" as const,
        items: [{ productId: p.id, quantity: "1" }],
        payments: [{ method: "CASH" as const, amount: "59" }],
      });
      await expect(createSale(w3.cashier, input(), meta())).rejects.toMatchObject({
        code: "ISSUER_RUC",
      });
      expect(await admin.sale.count({ where: { tenantId: w3.tenantId } })).toBe(0);
      expect(
        Number(
          (
            await admin.stockBalance.findFirstOrThrow({
              where: { tenantId: w3.tenantId, productId: p.id },
            })
          ).quantity,
        ),
      ).toBe(5);

      await admin.tenant.update({
        where: { id: w3.tenantId },
        data: { isDemo: true, demoExpiresAt: new Date(Date.now() + 3_600_000) },
      });
      const rucs: string[] = [];
      setInvoiceProviderForTests(() => ({
        name: "TEST",
        submit: async (payload) => {
          rucs.push(payload.issuer.ruc);
          return {
            outcome: "ACCEPTED",
            providerRef: "x",
            hash: null,
            xmlUrl: null,
            pdfUrl: null,
            cdrUrl: null,
            code: "0",
            message: null,
          };
        },
      }));
      await createSale(w3.cashier, input(), meta());
      expect(rucs).toEqual(["00000000000"]);
      setInvoiceProviderForTests(null);
    });

    it("el tope de descuento del rol se edita con auditoría; el de Administrador es inmutable", async () => {
      const cashierRole = await admin.role.findFirstOrThrow({
        where: { tenantId: w.tenantId, key: "cashier" },
      });
      const adminRole = await admin.role.findFirstOrThrow({
        where: { tenantId: w.tenantId, key: "admin" },
      });
      expect(Number(cashierRole.maxDiscountPercent)).toBe(10);
      expect(Number(adminRole.maxDiscountPercent)).toBe(100);
      await setRoleDiscountLimit(w.admin, cashierRole.id, 5, meta());
      expect(
        Number(
          (await admin.role.findFirstOrThrow({ where: { id: cashierRole.id } })).maxDiscountPercent,
        ),
      ).toBe(5);
      expect(
        await admin.auditLog.count({
          where: { entityId: cashierRole.id, action: "role.discount_limit_changed" },
        }),
      ).toBe(1);
      await expect(setRoleDiscountLimit(w.admin, adminRole.id, 50, meta())).rejects.toBeInstanceOf(
        ConflictError,
      );
      await expect(setRoleDiscountLimit(w.admin, cashierRole.id, 101, meta())).rejects.toThrow();
      await expect(
        setRoleDiscountLimit(w.cashier, cashierRole.id, 100, meta()),
      ).rejects.toBeInstanceOf(PermissionDeniedError);
    });
  });
});
