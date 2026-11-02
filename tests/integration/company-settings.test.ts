import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "@/lib/db/generated/client.ts";
import { ConflictError, PermissionDeniedError } from "@/lib/errors";
import {
  getCompanySettings,
  updateCompanyProfile,
  updateOperations,
} from "@/server/services/company-settings";
import { createSale, getSale } from "@/server/services/sales";
import { configureAuthCache } from "@/server/services/session-resolver";
import { adminClient } from "../helpers/db.ts";
import { meta } from "../helpers/auth.ts";
import { make, plain } from "../helpers/inventory.ts";
import { openCash, posWorld, saleKey, stockUp, type PosWorld } from "../helpers/pos.ts";

const OPS = {
  taxName: "IGV",
  taxRate: 0.18,
  pricesIncludeTax: true,
  ticketWidthMm: 80,
  tireMaxAgeYears: 5,
  allowNegativeStock: false,
  rotationWindowDays: 30,
  deadStockDays: 90,
  aiMinutesSavedPerLine: 4,
  staffHourlyCost: 15,
  usdExchangeRate: 3.75,
};
const PROFILE = {
  legalName: "Taller Norte SAC",
  tradeName: "Taller Norte",
  address: "Av. Norte 123",
  phone: "999888777",
  contactName: "Ana",
  contactEmail: "ana@norte.pe",
  billingEmail: "pagos@norte.pe",
};

