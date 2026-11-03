import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "@/lib/db/generated/client.ts";
import { createCustomer } from "@/server/services/customers";
import {
  lookupCustomers,
  posSnapshot,
  posTaxContext,
  searchPosProducts,
  SNAPSHOT_LIMIT,
  suggestProducts,
} from "@/server/services/pos-lookup";
import { syncOfflineSale } from "@/server/services/pos-offline";
import { createSale } from "@/server/services/sales";
import { configureAuthCache } from "@/server/services/session-resolver";
import { adminClient } from "../helpers/db.ts";
import { meta } from "../helpers/auth.ts";
import { make, plain } from "../helpers/inventory.ts";
import { openCash, posWorld, saleKey, stockUp, type PosWorld } from "../helpers/pos.ts";

/** RUC válido (módulo 11) a partir de 10 dígitos. */
function ruc(prefix10: string): string {
  const factors = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
  const sum = factors.reduce((acc, f, i) => acc + f * Number(prefix10[i]), 0);
  return `${prefix10}${(11 - (sum % 11)) % 10}`;
}

describe("mostrador: búsqueda, catálogo sin conexión y sincronización", () => {
  let admin: PrismaClient;
  let w: PosWorld;
  let other: PosWorld;

  const product = async (name: string, price = 118, over: Record<string, unknown> = {}) => {
    const p = await make(w.admin, plain({ name, salePrice: price, ...over }));
    await stockUp(w, p.id, "20");
    return p;
  };
  const sale = (productId: string, over: Record<string, unknown> = {}) => ({
    idempotencyKey: saleKey(),
    documentType: "BOLETA",
    items: [{ productId, quantity: "1" }],
    payments: [{ method: "CASH", amount: "118" }],
    ...over,
  });
  const offlineSale = (s: Record<string, unknown>, over: Record<string, unknown> = {}) => ({
    localId: randomUUID(),
    occurredAt: new Date(Date.now() - 600_000).toISOString(),
    sale: s,
    ...over,
  });

  beforeAll(async () => {
    configureAuthCache(0);
    admin = adminClient();
    w = await posWorld(admin);
    other = await posWorld(admin);
    await openCash(w.cashier);
    await openCash(other.cashier);
  }, 240_000);
  afterAll(async () => {
    await admin.$disconnect();
  });

  describe("sugerencias y catálogo", () => {
    it("sugiere por nombre, SKU y marca con un mínimo de 2 letras y respeta el límite", async () => {
      const a = await product("Bujía Iridium NGK Zeta", 45, { brand: "NGK" });
      for (let i = 0; i < 12; i += 1) await product(`Bujía común modelo ${i}`, 20);
      expect((await suggestProducts(w.cashier, "iridium")).map((p) => p.id)).toEqual([a.id]);
      expect((await suggestProducts(w.cashier, a.sku)).map((p) => p.id)).toContain(a.id);
      expect((await suggestProducts(w.cashier, "ngk")).map((p) => p.id)).toContain(a.id);
      expect(await suggestProducts(w.cashier, "b")).toEqual([]);
      expect(await suggestProducts(w.cashier, "  ")).toEqual([]);
      expect((await suggestProducts(w.cashier, "bujía", 5)).length).toBe(5);
      expect((await suggestProducts(w.cashier, "bujía", 100)).length).toBeLessThanOrEqual(20);
    });

    it("trae precio, afectación, stock y tasa para vender sin conexión", async () => {
      const exempt = await product("Servicio exonerado demo", 50, { taxAffectation: "EXEMPT" });
      const [found] = await suggestProducts(w.cashier, exempt.sku);
      expect(found).toMatchObject({
        id: exempt.id,
        salePrice: "50",
        taxAffectation: "EXEMPT",
        stock: 20,
      });
      expect(await posTaxContext(w.cashier)).toEqual({ taxRate: "0.18", pricesIncludeTax: true });
    });

    it("la copia del catálogo es solo del negocio de la sesión y excluye productos inactivos", async () => {
      const mine = await product("Producto visible snapshot");
      const hidden = await product("Producto inactivo snapshot");
      await admin.product.update({ where: { id: hidden.id }, data: { isActive: false } });
      await product("Producto ajeno snapshot");
      const theirs = await make(
        other.admin,
        plain({ name: "Producto solo del otro negocio", salePrice: 10 }),
      );
      const snap = await posSnapshot(w.cashier);
      const ids = snap.products.map((p) => p.id);
      expect(ids).toContain(mine.id);
      expect(ids).not.toContain(hidden.id);
      expect(ids).not.toContain(theirs.id);
      expect(snap).toMatchObject({
        version: 1,
        truncated: false,
        tax: { taxRate: "0.18", pricesIncludeTax: true },
      });
      expect(snap.products.length).toBeLessThanOrEqual(SNAPSHOT_LIMIT);
      expect((await posSnapshot(other.cashier)).products.map((p) => p.id)).not.toContain(mine.id);
    });

    it("exige permiso de vender y ver catálogo", async () => {
      await expect(posSnapshot(w.mechanic)).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
      await expect(suggestProducts(w.mechanic, "bujía")).rejects.toMatchObject({
        code: "PERMISSION_DENIED",
      });
      await expect(posTaxContext(w.mechanic)).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    });

    it("la búsqueda con filtros valida la medida de llanta y encuentra por ella", async () => {
      await expect(searchPosProducts(w.cashier, { tireSize: "xx" })).rejects.toMatchObject({
        code: "TIRE_SIZE",
      });
      const tire = await make(w.admin, {
        kind: "TIRE",
        sku: `LL-${randomUUID().slice(0, 6)}`,
        name: "Llanta prueba 175/70 R13",
        salePrice: 200,
        tire: { size: "175/70R13" },
      });
      const found = await searchPosProducts(w.cashier, { tireSize: "175 70 13" });
      expect(found.map((p) => p.id)).toContain(tire.id);
      expect(found.find((p) => p.id === tire.id)?.tire).toBe("175/70 R13");
    });

    it("las consultas de clientes solo ven al propio negocio", async () => {
      const doc = String(Math.floor(10_000_000 + Math.random() * 89_999_999));
      await createCustomer(
        w.admin,
        { docType: "DNI", docNumber: doc, name: "Cliente Visible Único" } as never,
        meta(),
      );
      expect((await lookupCustomers(w.cashier, "Visible Único")).customers).toHaveLength(1);
      expect((await lookupCustomers(other.cashier, "Visible Único")).customers).toHaveLength(0);
    });
  });

  describe("venta registrada desde el modo sin conexión", () => {
    it("registra la venta con el mismo servicio en línea y deja constancia de cuándo se cobró", async () => {
      const p = await product("Filtro sincronizado");
      const input = offlineSale(sale(p.id));
      const result = await syncOfflineSale(w.cashier, input, meta());
      expect(result).toMatchObject({
        replayed: false,
        documentNumber: expect.stringMatching(/^B\d{3}-\d{8}$/),
      });
      const row = await admin.sale.findUniqueOrThrow({ where: { id: result.saleId } });
      expect(row.tenantId).toBe(w.tenantId);
      const log = await admin.auditLog.findFirstOrThrow({
        where: { tenantId: w.tenantId, action: "pos.offline_sale_synced", entityId: result.saleId },
      });
      expect(log.after).toMatchObject({
        localId: input.localId,
        occurredAt: input.occurredAt,
        documentType: "BOLETA",
      });
    });

    it("reintentar la misma venta no la duplica ni descuenta stock dos veces", async () => {
      const p = await product("Filtro reintento");
      const s = sale(p.id);
      const first = await syncOfflineSale(w.cashier, offlineSale(s), meta());
      const second = await syncOfflineSale(w.cashier, offlineSale(s), meta());
      expect(second).toMatchObject({ saleId: first.saleId, replayed: true });
      expect(await admin.sale.count({ where: { idempotencyKey: s.idempotencyKey } })).toBe(1);
      const stock = await admin.stockBalance.aggregate({
        where: { productId: p.id },
        _sum: { quantity: true },
      });
      expect(Number(stock._sum.quantity)).toBe(19);
      const logs = await admin.auditLog.count({
        where: { tenantId: w.tenantId, action: "pos.offline_sale_synced", entityId: first.saleId },
      });
      expect(logs).toBe(1);
    });

    it("rechaza facturas y ventas a crédito (necesitan conexión)", async () => {
      const p = await product("Filtro factura offline");
      await expect(
        syncOfflineSale(w.cashier, offlineSale(sale(p.id, { documentType: "FACTURA" })), meta()),
      ).rejects.toMatchObject({
        code: "OFFLINE_FACTURA",
      });
      await expect(
        syncOfflineSale(
          w.cashier,
          offlineSale(sale(p.id, { isCredit: true, payments: [] })),
          meta(),
        ),
      ).rejects.toMatchObject({ code: "OFFLINE_CREDIT" });
    });

    it("rechaza una fecha futura y datos inválidos", async () => {
      const p = await product("Filtro fecha");
      await expect(
        syncOfflineSale(
          w.cashier,
          offlineSale(sale(p.id), { occurredAt: new Date(Date.now() + 3_600_000).toISOString() }),
          meta(),
        ),
      ).rejects.toMatchObject({ code: "OFFLINE_CLOCK" });
      await expect(
        syncOfflineSale(w.cashier, { localId: "no-es-uuid", occurredAt: "ayer", sale: {} }, meta()),
      ).rejects.toBeTruthy();
      await expect(
        syncOfflineSale(w.cashier, offlineSale({ idempotencyKey: saleKey(), items: [] }), meta()),
      ).rejects.toBeTruthy();
    });

    it("las reglas de negocio siguen valiendo: sin caja abierta, sin permiso y sin cruzar negocios", async () => {
      const p = await product("Filtro reglas");
      await expect(
        syncOfflineSale(w.mechanic, offlineSale(sale(p.id)), meta()),
      ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
      // El cajero 2 no abrió caja: la venta se rechaza con un mensaje claro (el cajero la reintenta tras abrirla).
      await expect(
        syncOfflineSale(w.cashier2, offlineSale(sale(p.id)), meta()),
      ).rejects.toMatchObject({ code: "NO_CASH_SESSION" });
      // Un producto de otro negocio no existe para este.
      const foreign = await make(other.admin, plain({ name: "Ajeno", salePrice: 10 }));
      await expect(
        syncOfflineSale(
          w.cashier,
          offlineSale(sale(foreign.id, { payments: [{ method: "CASH", amount: "10" }] })),
          meta(),
        ),
      ).rejects.toMatchObject({ name: "NotFoundError" });
    });

    it("sin stock suficiente la venta se rechaza (no se vende lo que no hay)", async () => {
      const p = await make(w.admin, plain({ name: "Sin existencias", salePrice: 118 }));
      await stockUp(w, p.id, "1");
      await expect(
        syncOfflineSale(
          w.cashier,
          offlineSale(
            sale(p.id, {
              items: [{ productId: p.id, quantity: "5" }],
              payments: [{ method: "CASH", amount: "590" }],
            }),
          ),
          meta(),
        ),
      ).rejects.toMatchObject({ code: "INSUFFICIENT_STOCK" });
    });
  });

  describe("validación SUNAT al vender", () => {
    it("la factura exige RUC con prefijo 10 o 20, válido, y comprador con razón social", async () => {
      const p = await product("Filtro factura");
      const make15 = await createCustomer(
        w.admin,
        { docType: "RUC", docNumber: ruc("1512345678"), name: "Contribuyente 15 SAC" } as never,
        meta(),
      );
      await expect(
        createSale(
          w.cashier,
          sale(p.id, { documentType: "FACTURA", customerId: make15.id }) as never,
          meta(),
        ),
      ).rejects.toMatchObject({
        code: "DOC_RULE",
        message: expect.stringContaining("10 o 20"),
      });
      const dni = await createCustomer(
        w.admin,
        {
          docType: "DNI",
          docNumber: String(Math.floor(10_000_000 + Math.random() * 89_999_999)),
          name: "Persona DNI",
        } as never,
        meta(),
      );
      await expect(
        createSale(
          w.cashier,
          sale(p.id, { documentType: "FACTURA", customerId: dni.id }) as never,
          meta(),
        ),
      ).rejects.toMatchObject({ code: "DOC_RULE" });
      const good = await createCustomer(
        w.admin,
        {
          docType: "RUC",
          docNumber: ruc(`20${Math.floor(10_000_000 + Math.random() * 89_999_999)}`),
          name: "Empresa Buena SAC",
        } as never,
        meta(),
      );
      const ok = await createSale(
        w.cashier,
        sale(p.id, { documentType: "FACTURA", customerId: good.id }) as never,
        meta(),
      );
      expect(ok.documentNumber).toMatch(/^F\d{3}-\d{8}$/);
    });

    it("la boleta usa la serie B de Configuración y una boleta mayor a S/ 700 exige identificar al cliente", async () => {
      const cheap = await product("Boleta barata", 100);
      const big = await product("Boleta cara", 900);
      const anon = await createSale(
        w.cashier,
        sale(cheap.id, { payments: [{ method: "CASH", amount: "100" }] }) as never,
        meta(),
      );
      expect(anon.documentNumber).toMatch(/^B\d{3}-\d{8}$/);
      await expect(
        createSale(
          w.cashier,
          sale(big.id, { payments: [{ method: "CASH", amount: "900" }] }) as never,
          meta(),
        ),
      ).rejects.toMatchObject({ code: "DOC_RULE", message: expect.stringContaining("700") });
      const dni = await createCustomer(
        w.admin,
        {
          docType: "DNI",
          docNumber: String(Math.floor(10_000_000 + Math.random() * 89_999_999)),
          name: "Comprador identificado",
        } as never,
        meta(),
      );
      await expect(
        createSale(
          w.cashier,
          sale(big.id, {
            customerId: dni.id,
            payments: [{ method: "CASH", amount: "900" }],
          }) as never,
          meta(),
        ),
      ).resolves.toBeTruthy();
    });

    it("el IGV del comprobante es 18 %: otra tasa configurada bloquea la emisión", async () => {
      const p = await product("Filtro IGV");
      await admin.tenantSettings.update({
        where: { tenantId: w.tenantId },
        data: { taxRate: 0.1 },
      });
      try {
        await expect(
          createSale(
            w.cashier,
            sale(p.id, { payments: [{ method: "CASH", amount: "118" }] }) as never,
            meta(),
          ),
        ).rejects.toMatchObject({ code: "IGV_RATE", message: expect.stringContaining("18 %") });
        // Una nota de venta (no es comprobante electrónico) no se bloquea.
        await expect(
          createSale(
            w.cashier,
            sale(p.id, {
              documentType: "NOTA_VENTA",
              payments: [{ method: "CASH", amount: "118" }],
            }) as never,
            meta(),
          ),
        ).resolves.toBeTruthy();
      } finally {
        await admin.tenantSettings.update({
          where: { tenantId: w.tenantId },
          data: { taxRate: 0.18 },
        });
      }
    });

    it("el comprobante guarda base, IGV y total coherentes con el 18 %", async () => {
      const p = await product("Filtro totales", 59.9);
      const result = await createSale(
        w.cashier,
        sale(p.id, { payments: [{ method: "CASH", amount: "59.90" }] }) as never,
        meta(),
      );
      const doc = await admin.fiscalDocument.findFirstOrThrow({ where: { saleId: result.id } });
      expect(doc.total.toFixed(2)).toBe("59.90");
      expect(Number(doc.subtotal) + Number(doc.taxTotal)).toBeCloseTo(59.9, 2);
      expect(Math.abs(Number(doc.taxTotal) - Number(doc.subtotal) * 0.18)).toBeLessThanOrEqual(
        0.01,
      );
    });
  });
});
