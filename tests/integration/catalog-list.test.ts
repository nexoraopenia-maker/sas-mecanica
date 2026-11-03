import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "@/lib/db/generated/client.ts";
import { listCatalog } from "@/server/services/catalog";
import { registerStockIn } from "@/server/services/inventory";
import { configureAuthCache } from "@/server/services/session-resolver";
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

describe("catálogo paginado (servidor)", () => {
  let admin: PrismaClient;
  let w: InventoryWorld;
  let other: InventoryWorld;

  const stockIn = (productId: string, quantity: string) =>
    registerStockIn(
      w.manager,
      { warehouseId: w.warehouseId, productId, quantity, unitCost: "50", idempotencyKey: key() },
      meta(),
    );
  const policy = (productId: string, reorderPoint: number) =>
    admin.reorderPolicy.create({
      data: {
        tenantId: w.tenantId,
        warehouseId: w.warehouseId,
        productId,
        mode: "MANUAL",
        manualMinStock: 0,
        manualReorderPoint: reorderPoint,
      },
    });

  beforeAll(async () => {
    configureAuthCache(0);
    admin = adminClient();
    w = await inventoryWorld(admin);
    other = await inventoryWorld(admin);
  }, 240_000);
  afterAll(async () => {
    await admin.$disconnect();
  });

  describe("paginación y filtros", () => {
    beforeAll(async () => {
      for (let i = 1; i <= 30; i += 1)
        await make(
          w.manager,
          plain({
            sku: `PAG-${String(i).padStart(2, "0")}`,
            name: `Pag ${String(i).padStart(2, "0")}`,
          }),
        );
    }, 120_000);

    it("pagina en el servidor sin repetir ni omitir productos", async () => {
      const first = await listCatalog(w.cashier, { q: "PAG-", pageSize: 12 });
      expect(first).toMatchObject({ total: 30, page: 1, pageCount: 3, filtered: true });
      expect(first.items).toHaveLength(12);
      const second = await listCatalog(w.cashier, { q: "PAG-", pageSize: 12, page: 2 });
      const third = await listCatalog(w.cashier, { q: "PAG-", pageSize: 12, page: 3 });
      expect(third.items).toHaveLength(6);
      const all = [...first.items, ...second.items, ...third.items].map((p) => p.sku);
      expect(new Set(all).size).toBe(30);
      expect(all).toEqual([...all].sort());
    });

    it("una página fuera de rango cae en la última", async () => {
      const last = await listCatalog(w.cashier, { q: "PAG-", page: 99 });
      expect(last.page).toBe(last.pageCount);
      expect(last.items.length).toBeGreaterThan(0);
    });

    it("busca por SKU, nombre y código de barras", async () => {
      await make(
        w.manager,
        plain({ sku: "BUS-CB", name: "Producto con barras", barcode: "7750001112223" }),
      );
      for (const q of ["BUS-CB", "con barras", "7750001112223"]) {
        const r = await listCatalog(w.cashier, { q });
        expect(
          r.items.map((p) => p.sku),
          q,
        ).toEqual(["BUS-CB"]);
      }
    });

    it("filtra por medida de llanta, OEM y vehículo (modelo o año sin marca)", async () => {
      const t = await make(w.manager, tire({ sku: "CT-LL-1", tire: { size: "195/65R15" } }));
      expect(
        (await listCatalog(w.cashier, { tireSize: "195-65-15" })).items.map((p) => p.id),
      ).toEqual([t.id]);
      const part = await make(w.manager, {
        kind: "PART",
        sku: "CT-PA-1",
        name: "Pastillas CT",
        salePrice: 100,
        part: { oemCode: "04465-OEM-9", isOem: true },
      });
      await admin.vehicleCompatibility.create({
        data: {
          tenantId: w.tenantId,
          productId: part.id,
          make: "Toyota",
          model: "Yaris",
          yearFrom: 2014,
          yearTo: 2020,
        },
      });
      expect(
        (await listCatalog(w.cashier, { code: "04465-oem-9" })).items.map((p) => p.sku),
      ).toEqual(["CT-PA-1"]);
      expect(
        (await listCatalog(w.cashier, { model: "Yaris", year: 2018 })).items.map((p) => p.sku),
      ).toContain("CT-PA-1");
      expect(
        (await listCatalog(w.cashier, { model: "Yaris", year: 2025 })).items.map((p) => p.sku),
      ).not.toContain("CT-PA-1");
      expect(
        (await listCatalog(w.cashier, { make: "Toyota", model: "Yaris", year: 2018 })).items.map(
          (p) => p.sku,
        ),
      ).toContain("CT-PA-1");
    });

    it("rechaza una medida de llanta inválida", async () => {
      await expect(listCatalog(w.cashier, { tireSize: "xx" })).rejects.toThrow(/Medida de llanta/);
    });

    it("chips de categoría: por tipo y por nombre de categoría (también la categoría padre)", async () => {
      const lub = await make(w.manager, {
        kind: "LUBRICANT",
        sku: "CH-LUB",
        name: "Aceite CH",
        salePrice: 50,
        lubricant: { viscosity: "5W-30" },
      });
      const bat = await make(w.manager, battery({ sku: "CH-BAT" }));
      const parent = await admin.productCategory.create({
        data: { tenantId: w.tenantId, name: "Frenos y suspensión" },
      });
      const child = await admin.productCategory.create({
        data: { tenantId: w.tenantId, name: "Discos", parentId: parent.id },
      });
      const disc = await make(w.manager, {
        kind: "PART",
        sku: "CH-DIS",
        name: "Disco CH",
        salePrice: 90,
        categoryId: child.id,
        part: {},
      });
      const filt = await make(w.manager, {
        kind: "PART",
        sku: "CH-FIL",
        name: "Filtro CH",
        salePrice: 30,
        part: {},
      });
      const cat = await admin.productCategory.create({
        data: { tenantId: w.tenantId, name: "Filtros" },
      });
      await admin.product.update({ where: { id: filt.id }, data: { categoryId: cat.id } });
      const skus = async (chip: "lubricante" | "filtro" | "frenos" | "llantas" | "baterias") =>
        (await listCatalog(w.cashier, { chip, pageSize: 48 })).items.map((p) => p.sku);
      expect(await skus("lubricante")).toContain(lub.sku);
      expect(await skus("baterias")).toContain(bat.sku);
      expect(await skus("frenos")).toEqual(expect.arrayContaining([disc.sku]));
      expect(await skus("frenos")).not.toContain(filt.sku);
      expect(await skus("filtro")).toEqual(expect.arrayContaining([filt.sku]));
      for (const sku of await skus("llantas")) expect(sku).not.toBe(lub.sku);
      const only = await listCatalog(w.cashier, { chip: "llantas", pageSize: 48 });
      expect(only.items.every((p) => p.kind === "TIRE")).toBe(true);
      expect(
        (await listCatalog(w.cashier, { chip: "frenos" })).items.find((p) => p.sku === "CH-DIS")
          ?.categoryName,
      ).toBe("Discos");
    });
  });

  describe("semáforo de stock", () => {
    const find = async (sku: string, actor = w.cashier) =>
      (await listCatalog(actor, { q: sku })).items.find((p) => p.sku === sku);

    it("verde por encima del punto de reposición, ámbar en el punto o por debajo, rojo en 0", async () => {
      const make1 = async (sku: string, qty: string | null, point: number | null) => {
        const p = await make(w.manager, plain({ sku, name: sku }));
        if (qty) await stockIn(p.id, qty);
        if (point !== null) await policy(p.id, point);
        return p;
      };
      await make1("SEM-ALTO", "25", 10);
      await make1("SEM-PUNTO", "10", 10);
      await make1("SEM-BAJO", "4", 10);
      await make1("SEM-CERO", null, 10);
      await make1("SEM-SINPOL", "7", null);
      await make1("SEM-SINPOL0", null, null);

      expect((await find("SEM-ALTO"))?.stockInfo).toMatchObject({
        light: "GREEN",
        quantity: 25,
        reorderPoint: 10,
        bar: 1,
      });
      expect((await find("SEM-PUNTO"))?.stockInfo).toMatchObject({ light: "AMBER", bar: 0.5 });
      expect((await find("SEM-BAJO"))?.stockInfo).toMatchObject({ light: "AMBER", bar: 0.2 });
      expect((await find("SEM-CERO"))?.stockInfo).toMatchObject({
        light: "RED",
        quantity: 0,
        bar: 0,
      });
      expect((await find("SEM-SINPOL"))?.stockInfo).toMatchObject({
        light: "GREEN",
        bar: null,
        reorderPoint: 0,
      });
      expect((await find("SEM-SINPOL0"))?.stockInfo).toMatchObject({ light: "RED", bar: null });
    });

    it("un servicio sin control de stock no muestra semáforo", async () => {
      await make(w.manager, {
        kind: "SERVICE",
        sku: "SEM-SERV",
        name: "Mano de obra",
        salePrice: 80,
      });
      const service = await find("SEM-SERV");
      expect(service?.isStocked).toBe(false);
      expect(service?.stockInfo).toBeUndefined();
    });

    it("suma el stock de todos los almacenes y los puntos de reposición de cada uno", async () => {
      const p = await make(w.manager, plain({ sku: "SEM-MULTI", name: "Multi" }));
      await stockIn(p.id, "6");
      await registerStockIn(
        w.manager,
        {
          warehouseId: w.warehouse2Id,
          productId: p.id,
          quantity: "6",
          unitCost: "50",
          idempotencyKey: key(),
        },
        meta(),
      );
      await policy(p.id, 5);
      await admin.reorderPolicy.create({
        data: {
          tenantId: w.tenantId,
          warehouseId: w.warehouse2Id,
          productId: p.id,
          mode: "MANUAL",
          manualMinStock: 0,
          manualReorderPoint: 5,
        },
      });
      expect((await find("SEM-MULTI"))?.stockInfo).toMatchObject({
        quantity: 12,
        reorderPoint: 10,
        light: "GREEN",
      });
    });
  });

  describe("costos y margen", () => {
    it("solo con permiso: el cajero no recibe costo ni margen; el jefe de almacén sí", async () => {
      await make(
        w.manager,
        plain({ sku: "COS-1", name: "Con costo", salePrice: 118, lastPurchaseCost: 60 }),
      );
      await make(w.manager, plain({ sku: "COS-2", name: "Sin costo", salePrice: 118 }));
      const asCashier = (await listCatalog(w.cashier, { q: "COS-" })).items;
      for (const item of asCashier) {
        expect(item).not.toHaveProperty("lastPurchaseCost");
        expect(item).not.toHaveProperty("marginPercent");
      }
      const asManager = (await listCatalog(w.manager, { q: "COS-" })).items;
      expect(asManager.find((p) => p.sku === "COS-1")).toMatchObject({
        lastPurchaseCost: "60",
        marginPercent: "40.0",
      });
      expect(asManager.find((p) => p.sku === "COS-2")?.marginPercent).toBeNull();
    });
  });

  describe("estados vacíos y aislamiento", () => {
    it("distingue catálogo vacío de búsqueda sin resultados", async () => {
      const none = await listCatalog(w.cashier, { q: "no-existe-zzz" });
      expect(none).toMatchObject({ total: 0, items: [], filtered: true, pageCount: 1 });
      const empty = await listCatalog(other.cashier, {});
      expect(empty.filtered).toBe(false);
    });

    it("otro negocio no ve productos ajenos (ni con filtros ni en el total)", async () => {
      const theirs = await listCatalog(other.cashier, { q: "PAG-" });
      expect(theirs.total).toBe(0);
      const mineAll = await listCatalog(w.cashier, {});
      const theirsAll = await listCatalog(other.cashier, {});
      expect(mineAll.total).toBeGreaterThan(theirsAll.total);
    });
  });
});