describe("configuración final por empresa", () => {
  let admin: PrismaClient;
  let w: PosWorld;

  beforeAll(async () => {
    configureAuthCache(0);
    admin = adminClient();
    w = await posWorld(admin);
  }, 240_000);
  afterAll(async () => {
    await admin.$disconnect();
  });

  it("el perfil se guarda con auditoría y se lee de vuelta; los campos ausentes no se tocan", async () => {
    await updateCompanyProfile(w.admin, PROFILE, meta());
    const view = await getCompanySettings(w.admin);
    expect(view.profile).toMatchObject({
      legalName: "Taller Norte SAC",
      tradeName: "Taller Norte",
      billingEmail: "pagos@norte.pe",
    });
    expect(
      await admin.auditLog.count({
        where: { tenantId: w.tenantId, action: "company.profile_changed" },
      }),
    ).toBe(1);
    await updateCompanyProfile(w.admin, { legalName: "Taller Norte SAC" }, meta());
    expect((await getCompanySettings(w.admin)).profile.tradeName).toBe("Taller Norte");
    await updateCompanyProfile(w.admin, { ...PROFILE, tradeName: "" }, meta());
    expect((await getCompanySettings(w.admin)).profile.tradeName).toBeNull();
  });

  it("valida RUC, correos y textos; rechaza a quien no tiene permiso de edición", async () => {
    await expect(
      updateCompanyProfile(w.admin, { ...PROFILE, taxId: "20100070971" }, meta()),
    ).rejects.toThrow(/RUC/);
    await expect(
      updateCompanyProfile(w.admin, { ...PROFILE, billingEmail: "no-es-correo" }, meta()),
    ).rejects.toThrow();
    await expect(
      updateCompanyProfile(w.admin, { ...PROFILE, legalName: "x" }, meta()),
    ).rejects.toThrow();
    await expect(
      updateCompanyProfile(w.admin, { ...PROFILE, address: "calle\u0000" }, meta()),
    ).rejects.toThrow();
    await expect(updateCompanyProfile(w.cashier, PROFILE, meta())).rejects.toBeInstanceOf(
      PermissionDeniedError,
    );
    await expect(getCompanySettings(w.cashier)).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it("el RUC no puede repetirse entre empresas ni cambiarse una vez emitidos comprobantes", async () => {
    const other = await posWorld(admin);
    // Un RUC nuevo debe ser válido; la empresa lo toma con un cambio normal.
    await expect(
      updateCompanyProfile(w.admin, { ...PROFILE, taxId: "20100070971" }, meta()),
    ).rejects.toMatchObject({ code: "TAXID_INVALID" });
    await updateCompanyProfile(w.admin, { ...PROFILE, taxId: "20100070970" }, meta());
    expect((await getCompanySettings(w.admin)).profile.taxId).toBe("20100070970");
    await expect(
      updateCompanyProfile(other.admin, { ...PROFILE, taxId: "20100070970" }, meta()),
    ).rejects.toMatchObject({ code: "TAXID_TAKEN" });

    await openCash(w.cashier);
    const p = await make(w.admin, plain({ salePrice: 59 }));
    await stockUp(w, p.id, "5");
    expect((await getCompanySettings(w.admin)).locks.taxId).toBe(false);
    await createSale(
      w.cashier,
      {
        idempotencyKey: saleKey(),
        documentType: "BOLETA",
        items: [{ productId: p.id, quantity: "1" }],
        payments: [{ method: "CASH", amount: "59" }],
      },
      meta(),
    );
    expect((await getCompanySettings(w.admin)).locks.taxId).toBe(true);
    await expect(
      updateCompanyProfile(w.admin, { ...PROFILE, taxId: "20512528458" }, meta()),
    ).rejects.toMatchObject({ code: "TAXID_LOCKED" });
    // Repetir el mismo RUC no es un cambio, aunque ya haya comprobantes.
    await expect(
      updateCompanyProfile(w.admin, { ...PROFILE, taxId: "20100070970" }, meta()),
    ).resolves.toBeUndefined();
  });

  it("los parámetros operativos se validan con límites razonables", async () => {
    const bad = (over: Record<string, unknown>) =>
      updateOperations(w.admin, { ...OPS, ...over }, meta());
    await expect(bad({ taxRate: 0.9 })).rejects.toThrow();
    await expect(bad({ taxRate: -0.1 })).rejects.toThrow();
    await expect(bad({ ticketWidthMm: 70 })).rejects.toThrow(/58 o 80/);
    await expect(bad({ deadStockDays: 3 })).rejects.toThrow();
    await expect(bad({ rotationWindowDays: 500 })).rejects.toThrow();
    await expect(bad({ usdExchangeRate: 0 })).rejects.toThrow();
    await expect(bad({ staffHourlyCost: -1 })).rejects.toThrow();
    await expect(bad({ aiMinutesSavedPerLine: 1000 })).rejects.toThrow();
    await expect(updateOperations(w.cashier, OPS, meta())).rejects.toBeInstanceOf(
      PermissionDeniedError,
    );
  });

  it("cambiar el IGV afecta solo las ventas nuevas; las anteriores conservan su cálculo", async () => {
    await openCash(w.admin);
    const p = await make(w.admin, plain({ salePrice: 110 }));
    await stockUp(w, p.id, "10");
    const before = await createSale(
      w.cashier,
      {
        idempotencyKey: saleKey(),
        documentType: "NOTA_VENTA",
        items: [{ productId: p.id, quantity: "1" }],
        payments: [{ method: "CASH", amount: "110" }],
      },
      meta(),
    );
    await updateOperations(w.admin, { ...OPS, taxRate: 0.1 }, meta());
    expect((await getCompanySettings(w.admin)).operations.taxRate).toBe("0.1");
    const after = await createSale(
      w.cashier,
      {
        idempotencyKey: saleKey(),
        documentType: "NOTA_VENTA",
        items: [{ productId: p.id, quantity: "1" }],
        payments: [{ method: "CASH", amount: "110" }],
      },
      meta(),
    );
    expect((await getSale(w.admin, before.id)).taxTotal).toBe("16.78");
    expect((await getSale(w.admin, after.id)).taxTotal).toBe("10.00");
    expect(
      await admin.auditLog.count({
        where: { tenantId: w.tenantId, action: "company.operations_changed" },
      }),
    ).toBe(1);
    await updateOperations(w.admin, OPS, meta());
  });

  it("«los precios incluyen IGV» no se invierte cuando ya hay ventas o cotizaciones", async () => {
    expect((await getCompanySettings(w.admin)).locks.pricesIncludeTax).toBe(true);
    await expect(
      updateOperations(w.admin, { ...OPS, pricesIncludeTax: false }, meta()),
    ).rejects.toMatchObject({ code: "PRICES_LOCKED" });
    await expect(
      updateOperations(w.admin, { ...OPS, pricesIncludeTax: false }, meta()),
    ).rejects.toBeInstanceOf(ConflictError);
    // Una empresa sin ventas sí puede elegir.
    const fresh = await posWorld(admin);
    expect((await getCompanySettings(fresh.admin)).locks.pricesIncludeTax).toBe(false);
    await updateOperations(fresh.admin, { ...OPS, pricesIncludeTax: false }, meta());
    expect((await getCompanySettings(fresh.admin)).operations.pricesIncludeTax).toBe(false);
    // Mantener el valor actual con ventas existentes no es un cambio.
    await expect(
      updateOperations(w.admin, { ...OPS, pricesIncludeTax: true }, meta()),
    ).resolves.toBeUndefined();
  });

  it("la configuración de una empresa no se ve ni se cambia desde otra", async () => {
    const other = await posWorld(admin);
    await updateOperations(other.admin, { ...OPS, deadStockDays: 45, ticketWidthMm: 58 }, meta());
    expect((await getCompanySettings(w.admin)).operations).toMatchObject({
      deadStockDays: 90,
      ticketWidthMm: 80,
    });
    expect((await getCompanySettings(other.admin)).operations).toMatchObject({
      deadStockDays: 45,
      ticketWidthMm: 58,
    });
  });
});
