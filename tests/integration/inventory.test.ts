import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTenant, type MovementType } from "@/lib/db";
import type { PrismaClient } from "@/lib/db/generated/client.ts";
import {
  ConflictError,
  InsufficientStockError,
  NotFoundError,
  PermissionDeniedError,
} from "@/lib/errors";
import {
  adjustStock,
  applyMovement,
  applyMovements,
  registerStockIn,
  type MovementRequest,
} from "@/server/services/inventory";
import { reconcileStock } from "@/server/services/reconcile";
import { configureAuthCache } from "@/server/services/session-resolver";
import { listStock } from "@/server/services/stock-queries";
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

describe("kardex, lotes, series y concurrencia", () => {
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

  /** Camino interno (ventas, OT...): sin chequeo de permisos, como lo usarán las fases 5 y 6. */
  const post = (
    world: InventoryWorld,
    req: Partial<MovementRequest> & { productId: string; type: MovementType },
  ) =>
    withTenant(world.tenantId, (tx) =>
      applyMovement(tx, { warehouseId: world.warehouseId, idempotencyKey: key(), ...req }),
    );
  const balance = async (
    world: InventoryWorld,
    productId: string,
    warehouseId = world.warehouseId,
  ) =>
    Number(
      (
        await admin.stockBalance.findFirst({
          where: { tenantId: world.tenantId, productId, warehouseId },
        })
      )?.quantity ?? 0,
    );
  const stockIn = (
    productId: string,
    quantity: string,
    unitCost = "10",
    extra: Record<string, unknown> = {},
  ) =>
    registerStockIn(
      w.manager,
      {
        warehouseId: w.warehouseId,
        productId,
        quantity,
        unitCost,
        idempotencyKey: key(),
        ...extra,
      },
      meta(),
    );

  describe("entradas y costo promedio", () => {
    it("suma al saldo, calcula el costo promedio ponderado y actualiza el último costo", async () => {
      const p = await make(w.manager, plain());
      const first = await stockIn(p.id, "10", "5");
      expect(first.movements[0]).toMatchObject({
        quantityDelta: "10",
        balanceAfter: "10",
        avgCostAfter: "5",
      });
      const second = await stockIn(p.id, "10", "7");
      expect(second.movements[0]).toMatchObject({ balanceAfter: "20", avgCostAfter: "6" });
      const sale = await post(w, { productId: p.id, type: "SALE", quantity: "5" });
      expect(sale.movements[0]).toMatchObject({
        quantityDelta: "-5",
        balanceAfter: "15",
        unitCost: "6",
      }); // salida al costo promedio
      expect(
        (
          await admin.product.findUniqueOrThrow({ where: { id: p.id } })
        ).lastPurchaseCost?.toString(),
      ).toBe("7");
      expect(
        (await admin.auditLog.findMany({ where: { entityId: p.id, action: "stock.in" } })).length,
      ).toBe(2);
    });

    it("solo quien tiene permisos de inventario registra entradas", async () => {
      const p = await make(w.manager, plain());
      await expect(
        registerStockIn(
          w.cashier,
          {
            warehouseId: w.warehouseId,
            productId: p.id,
            quantity: "1",
            unitCost: "1",
            idempotencyKey: key(),
          },
          meta(),
        ),
      ).rejects.toBeInstanceOf(PermissionDeniedError);
      await expect(
        registerStockIn(
          w.mechanic,
          {
            warehouseId: w.warehouseId,
            productId: p.id,
            quantity: "1",
            unitCost: "1",
            idempotencyKey: key(),
          },
          meta(),
        ),
      ).rejects.toBeInstanceOf(PermissionDeniedError);
    });

    it("rechaza servicios, productos y almacenes inexistentes o ajenos", async () => {
      const service = await make(w.manager, {
        kind: "SERVICE",
        sku: "SV-" + randomUUID().slice(0, 6),
        name: "Servicio",
        salePrice: 10,
      });
      await expect(stockIn(service.id, "1")).rejects.toMatchObject({ code: "NOT_STOCKED" });
      await expect(stockIn(randomUUID(), "1")).rejects.toBeInstanceOf(NotFoundError);
      const p = await make(w.manager, plain());
      await expect(
        registerStockIn(
          w.manager,
          {
            warehouseId: other.warehouseId,
            productId: p.id,
            quantity: "1",
            unitCost: "1",
            idempotencyKey: key(),
          },
          meta(),
        ),
      ).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  describe("saldo nunca negativo", () => {
    it("una salida mayor al stock falla con InsufficientStockError y deja el saldo intacto", async () => {
      const p = await make(w.manager, plain());
      await stockIn(p.id, "3");
      await expect(
        post(w, { productId: p.id, type: "SALE", quantity: "4" }),
      ).rejects.toBeInstanceOf(InsufficientStockError);
      expect(await balance(w, p.id)).toBe(3);
      expect(await admin.kardexMovement.count({ where: { productId: p.id } })).toBe(1);
    });

    it("el ajuste negativo exige el permiso Y que el tenant lo habilite", async () => {
      const p = await make(w.manager, plain());
      await stockIn(p.id, "2");
      const adjust = (actor: InventoryWorld["admin"], over: Record<string, unknown> = {}) =>
        adjustStock(
          actor,
          {
            warehouseId: w.warehouseId,
            productId: p.id,
            direction: "OUT",
            quantity: "5",
            reason: "Merma detectada",
            idempotencyKey: key(),
            ...over,
          },
          meta(),
        );

      await expect(adjust(w.manager)).rejects.toBeInstanceOf(InsufficientStockError);
      await expect(adjust(w.manager, { allowNegative: true })).rejects.toBeInstanceOf(
        PermissionDeniedError,
      ); // sin permitir_stock_negativo
      await expect(adjust(w.admin, { allowNegative: true })).rejects.toMatchObject({
        code: "NEGATIVE_NOT_ENABLED",
      }); // tenant no lo habilitó

      await admin.tenantSettings.update({
        where: { tenantId: w.tenantId },
        data: { allowNegativeStock: true },
      });
      const outcome = await adjust(w.admin, { allowNegative: true });
      expect(outcome.movements[0]?.balanceAfter).toBe("-3");
      await admin.tenantSettings.update({
        where: { tenantId: w.tenantId },
        data: { allowNegativeStock: false },
      });
      expect(await balance(w, p.id)).toBe(-3);
    });

    it("los ajustes exigen motivo, quedan auditados con valor anterior y nuevo", async () => {
      const p = await make(w.manager, plain());
      await stockIn(p.id, "10");
      await expect(
        adjustStock(
          w.manager,
          {
            warehouseId: w.warehouseId,
            productId: p.id,
            direction: "OUT",
            quantity: "1",
            reason: "x",
            idempotencyKey: key(),
          },
          meta(),
        ),
      ).rejects.toThrow(/motivo/);
      await adjustStock(
        w.manager,
        {
          warehouseId: w.warehouseId,
          productId: p.id,
          direction: "OUT",
          quantity: "4",
          reason: "Rotura en almacén",
          idempotencyKey: key(),
        },
        meta(),
      );
      const log = await admin.auditLog.findFirstOrThrow({
        where: { entityId: p.id, action: "stock.adjusted" },
      });
      expect(log).toMatchObject({
        before: { quantity: "10" },
        after: { quantity: "6", direction: "OUT" },
        reason: "Rotura en almacén",
        actorUserId: w.manager.userId,
      });
      const row = await admin.kardexMovement.findFirstOrThrow({
        where: { productId: p.id, type: "ADJUSTMENT_OUT" },
      });
      expect(row.reason).toBe("Rotura en almacén");
    });

    it("el cajero no puede ajustar stock", async () => {
      const p = await make(w.manager, plain());
      await expect(
        adjustStock(
          w.cashier,
          {
            warehouseId: w.warehouseId,
            productId: p.id,
            direction: "IN",
            quantity: "1",
            reason: "Sobrante visto",
            idempotencyKey: key(),
          },
          meta(),
        ),
      ).rejects.toBeInstanceOf(PermissionDeniedError);
    });
  });

  describe("idempotencia", () => {
    it("repetir la misma clave devuelve el movimiento original sin duplicar", async () => {
      const p = await make(w.manager, plain());
      const k = key();
      const first = await registerStockIn(
        w.manager,
        {
          warehouseId: w.warehouseId,
          productId: p.id,
          quantity: "5",
          unitCost: "2",
          idempotencyKey: k,
        },
        meta(),
      );
      const again = await registerStockIn(
        w.manager,
        {
          warehouseId: w.warehouseId,
          productId: p.id,
          quantity: "5",
          unitCost: "2",
          idempotencyKey: k,
        },
        meta(),
      );
      expect(first.replayed).toBe(false);
      expect(again.replayed).toBe(true);
      expect(again.movements[0]?.id).toBe(first.movements[0]?.id);
      expect(await balance(w, p.id)).toBe(5);
      expect(await admin.auditLog.count({ where: { entityId: p.id, action: "stock.in" } })).toBe(1);
    });

    it("12 peticiones simultáneas con la misma clave aplican el movimiento UNA sola vez", async () => {
      const p = await make(w.manager, plain());
      const k = key();
      const results = await Promise.all(
        Array.from({ length: 12 }, () =>
          registerStockIn(
            w.manager,
            {
              warehouseId: w.warehouseId,
              productId: p.id,
              quantity: "5",
              unitCost: "2",
              idempotencyKey: k,
            },
            meta(),
          ),
        ),
      );
      expect(new Set(results.map((r) => r.movements[0]?.id)).size).toBe(1);
      expect(results.filter((r) => !r.replayed)).toHaveLength(1);
      expect(await balance(w, p.id)).toBe(5);
      expect(await admin.kardexMovement.count({ where: { idempotencyKey: k } })).toBe(1);
    });

    it("la misma clave para otra operación es un conflicto, no un duplicado silencioso", async () => {
      const a = await make(w.manager, plain());
      const b = await make(w.manager, plain());
      const k = key();
      await stockIn(a.id, "1", "1", { idempotencyKey: k });
      await expect(stockIn(b.id, "1", "1", { idempotencyKey: k })).rejects.toBeInstanceOf(
        ConflictError,
      );
    });

    it("la clave es por tenant: otro tenant puede usar la misma", async () => {
      const mine = await make(w.manager, plain());
      const theirs = await make(other.manager, plain());
      const k = key();
      await registerStockIn(
        w.manager,
        {
          warehouseId: w.warehouseId,
          productId: mine.id,
          quantity: "1",
          unitCost: "1",
          idempotencyKey: k,
        },
        meta(),
      );
      await expect(
        registerStockIn(
          other.manager,
          {
            warehouseId: other.warehouseId,
            productId: theirs.id,
            quantity: "1",
            unitCost: "1",
            idempotencyKey: k,
          },
          meta(),
        ),
      ).resolves.toMatchObject({ replayed: false });
    });
  });

  describe("llantas por lote (DOT) con FEFO", () => {
    it("exige lote en llantas, valida el DOT y crea el lote con su fecha de fabricación", async () => {
      const p = await make(w.manager, tire());
      await expect(stockIn(p.id, "4", "200")).rejects.toMatchObject({ code: "LOT_REQUIRED" });
      await expect(
        stockIn(p.id, "4", "200", { lot: { code: "L-X", dotCode: "9999" } }),
      ).rejects.toThrow(/DOT inválido/);
      await stockIn(p.id, "4", "200", { lot: { code: "DOT-2423", dotCode: "2423" } });
      const lot = await admin.stockLot.findFirstOrThrow({ where: { productId: p.id } });
      expect(lot).toMatchObject({ dotCode: "2423" });
      expect(lot.manufacturedAt?.toISOString()).toBe("2023-06-12T00:00:00.000Z");
    });

    it("la salida consume primero el lote de DOT más antiguo, sin importar el orden de recepción", async () => {
      const p = await make(w.manager, tire());
      // Recepción: A (2024), B (2022, el más viejo), C (2025). Ni "primero en llegar" ni "último en llegar" dan B, A, C.
      await stockIn(p.id, "4", "250", { lot: { code: "A", dotCode: "1024" } });
      await stockIn(p.id, "3", "240", { lot: { code: "B", dotCode: "0822" } });
      await stockIn(p.id, "10", "260", { lot: { code: "C", dotCode: "2025" } });
      const outcome = await post(w, { productId: p.id, type: "SALE", quantity: "9" });
      const lots = await admin.stockLot.findMany({ where: { productId: p.id } });
      const code = (id: string | null) => lots.find((l) => l.id === id)?.code;
      expect(outcome.movements.map((m) => [code(m.lotId), m.quantityDelta])).toEqual([
        ["B", "-3"],
        ["A", "-4"],
        ["C", "-2"],
      ]);
      const balances = await admin.stockLotBalance.findMany({ where: { productId: p.id } });
      expect(Object.fromEntries(balances.map((b) => [code(b.lotId), Number(b.quantity)]))).toEqual({
        A: 0,
        B: 0,
        C: 8,
      });
      expect(await balance(w, p.id)).toBe(8);
      // Las claves de idempotencia de un reparto múltiple son derivadas y estables.
      expect(
        await admin.kardexMovement.count({
          where: { productId: p.id, type: "SALE", idempotencyKey: { contains: "#" } },
        }),
      ).toBe(3);
    });

    it("si no alcanza entre todos los lotes falla sin tocar nada", async () => {
      const p = await make(w.manager, tire());
      await stockIn(p.id, "3", "200", { lot: { code: "A", dotCode: "2025" } });
      await stockIn(p.id, "2", "200", { lot: { code: "B", dotCode: "1025" } });
      await expect(
        post(w, { productId: p.id, type: "SALE", quantity: "6" }),
      ).rejects.toBeInstanceOf(InsufficientStockError);
      expect(await balance(w, p.id)).toBe(5);
    });

    it("se puede elegir un lote concreto y no se pasa de su saldo", async () => {
      const p = await make(w.manager, tire());
      await stockIn(p.id, "3", "200", { lot: { code: "A", dotCode: "2025" } });
      await stockIn(p.id, "9", "200", { lot: { code: "B", dotCode: "1025" } });
      const lotA = await admin.stockLot.findFirstOrThrow({ where: { productId: p.id, code: "A" } });
      await expect(
        post(w, { productId: p.id, type: "SALE", quantity: "4", lotId: lotA.id }),
      ).rejects.toBeInstanceOf(InsufficientStockError);
      await expect(
        post(w, { productId: p.id, type: "SALE", quantity: "3", lotId: lotA.id }),
      ).resolves.toMatchObject({ replayed: false });
    });

    it("concurrencia por lotes: 20 ventas sobre 12 unidades en 2 lotes => exactamente 12 y ningún lote negativo", async () => {
      const p = await make(w.manager, tire());
      await stockIn(p.id, "6", "200", { lot: { code: "A", dotCode: "2025" } });
      await stockIn(p.id, "6", "200", { lot: { code: "B", dotCode: "1025" } });
      const results = await Promise.allSettled(
        Array.from({ length: 20 }, () => post(w, { productId: p.id, type: "SALE", quantity: "1" })),
      );
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(12);
      expect(
        results
          .filter((r): r is PromiseRejectedResult => r.status === "rejected")
          .every((r) => r.reason instanceof InsufficientStockError),
      ).toBe(true);
      const lots = await admin.stockLotBalance.findMany({ where: { productId: p.id } });
      expect(lots.map((l) => Number(l.quantity))).toEqual([0, 0]);
      expect(await balance(w, p.id)).toBe(0);
    });
  });

  describe("baterías con serie única", () => {
    it("exige series, rechaza duplicadas y valida que cuadre la cantidad", async () => {
      const p = await make(w.manager, battery());
      await expect(stockIn(p.id, "2", "300")).rejects.toMatchObject({ code: "SERIAL_REQUIRED" });
      await expect(stockIn(p.id, "3", "300", { serials: ["S-1", "S-2"] })).rejects.toMatchObject({
        code: "SERIAL_QTY_MISMATCH",
      });
      const ok = await registerStockIn(
        w.manager,
        {
          warehouseId: w.warehouseId,
          productId: p.id,
          unitCost: "300",
          serials: ["S-100", "S-101", "S-102"],
          idempotencyKey: key(),
        },
        meta(),
      );
      expect(ok.movements).toHaveLength(3);
      expect(await balance(w, p.id)).toBe(3);
      await expect(
        registerStockIn(
          w.manager,
          {
            warehouseId: w.warehouseId,
            productId: p.id,
            unitCost: "300",
            serials: ["S-101"],
            idempotencyKey: key(),
          },
          meta(),
        ),
      ).rejects.toMatchObject({ code: "SERIAL_EXISTS" });
      expect(await balance(w, p.id)).toBe(3);
    });

    it("vender una serie la marca SOLD y no se puede vender dos veces", async () => {
      const p = await make(w.manager, battery());
      await registerStockIn(
        w.manager,
        {
          warehouseId: w.warehouseId,
          productId: p.id,
          unitCost: "300",
          serials: ["VTA-1", "VTA-2"],
          idempotencyKey: key(),
        },
        meta(),
      );
      await post(w, { productId: p.id, type: "SALE", serials: ["VTA-1"] });
      const serial = await admin.serialNumber.findFirstOrThrow({
        where: { productId: p.id, serial: "VTA-1" },
      });
      expect(serial.status).toBe("SOLD");
      expect(serial.soldAt).not.toBeNull();
      await expect(
        post(w, { productId: p.id, type: "SALE", serials: ["VTA-1"] }),
      ).rejects.toMatchObject({ code: "SERIAL_UNAVAILABLE" });
      await expect(
        post(w, { productId: p.id, type: "SALE", serials: ["NO-EXISTE"] }),
      ).rejects.toBeInstanceOf(NotFoundError);
      expect(await balance(w, p.id)).toBe(1);
    });

    it("concurrencia: 8 ventas simultáneas de la MISMA serie => solo una prospera", async () => {
      const p = await make(w.manager, battery());
      await registerStockIn(
        w.manager,
        {
          warehouseId: w.warehouseId,
          productId: p.id,
          unitCost: "300",
          serials: ["RACE-1"],
          idempotencyKey: key(),
        },
        meta(),
      );
      const results = await Promise.allSettled(
        Array.from({ length: 8 }, () =>
          post(w, { productId: p.id, type: "SALE", serials: ["RACE-1"] }),
        ),
      );
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect(await balance(w, p.id)).toBe(0);
      expect(await admin.kardexMovement.count({ where: { productId: p.id, type: "SALE" } })).toBe(
        1,
      );
    });

    it("devolución de cliente: la serie vuelve a IN_STOCK y suma al saldo", async () => {
      const p = await make(w.manager, battery());
      await registerStockIn(
        w.manager,
        {
          warehouseId: w.warehouseId,
          productId: p.id,
          unitCost: "300",
          serials: ["DEV-1"],
          idempotencyKey: key(),
        },
        meta(),
      );
      await expect(
        post(w, { productId: p.id, type: "RETURN_CUSTOMER", serials: ["DEV-1"] }),
      ).rejects.toMatchObject({ code: "SERIAL_STATE" }); // aún no se vendió
      await post(w, { productId: p.id, type: "SALE", serials: ["DEV-1"] });
      await post(w, { productId: p.id, type: "RETURN_CUSTOMER", serials: ["DEV-1"] });
      expect(
        (await admin.serialNumber.findFirstOrThrow({ where: { productId: p.id, serial: "DEV-1" } }))
          .status,
      ).toBe("IN_STOCK");
      expect(await balance(w, p.id)).toBe(1);
    });

    it("una serie de otro almacén no está disponible", async () => {
      const p = await make(w.manager, battery());
      await registerStockIn(
        w.manager,
        {
          warehouseId: w.warehouseId,
          productId: p.id,
          unitCost: "300",
          serials: ["ALM-1"],
          idempotencyKey: key(),
        },
        meta(),
      );
      await expect(
        withTenant(w.tenantId, (tx) =>
          applyMovement(tx, {
            warehouseId: w.warehouse2Id,
            productId: p.id,
            type: "SALE",
            serials: ["ALM-1"],
            idempotencyKey: key(),
          }),
        ),
      ).rejects.toThrow();
    });
  });

  describe("concurrencia", () => {
    it("40 ventas simultáneas sobre 20 unidades => exactamente 20, saldo 0 y saldo = suma del kardex", async () => {
      const p = await make(w.manager, plain());
      await stockIn(p.id, "20", "3");
      const results = await Promise.allSettled(
        Array.from({ length: 40 }, () => post(w, { productId: p.id, type: "SALE", quantity: "1" })),
      );
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(20);
      expect(
        results
          .filter((r): r is PromiseRejectedResult => r.status === "rejected")
          .every((r) => r.reason instanceof InsufficientStockError),
      ).toBe(true);
      expect(await balance(w, p.id)).toBe(0);
      const sum = await admin.kardexMovement.aggregate({
        where: { productId: p.id },
        _sum: { quantityDelta: true },
      });
      expect(Number(sum._sum.quantityDelta)).toBe(0);
    });

    it("ventas y entradas mezcladas mantienen el saldo exacto", async () => {
      const p = await make(w.manager, plain());
      await stockIn(p.id, "10", "3");
      const ops = [
        ...Array.from({ length: 15 }, () =>
          post(w, { productId: p.id, type: "SALE", quantity: "1" }),
        ),
        ...Array.from({ length: 10 }, () => stockIn(p.id, "1", "3")),
      ];
      const results = await Promise.allSettled(ops);
      const sold = results.slice(0, 15).filter((r) => r.status === "fulfilled").length;
      expect(results.slice(15).every((r) => r.status === "fulfilled")).toBe(true);
      expect(await balance(w, p.id)).toBe(10 + 10 - sold);
      expect(await balance(w, p.id)).toBeGreaterThanOrEqual(0);
    });

    it("líneas cruzadas [A,B] y [B,A] no se bloquean entre sí (orden fijo)", async () => {
      const a = await make(w.manager, plain());
      const b = await make(w.manager, plain());
      await stockIn(a.id, "100", "1");
      await stockIn(b.id, "100", "1");
      const lines = (first: string, second: string): MovementRequest[] => [
        {
          warehouseId: w.warehouseId,
          productId: first,
          type: "SALE",
          quantity: "1",
          idempotencyKey: key(),
        },
        {
          warehouseId: w.warehouseId,
          productId: second,
          type: "SALE",
          quantity: "1",
          idempotencyKey: key(),
        },
      ];
      const results = await Promise.allSettled(
        Array.from({ length: 30 }, (_, i) =>
          withTenant(w.tenantId, (tx) =>
            applyMovements(tx, i % 2 === 0 ? lines(a.id, b.id) : lines(b.id, a.id)),
          ),
        ),
      );
      expect(results.filter((r) => r.status === "rejected")).toHaveLength(0);
      expect(await balance(w, a.id)).toBe(70);
      expect(await balance(w, b.id)).toBe(70);
    });

    it("una operación que falla a mitad revierte TODO (atomicidad)", async () => {
      const a = await make(w.manager, plain());
      const b = await make(w.manager, plain());
      await stockIn(a.id, "5", "1");
      await stockIn(b.id, "1", "1");
      await expect(
        withTenant(w.tenantId, (tx) =>
          applyMovements(tx, [
            {
              warehouseId: w.warehouseId,
              productId: a.id,
              type: "SALE",
              quantity: "2",
              idempotencyKey: key(),
            },
            {
              warehouseId: w.warehouseId,
              productId: b.id,
              type: "SALE",
              quantity: "9",
              idempotencyKey: key(),
            },
          ]),
        ),
      ).rejects.toBeInstanceOf(InsufficientStockError);
      expect(await balance(w, a.id)).toBe(5);
      expect(await balance(w, b.id)).toBe(1);
    });
  });

  describe("conciliación y aislamiento", () => {
    it("tras toda esta actividad, saldo = kardex en el tenant (sin diferencias)", async () => {
      expect(await withTenant(w.tenantId, (tx) => reconcileStock(tx))).toEqual([]);
    });

    it("el tenant B no ve ni puede mover el stock del tenant A", async () => {
      const p = await make(w.manager, plain());
      await stockIn(p.id, "7", "3");
      await expect(
        post(other, { productId: p.id, type: "SALE", quantity: "1" }),
      ).rejects.toBeInstanceOf(NotFoundError);
      await expect(
        post(other, { productId: p.id, warehouseId: w.warehouseId, type: "SALE", quantity: "1" }),
      ).rejects.toBeInstanceOf(NotFoundError);
      expect((await listStock(other.manager, {})).some((row) => row.productId === p.id)).toBe(
        false,
      );
      expect(await balance(w, p.id)).toBe(7);
    });
  });
});
