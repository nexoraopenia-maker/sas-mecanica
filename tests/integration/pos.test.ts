import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "@/lib/db/generated/client.ts";
import {
  ConflictError,
  InsufficientStockError,
  NotFoundError,
  PermissionDeniedError,
} from "@/lib/errors";
import {
  setInvoiceProviderForTests,
  SimulatedInvoiceProvider,
  type InvoiceProvider,
} from "@/server/integrations/invoicing";
import {
  addCashMovement,
  closeCashSession,
  getCurrentSession,
  openCashSession,
} from "@/server/services/cash";
import { dispatchDocument, dispatchPendingForTenant } from "@/server/services/billing";
import { createSale, getSale, returnSale, voidSale } from "@/server/services/sales";
import { configureAuthCache } from "@/server/services/session-resolver";
import { adminClient } from "../helpers/db.ts";
import { meta } from "../helpers/auth.ts";
import { battery, key, make, plain, tire } from "../helpers/inventory.ts";
import {
  dniCustomer,
  openCash,
  posWorld,
  rucCustomer,
  saleKey,
  stockUp,
  type PosWorld,
} from "../helpers/pos.ts";

describe("POS, caja y facturación", () => {
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
  const product = async (price = 118, extra: Record<string, unknown> = {}) => {
    const p = await make(w.admin, plain({ salePrice: price, ...extra }));
    await stockUp(w, p.id, "20");
    return p;
  };
  const sell = (
    items: Array<Record<string, unknown>>,
    over: Record<string, unknown> = {},
    user = w.cashier,
  ) => {
    const total = over.payTotal as string | undefined;
    return createSale(
      user,
      {
        idempotencyKey: saleKey(),
        documentType: "NOTA_VENTA",
        items,
        payments: [{ method: "CASH", amount: total ?? "118" }],
        ...over,
        payTotal: undefined,
      } as never,
      meta(),
    );
  };

  describe("caja", () => {
    it("una sola caja abierta por usuario y sucursal; otro usuario abre la suya", async () => {
      await expect(openCashSession(w.cashier, { openingAmount: 50 }, meta())).rejects.toMatchObject(
        { code: "CASH_ALREADY_OPEN" },
      );
      await expect(openCash(w.cashier2, 20)).resolves.toBeTruthy();
      expect(
        await admin.cashSession.count({
          where: { tenantId: w.tenantId, status: "OPEN", openedById: w.cashier.userId },
        }),
      ).toBe(1);
    });

    it("sin caja abierta no se vende", async () => {
      const p = await product();
      const user = other.cashier;
      await expect(sell([{ productId: p.id, quantity: "1" }], {}, user)).rejects.toBeInstanceOf(
        NotFoundError,
      );
      await expect(
        createSale(
          user,
          {
            idempotencyKey: saleKey(),
            documentType: "NOTA_VENTA",
            items: [{ description: "Servicio libre", quantity: "1", unitPrice: "50" }],
            payments: [{ method: "CASH", amount: "50" }],
          },
          meta(),
        ),
      ).rejects.toMatchObject({ code: "NO_CASH_SESSION" });
    });

    it("arqueo: esperado por medio de pago, diferencia con tolerancia y nota obligatoria; cerrada no vende", async () => {
      await openCash(other.cashier, 100);
      await admin.tenantSettings.update({
        where: { tenantId: other.tenantId },
        data: { cashTolerance: 1 },
      });
      const p = await make(other.admin, plain({ salePrice: 118 }));
      await stockUp(other, p.id, "10");
      await createSale(
        other.cashier,
        {
          idempotencyKey: saleKey(),
          documentType: "NOTA_VENTA",
          items: [{ productId: p.id, quantity: "1" }],
          payments: [
            { method: "CASH", amount: "50" },
            { method: "YAPE", amount: "68" },
          ],
        },
        meta(),
      );
      await addCashMovement(
        other.cashier,
        { type: "EXPENSE", amount: "10", reason: "Compra de útiles" },
        meta(),
      );
      await addCashMovement(
        other.cashier,
        { type: "INCOME", amount: "5", reason: "Sencillo" },
        meta(),
      );
      const current = await getCurrentSession(other.cashier);
      expect(current?.summary).toMatchObject({ expectedCash: "145.00" });
      expect(current?.summary.byMethod.YAPE).toBe("68.00");

      await expect(
        addCashMovement(
          other.cashier,
          { type: "EXPENSE", amount: "1000", reason: "Retiro" },
          meta(),
        ),
      ).rejects.toMatchObject({ code: "CASH_INSUFFICIENT" });
      const sessionId = current?.id as string;
      await expect(
        closeCashSession(other.cashier, { sessionId, counted: { CASH: "140" } }, meta()),
      ).rejects.toMatchObject({ code: "CASH_DIFFERENCE_NOTES" });
      const closed = await closeCashSession(
        other.cashier,
        { sessionId, counted: { CASH: "140", YAPE: "68" }, notes: "Faltó un sencillo de S/ 5" },
        meta(),
      );
      expect(closed.cashDifference).toBe("-5.00");
      const row = await admin.cashSession.findFirstOrThrow({ where: { id: sessionId } });
      expect(row).toMatchObject({ status: "CLOSED", openKey: null });
      expect(Number(row.difference)).toBe(-5);
      expect(
        await admin.auditLog.count({ where: { entityId: sessionId, action: "cash.closed" } }),
      ).toBe(1);
      await expect(
        closeCashSession(
          other.cashier,
          { sessionId, counted: { CASH: "140" }, notes: "otra vez" },
          meta(),
        ),
      ).rejects.toMatchObject({ code: "CASH_CLOSED" });
      await expect(
        sell([{ productId: p.id, quantity: "1" }], {}, other.cashier),
      ).rejects.toMatchObject({ code: "NO_CASH_SESSION" });
      // La diferencia dentro de la tolerancia no exige nota.
      await openCash(other.cashier, 10);
      const second = await getCurrentSession(other.cashier);
      await expect(
        closeCashSession(
          other.cashier,
          { sessionId: second?.id as string, counted: { CASH: "10.50" } },
          meta(),
        ),
      ).resolves.toBeTruthy();
    });

    it("solo cierra su caja quien la abrió (o quien tiene permiso de edición)", async () => {
      const mine = await getCurrentSession(w.cashier2);
      await expect(
        closeCashSession(
          w.cashier,
          { sessionId: mine?.id as string, counted: { CASH: "20" } },
          meta(),
        ),
      ).rejects.toBeInstanceOf(PermissionDeniedError);
    });
  });

  describe("venta de mostrador", () => {
    it("descarga el stock solo por el kardex, calcula el IGV y deja la venta auditada", async () => {
      const p = await product(118);
      const before = await balance(p.id);
      const sale = await sell([{ productId: p.id, quantity: "2" }], { payTotal: "236" });
      expect(await balance(p.id)).toBe(before - 2);
      const movements = await admin.kardexMovement.findMany({
        where: { productId: p.id, type: "SALE" },
      });
      expect(movements).toHaveLength(1);
      expect(movements[0]?.referenceId).toBe(sale.id);
      const detail = await getSale(w.cashier, sale.id);
      expect(detail).toMatchObject({
        subtotal: "200.00",
        taxTotal: "36.00",
        total: "236.00",
        paidTotal: "236.00",
        paymentStatus: "PAID",
      });
      expect(detail.items[0]?.unitPrice).toBe("118");
      expect(JSON.stringify(detail)).not.toMatch(/unitCost/); // el cajero no ve costos
      expect(
        await admin.auditLog.count({ where: { entityId: sale.id, action: "sale.created" } }),
      ).toBe(1);
      const sold = await admin.saleItem.findFirstOrThrow({ where: { saleId: sale.id } });
      expect(Number(sold.unitCost)).toBe(50);
      expect(sold.kardexMovementId).toBe(movements[0]?.id);
    });

    it("idempotente: repetir o competir con la misma clave no vende dos veces", async () => {
      const p = await product();
      const k = saleKey();
      const input = {
        idempotencyKey: k,
        documentType: "NOTA_VENTA",
        items: [{ productId: p.id, quantity: "1" }],
        payments: [{ method: "CASH", amount: "118" }],
      };
      const results = await Promise.all([
        createSale(w.cashier, input as never, meta()),
        createSale(w.cashier, input as never, meta()),
        createSale(w.cashier, input as never, meta()),
      ]);
      expect(new Set(results.map((r) => r.id)).size).toBe(1);
      expect(results.filter((r) => !r.replayed)).toHaveLength(1);
      expect(await balance(p.id)).toBe(19);
      expect((await createSale(w.cashier, input as never, meta())).replayed).toBe(true);
      expect(await admin.sale.count({ where: { tenantId: w.tenantId, idempotencyKey: k } })).toBe(
        1,
      );
    });

    it("dos ventas simultáneas de la última unidad: una pasa y el stock no queda negativo", async () => {
      const p = await make(w.admin, plain({ salePrice: 118 }));
      await stockUp(w, p.id, "1");
      const results = await Promise.allSettled([
        sell([{ productId: p.id, quantity: "1" }]),
        sell([{ productId: p.id, quantity: "1" }], {}, w.admin),
      ]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      const failed = results.find((r) => r.status === "rejected");
      expect((failed as PromiseRejectedResult).reason).toBeInstanceOf(InsufficientStockError);
      expect(await balance(p.id)).toBe(0);
      // La venta fallida no dejó nada a medias.
      expect(
        await admin.sale.count({
          where: { tenantId: w.tenantId, items: { some: { productId: p.id } } },
        }),
      ).toBe(1);
    });

    it("los pagos deben sumar el total; se admiten varios medios", async () => {
      const p = await product();
      await expect(
        sell([{ productId: p.id, quantity: "1" }], { payTotal: "100" }),
      ).rejects.toMatchObject({ code: "PAYMENT_MISMATCH" });
      await expect(
        sell([{ productId: p.id, quantity: "1" }], { payTotal: "200" }),
      ).rejects.toMatchObject({ code: "PAYMENT_EXCEEDS" });
      const ok = await sell([{ productId: p.id, quantity: "1" }], {
        payments: [
          { method: "CASH", amount: "18" },
          { method: "CARD", amount: "50" },
          { method: "YAPE", amount: "50" },
        ],
      });
      expect((await getSale(w.cashier, ok.id)).payments.map((x) => x.method).sort()).toEqual([
        "CARD",
        "CASH",
        "YAPE",
      ]);
      expect(await balance(p.id)).toBe(19);
    });

    it("descuentos: exigen permiso y respetan el tope del rol", async () => {
      const p = await product(100);
      const cashierSale = (discount: string) =>
        sell([{ productId: p.id, quantity: "1", discount }], {
          payTotal: String(100 - Number(discount)),
        });
      await expect(cashierSale("11")).rejects.toMatchObject({ code: "DISCOUNT_LIMIT" });
      await expect(cashierSale("10")).resolves.toBeTruthy();
      // El mecánico no tiene POS.
      await expect(
        createSale(
          w.mechanic,
          {
            idempotencyKey: saleKey(),
            items: [{ productId: p.id, quantity: "1" }],
            payments: [{ method: "CASH", amount: "100" }],
          },
          meta(),
        ),
      ).rejects.toBeInstanceOf(PermissionDeniedError);
      // El administrador llega al 100 %.
      await expect(
        sell([{ productId: p.id, quantity: "1", discount: "50" }], { payTotal: "50" }, w.admin),
      ).resolves.toBeTruthy();
    });

    it("el precio de un producto sale del catálogo: no se puede fijar al vender", async () => {
      const p = await product(100);
      await expect(
        sell([{ productId: p.id, quantity: "1", unitPrice: "1" }], { payTotal: "1" }),
      ).rejects.toThrow();
    });

    it("reglas SUNAT: factura exige RUC; boleta > S/ 700 exige cliente identificado", async () => {
      const p = await product(900);
      const input = (over: Record<string, unknown>) =>
        sell([{ productId: p.id, quantity: "1" }], {
          documentType: "BOLETA",
          payTotal: "900",
          ...over,
        });
      await expect(input({})).rejects.toMatchObject({ code: "DOC_RULE" });
      const dni = await dniCustomer(w.cashier);
      await expect(input({ documentType: "FACTURA", customerId: dni.id })).rejects.toMatchObject({
        code: "DOC_RULE",
      });
      await expect(input({ customerId: dni.id })).resolves.toMatchObject({
        documentNumber: expect.stringMatching(/^B001-/),
      });
      const ruc = await rucCustomer(w.cashier);
      const factura = await input({ documentType: "FACTURA", customerId: ruc.id });
      expect(factura.documentNumber).toMatch(/^F001-0000000\d$/);
    });

    it("el comprobante nace PENDING con su correlativo y se acepta al enviarse; correlativos consecutivos", async () => {
      const p = await product(59);
      const first = await sell([{ productId: p.id, quantity: "1" }], {
        documentType: "BOLETA",
        payTotal: "59",
      });
      const second = await sell([{ productId: p.id, quantity: "1" }], {
        documentType: "BOLETA",
        payTotal: "59",
      });
      const [a, b] = [first.documentNumber, second.documentNumber].map((n) =>
        Number(n?.split("-")[1]),
      );
      expect(b).toBe((a ?? 0) + 1);
      const doc = await admin.fiscalDocument.findFirstOrThrow({
        where: { id: first.documentId as string },
      });
      expect(doc).toMatchObject({
        status: "ACCEPTED",
        type: "BOLETA",
        series: "B001",
        docKey: `${first.id}:BOLETA`,
      });
      expect(doc.providerRef).toMatch(/^SIM-/);
      expect(Number(doc.subtotal) + Number(doc.taxTotal)).toBeCloseTo(Number(doc.total), 2);
    });

    it("un comprobante nunca se emite dos veces para la misma venta", async () => {
      const p = await product(59);
      const sale = await sell([{ productId: p.id, quantity: "1" }], {
        documentType: "BOLETA",
        payTotal: "59",
      });
      expect(await admin.fiscalDocument.count({ where: { saleId: sale.id } })).toBe(1);
      await expect(
        admin.fiscalDocument.create({
          data: {
            tenantId: w.tenantId,
            saleId: sale.id,
            docKey: `${sale.id}:BOLETA`,
            type: "BOLETA",
            series: "B001",
            correlative: 99999,
            issueDate: new Date(),
            currency: "PEN",
            customerSnapshot: {},
            itemsSnapshot: [],
            subtotal: 0,
            taxTotal: 0,
            total: 0,
          },
        }),
      ).rejects.toThrow();
    });

    it("batería por serie: exige las series, no se vende dos veces y emite garantía", async () => {
      const b = await make(w.admin, battery({ salePrice: 400 }));
      const policy = await admin.warrantyPolicy.create({
        data: { tenantId: w.tenantId, name: "Batería 12m", months: 12 },
      });
      await admin.product.update({ where: { id: b.id }, data: { warrantyPolicyId: policy.id } });
      const serial = `SN-${key().slice(-8)}`;
      await stockUp(w, b.id, "1", { quantity: undefined, serials: [serial] });
      await expect(
        sell([{ productId: b.id, quantity: "1" }], { payTotal: "400" }),
      ).rejects.toMatchObject({ code: "SERIAL_REQUIRED" });
      const dni = await dniCustomer(w.cashier);
      const sale = await sell([{ productId: b.id, quantity: "1", serials: [serial] }], {
        payTotal: "400",
        customerId: dni.id,
      });
      await expect(
        sell([{ productId: b.id, quantity: "1", serials: [serial] }], { payTotal: "400" }),
      ).rejects.toBeInstanceOf(ConflictError);
      const item = await admin.saleItem.findFirstOrThrow({
        where: { saleId: sale.id },
        include: { serial: true },
      });
      expect(item.serial?.serial).toBe(serial);
      const warranty = await admin.warranty.findFirstOrThrow({ where: { saleItemId: item.id } });
      expect(warranty).toMatchObject({
        source: "SALE_ITEM",
        status: "ACTIVE",
        serialId: item.serialId,
        customerId: dni.id,
      });
    });

    it("una venta que consume dos lotes (FEFO) reparte el importe sin perder céntimos", async () => {
      const t = await make(w.admin, tire({ salePrice: 333.33 }));
      await stockUp(w, t.id, "2", { lot: { code: "L-A", dotCode: "0123" } });
      await stockUp(w, t.id, "3", { lot: { code: "L-B", dotCode: "4524" } });
      const sale = await sell([{ productId: t.id, quantity: "4" }], { payTotal: "1333.32" });
      const items = await admin.saleItem.findMany({
        where: { saleId: sale.id },
        orderBy: { quantity: "asc" },
      });
      expect(items).toHaveLength(2);
      expect(items.map((i) => Number(i.quantity)).sort()).toEqual([2, 2]);
      expect(items.reduce((s, i) => s + Number(i.lineTotal), 0).toFixed(2)).toBe("1333.32");
      expect(new Set(items.map((i) => i.lotId)).size).toBe(2);
    });

    it("las líneas de servicio libre no mueven stock", async () => {
      const sale = await sell(
        [{ description: "Alineamiento y balanceo", quantity: "1", unitPrice: "80" }],
        { payTotal: "80" },
      );
      expect(await admin.kardexMovement.count({ where: { referenceId: sale.id } })).toBe(0);
    });

    it("otro tenant no puede ver ni anular la venta", async () => {
      const p = await product();
      const sale = await sell([{ productId: p.id, quantity: "1" }]);
      await expect(getSale(other.admin, sale.id)).rejects.toBeInstanceOf(NotFoundError);
      await expect(
        voidSale(other.admin, { saleId: sale.id, reason: "intento ajeno" }, meta()),
      ).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  describe("anulaciones y devoluciones", () => {
    it("anular: reingresa el stock por el kardex, reintegra el dinero, anula la garantía y emite la nota de crédito", async () => {
      const b = await make(w.admin, battery({ salePrice: 400 }));
      const policy = await admin.warrantyPolicy.create({
        data: { tenantId: w.tenantId, name: "Bat 6m", months: 6 },
      });
      await admin.product.update({ where: { id: b.id }, data: { warrantyPolicyId: policy.id } });
      const serial = `SN-${key().slice(-8)}`;
      await stockUp(w, b.id, "1", { quantity: undefined, serials: [serial] });
      const dni = await dniCustomer(w.cashier);
      const sale = await sell([{ productId: b.id, quantity: "1", serials: [serial] }], {
        documentType: "BOLETA",
        customerId: dni.id,
        payTotal: "400",
      });
      expect(await balance(b.id)).toBe(0);

      await expect(
        voidSale(w.cashier, { saleId: sale.id, reason: "El cliente se arrepintió" }, meta()),
      ).rejects.toBeInstanceOf(PermissionDeniedError);
      const before = await getCurrentSession(w.admin);
      const result = await voidSale(
        w.admin,
        { saleId: sale.id, reason: "El cliente se arrepintió" },
        meta(),
      );
      expect(result.noteId).toBeTruthy();
      expect(await balance(b.id)).toBe(1);
      expect(
        await admin.kardexMovement.count({
          where: { productId: b.id, type: "SALE_VOID", referenceId: sale.id },
        }),
      ).toBe(1);
      expect(
        (await admin.serialNumber.findFirstOrThrow({ where: { productId: b.id, serial } })).status,
      ).toBe("IN_STOCK");

      const detail = await getSale(w.admin, sale.id);
      expect(detail.status).toBe("VOIDED");
      expect(detail.payments.reduce((s, p) => s + Number(p.amount), 0)).toBe(0);
      const note = await admin.fiscalDocument.findFirstOrThrow({
        where: { id: result.noteId as string },
      });
      expect(note).toMatchObject({
        type: "NOTA_CREDITO",
        status: "ACCEPTED",
        noteReasonCode: "01",
        series: "BC01",
        total: expect.anything(),
      });
      expect(Number(note.total)).toBe(400);
      expect(note.relatedDocumentId).toBe(detail.documents.find((d) => d.type === "BOLETA")?.id);
      expect(
        (await admin.warranty.findFirstOrThrow({ where: { saleItem: { saleId: sale.id } } }))
          .status,
      ).toBe("VOID");
      const after = await getCurrentSession(w.admin);
      expect(Number(after?.summary.expectedCash)).toBe(Number(before?.summary.expectedCash) - 400);
      expect(
        await admin.auditLog.count({
          where: { entityId: sale.id, action: "sale.voided", reason: "El cliente se arrepintió" },
        }),
      ).toBe(1);

      // Idempotente: anular otra vez no devuelve nada dos veces.
      expect(
        (await voidSale(w.admin, { saleId: sale.id, reason: "El cliente se arrepintió" }, meta()))
          .replayed,
      ).toBe(true);
      expect(await balance(b.id)).toBe(1);
    });

    it("devolución parcial: reingresa lo devuelto, reembolsa en caja y no permite devolver de más", async () => {
      const p = await product(118);
      const sale = await sell([{ productId: p.id, quantity: "3" }], {
        documentType: "BOLETA",
        payTotal: "354",
        customerId: (await dniCustomer(w.cashier)).id,
      });
      const item = (await getSale(w.admin, sale.id)).items[0];
      const rk = saleKey();
      const ret = await returnSale(
        w.admin,
        {
          saleId: sale.id,
          idempotencyKey: rk,
          reason: "Dos unidades no sirven",
          resolution: "REFUND",
          items: [{ saleItemId: item?.id as string, quantity: "2", restock: true }],
        },
        meta(),
      );
      expect(ret).toMatchObject({ total: "236.00", cashRefund: "236.00", debtReduction: "0.00" });
      expect(await balance(p.id)).toBe(19);
      const note = await admin.fiscalDocument.findFirstOrThrow({
        where: { id: ret.noteId as string },
      });
      expect(note).toMatchObject({
        type: "NOTA_CREDITO",
        noteReasonCode: "07",
        status: "ACCEPTED",
      });
      expect(Number(note.total)).toBe(236);
      // Idempotente por clave.
      expect(
        (
          await returnSale(
            w.admin,
            {
              saleId: sale.id,
              idempotencyKey: rk,
              reason: "Dos unidades no sirven",
              resolution: "REFUND",
              items: [{ saleItemId: item?.id as string, quantity: "2", restock: true }],
            },
            meta(),
          )
        ).replayed,
      ).toBe(true);
      expect(await balance(p.id)).toBe(19);
      // Solo quedaba 1 por devolver.
      await expect(
        returnSale(
          w.admin,
          {
            saleId: sale.id,
            idempotencyKey: saleKey(),
            reason: "Una más de la cuenta",
            resolution: "REFUND",
            items: [{ saleItemId: item?.id as string, quantity: "2" }],
          },
          meta(),
        ),
      ).rejects.toMatchObject({ code: "RETURN_EXCEEDS" });
      // Devolver lo que queda cierra la venta con la nota de devolución total.
      const rest = await returnSale(
        w.admin,
        {
          saleId: sale.id,
          idempotencyKey: saleKey(),
          reason: "Devolución del resto",
          resolution: "REFUND",
          items: [{ saleItemId: item?.id as string, quantity: "1", restock: false }],
        },
        meta(),
      );
      expect(rest.total).toBe("118.00");
      expect(
        (await admin.fiscalDocument.findFirstOrThrow({ where: { id: rest.noteId as string } }))
          .noteReasonCode,
      ).toBe("06");
      expect(await balance(p.id)).toBe(19); // restock=false: el producto no volvió al stock
    });

    it("una devolución sin permiso o con «nota de crédito» sobre una venta al contado se rechaza", async () => {
      const p = await product();
      const sale = await sell([{ productId: p.id, quantity: "1" }]);
      const item = (await getSale(w.admin, sale.id)).items[0];
      const input = {
        saleId: sale.id,
        idempotencyKey: saleKey(),
        reason: "Producto equivocado",
        resolution: "CREDIT_NOTE" as const,
        items: [{ saleItemId: item?.id as string, quantity: "1" }],
      };
      await expect(returnSale(w.cashier, input, meta())).rejects.toBeInstanceOf(
        PermissionDeniedError,
      );
      await expect(returnSale(w.admin, input, meta())).rejects.toMatchObject({
        code: "CREDIT_NOTE_NO_DEBT",
      });
    });
  });

  describe("facturación electrónica", () => {
    const customProvider = (submit: InvoiceProvider["submit"]) =>
      setInvoiceProviderForTests(() => ({ name: "TEST", submit }));

    it("un rechazo del proveedor deja el comprobante visible, con alerta, y se reintenta con el MISMO correlativo", async () => {
      customProvider(async () => ({
        outcome: "REJECTED",
        providerRef: null,
        hash: null,
        xmlUrl: null,
        pdfUrl: null,
        cdrUrl: null,
        code: "2800",
        message: "RUC del receptor no existe",
      }));
      const p = await product(59);
      const sale = await sell([{ productId: p.id, quantity: "1" }], {
        documentType: "BOLETA",
        payTotal: "59",
      });
      const doc = await admin.fiscalDocument.findFirstOrThrow({
        where: { id: sale.documentId as string },
      });
      expect(doc).toMatchObject({ status: "REJECTED" });
      expect(doc.errorMessage).toContain("2800");
      expect(
        await admin.notification.count({
          where: { tenantId: w.tenantId, kind: "billing.rejected" },
        }),
      ).toBeGreaterThanOrEqual(1);
      const number = doc.correlative;

      setInvoiceProviderForTests(null);
      const { retryDocument } = await import("@/server/services/billing");
      expect(await retryDocument(w.admin, doc.id, meta())).toBe("ACCEPTED");
      expect(
        (await admin.fiscalDocument.findFirstOrThrow({ where: { id: doc.id } })).correlative,
      ).toBe(number);
    });

    it("un fallo transitorio reintenta con espera creciente, y al agotarse alerta sin perder el comprobante", async () => {
      let calls = 0;
      customProvider(async () => {
        calls += 1;
        const { InvoiceProviderError } = await import("@/server/integrations/invoicing");
        throw new InvoiceProviderError("El proveedor respondió 503", true);
      });
      const p = await product(59);
      const sale = await sell([{ productId: p.id, quantity: "1" }], {
        documentType: "BOLETA",
        payTotal: "59",
      });
      let doc = await admin.fiscalDocument.findFirstOrThrow({
        where: { id: sale.documentId as string },
      });
      expect(doc).toMatchObject({ status: "PENDING", attempts: 1 });
      expect(doc.nextRetryAt && doc.nextRetryAt.getTime()).toBeGreaterThan(Date.now());
      // Aún no toca: no se vuelve a llamar.
      expect(await dispatchDocument(w.tenantId, doc.id)).toBe("SKIPPED");
      expect(calls).toBe(1);

      let clock = Date.now();
      for (let attempt = 2; attempt <= 8; attempt += 1) {
        clock += 13 * 3_600_000;
        await dispatchPendingForTenant(w.tenantId, new Date(clock));
      }
      doc = await admin.fiscalDocument.findFirstOrThrow({ where: { id: doc.id } });
      expect(doc).toMatchObject({ status: "PENDING", attempts: 8, nextRetryAt: null });
      expect(
        await admin.notification.count({
          where: { tenantId: w.tenantId, kind: "billing.stuck", dedupeKey: `doc-stuck:${doc.id}` },
        }),
      ).toBe(1);
      // Con el proveedor recuperado, el reintento manual lo envía.
      setInvoiceProviderForTests(null);
      const { retryDocument } = await import("@/server/services/billing");
      expect(await retryDocument(w.admin, doc.id, meta())).toBe("ACCEPTED");
    });

    it("dos envíos simultáneos del mismo comprobante llaman al proveedor una sola vez", async () => {
      let calls = 0;
      setInvoiceProviderForTests(() => ({
        name: "TEST",
        submit: async (payload) => {
          calls += 1;
          return new SimulatedInvoiceProvider().submit(payload);
        },
      }));
      customProvider(async () => {
        const { InvoiceProviderError } = await import("@/server/integrations/invoicing");
        throw new InvoiceProviderError("caído", true);
      });
      const p = await product(59);
      const sale = await sell([{ productId: p.id, quantity: "1" }], {
        documentType: "BOLETA",
        payTotal: "59",
      });
      await admin.fiscalDocument.update({
        where: { id: sale.documentId as string },
        data: { nextRetryAt: null, attempts: 0 },
      });
      setInvoiceProviderForTests(() => ({
        name: "TEST",
        submit: async (payload) => {
          calls += 1;
          return new SimulatedInvoiceProvider().submit(payload);
        },
      }));
      calls = 0;
      const results = await Promise.all([
        dispatchDocument(w.tenantId, sale.documentId as string),
        dispatchDocument(w.tenantId, sale.documentId as string),
        dispatchDocument(w.tenantId, sale.documentId as string),
      ]);
      expect(results.filter((r) => r === "ACCEPTED")).toHaveLength(1);
      expect(calls).toBe(1);
    });

    it("sin proveedor configurado el comprobante queda PENDING sin consumir intentos", async () => {
      setInvoiceProviderForTests(null);
      await admin.tenantSettings.update({
        where: { tenantId: w.tenantId },
        data: { invoiceProvider: null },
      });
      const p = await product(59);
      const sale = await sell([{ productId: p.id, quantity: "1" }], {
        documentType: "BOLETA",
        payTotal: "59",
      });
      const doc = await admin.fiscalDocument.findFirstOrThrow({
        where: { id: sale.documentId as string },
      });
      expect(doc).toMatchObject({ status: "PENDING", attempts: 0 });
      await admin.tenantSettings.update({
        where: { tenantId: w.tenantId },
        data: { invoiceProvider: "SIMULATED" },
      });
      expect(await dispatchDocument(w.tenantId, doc.id)).toBe("ACCEPTED");
    });
  });
});
