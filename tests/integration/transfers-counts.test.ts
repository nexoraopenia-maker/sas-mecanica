import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTenant, type MovementType } from "@/lib/db";
import type { PrismaClient } from "@/lib/db/generated/client.ts";
import { ConflictError, InsufficientStockError, PermissionDeniedError } from "@/lib/errors";
import { applyCount, closeCount, openCount, recordCount } from "@/server/services/counts";
import { applyMovement, registerStockIn, type MovementRequest } from "@/server/services/inventory";
import { reconcileStock } from "@/server/services/reconcile";
import { configureAuthCache } from "@/server/services/session-resolver";
import {
  cancelTransfer,
  receiveTransfer,
  requestTransfer,
  shipTransfer,
} from "@/server/services/transfers";
import { adminClient } from "../helpers/db.ts";
import { meta } from "../helpers/auth.ts";
import {
  battery,
  inventoryWorld,
  key,
  make,
  plain,
  tire,
  type InventoryWorld,
} from "../helpers/inventory.ts";

describe("transferencias entre almacenes y conteo físico", () => {
  let admin: PrismaClient;
  let w: InventoryWorld;
  let other: InventoryWorld;

  beforeAll(async () => {
    configureAuthCache(0);
    admin = adminClient();
    w = await inventoryWorld(admin);
    other = await inventoryWorld(admin);
  }, 120_000);
  afterAll(async () => {
    await admin.$disconnect();
  });

  const qty = async (productId: string, warehouseId: string) =>
    Number(
      (
        await admin.stockBalance.findFirst({
          where: { tenantId: w.tenantId, productId, warehouseId },
        })
      )?.quantity ?? 0,
    );
  const stockIn = (
    productId: string,
    quantity: string,
    unitCost = "10",
    extra: Record<string, unknown> = {},
    warehouseId = w.warehouseId,
  ) =>
    registerStockIn(
      w.manager,
      { warehouseId, productId, quantity, unitCost, idempotencyKey: key(), ...extra },
      meta(),
    );
  const sell = (
    productId: string,
    quantity: string,
    type: MovementType = "SALE",
    extra: Partial<MovementRequest> = {},
  ) =>
    withTenant(w.tenantId, (tx) =>
      applyMovement(tx, {
        warehouseId: w.warehouseId,
        productId,
        type,
        quantity,
        idempotencyKey: key(),
        ...extra,
      }),
    );
  const transfer = (items: Array<Record<string, unknown>>, over: Record<string, unknown> = {}) =>
    requestTransfer(
      w.manager,
      {
        fromWarehouseId: w.warehouseId,
        toWarehouseId: w.warehouse2Id,
        items: items as never,
        ...over,
      },
      meta(),
    );

  describe("transferencias", () => {
    it("solicitada → en tránsito → recibida, conservando el costo", async () => {
      const p = await make(w.manager, plain());
      await stockIn(p.id, "10", "8");
      const { id, number } = await transfer([{ productId: p.id, quantity: "6" }]);
      expect(number).toBeGreaterThan(0);
      expect(await qty(p.id, w.warehouseId)).toBe(10); // solicitar no mueve stock

      await shipTransfer(w.manager, id, meta());
      expect(await qty(p.id, w.warehouseId)).toBe(4);
      expect(await qty(p.id, w.warehouse2Id)).toBe(0); // en tránsito: no está en ningún almacén
      expect((await admin.stockTransfer.findUniqueOrThrow({ where: { id } })).status).toBe(
        "IN_TRANSIT",
      );

      const received = await receiveTransfer(w.manager, { transferId: id }, meta());
      expect(received.missing).toBe("0");
      expect(await qty(p.id, w.warehouse2Id)).toBe(6);
      const destination = await admin.stockBalance.findFirstOrThrow({
        where: { productId: p.id, warehouseId: w.warehouse2Id },
      });
      expect(destination.avgCost.toString()).toBe("8"); // el costo viaja con la mercadería
      const types = (
        await admin.kardexMovement.findMany({
          where: { referenceId: id },
          orderBy: { occurredAt: "asc" },
        })
      ).map((m) => m.type);
      expect(types).toEqual(["TRANSFER_OUT", "TRANSFER_IN"]);
      expect((await admin.stockTransfer.findUniqueOrThrow({ where: { id } })).status).toBe(
        "RECEIVED",
      );
      expect(await admin.auditLog.count({ where: { entityId: id } })).toBe(3);
    });

    it("no se puede despachar dos veces ni recibir antes de despachar", async () => {
      const p = await make(w.manager, plain());
      await stockIn(p.id, "10");
      const { id } = await transfer([{ productId: p.id, quantity: "3" }]);
      await expect(receiveTransfer(w.manager, { transferId: id }, meta())).rejects.toMatchObject({
        code: "TRANSFER_STATE",
      });
      await shipTransfer(w.manager, id, meta());
      await expect(shipTransfer(w.manager, id, meta())).rejects.toMatchObject({
        code: "TRANSFER_STATE",
      });
      expect(await qty(p.id, w.warehouseId)).toBe(7);
    });

    it("5 despachos simultáneos de la misma transferencia => solo uno descuenta stock", async () => {
      const p = await make(w.manager, plain());
      await stockIn(p.id, "10");
      const { id } = await transfer([{ productId: p.id, quantity: "4" }]);
      const results = await Promise.allSettled(
        Array.from({ length: 5 }, () => shipTransfer(w.manager, id, meta())),
      );
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect(await qty(p.id, w.warehouseId)).toBe(6);
    });

    it("sin stock suficiente el despacho falla y la transferencia sigue Solicitada", async () => {
      const p = await make(w.manager, plain());
      await stockIn(p.id, "2");
      const { id } = await transfer([{ productId: p.id, quantity: "5" }]);
      await expect(shipTransfer(w.manager, id, meta())).rejects.toBeInstanceOf(
        InsufficientStockError,
      );
      expect((await admin.stockTransfer.findUniqueOrThrow({ where: { id } })).status).toBe(
        "REQUESTED",
      );
      expect(await qty(p.id, w.warehouseId)).toBe(2);
    });

    it("llantas: FEFO entre lotes y los mismos lotes llegan al destino", async () => {
      const p = await make(w.manager, tire());
      await stockIn(p.id, "10", "250", { lot: { code: "NUEVO", dotCode: "2025" } });
      await stockIn(p.id, "5", "240", { lot: { code: "VIEJO", dotCode: "1222" } });
      const { id } = await transfer([{ productId: p.id, quantity: "7" }]);
      await shipTransfer(w.manager, id, meta());
      const items = await admin.stockTransferItem.findMany({ where: { transferId: id } });
      expect(items).toHaveLength(2);
      expect(items.map((i) => Number(i.qtyShipped)).sort()).toEqual([2, 5]);
      await receiveTransfer(w.manager, { transferId: id }, meta());

      const lots = await admin.stockLot.findMany({ where: { productId: p.id } });
      const name = (lotId: string) => lots.find((l) => l.id === lotId)?.code;
      const at = async (warehouseId: string) =>
        Object.fromEntries(
          (await admin.stockLotBalance.findMany({ where: { productId: p.id, warehouseId } })).map(
            (b) => [name(b.lotId), Number(b.quantity)],
          ),
        );
      expect(await at(w.warehouseId)).toEqual({ VIEJO: 0, NUEVO: 8 });
      expect(await at(w.warehouse2Id)).toEqual({ VIEJO: 5, NUEVO: 2 });
    });

    it("baterías: la serie queda EN_TRÁNSITO y luego IN_STOCK en el destino", async () => {
      const p = await make(w.manager, battery());
      await registerStockIn(
        w.manager,
        {
          warehouseId: w.warehouseId,
          productId: p.id,
          unitCost: "300",
          serials: ["TR-1", "TR-2", "TR-3"],
          idempotencyKey: key(),
        },
        meta(),
      );
      await expect(transfer([{ productId: p.id, serials: ["TR-NOPE"] }])).rejects.toMatchObject({
        code: "SERIAL_UNAVAILABLE",
      });
      await expect(transfer([{ productId: p.id, quantity: "1" }])).rejects.toMatchObject({
        code: "SERIAL_REQUIRED",
      });

      const { id } = await transfer([{ productId: p.id, serials: ["TR-1", "TR-2"] }]);
      await shipTransfer(w.manager, id, meta());
      expect(
        (
          await admin.serialNumber.findMany({
            where: { productId: p.id, serial: { in: ["TR-1", "TR-2"] } },
          })
        ).map((s) => s.status),
      ).toEqual(["IN_TRANSIT", "IN_TRANSIT"]);
      await receiveTransfer(w.manager, { transferId: id }, meta());
      const moved = await admin.serialNumber.findMany({
        where: { productId: p.id, serial: { in: ["TR-1", "TR-2"] } },
      });
      expect(moved.every((s) => s.status === "IN_STOCK" && s.warehouseId === w.warehouse2Id)).toBe(
        true,
      );
      expect(
        (await admin.serialNumber.findFirstOrThrow({ where: { productId: p.id, serial: "TR-3" } }))
          .warehouseId,
      ).toBe(w.warehouseId);
      expect(await qty(p.id, w.warehouseId)).toBe(1);
      expect(await qty(p.id, w.warehouse2Id)).toBe(2);
    });

    it("si llega menos de lo despachado queda la diferencia y una alerta crítica", async () => {
      const p = await make(w.manager, plain());
      await stockIn(p.id, "10", "5");
      const { id } = await transfer([{ productId: p.id, quantity: "6" }]);
      await shipTransfer(w.manager, id, meta());
      const item = await admin.stockTransferItem.findFirstOrThrow({ where: { transferId: id } });
      await expect(
        receiveTransfer(
          w.manager,
          { transferId: id, received: [{ itemId: item.id, quantity: "7" }] },
          meta(),
        ),
      ).rejects.toMatchObject({ code: "TRANSFER_EXCESS" });
      expect((await admin.stockTransfer.findUniqueOrThrow({ where: { id } })).status).toBe(
        "IN_TRANSIT",
      ); // el error revierte todo

      const result = await receiveTransfer(
        w.manager,
        { transferId: id, received: [{ itemId: item.id, quantity: "4" }] },
        meta(),
      );
      expect(result.missing).toBe("2");
      expect(await qty(p.id, w.warehouse2Id)).toBe(4);
      expect(
        Number(
          (await admin.stockTransferItem.findUniqueOrThrow({ where: { id: item.id } })).qtyReceived,
        ),
      ).toBe(4);
      const alert = await admin.notification.findFirstOrThrow({
        where: { tenantId: w.tenantId, dedupeKey: `transfer-diff:${id}` },
      });
      expect(alert).toMatchObject({ kind: "transfer.difference", severity: "CRITICAL" });
    });

    it("cancelar solo antes de despachar; validaciones y permisos", async () => {
      const p = await make(w.manager, plain());
      await stockIn(p.id, "5");
      const first = await transfer([{ productId: p.id, quantity: "1" }]);
      await cancelTransfer(w.manager, first.id, meta());
      expect(
        (await admin.stockTransfer.findUniqueOrThrow({ where: { id: first.id } })).status,
      ).toBe("CANCELLED");
      await expect(shipTransfer(w.manager, first.id, meta())).rejects.toMatchObject({
        code: "TRANSFER_STATE",
      });

      const second = await transfer([{ productId: p.id, quantity: "1" }]);
      await shipTransfer(w.manager, second.id, meta());
      await expect(cancelTransfer(w.manager, second.id, meta())).rejects.toBeInstanceOf(
        ConflictError,
      );

      await expect(
        transfer([{ productId: p.id, quantity: "1" }], { toWarehouseId: w.warehouseId }),
      ).rejects.toThrow(/distintos/);
      await expect(transfer([])).rejects.toThrow();
      await expect(
        requestTransfer(
          w.cashier,
          {
            fromWarehouseId: w.warehouseId,
            toWarehouseId: w.warehouse2Id,
            items: [{ productId: p.id, quantity: "1" }],
          },
          meta(),
        ),
      ).rejects.toBeInstanceOf(PermissionDeniedError);
      await expect(shipTransfer(w.cashier, second.id, meta())).rejects.toBeInstanceOf(
        PermissionDeniedError,
      );
    });

    it("otro tenant no puede despachar ni recibir transferencias ajenas", async () => {
      const p = await make(w.manager, plain());
      await stockIn(p.id, "5");
      const { id } = await transfer([{ productId: p.id, quantity: "2" }]);
      await expect(shipTransfer(other.manager, id, meta())).rejects.toMatchObject({
        code: "TRANSFER_STATE",
      });
      await expect(cancelTransfer(other.manager, id, meta())).rejects.toMatchObject({
        code: "TRANSFER_STATE",
      });
      expect((await admin.stockTransfer.findUniqueOrThrow({ where: { id } })).status).toBe(
        "REQUESTED",
      );
    });
  });

  describe("conteo físico (inventario cíclico)", () => {
    it("abre, cuenta, cierra y aplica ajustes auditados con motivo", async () => {
      const a = await make(w.manager, plain());
      const b = await make(w.manager, plain());
      await stockIn(a.id, "10", "4", {}, w.warehouse2Id);
      await stockIn(b.id, "5", "4", {}, w.warehouse2Id);
      const count = await openCount(
        w.manager,
        { warehouseId: w.warehouse2Id, productIds: [a.id, b.id], cyclic: true },
        meta(),
      );
      expect(count.items).toBe(2);
      const items = await admin.inventoryCountItem.findMany({ where: { countId: count.id } });
      const itemOf = (productId: string) => items.find((i) => i.productId === productId)?.id ?? "";

      expect(
        await recordCount(w.manager, { countId: count.id, itemId: itemOf(a.id), countedQty: "8" }),
      ).toEqual({ difference: "-2" });
      expect(
        await recordCount(w.manager, { countId: count.id, itemId: itemOf(b.id), countedQty: 7 }),
      ).toEqual({ difference: "2" });
      await expect(applyCount(w.manager, count.id, meta())).rejects.toMatchObject({
        code: "COUNT_STATE",
      }); // falta cerrar
      await closeCount(w.manager, count.id);
      await expect(
        recordCount(w.manager, { countId: count.id, itemId: itemOf(a.id), countedQty: "9" }),
      ).rejects.toMatchObject({ code: "COUNT_STATE" });

      const result = await applyCount(w.manager, count.id, meta());
      expect(result).toEqual({ adjusted: 2, unitsIn: "2", unitsOut: "2", skippedSerial: [] });
      expect(await qty(a.id, w.warehouse2Id)).toBe(8);
      expect(await qty(b.id, w.warehouse2Id)).toBe(7);
      const movements = await admin.kardexMovement.findMany({
        where: { referenceId: count.id },
        orderBy: { quantityDelta: "asc" },
      });
      expect(movements.map((m) => m.type)).toEqual(["COUNT_ADJUSTMENT_OUT", "COUNT_ADJUSTMENT_IN"]);
      expect(movements.every((m) => m.reason === `Conteo físico #${count.number}`)).toBe(true);
      const audit = await admin.auditLog.findFirstOrThrow({
        where: { entityId: count.id, action: "count.applied" },
      });
      expect(audit).toMatchObject({
        actorUserId: w.manager.userId,
        reason: `Conteo físico #${count.number}`,
      });
      await expect(applyCount(w.manager, count.id, meta())).rejects.toMatchObject({
        code: "COUNT_STATE",
      });
      expect(
        await admin.inventoryCountItem.count({
          where: { countId: count.id, adjustmentMovementId: { not: null } },
        }),
      ).toBe(2);
    });

    it("las ventas anteriores al conteo no se convierten en faltantes fantasma", async () => {
      const p = await make(w.manager, plain());
      await stockIn(p.id, "10");
      const count = await openCount(
        w.manager,
        { warehouseId: w.warehouseId, productIds: [p.id] },
        meta(),
      );
      await sell(p.id, "3"); // se vende después de abrir: el sistema ahora dice 7
      const item = await admin.inventoryCountItem.findFirstOrThrow({
        where: { countId: count.id },
      });
      expect(
        await recordCount(w.manager, { countId: count.id, itemId: item.id, countedQty: "7" }),
      ).toEqual({ difference: "0" });
      await closeCount(w.manager, count.id);
      expect((await applyCount(w.manager, count.id, meta())).adjusted).toBe(0);
      expect(await qty(p.id, w.warehouseId)).toBe(7);
    });

    it("llantas: se cuenta por lote y el ajuste afecta a ese lote", async () => {
      const p = await make(w.manager, tire());
      await stockIn(p.id, "6", "250", { lot: { code: "A", dotCode: "2025" } });
      await stockIn(p.id, "4", "250", { lot: { code: "B", dotCode: "1025" } });
      const count = await openCount(
        w.manager,
        { warehouseId: w.warehouseId, productIds: [p.id] },
        meta(),
      );
      expect(count.items).toBe(2);
      const lotB = await admin.stockLot.findFirstOrThrow({ where: { productId: p.id, code: "B" } });
      const item = await admin.inventoryCountItem.findFirstOrThrow({
        where: { countId: count.id, lotId: lotB.id },
      });
      await recordCount(w.manager, { countId: count.id, itemId: item.id, countedQty: "3" });
      await closeCount(w.manager, count.id);
      await applyCount(w.manager, count.id, meta());
      const balances = await admin.stockLotBalance.findMany({ where: { productId: p.id } });
      expect(balances.find((b) => b.lotId === lotB.id)?.quantity.toString()).toBe("3");
      expect(await qty(p.id, w.warehouseId)).toBe(9);
    });

    it("productos con serie no se ajustan por cantidad: se reportan para ajustar por serie", async () => {
      const p = await make(w.manager, battery());
      await registerStockIn(
        w.manager,
        {
          warehouseId: w.warehouseId,
          productId: p.id,
          unitCost: "300",
          serials: ["CNT-1", "CNT-2"],
          idempotencyKey: key(),
        },
        meta(),
      );
      const count = await openCount(
        w.manager,
        { warehouseId: w.warehouseId, productIds: [p.id] },
        meta(),
      );
      const item = await admin.inventoryCountItem.findFirstOrThrow({
        where: { countId: count.id },
      });
      await recordCount(w.manager, { countId: count.id, itemId: item.id, countedQty: "1" });
      await closeCount(w.manager, count.id);
      const result = await applyCount(w.manager, count.id, meta());
      expect(result.adjusted).toBe(0);
      expect(result.skippedSerial).toEqual([p.sku]);
      expect(await qty(p.id, w.warehouseId)).toBe(2);
    });

    it("validaciones, vacío y permisos", async () => {
      const p = await make(w.manager, plain());
      await stockIn(p.id, "2");
      await expect(
        openCount(w.cashier, { warehouseId: w.warehouseId }, meta()),
      ).rejects.toBeInstanceOf(PermissionDeniedError);
      await expect(
        openCount(w.manager, { warehouseId: w.warehouse2Id, productIds: [p.id] }, meta()),
      ).rejects.toMatchObject({ code: "COUNT_EMPTY" });
      const count = await openCount(
        w.manager,
        { warehouseId: w.warehouseId, productIds: [p.id] },
        meta(),
      );
      await expect(closeCount(w.manager, count.id)).rejects.toMatchObject({ code: "COUNT_EMPTY" }); // nada contado
      const item = await admin.inventoryCountItem.findFirstOrThrow({
        where: { countId: count.id },
      });
      await expect(
        recordCount(w.manager, { countId: count.id, itemId: item.id, countedQty: "-1" }),
      ).rejects.toThrow();
      await expect(
        recordCount(other.manager, { countId: count.id, itemId: item.id, countedQty: "1" }),
      ).rejects.toMatchObject({ code: "COUNT_STATE" });
    });
  });

  it("después de transferencias y conteos el saldo coincide con el kardex", async () => {
    expect(await withTenant(w.tenantId, (tx) => reconcileStock(tx))).toEqual([]);
  });
});
