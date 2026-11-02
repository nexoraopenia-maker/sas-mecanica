import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "@/lib/db/generated/client.ts";
import {
  ConflictError,
  InsufficientStockError,
  NotFoundError,
  PermissionDeniedError,
} from "@/lib/errors";
import { registerStockIn } from "@/server/services/inventory";
import {
  acceptQuote,
  cancelPurchaseOrder,
  createPurchaseOrder,
  createSupplierReturn,
  listPurchaseOrders,
  markInTransit,
  receivePurchaseOrder,
  sendPurchaseOrder,
} from "@/server/services/purchasing";
import { configureAuthCache } from "@/server/services/session-resolver";
import {
  createSupplier,
  deleteSupplier,
  listSupplierProducts,
  listSuppliers,
  updateSupplier,
  upsertSupplierProduct,
} from "@/server/services/suppliers";
import { adminClient } from "../helpers/db.ts";
import { meta } from "../helpers/auth.ts";
import { battery, key, make, plain, tire } from "../helpers/inventory.ts";
import { purchasingWorld, type PurchasingWorld } from "../helpers/purchasing.ts";

describe("proveedores, órdenes de compra, recepción y devoluciones", () => {
  let admin: PrismaClient;
  let w: PurchasingWorld;
  let other: PurchasingWorld;

  beforeAll(async () => {
    configureAuthCache(0);
    admin = adminClient();
    w = await purchasingWorld(admin);
    other = await purchasingWorld(admin);
  }, 180_000);
  afterAll(async () => {
    await admin.$disconnect();
  });

  const order = async (
    items: Array<{ productId: string; quantity: string; unitCost: string }>,
    supplierId = w.suppliers.whitelisted,
    over: Record<string, unknown> = {},
  ) =>
    createPurchaseOrder(
      w.manager,
      { supplierId, warehouseId: w.warehouseId, idempotencyKey: key(), items, ...over },
      meta(),
    );
  const sent = async (
    items: Array<{ productId: string; quantity: string; unitCost: string }>,
    supplierId = w.suppliers.whitelisted,
  ) => {
    const created = await order(items, supplierId);
    await sendPurchaseOrder(w.manager, created.id, meta());
    return created;
  };
  const balance = async (productId: string) =>
    Number(
      (
        await admin.stockBalance.findFirst({
          where: { tenantId: w.tenantId, productId, warehouseId: w.warehouseId },
        })
      )?.quantity ?? 0,
    );
  const receive = (
    orderId: string,
    lines: Array<Record<string, unknown>>,
    over: Record<string, unknown> = {},
  ) =>
    receivePurchaseOrder(
      w.manager,
      { orderId, idempotencyKey: key(), lines: lines as never, ...over },
      meta(),
    );
  const itemOf = async (orderId: string, productId: string) =>
    admin.purchaseOrderItem.findFirstOrThrow({ where: { orderId, productId } });

  describe("proveedores", () => {
    it("alta con auditoría; el RUC no se repite", async () => {
      const ruc = `20${Math.floor(Math.random() * 1e9)}`;
      const created = await createSupplier(
        w.manager,
        {
          name: "Frenos Perú SAC",
          taxId: ruc,
          whatsapp: "+51 999 111 222",
          defaultLeadTimeDays: 4,
        },
        meta(),
      );
      expect(
        await admin.auditLog.count({
          where: {
            entityId: created.id,
            action: "supplier.created",
            actorUserId: w.manager.userId,
          },
        }),
      ).toBe(1);
      await expect(
        createSupplier(w.manager, { name: "Otro", taxId: ruc }, meta()),
      ).rejects.toMatchObject({ code: "SUPPLIER_TAX_ID" });
      await expect(
        createSupplier(w.manager, { name: "X", whatsapp: "abc" }, meta()),
      ).rejects.toThrow(/WhatsApp inválido/);
      await expect(createSupplier(w.cashier, { name: "Intruso" }, meta())).rejects.toBeInstanceOf(
        PermissionDeniedError,
      );
    });

    it("la lista blanca del agente solo la cambia quien administra la IA, y queda auditada", async () => {
      await expect(
        createSupplier(w.manager, { name: "Con lista blanca", aiWhitelisted: true }, meta()),
      ).rejects.toBeInstanceOf(PermissionDeniedError);
      await expect(
        updateSupplier(w.manager, w.suppliers.other, { aiWhitelisted: true }, meta()),
      ).rejects.toBeInstanceOf(PermissionDeniedError);
      await updateSupplier(w.admin, w.suppliers.other, { aiWhitelisted: true }, meta());
      await updateSupplier(w.admin, w.suppliers.other, { aiWhitelisted: false }, meta());
      const logs = await admin.auditLog.findMany({
        where: { entityId: w.suppliers.other, action: "supplier.whitelist_changed" },
        orderBy: { occurredAt: "asc" },
      });
      expect(logs.map((l) => (l.after as { aiWhitelisted: boolean }).aiWhitelisted)).toEqual([
        true,
        false,
      ]);
      await updateSupplier(w.manager, w.suppliers.other, { defaultLeadTimeDays: 8 }, meta()); // el resto sí
      expect(
        (await listSuppliers(w.manager)).find((s) => s.id === w.suppliers.other),
      ).toMatchObject({ defaultLeadTimeDays: 8, aiWhitelisted: false });
    });

    it("catálogo del proveedor: precio con historial, preferido exclusivo y costos protegidos", async () => {
      const p = await make(w.manager, plain());
      const a = await upsertSupplierProduct(
        w.manager,
        {
          supplierId: w.suppliers.whitelisted,
          productId: p.id,
          price: "10.5",
          leadTimeDays: 3,
          isPreferred: true,
          minOrderQty: "6",
        },
        meta(),
      );
      await upsertSupplierProduct(
        w.manager,
        { supplierId: w.suppliers.whitelisted, productId: p.id, price: "11", isPreferred: true },
        meta(),
      );
      const b = await upsertSupplierProduct(
        w.manager,
        { supplierId: w.suppliers.third, productId: p.id, price: "9.9", isPreferred: true },
        meta(),
      );
      expect(
        await admin.supplierProduct.count({ where: { productId: p.id, isPreferred: true } }),
      ).toBe(1);
      expect(
        (await admin.supplierProduct.findUniqueOrThrow({ where: { id: b.id } })).isPreferred,
      ).toBe(true);

      const history = await admin.supplierPriceHistory.findMany({
        where: { supplierProductId: a.id },
        orderBy: { recordedAt: "asc" },
      });
      // Los registros pueden compartir milisegundo: se compara sin depender del orden.
      expect(history.map((h) => h.price.toString()).sort()).toEqual(["10.5", "11"]);
      // Sin depender del orden por milisegundo: se busca el cambio 10.5 → 11 entre todos los registros.
      const audits = await admin.auditLog.findMany({
        where: { entityId: a.id, action: "supplier.price_changed" },
      });
      expect(audits.map((log) => log.after)).toEqual(
        expect.arrayContaining([{ price: "10.5" }, { price: "11" }]),
      );
      expect(audits.find((log) => (log.after as { price: string }).price === "11")?.before).toEqual(
        { price: "10.5" },
      );
      expect(
        (
          await admin.supplierProduct.findUniqueOrThrow({ where: { id: a.id } })
        ).minOrderQty?.toString(),
      ).toBe("6"); // se conserva

      await expect(
        upsertSupplierProduct(
          w.noCost,
          { supplierId: w.suppliers.third, productId: p.id, price: "1", isPreferred: false },
          meta(),
        ),
      ).rejects.toBeInstanceOf(PermissionDeniedError);
      const asManager = await listSupplierProducts(w.manager, w.suppliers.whitelisted);
      expect(asManager.find((r) => r.productId === p.id)).toMatchObject({ lastPrice: "11" });
      const asNoCost = await listSupplierProducts(w.noCost, w.suppliers.whitelisted);
      expect(asNoCost.find((r) => r.productId === p.id)).not.toHaveProperty("lastPrice");
      expect(JSON.stringify(asNoCost)).not.toContain("lastPrice");
      expect(asNoCost.every((row) => !("lastPrice" in row))).toBe(true);
    });

    it("no se elimina un proveedor con órdenes abiertas", async () => {
      const p = await make(w.manager, plain());
      const supplier = await createSupplier(
        w.manager,
        { name: "Temporal SAC", whatsapp: "+51 911 000 111" },
        meta(),
      );
      const o = await createPurchaseOrder(
        w.manager,
        {
          supplierId: supplier.id,
          warehouseId: w.warehouseId,
          idempotencyKey: key(),
          items: [{ productId: p.id, quantity: "2", unitCost: "5" }],
        },
        meta(),
      );
      await sendPurchaseOrder(w.manager, o.id, meta());
      await expect(deleteSupplier(w.manager, supplier.id, meta())).rejects.toMatchObject({
        code: "SUPPLIER_OPEN_ORDERS",
      });
      await cancelPurchaseOrder(w.manager, o.id, "Pedido duplicado", meta());
      await expect(deleteSupplier(w.manager, supplier.id, meta())).resolves.toBeUndefined();
      expect((await listSuppliers(w.manager)).some((s) => s.id === supplier.id)).toBe(false);
    });
  });

  describe("orden de compra", () => {
    it("calcula subtotal, impuesto (solo ítems gravados) y total con precios exactos", async () => {
      const taxed = await make(w.manager, plain({ taxAffectation: "TAXED" }));
      const exempt = await make(w.manager, plain({ taxAffectation: "EXEMPT" }));
      const { id, number } = await order([
        { productId: taxed.id, quantity: "2", unitCost: "100" },
        { productId: exempt.id, quantity: "1", unitCost: "50" },
      ]);
      const stored = await admin.purchaseOrder.findUniqueOrThrow({
        where: { id },
        include: { items: true },
      });
      expect(number).toBeGreaterThan(0);
      expect([stored.subtotal, stored.taxTotal, stored.total].map((d) => d.toString())).toEqual([
        "250",
        "36",
        "286",
      ]);
      expect(stored.status).toBe("DRAFT");
      expect(stored.items.find((i) => i.productId === taxed.id)?.taxRate.toString()).toBe("0.18");
      expect(stored.items.find((i) => i.productId === exempt.id)?.taxRate.toString()).toBe("0");
    });

    it("es idempotente: 6 peticiones simultáneas con la misma clave crean UNA orden", async () => {
      const p = await make(w.manager, plain());
      const input = {
        supplierId: w.suppliers.whitelisted,
        warehouseId: w.warehouseId,
        idempotencyKey: key(),
        items: [{ productId: p.id, quantity: "3", unitCost: "4" }],
      };
      const results = await Promise.all(
        Array.from({ length: 6 }, () => createPurchaseOrder(w.manager, input, meta())),
      );
      expect(new Set(results.map((r) => r.id)).size).toBe(1);
      expect(results.filter((r) => !r.replayed)).toHaveLength(1);
      expect(
        await admin.purchaseOrder.count({ where: { idempotencyKey: input.idempotencyKey } }),
      ).toBe(1);
    });

    it("rechaza líneas repetidas, productos ajenos o servicios, y exige permisos", async () => {
      const p = await make(w.manager, plain());
      await expect(
        order([
          { productId: p.id, quantity: "1", unitCost: "1" },
          { productId: p.id, quantity: "2", unitCost: "1" },
        ]),
      ).rejects.toMatchObject({ code: "DUPLICATE_ITEMS" });
      const foreign = await make(other.manager, plain());
      await expect(
        order([{ productId: foreign.id, quantity: "1", unitCost: "1" }]),
      ).rejects.toBeInstanceOf(NotFoundError);
      const service = await make(w.manager, {
        kind: "SERVICE",
        sku: `SV-${randomUUID().slice(0, 6)}`,
        name: "Servicio",
        salePrice: 10,
      });
      await expect(
        order([{ productId: service.id, quantity: "1", unitCost: "1" }]),
      ).rejects.toBeInstanceOf(NotFoundError);
      await expect(
        createPurchaseOrder(
          w.cashier,
          {
            supplierId: w.suppliers.whitelisted,
            warehouseId: w.warehouseId,
            idempotencyKey: key(),
            items: [{ productId: p.id, quantity: "1", unitCost: "1" }],
          },
          meta(),
        ),
      ).rejects.toBeInstanceOf(PermissionDeniedError);
      await expect(
        createPurchaseOrder(
          w.noCost,
          {
            supplierId: w.suppliers.whitelisted,
            warehouseId: w.warehouseId,
            idempotencyKey: key(),
            items: [{ productId: p.id, quantity: "1", unitCost: "1" }],
          },
          meta(),
        ),
      ).rejects.toBeInstanceOf(PermissionDeniedError);
      await expect(order([{ productId: p.id, quantity: "0", unitCost: "1" }])).rejects.toThrow(
        /Cantidad inválida/,
      );
    });

    it("Solicitar: pasa a Solicitado y encola el WhatsApp con las líneas calculadas por el sistema", async () => {
      const p = await make(w.manager, plain({ name: "Filtro de aceite Toyota" }));
      const created = await order([{ productId: p.id, quantity: "6", unitCost: "24.5" }]);
      const result = await sendPurchaseOrder(w.manager, created.id, meta());
      expect(result.delivery).toBe("PENDING");
      const stored = await admin.purchaseOrder.findUniqueOrThrow({ where: { id: created.id } });
      expect(stored.status).toBe("REQUESTED");
      expect(stored.sentAt).not.toBeNull();
      const message = await admin.outboundMessage.findFirstOrThrow({
        where: { tenantId: w.tenantId, relatedId: created.id },
      });
      expect(message).toMatchObject({
        channel: "WHATSAPP",
        toAddress: "+51 987 000 001",
        status: "PENDING",
        idempotencyKey: `po-send:${created.id}`,
      });
      expect(message.body).toContain(`Pedido N.º ${created.number}`);
      expect(message.body).toContain("Filtro de aceite Toyota — 6 u. × PEN 24.50");
      expect(
        await admin.supplierMessage.count({
          where: { orderId: created.id, direction: "OUTBOUND" },
        }),
      ).toBe(1);
      await expect(sendPurchaseOrder(w.manager, created.id, meta())).rejects.toMatchObject({
        code: "PO_STATE",
      });
      expect(await admin.outboundMessage.count({ where: { relatedId: created.id } })).toBe(1);
    });

    it("sin canal de contacto no se envía y la orden sigue en Borrador (todo o nada)", async () => {
      const supplier = await createSupplier(w.manager, { name: "Sin contacto SAC" }, meta());
      const p = await make(w.manager, plain());
      const created = await order([{ productId: p.id, quantity: "1", unitCost: "1" }], supplier.id);
      await expect(sendPurchaseOrder(w.manager, created.id, meta())).rejects.toMatchObject({
        code: "SUPPLIER_NO_CONTACT",
      });
      expect(
        (await admin.purchaseOrder.findUniqueOrThrow({ where: { id: created.id } })).status,
      ).toBe("DRAFT");
    });

    it("seguimiento: no hay saltos hacia atrás y cancelar exige motivo", async () => {
      const p = await make(w.manager, plain());
      const created = await order([{ productId: p.id, quantity: "2", unitCost: "3" }]);
      await expect(markInTransit(w.manager, created.id, meta())).rejects.toMatchObject({
        code: "PO_STATE",
      }); // aún borrador
      await sendPurchaseOrder(w.manager, created.id, meta());
      await markInTransit(w.manager, created.id, meta());
      expect(
        (await admin.purchaseOrder.findUniqueOrThrow({ where: { id: created.id } })).status,
      ).toBe("IN_TRANSIT");
      await expect(sendPurchaseOrder(w.manager, created.id, meta())).rejects.toMatchObject({
        code: "PO_STATE",
      });
      await expect(cancelPurchaseOrder(w.manager, created.id, "no", meta())).rejects.toMatchObject({
        code: "REASON_REQUIRED",
      });
      await cancelPurchaseOrder(w.manager, created.id, "El proveedor no pudo despachar", meta());
      await expect(markInTransit(w.manager, created.id, meta())).rejects.toMatchObject({
        code: "PO_STATE",
      });
    });

    it("aceptar una cotización cambia los precios (auditado) y recalcula los totales; solo con permiso de costos", async () => {
      const p = await make(w.manager, plain());
      const created = await sent([{ productId: p.id, quantity: "10", unitCost: "8" }]);
      await expect(
        acceptQuote(w.noCost, created.id, [{ productId: p.id, unitCost: "9" }], meta()),
      ).rejects.toBeInstanceOf(PermissionDeniedError);
      await expect(
        acceptQuote(w.manager, created.id, [{ productId: randomUUID(), unitCost: "9" }], meta()),
      ).rejects.toBeInstanceOf(NotFoundError);
      await expect(
        acceptQuote(w.manager, created.id, [{ productId: p.id, unitCost: "9,5x" }], meta()),
      ).rejects.toMatchObject({ code: "PRICE_INVALID" });
      await acceptQuote(w.manager, created.id, [{ productId: p.id, unitCost: "9.25" }], meta());
      const stored = await admin.purchaseOrder.findUniqueOrThrow({ where: { id: created.id } });
      expect([stored.subtotal, stored.total].map((d) => d.toString())).toEqual(["92.5", "109.15"]);
      const audit = await admin.auditLog.findFirstOrThrow({
        where: { entityId: created.id, action: "purchase.quote_accepted" },
      });
      expect(audit).toMatchObject({
        before: { [p.id]: "8" },
        after: { [p.id]: "9.25" },
        actorUserId: w.manager.userId,
      });
    });

    it("quien no ve costos de compra recibe las órdenes sin precios ni totales", async () => {
      const p = await make(w.manager, plain());
      const created = await order([{ productId: p.id, quantity: "5", unitCost: "77.77" }]);
      const asManager = (await listPurchaseOrders(w.manager)).find((o) => o.id === created.id);
      expect(asManager).toMatchObject({ total: "458.84" });
      expect(asManager?.items[0]).toMatchObject({ unitCost: "77.77" });
      const asNoCost = (await listPurchaseOrders(w.noCost)).find((o) => o.id === created.id);
      expect(asNoCost?.items[0]).toMatchObject({ qtyOrdered: "5" });
      expect(JSON.stringify(asNoCost)).not.toContain("77.77");
      expect(JSON.stringify(asNoCost)).not.toContain("458.84");
      expect(JSON.stringify(asNoCost)).not.toContain("388.85");
      await expect(listPurchaseOrders(w.cashier)).rejects.toBeInstanceOf(PermissionDeniedError);
    });
  });

  describe("recepción contra la orden", () => {
    it("parcial → completa: ingresa al kardex con el costo de la orden y registra las diferencias", async () => {
      const p = await make(w.manager, plain());
      const created = await sent([{ productId: p.id, quantity: "10", unitCost: "8" }]);
      const item = await itemOf(created.id, p.id);

      const first = await receive(created.id, [{ orderItemId: item.id, quantity: "6" }], {
        supplierDocRef: "GR-001",
      });
      expect(first).toMatchObject({ status: "PARTIALLY_RECEIVED", replayed: false });
      expect(first.differences).toEqual([
        { productId: p.id, expected: "10", received: "6", difference: "-4" },
      ]);
      expect(await balance(p.id)).toBe(6);
      expect(
        (
          await admin.stockBalance.findFirstOrThrow({ where: { productId: p.id } })
        ).avgCost.toString(),
      ).toBe("8");
      const receiptItem = await admin.purchaseReceiptItem.findFirstOrThrow({
        where: { receiptId: first.receiptId },
      });
      expect(
        [receiptItem.qtyExpected, receiptItem.qtyReceived, receiptItem.difference].map((d) =>
          d.toString(),
        ),
      ).toEqual(["10", "6", "-4"]);
      const movement = await admin.kardexMovement.findFirstOrThrow({
        where: { productId: p.id, referenceId: first.receiptId },
      });
      expect(movement).toMatchObject({ type: "PURCHASE", referenceType: "purchase_receipt" });
      expect(movement.unitCost?.toString()).toBe("8");
      expect(
        await admin.notification.count({
          where: { tenantId: w.tenantId, dedupeKey: `po-diff:${first.receiptId}` },
        }),
      ).toBe(1);

      const second = await receive(created.id, [{ orderItemId: item.id, quantity: "4" }]);
      expect(second).toMatchObject({ status: "RECEIVED", differences: [] });
      expect(await balance(p.id)).toBe(10);
      const done = await admin.purchaseOrder.findUniqueOrThrow({ where: { id: created.id } });
      expect(done.status).toBe("RECEIVED");
      expect(done.receivedAt).not.toBeNull();
      expect(
        (
          await admin.product.findUniqueOrThrow({ where: { id: p.id } })
        ).lastPurchaseCost?.toString(),
      ).toBe("8");
      await expect(
        receive(created.id, [{ orderItemId: item.id, quantity: "1" }]),
      ).rejects.toMatchObject({ code: "PO_STATE" });
    });

    it("sin cantidad recibe lo pendiente; se tolera hasta +10 % y más se rechaza", async () => {
      const a = await make(w.manager, plain());
      const b = await make(w.manager, plain());
      const created = await sent([
        { productId: a.id, quantity: "10", unitCost: "1" },
        { productId: b.id, quantity: "10", unitCost: "1" },
      ]);
      await expect(
        receive(created.id, [{ orderItemId: (await itemOf(created.id, a.id)).id, quantity: "12" }]),
      ).rejects.toMatchObject({ code: "RECEIPT_EXCESS" });
      expect(await balance(a.id)).toBe(0);
      const result = await receive(created.id, [
        { orderItemId: (await itemOf(created.id, a.id)).id },
        { orderItemId: (await itemOf(created.id, b.id)).id, quantity: "11" },
      ]);
      expect(result.status).toBe("RECEIVED");
      expect(result.differences).toEqual([
        { productId: b.id, expected: "10", received: "11", difference: "1" },
      ]);
      expect(await balance(a.id)).toBe(10);
      expect(await balance(b.id)).toBe(11);
    });

    it("es idempotente: repetir o disparar 6 veces la misma recepción ingresa UNA sola vez", async () => {
      const p = await make(w.manager, plain());
      const created = await sent([{ productId: p.id, quantity: "10", unitCost: "2" }]);
      const item = await itemOf(created.id, p.id);
      const k = key();
      const results = await Promise.all(
        Array.from({ length: 6 }, () =>
          receivePurchaseOrder(
            w.manager,
            {
              orderId: created.id,
              idempotencyKey: k,
              lines: [{ orderItemId: item.id, quantity: "4" }],
            },
            meta(),
          ),
        ),
      );
      expect(new Set(results.map((r) => r.receiptId)).size).toBe(1);
      expect(results.filter((r) => !r.replayed)).toHaveLength(1);
      expect(await balance(p.id)).toBe(4);
      expect(await admin.purchaseReceipt.count({ where: { orderId: created.id } })).toBe(1);
      expect(Number((await itemOf(created.id, p.id)).qtyReceived)).toBe(4);
    });

    it("llantas: exige lote/DOT; baterías: series únicas", async () => {
      const t = await make(w.manager, tire());
      const bt = await make(w.manager, battery());
      const created = await sent([
        { productId: t.id, quantity: "8", unitCost: "200" },
        { productId: bt.id, quantity: "3", unitCost: "300" },
      ]);
      const tireItem = await itemOf(created.id, t.id);
      const batItem = await itemOf(created.id, bt.id);
      await expect(
        receive(created.id, [{ orderItemId: tireItem.id, quantity: "8" }]),
      ).rejects.toMatchObject({ code: "LOT_REQUIRED" });
      await expect(receive(created.id, [{ orderItemId: batItem.id }])).rejects.toThrow(/cantidad/i);
      expect(await balance(t.id)).toBe(0);

      const result = await receive(created.id, [
        { orderItemId: tireItem.id, quantity: "8", lot: { code: "DOT-2425", dotCode: "2425" } },
        { orderItemId: batItem.id, serials: ["B-1001", "B-1002", "B-1003"] },
      ]);
      expect(result.status).toBe("RECEIVED");
      expect(await balance(t.id)).toBe(8);
      expect(await balance(bt.id)).toBe(3);
      expect((await admin.stockLot.findFirstOrThrow({ where: { productId: t.id } })).dotCode).toBe(
        "2425",
      );
      expect(
        await admin.serialNumber.count({ where: { productId: bt.id, status: "IN_STOCK" } }),
      ).toBe(3);
    });

    it("todo o nada: si una línea falla no se ingresa ninguna", async () => {
      const a = await make(w.manager, plain());
      const bt = await make(w.manager, battery());
      const created = await sent([
        { productId: a.id, quantity: "5", unitCost: "1" },
        { productId: bt.id, quantity: "2", unitCost: "300" },
      ]);
      await expect(
        receive(created.id, [
          { orderItemId: (await itemOf(created.id, a.id)).id, quantity: "5" },
          { orderItemId: (await itemOf(created.id, bt.id)).id },
        ]),
      ).rejects.toThrow();
      expect(await balance(a.id)).toBe(0);
      expect(
        (await admin.purchaseOrder.findUniqueOrThrow({ where: { id: created.id } })).status,
      ).toBe("REQUESTED");
      expect(await admin.purchaseReceipt.count({ where: { orderId: created.id } })).toBe(0);
    });

    it("actualiza el último precio del proveedor y su historial con lo realmente recibido", async () => {
      const p = await make(w.manager, plain());
      const link = await upsertSupplierProduct(
        w.manager,
        { supplierId: w.suppliers.whitelisted, productId: p.id, price: "10", isPreferred: false },
        meta(),
      );
      const created = await sent([{ productId: p.id, quantity: "4", unitCost: "12" }]);
      await receive(created.id, [{ orderItemId: (await itemOf(created.id, p.id)).id }]);
      const updated = await admin.supplierProduct.findUniqueOrThrow({ where: { id: link.id } });
      expect(updated.lastPrice?.toString()).toBe("12");
      expect(
        (
          await admin.supplierPriceHistory.findMany({
            where: { supplierProductId: link.id },
            orderBy: { recordedAt: "asc" },
          })
        ).map((h) => [h.price.toString(), h.source]),
      ).toEqual([
        ["10", "MANUAL"],
        ["12", "PURCHASE_ORDER"],
      ]);
    });

    it("estados y permisos: borrador/cancelada no se reciben; el cajero y otro tenant no pueden", async () => {
      const p = await make(w.manager, plain());
      const draft = await order([{ productId: p.id, quantity: "2", unitCost: "1" }]);
      await expect(
        receive(draft.id, [{ orderItemId: (await itemOf(draft.id, p.id)).id }]),
      ).rejects.toMatchObject({ code: "PO_STATE" });
      const live = await sent([{ productId: p.id, quantity: "2", unitCost: "1" }]);
      const item = await itemOf(live.id, p.id);
      await expect(
        receivePurchaseOrder(
          w.cashier,
          { orderId: live.id, idempotencyKey: key(), lines: [{ orderItemId: item.id }] },
          meta(),
        ),
      ).rejects.toBeInstanceOf(PermissionDeniedError);
      await expect(
        receivePurchaseOrder(
          other.manager,
          { orderId: live.id, idempotencyKey: key(), lines: [{ orderItemId: item.id }] },
          meta(),
        ),
      ).rejects.toBeInstanceOf(NotFoundError);
      await expect(receive(live.id, [{ orderItemId: randomUUID() }])).rejects.toBeInstanceOf(
        NotFoundError,
      );
      expect(await balance(p.id)).toBe(0);
    });
  });

  describe("devoluciones a proveedor", () => {
    const stockUp = (productId: string, quantity: string) =>
      registerStockIn(
        w.manager,
        { warehouseId: w.warehouseId, productId, quantity, unitCost: "6", idempotencyKey: key() },
        meta(),
      );

    it("descuenta del stock con motivo, deja la devolución numerada y auditada", async () => {
      const p = await make(w.manager, plain());
      await stockUp(p.id, "10");
      const ret = await createSupplierReturn(
        w.manager,
        {
          supplierId: w.suppliers.whitelisted,
          warehouseId: w.warehouseId,
          reason: "Lote defectuoso",
          idempotencyKey: key(),
          items: [{ productId: p.id, quantity: "3" }],
        },
        meta(),
      );
      expect(ret.number).toBeGreaterThan(0);
      expect(await balance(p.id)).toBe(7);
      const item = await admin.supplierReturnItem.findFirstOrThrow({ where: { returnId: ret.id } });
      expect([item.quantity.toString(), item.unitCost.toString()]).toEqual(["3", "6"]);
      const movement = await admin.kardexMovement.findFirstOrThrow({
        where: { referenceId: ret.id },
      });
      expect(movement).toMatchObject({ type: "RETURN_SUPPLIER", reason: "Lote defectuoso" });
      expect(
        await admin.auditLog.count({
          where: { entityId: ret.id, action: "supplier.return_created", reason: "Lote defectuoso" },
        }),
      ).toBe(1);
    });

    it("sin stock suficiente no se crea nada; el motivo es obligatorio; es idempotente", async () => {
      const p = await make(w.manager, plain());
      await stockUp(p.id, "2");
      const base = {
        supplierId: w.suppliers.whitelisted,
        warehouseId: w.warehouseId,
        items: [{ productId: p.id, quantity: "5" }],
      };
      const before = await admin.supplierReturn.count({ where: { tenantId: w.tenantId } });
      await expect(
        createSupplierReturn(
          w.manager,
          { ...base, reason: "Producto equivocado", idempotencyKey: key() },
          meta(),
        ),
      ).rejects.toBeInstanceOf(InsufficientStockError);
      expect(await admin.supplierReturn.count({ where: { tenantId: w.tenantId } })).toBe(before);
      await expect(
        createSupplierReturn(w.manager, { ...base, reason: "no", idempotencyKey: key() }, meta()),
      ).rejects.toThrow(/motivo/);

      const k = key();
      const ok = {
        ...base,
        items: [{ productId: p.id, quantity: "1" }],
        reason: "Producto equivocado",
        idempotencyKey: k,
      };
      const results = await Promise.all(
        Array.from({ length: 4 }, () => createSupplierReturn(w.manager, ok, meta())),
      );
      expect(new Set(results.map((r) => r.id)).size).toBe(1);
      expect(await balance(p.id)).toBe(1);
    });

    it("baterías: devolver una serie la marca RETURNED_TO_SUPPLIER", async () => {
      const bt = await make(w.manager, battery());
      await registerStockIn(
        w.manager,
        {
          warehouseId: w.warehouseId,
          productId: bt.id,
          unitCost: "300",
          serials: ["RET-1", "RET-2"],
          idempotencyKey: key(),
        },
        meta(),
      );
      await createSupplierReturn(
        w.manager,
        {
          supplierId: w.suppliers.third,
          warehouseId: w.warehouseId,
          reason: "Garantía de fábrica",
          idempotencyKey: key(),
          items: [{ productId: bt.id, serials: ["RET-1"] }],
        },
        meta(),
      );
      expect(
        (
          await admin.serialNumber.findFirstOrThrow({
            where: { productId: bt.id, serial: "RET-1" },
          })
        ).status,
      ).toBe("RETURNED_TO_SUPPLIER");
      expect(await balance(bt.id)).toBe(1);
    });

    it("el cajero no puede devolver mercadería", async () => {
      const p = await make(w.manager, plain());
      await expect(
        createSupplierReturn(
          w.cashier,
          {
            supplierId: w.suppliers.whitelisted,
            warehouseId: w.warehouseId,
            reason: "Intento no autorizado",
            idempotencyKey: key(),
            items: [{ productId: p.id, quantity: "1" }],
          },
          meta(),
        ),
      ).rejects.toBeInstanceOf(PermissionDeniedError);
    });
  });

  it("aislamiento: otro tenant no ve ni toca las órdenes ni los proveedores", async () => {
    const p = await make(w.manager, plain());
    const created = await sent([{ productId: p.id, quantity: "2", unitCost: "1" }]);
    expect((await listPurchaseOrders(other.manager)).some((o) => o.id === created.id)).toBe(false);
    await expect(sendPurchaseOrder(other.manager, created.id, meta())).rejects.toBeInstanceOf(
      NotFoundError,
    );
    await expect(
      cancelPurchaseOrder(other.manager, created.id, "Intento ajeno", meta()),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect((await listSuppliers(other.manager)).some((s) => s.id === w.suppliers.whitelisted)).toBe(
      false,
    );
    await expect(
      updateSupplier(other.manager, w.suppliers.whitelisted, { notes: "hack" }, meta()),
    ).rejects.toBeInstanceOf(NotFoundError);
    void ConflictError;
  });
});
