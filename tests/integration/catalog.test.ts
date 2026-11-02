import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTenant } from "@/lib/db";
import type { PrismaClient } from "@/lib/db/generated/client.ts";
import { ConflictError, NotFoundError, PermissionDeniedError } from "@/lib/errors";
import {
  createProduct,
  deleteProduct,
  getProduct,
  listOldTires,
  replaceCompatibilities,
  replaceEquivalences,
  searchProducts,
  updateProduct,
} from "@/server/services/catalog";
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
  sku,
  tire,
  type InventoryWorld,
} from "../helpers/inventory.ts";

describe("catálogo automotriz", () => {
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

  describe("fichas técnicas", () => {
    it("llanta: medida, índices, ubicación en rack y control por lote (DOT)", async () => {
      const product = await make(
        w.manager,
        tire({
          sku: "ll-205-michelin",
          tire: {
            size: "205/55R16",
            loadIndex: 91,
            speedRating: "v",
            design: "Primacy 4",
            rackLocation: "R3-N2",
          },
        }),
      );
      expect(product).toMatchObject({
        sku: "LL-205-MICHELIN",
        kind: "TIRE",
        trackingMode: "LOT",
        isStocked: true,
        salePrice: "389",
      });
      expect(product.tire).toMatchObject({
        size: "205/55 R16",
        width: 205,
        aspectRatio: 55,
        rimDiameter: "16",
        loadIndex: 91,
        speedRating: "V",
        rackLocation: "R3-N2",
      });
      const row = await admin.tireDetail.findFirstOrThrow({ where: { productId: product.id } });
      expect(row.tenantId).toBe(w.tenantId);
    });

    it("batería: Ah, CCA, polaridad y control por serie única", async () => {
      const product = await make(w.manager, battery());
      expect(product).toMatchObject({ kind: "BATTERY", trackingMode: "SERIAL" });
      expect(product.battery).toEqual({
        voltage: 12,
        capacityAh: 60,
        ccaA: 550,
        polarity: "LEFT_POSITIVE",
        label: "12V 60Ah 550CCA",
      });
    });

    it("repuesto: código OEM, equivalencias cruzadas y compatibilidad por vehículo", async () => {
      const product = await make(w.manager, {
        kind: "PART",
        sku: sku("FR"),
        name: "Pastillas de freno delanteras Yaris",
        salePrice: 189,
        lastPurchaseCost: 128,
        part: { oemCode: "04465-52130", isOem: true, partCategory: "Frenos" },
        equivalences: [
          { code: "GDB3469", brand: "TRW", type: "ALTERNATIVE" },
          { code: "04465-0D150", brand: "Toyota", type: "OEM" },
        ],
        compatibilities: [
          { make: "Toyota", model: "Yaris", yearFrom: 2014, yearTo: 2020, engine: "1.3L" },
        ],
      });
      expect(product.part).toMatchObject({ oemCode: "04465-52130", isOem: true });
      expect(product.equivalences).toHaveLength(2);
      expect(product.compatibilities[0]).toMatchObject({
        make: "Toyota",
        model: "Yaris",
        yearFrom: 2014,
        yearTo: 2020,
      });
    });

    it("lubricante y servicio (los servicios no manejan stock)", async () => {
      const oil = await make(w.manager, {
        kind: "LUBRICANT",
        sku: sku("OIL"),
        name: "Aceite 5W-30 sintético 4L",
        salePrice: 189,
        lubricant: { viscosity: "5w-30", baseType: "SYNTHETIC", volumeLiters: 4 },
      });
      expect(oil.lubricant).toMatchObject({
        viscosity: "5W-30",
        baseType: "SYNTHETIC",
        volumeLiters: "4",
      });
      const service = await make(w.manager, {
        kind: "SERVICE",
        sku: sku("SV"),
        name: "Alineamiento",
        salePrice: 90,
      });
      expect(service.isStocked).toBe(false);
    });

    it("SKU y código de barras únicos por tenant, pero reutilizables entre tenants y tras borrar", async () => {
      const code = sku("DUP");
      await make(w.manager, plain({ sku: code, barcode: "7750000000001" }));
      await expect(make(w.manager, plain({ sku: code }))).rejects.toBeInstanceOf(ConflictError);
      await expect(make(w.manager, plain({ barcode: "7750000000001" }))).rejects.toMatchObject({
        code: "BARCODE_TAKEN",
      });
      await expect(make(other.manager, plain({ sku: code }))).resolves.toBeDefined();
    });

    it("rechaza datos inválidos con mensajes de Zod", async () => {
      await expect(make(w.manager, tire({ tire: { size: "medida rara" } }))).rejects.toThrow(
        /Medida de llanta inválida/,
      );
      await expect(
        make(w.manager, battery({ battery: { capacityAh: 60, ccaA: 550 } })),
      ).rejects.toThrow();
      await expect(make(w.manager, plain({ salePrice: -5 }))).rejects.toThrow();
    });
  });

  describe("permisos y costos", () => {
    it("el cajero consulta pero no crea, edita ni elimina", async () => {
      const product = await make(w.manager, plain());
      await expect(createProduct(w.cashier, plain() as never, meta())).rejects.toBeInstanceOf(
        PermissionDeniedError,
      );
      await expect(
        updateProduct(w.cashier, product.id, { salePrice: 1 }, meta()),
      ).rejects.toBeInstanceOf(PermissionDeniedError);
      await expect(deleteProduct(w.cashier, product.id, meta())).rejects.toBeInstanceOf(
        PermissionDeniedError,
      );
      await expect(getProduct(w.cashier, product.id)).resolves.toMatchObject({ id: product.id });
    });

    it("el vendedor NUNCA recibe costos de compra; el jefe de almacén sí", async () => {
      const product = await make(w.manager, plain({ lastPurchaseCost: 12.5 }));
      expect(product.lastPurchaseCost).toBe("12.5");

      const asCashier = await getProduct(w.cashier, product.id);
      expect("lastPurchaseCost" in asCashier).toBe(false);
      const found = await searchProducts(w.cashier, { q: product.sku });
      expect(found).toHaveLength(1);
      expect(JSON.stringify(found)).not.toContain("lastPurchaseCost");
      expect(JSON.stringify(found)).not.toContain("12.5");
      expect((await getProduct(w.manager, product.id)).lastPurchaseCost).toBe("12.5");
    });

    it("el mecánico no ve costos ni puede escribir costos", async () => {
      await expect(
        createProduct(w.mechanic, plain({ lastPurchaseCost: 1 }) as never, meta()),
      ).rejects.toBeInstanceOf(PermissionDeniedError);
    });

    it("el costo promedio por almacén tampoco llega al vendedor", async () => {
      const product = await make(w.manager, plain());
      await registerStockIn(
        w.manager,
        {
          warehouseId: w.warehouseId,
          productId: product.id,
          quantity: "10",
          unitCost: "7.25",
          idempotencyKey: key(),
        },
        meta(),
      );
      const asManager = await getProduct(w.manager, product.id);
      expect(asManager.stockByWarehouse?.[0]).toMatchObject({ quantity: "10", avgCost: "7.25" });
      const asCashier = await getProduct(w.cashier, product.id);
      expect(asCashier.stock).toBe(10);
      expect(asCashier.stockByWarehouse?.[0]).not.toHaveProperty("avgCost");
    });
  });

  describe("auditoría de precios y costos", () => {
    it("registra valor anterior y nuevo del precio y del costo", async () => {
      const product = await make(w.manager, plain({ salePrice: 25, lastPurchaseCost: 10 }));
      await updateProduct(w.manager, product.id, { salePrice: 29.9 }, meta());
      await updateProduct(w.manager, product.id, { lastPurchaseCost: 11 }, meta());
      await updateProduct(w.manager, product.id, { name: "Escobilla premium" }, meta());
      const logs = await admin.auditLog.findMany({
        where: { tenantId: w.tenantId, entityId: product.id },
        orderBy: { occurredAt: "asc" },
      });
      expect(logs.map((l) => l.action)).toEqual([
        "product.created",
        "product.price_changed",
        "product.cost_changed",
        "product.updated",
      ]);
      expect(logs[1]).toMatchObject({
        before: { salePrice: "25" },
        after: { salePrice: "29.9" },
        actorUserId: w.manager.userId,
      });
      expect(logs[2]).toMatchObject({
        before: { lastPurchaseCost: "10" },
        after: { lastPurchaseCost: "11" },
      });
    });

    it("cambiar el precio a un valor igual no genera ruido de auditoría de precio", async () => {
      const product = await make(w.manager, plain({ salePrice: 25 }));
      await updateProduct(w.manager, product.id, { salePrice: 25 }, meta());
      const logs = await admin.auditLog.findMany({
        where: { entityId: product.id, action: "product.price_changed" },
      });
      expect(logs).toHaveLength(0);
    });
  });

  describe("búsqueda", () => {
    let michelin: ProductViewLike;
    let pirelli: ProductViewLike;
    let pads: ProductViewLike;
    type ProductViewLike = Awaited<ReturnType<typeof make>>;

    beforeAll(async () => {
      michelin = await make(
        w.manager,
        tire({ name: "Llanta Michelin Primacy 4 205/55 R16", sku: "BUS-MICH" }),
      );
      pirelli = await make(
        w.manager,
        tire({
          name: "Llanta Pirelli P Zero 225/45 R17",
          sku: "BUS-PIRE",
          tire: { size: "225/45 R17" },
        }),
      );
      pads = await make(w.manager, {
        kind: "PART",
        sku: "BUS-PADS",
        name: "Pastillas delanteras",
        salePrice: 100,
        part: { oemCode: "04465-52130", partNumber: "PN-777" },
        equivalences: [{ code: "GDB3469", brand: "TRW" }],
        compatibilities: [
          { make: "Toyota", model: "Yaris", yearFrom: 2014, yearTo: 2020 },
          { make: "Toyota", model: "Corolla" },
        ],
      });
      await make(
        w.manager,
        plain({ sku: "BUS-OTRO", name: "Otra cosa", barcode: "7751112223334" }),
      );
    });

    // Solo los productos de esta sección (otras pruebas del mismo tenant crean repuestos parecidos).
    const skus = async (input: Parameters<typeof searchProducts>[1]) =>
      (await searchProducts(w.cashier, input))
        .map((p) => p.sku)
        .filter((code) => code.startsWith("BUS-") || code.startsWith("EQ-"))
        .sort();

    it("por medida de llanta en cualquier formato", async () => {
      for (const size of ["205/55 R16", "205/55R16", "205-55-16", "2055516", "205 55 r16"]) {
        expect(await skus({ tireSize: size, kind: "TIRE" }), size).toContain("BUS-MICH");
        expect(await skus({ tireSize: size }), size).not.toContain("BUS-PIRE");
      }
      expect(await skus({ q: "225/45 R17" })).toContain("BUS-PIRE");
      await expect(searchProducts(w.cashier, { tireSize: "xx" })).rejects.toThrow(
        /Medida de llanta inválida/,
      );
    });

    it("por código OEM, número de parte y equivalencia cruzada", async () => {
      expect(await skus({ code: "04465-52130" })).toEqual(["BUS-PADS"]);
      expect(await skus({ code: "gdb3469" })).toEqual(["BUS-PADS"]);
      expect(await skus({ code: "PN-777" })).toEqual(["BUS-PADS"]);
      expect(await skus({ q: "GDB34" })).toEqual(["BUS-PADS"]);
      expect(await skus({ code: "NO-EXISTE" })).toEqual([]);
    });

    it("por vehículo: marca, modelo y año dentro del rango", async () => {
      expect(await skus({ vehicle: { make: "toyota", model: "yaris", year: 2018 } })).toEqual([
        "BUS-PADS",
      ]);
      expect(await skus({ vehicle: { make: "Toyota", model: "Yaris", year: 2022 } })).toEqual([]);
      expect(await skus({ vehicle: { make: "Toyota", model: "Corolla", year: 2005 } })).toEqual([
        "BUS-PADS",
      ]); // sin rango = todos los años
      expect(await skus({ vehicle: { make: "Honda" } })).toEqual([]);
    });

    it("por texto, código de barras, marca y tipo", async () => {
      expect(await skus({ q: "pastillas" })).toContain("BUS-PADS");
      expect(await skus({ q: "7751112223334" })).toEqual(["BUS-OTRO"]);
      expect(await skus({ kind: "TIRE", q: "BUS-" })).toEqual(["BUS-MICH", "BUS-PIRE"]);
      void michelin;
      void pirelli;
      void pads;
    });

    it("excluye inactivos y borrados; respeta el límite", async () => {
      const temp = await make(w.manager, plain({ sku: "BUS-TEMP" }));
      await updateProduct(w.manager, temp.id, { isActive: false }, meta());
      expect(await skus({ q: "BUS-TEMP" })).toEqual([]);
      expect(await skus({ q: "BUS-TEMP", includeInactive: true })).toEqual(["BUS-TEMP"]);
      await deleteProduct(w.manager, temp.id, meta());
      expect(await skus({ q: "BUS-TEMP", includeInactive: true })).toEqual([]);
      expect((await searchProducts(w.cashier, { q: "BUS-", limit: 2 })).length).toBe(2);
    });

    it("reemplazar equivalencias y compatibilidades actualiza la búsqueda", async () => {
      const part = await make(w.manager, {
        kind: "PART",
        sku: sku("EQ"),
        name: "Filtro de aceite",
        salePrice: 39,
        part: {},
      });
      await replaceEquivalences(w.manager, part.id, [{ code: "W 68/3", brand: "Mann" }], meta());
      await replaceCompatibilities(
        w.manager,
        part.id,
        [{ make: "Kia", model: "Rio", yearFrom: 2012, yearTo: 2022 }],
        meta(),
      );
      expect(await skus({ code: "w 68/3" })).toEqual([part.sku]);
      expect(await skus({ vehicle: { make: "Kia", model: "Rio", year: 2020 } })).toEqual([
        part.sku,
      ]);
      await replaceEquivalences(w.manager, part.id, [], meta());
      expect(await skus({ code: "w 68/3" })).toEqual([]);
      await expect(replaceEquivalences(w.cashier, part.id, [], meta())).rejects.toBeInstanceOf(
        PermissionDeniedError,
      );
    });
  });

  describe("baja de productos y llantas antiguas", () => {
    it("no se puede eliminar un producto con existencias", async () => {
      const product = await make(w.manager, plain());
      await registerStockIn(
        w.manager,
        {
          warehouseId: w.warehouseId,
          productId: product.id,
          quantity: "3",
          unitCost: "5",
          idempotencyKey: key(),
        },
        meta(),
      );
      await expect(deleteProduct(w.manager, product.id, meta())).rejects.toMatchObject({
        code: "PRODUCT_HAS_STOCK",
      });
    });

    it("alerta de llantas con DOT anterior al máximo configurado", async () => {
      const product = await make(w.manager, tire());
      await registerStockIn(
        w.manager,
        {
          warehouseId: w.warehouseId,
          productId: product.id,
          quantity: "4",
          unitCost: "250",
          lot: { code: "DOT-1218", dotCode: "1218" },
          idempotencyKey: key(),
        },
        meta(),
      );
      await registerStockIn(
        w.manager,
        {
          warehouseId: w.warehouseId,
          productId: product.id,
          quantity: "6",
          unitCost: "250",
          lot: { code: "DOT-0825", dotCode: "0825" },
          idempotencyKey: key(),
        },
        meta(),
      );
      const old = await listOldTires(w.manager, new Date("2026-10-20T00:00:00Z"));
      const mine = old.filter((l) => l.productId === product.id);
      expect(mine).toHaveLength(1);
      expect(mine[0]).toMatchObject({ dotCode: "1218", quantity: 4 });
      expect(mine[0]?.ageYears).toBeGreaterThan(8);
      // El tenant puede endurecer el criterio (3 años): ahora también el lote 0825 (2025 → 1.x años no) sigue fuera.
      await admin.tenantSettings.update({
        where: { tenantId: w.tenantId },
        data: { tireMaxAgeYears: 1 },
      });
      const strict = (await listOldTires(w.manager, new Date("2026-10-20T00:00:00Z"))).filter(
        (l) => l.productId === product.id,
      );
      expect(strict.map((l) => l.dotCode).sort()).toEqual(["0825", "1218"]);
      await admin.tenantSettings.update({
        where: { tenantId: w.tenantId },
        data: { tireMaxAgeYears: 5 },
      });
    });
  });

  describe("aislamiento entre tenants", () => {
    it("otro tenant no ve, edita ni elimina productos ajenos", async () => {
      const mine = await make(w.manager, plain());
      await expect(getProduct(other.manager, mine.id)).rejects.toBeInstanceOf(NotFoundError);
      await expect(
        updateProduct(other.manager, mine.id, { salePrice: 1 }, meta()),
      ).rejects.toBeInstanceOf(NotFoundError);
      await expect(deleteProduct(other.manager, mine.id, meta())).rejects.toBeInstanceOf(
        NotFoundError,
      );
      expect((await searchProducts(other.manager, { q: mine.sku })).length).toBe(0);
      const seen = await withTenant(other.tenantId, (tx) =>
        tx.product.findFirst({ where: { id: mine.id } }),
      );
      expect(seen).toBeNull();
    });
  });
});
