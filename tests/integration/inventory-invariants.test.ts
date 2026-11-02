import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { nextSequence, withTenant, type TenantTx } from "@/lib/db";
import { InsufficientStockError } from "@/lib/errors";
import type { PrismaClient } from "@/lib/db/generated/client.ts";
import { adminClient, seedTenant, type SeededTenant } from "../helpers/db.ts";

/**
 * El stock jamás se edita: es el resultado del kardex. Estas pruebas corren
 * contra los triggers reales con el rol sin privilegios sobre los saldos.
 */
describe("kardex, saldos y concurrencia", () => {
  let admin: PrismaClient;
  let a: SeededTenant;
  let b: SeededTenant;

  beforeAll(async () => {
    admin = adminClient();
    a = await seedTenant(admin, "KA");
    b = await seedTenant(admin, "KB");
  });
  afterAll(async () => {
    await admin.$disconnect();
  });

  /** Producto nuevo por prueba para que los saldos no se mezclen. */
  async function newProduct(seed: SeededTenant): Promise<string> {
    const product = await admin.product.create({
      data: {
        tenantId: seed.tenantId,
        sku: `K-${randomUUID()}`,
        name: "Producto de kardex",
        kind: "PART",
      },
    });
    return product.id;
  }

  function move(
    tx: TenantTx,
    seed: SeededTenant,
    productId: string,
    data: {
      type: "PURCHASE" | "SALE" | "ADJUSTMENT_IN" | "ADJUSTMENT_OUT" | "INITIAL";
      qty: string;
      cost?: string;
      reason?: string;
      allowNegative?: boolean;
      lotId?: string;
      key?: string;
    },
  ) {
    return tx.kardexMovement.create({
      data: {
        warehouseId: seed.warehouseId,
        productId,
        type: data.type,
        quantityDelta: data.qty,
        unitCost: data.cost,
        reason: data.reason,
        allowNegative: data.allowNegative ?? false,
        lotId: data.lotId,
        idempotencyKey: data.key ?? randomUUID(),
      },
    });
  }

  async function balanceOf(seed: SeededTenant, productId: string) {
    return withTenant(seed.tenantId, (tx) =>
      tx.stockBalance.findUnique({
        where: {
          tenantId_warehouseId_productId: {
            tenantId: seed.tenantId,
            warehouseId: seed.warehouseId,
            productId,
          },
        },
      }),
    );
  }

  it("las entradas suben el saldo y recalculan el costo promedio ponderado", async () => {
    const productId = await newProduct(a);
    const first = await withTenant(a.tenantId, (tx) =>
      move(tx, a, productId, { type: "PURCHASE", qty: "10", cost: "5" }),
    );
    expect(first.balanceAfter.toString()).toBe("10");
    const second = await withTenant(a.tenantId, (tx) =>
      move(tx, a, productId, { type: "PURCHASE", qty: "10", cost: "7" }),
    );
    expect(second.balanceAfter.toString()).toBe("20");
    expect(second.avgCostAfter.toString()).toBe("6");

    const sale = await withTenant(a.tenantId, (tx) =>
      move(tx, a, productId, { type: "SALE", qty: "-5" }),
    );
    expect(sale.balanceAfter.toString()).toBe("15");
    expect(sale.unitCost?.toString()).toBe("6"); // salida valorizada al promedio
    const balance = await balanceOf(a, productId);
    expect(balance?.quantity.toString()).toBe("15");
    expect(balance?.avgCost.toString()).toBe("6");
  });

  it("no permite stock negativo y deja el saldo intacto", async () => {
    const productId = await newProduct(a);
    await withTenant(a.tenantId, (tx) =>
      move(tx, a, productId, { type: "PURCHASE", qty: "3", cost: "10" }),
    );
    await expect(
      withTenant(a.tenantId, (tx) => move(tx, a, productId, { type: "SALE", qty: "-4" })),
    ).rejects.toBeInstanceOf(InsufficientStockError);
    expect((await balanceOf(a, productId))?.quantity.toString()).toBe("3");
  });

  it("permite negativo solo con allowNegative explícito", async () => {
    const productId = await newProduct(a);
    const row = await withTenant(a.tenantId, (tx) =>
      move(tx, a, productId, { type: "SALE", qty: "-2", allowNegative: true }),
    );
    expect(row.balanceAfter.toString()).toBe("-2");
  });

  it("idempotencia: la misma clave no duplica el movimiento", async () => {
    const productId = await newProduct(a);
    const key = randomUUID();
    await withTenant(a.tenantId, (tx) =>
      move(tx, a, productId, { type: "PURCHASE", qty: "4", cost: "1", key }),
    );
    await expect(
      withTenant(a.tenantId, (tx) =>
        move(tx, a, productId, { type: "PURCHASE", qty: "4", cost: "1", key }),
      ),
    ).rejects.toThrow();
    expect((await balanceOf(a, productId))?.quantity.toString()).toBe("4");
  });

  it("CHECKs: signo por tipo, costo obligatorio en compras y motivo en ajustes", async () => {
    const productId = await newProduct(a);
    await expect(
      withTenant(a.tenantId, (tx) =>
        move(tx, a, productId, { type: "PURCHASE", qty: "-1", cost: "1" }),
      ),
    ).rejects.toThrow();
    await expect(
      withTenant(a.tenantId, (tx) => move(tx, a, productId, { type: "SALE", qty: "1" })),
    ).rejects.toThrow();
    await expect(
      withTenant(a.tenantId, (tx) => move(tx, a, productId, { type: "PURCHASE", qty: "1" })),
    ).rejects.toThrow();
    await expect(
      withTenant(a.tenantId, (tx) => move(tx, a, productId, { type: "ADJUSTMENT_IN", qty: "1" })),
    ).rejects.toThrow();
    const adjusted = await withTenant(a.tenantId, (tx) =>
      move(tx, a, productId, { type: "ADJUSTMENT_IN", qty: "1", reason: "Conteo físico" }),
    );
    expect(adjusted.reason).toBe("Conteo físico");
  });

  it("los saldos no se pueden editar a mano: ni la app ni el dueño de las tablas", async () => {
    const productId = await newProduct(a);
    await withTenant(a.tenantId, (tx) =>
      move(tx, a, productId, { type: "PURCHASE", qty: "2", cost: "1" }),
    );

    await expect(
      withTenant(
        a.tenantId,
        (tx) =>
          tx.$executeRaw`UPDATE stock_balances SET quantity = 999 WHERE "productId" = ${productId}::uuid`,
      ),
    ).rejects.toThrow(/permission denied/i);

    // El rol dueño (que ignora RLS) tampoco: lo bloquea el trigger de guarda.
    await expect(
      admin.$executeRaw`UPDATE stock_balances SET quantity = 999 WHERE "productId" = ${productId}::uuid`,
    ).rejects.toThrow(/stock_guard/);
    await expect(
      admin.$executeRaw`DELETE FROM stock_balances WHERE "productId" = ${productId}::uuid`,
    ).rejects.toThrow(/stock_guard/);
    expect((await balanceOf(a, productId))?.quantity.toString()).toBe("2");
  });

  it("el kardex y la auditoría son inmutables", async () => {
    const productId = await newProduct(a);
    const row = await withTenant(a.tenantId, (tx) =>
      move(tx, a, productId, { type: "PURCHASE", qty: "1", cost: "1" }),
    );
    await expect(
      admin.$executeRaw`UPDATE kardex_movements SET "quantityDelta" = 50 WHERE id = ${row.id}::uuid`,
    ).rejects.toThrow(/immutable/);
    await expect(
      admin.$executeRaw`DELETE FROM kardex_movements WHERE id = ${row.id}::uuid`,
    ).rejects.toThrow(/immutable/);
    await expect(admin.$executeRaw`TRUNCATE kardex_movements`).rejects.toThrow(/immutable/);

    const audit = await withTenant(a.tenantId, (tx) =>
      tx.auditLog.create({
        data: {
          actorType: "USER",
          action: "stock.adjust",
          entityType: "product",
          entityId: productId,
          before: { qty: 1 },
          after: { qty: 2 },
        },
      }),
    );
    await expect(
      admin.$executeRaw`UPDATE audit_logs SET action = 'x' WHERE id = ${audit.id}::uuid`,
    ).rejects.toThrow(/immutable/);
    await expect(
      admin.$executeRaw`DELETE FROM audit_logs WHERE id = ${audit.id}::uuid`,
    ).rejects.toThrow(/immutable/);
    await expect(
      withTenant(a.tenantId, (tx) => tx.$executeRaw`UPDATE audit_logs SET action = 'x'`),
    ).rejects.toThrow(/permission denied/i);
  });

  it("un tenant no puede mover stock de productos o almacenes de otro", async () => {
    const productOfB = await newProduct(b);
    await expect(
      withTenant(a.tenantId, (tx) =>
        tx.kardexMovement.create({
          data: {
            warehouseId: a.warehouseId,
            productId: productOfB,
            type: "PURCHASE",
            quantityDelta: "5",
            unitCost: "1",
            idempotencyKey: randomUUID(),
          },
        }),
      ),
    ).rejects.toThrow();
    await expect(
      withTenant(a.tenantId, (tx) =>
        tx.kardexMovement.create({
          data: {
            tenantId: b.tenantId,
            warehouseId: b.warehouseId,
            productId: productOfB,
            type: "PURCHASE",
            quantityDelta: "5",
            unitCost: "1",
            idempotencyKey: randomUUID(),
          },
        }),
      ),
    ).rejects.toThrow();
    expect(await balanceOf(b, productOfB)).toBeNull();
    // Y los saldos de B son invisibles para A.
    const productOfA = await newProduct(a);
    await withTenant(b.tenantId, (tx) =>
      move(tx, b, productOfB, { type: "PURCHASE", qty: "7", cost: "1" }),
    );
    const seenByA = await withTenant(a.tenantId, (tx) =>
      tx.stockBalance.findMany({ where: { productId: productOfB } }),
    );
    expect(seenByA).toEqual([]);
    expect(productOfA).toBeTruthy();
  });

  it("lotes: el saldo por lote se mantiene y tampoco queda negativo", async () => {
    const productId = await newProduct(a);
    const lot = await admin.stockLot.create({
      data: { tenantId: a.tenantId, productId, code: "DOT-2424", dotCode: "2424" },
    });
    await withTenant(a.tenantId, (tx) =>
      move(tx, a, productId, { type: "PURCHASE", qty: "4", cost: "100", lotId: lot.id }),
    );
    await withTenant(a.tenantId, (tx) =>
      move(tx, a, productId, { type: "SALE", qty: "-3", lotId: lot.id }),
    );
    const lotBalance = await withTenant(a.tenantId, (tx) =>
      tx.stockLotBalance.findFirstOrThrow({ where: { lotId: lot.id } }),
    );
    expect(lotBalance.quantity.toString()).toBe("1");
    await expect(
      withTenant(a.tenantId, (tx) =>
        move(tx, a, productId, { type: "SALE", qty: "-2", lotId: lot.id }),
      ),
    ).rejects.toBeInstanceOf(InsufficientStockError);
  });

  it("concurrencia: 12 ventas simultáneas sobre 5 unidades => exactamente 5 exitosas y saldo 0", async () => {
    const productId = await newProduct(a);
    await withTenant(a.tenantId, (tx) =>
      move(tx, a, productId, { type: "PURCHASE", qty: "5", cost: "10" }),
    );

    const results = await Promise.allSettled(
      Array.from({ length: 12 }, () =>
        withTenant(a.tenantId, (tx) => move(tx, a, productId, { type: "SALE", qty: "-1" })),
      ),
    );
    const succeeded = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(succeeded).toHaveLength(5);
    expect(rejected).toHaveLength(7);
    expect(rejected.every((r) => r.reason instanceof InsufficientStockError)).toBe(true);

    const balance = await balanceOf(a, productId);
    expect(balance?.quantity.toString()).toBe("0");
    const sum = await admin.kardexMovement.aggregate({
      where: { productId },
      _sum: { quantityDelta: true },
    });
    expect(sum._sum.quantityDelta?.toString()).toBe("0"); // saldo = suma de movimientos
  });

  it("correlativos: 20 solicitudes simultáneas obtienen números únicos y consecutivos", async () => {
    const series = `T-${randomUUID().slice(0, 6)}`;
    const numbers = await Promise.all(
      Array.from({ length: 20 }, () =>
        withTenant(a.tenantId, (tx) => nextSequence(tx, "SALE", series)),
      ),
    );
    expect([...numbers].sort((x, y) => x - y)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    // Cada tenant tiene su propio contador.
    expect(await withTenant(b.tenantId, (tx) => nextSequence(tx, "SALE", series))).toBe(1);
  });
});
