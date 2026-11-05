import { describe, expect, it } from "vitest";
import {
  DISPATCH_MODE_CODE,
  DISPATCH_REASON_CODE,
  isValidDriverLicense,
  isValidPlate,
  isValidUbigeo,
  normalizePlate,
} from "@/lib/dispatch/sunat";
import { createDispatchGuideSchema, voidDispatchGuideSchema } from "@/lib/validation/dispatch";
import {
  SimulatedDispatchProvider,
  type DispatchPayload,
} from "@/server/integrations/dispatch-provider";

function ruc(prefix10: string): string {
  const factors = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
  const sum = factors.reduce((acc, f, i) => acc + f * Number(prefix10[i]), 0);
  return `${prefix10}${(11 - (sum % 11)) % 10}`;
}
const RUC = ruc("2012345678");
const OTHER_RUC = ruc("2098765432");

const base = {
  transferDate: "2026-11-10",
  reason: "SALE",
  transportMode: "PRIVATE",
  driverDocNumber: "45871236",
  driverName: "Juan Pérez",
  driverLicense: "Q12345678",
  vehiclePlate: "abc-123",
  grossWeightKg: "125.5",
  originAddress: "Av. Industrial 123, Ate",
  originUbigeo: "150103",
  destinationAddress: "Jr. Comercio 456, Miraflores",
  destinationUbigeo: "150122",
  recipientDocType: "RUC",
  recipientDocNumber: OTHER_RUC,
  recipientName: "Cliente SAC",
  items: [{ description: "Filtro de aceite", sku: "FIL-1", unit: "UND", quantity: "10" }],
};

const issues = (input: unknown) => {
  const result = createDispatchGuideSchema.safeParse(input);
  return result.success ? [] : result.error.issues.map((issue) => issue.path[0]);
};

describe("catálogos y validadores de SUNAT", () => {
  it("usa los códigos de los catálogos 18 y 20", () => {
    expect(DISPATCH_REASON_CODE).toEqual({
      SALE: "01",
      PURCHASE: "02",
      TRANSFER_BETWEEN_ESTABLISHMENTS: "04",
      OTHER: "13",
    });
    expect(DISPATCH_MODE_CODE).toEqual({ PUBLIC: "01", PRIVATE: "02" });
  });

  it("valida placa, ubigeo y licencia", () => {
    expect(normalizePlate(" abc-123 ")).toBe("ABC123");
    expect(isValidPlate("ABC-123")).toBe(true);
    expect(isValidPlate("AB1")).toBe(false);
    expect(isValidUbigeo("150101")).toBe(true);
    expect(isValidUbigeo("260101")).toBe(false);
    expect(isValidUbigeo("15010")).toBe(false);
    expect(isValidDriverLicense("Q12345678")).toBe(true);
    expect(isValidDriverLicense("12345678")).toBe(false);
  });
});

describe("validación de la GRE remitente", () => {
  it("acepta una guía de transporte privado y normaliza los datos", () => {
    const parsed = createDispatchGuideSchema.parse(base);
    expect(parsed.series).toBe("T001");
    expect(parsed.grossWeightKg).toBe("125.500");
    expect(parsed.items[0]?.quantity).toBe("10.0000");
  });

  it("transporte privado exige placa, DNI y nombre del conductor", () => {
    expect(issues({ ...base, vehiclePlate: undefined })).toContain("vehiclePlate");
    expect(issues({ ...base, vehiclePlate: "A1" })).toContain("vehiclePlate");
    expect(issues({ ...base, driverDocNumber: "123" })).toContain("driverDocNumber");
    expect(issues({ ...base, driverName: undefined })).toContain("driverName");
    expect(issues({ ...base, driverLicense: "123" })).toContain("driverLicense");
    expect(issues({ ...base, driverLicense: "" })).toEqual([]);
  });

  it("transporte público exige RUC válido y razón social del transportista", () => {
    const pub = {
      ...base,
      transportMode: "PUBLIC",
      carrierDocNumber: RUC,
      carrierName: "Transportes SAC",
    };
    expect(issues(pub)).toEqual([]);
    expect(issues({ ...pub, carrierDocNumber: "20123456789" })).toContain("carrierDocNumber");
    expect(issues({ ...pub, carrierName: undefined })).toContain("carrierName");
    // La placa es opcional, pero si se indica debe ser válida.
    expect(issues({ ...pub, vehiclePlate: "X" })).toContain("vehiclePlate");
  });

  it("valida peso, bienes y direcciones", () => {
    expect(issues({ ...base, grossWeightKg: "0" })).toContain("grossWeightKg");
    expect(issues({ ...base, grossWeightKg: "abc" })).toContain("grossWeightKg");
    expect(issues({ ...base, items: [] })).toContain("items");
    expect(issues({ ...base, items: [{ description: "x", quantity: "0" }] })).toContain("items");
    expect(issues({ ...base, originAddress: "x" })).toContain("originAddress");
    expect(issues({ ...base, destinationUbigeo: "999999" })).toContain("destinationUbigeo");
  });

  it("valida el documento del destinatario según su tipo", () => {
    expect(
      issues({ ...base, recipientDocType: "RUC", recipientDocNumber: "20123456789" }),
    ).toContain("recipientDocNumber");
    expect(issues({ ...base, recipientDocType: "DNI", recipientDocNumber: "45871236" })).toEqual(
      [],
    );
    expect(issues({ ...base, recipientDocType: "DNI", recipientDocNumber: "12" })).toContain(
      "recipientDocNumber",
    );
  });

  it("el motivo «Otros» exige detalle", () => {
    expect(issues({ ...base, reason: "OTHER" })).toContain("reasonNote");
    expect(issues({ ...base, reason: "OTHER", reasonNote: "Muestra para cliente" })).toEqual([]);
  });

  it("un traslado entre establecimientos va a tu propia empresa (RUC)", () => {
    expect(
      issues({
        ...base,
        reason: "TRANSFER_BETWEEN_ESTABLISHMENTS",
        recipientDocType: "DNI",
        recipientDocNumber: "45871236",
      }),
    ).toContain("recipientDocType");
    expect(
      issues({ ...base, reason: "TRANSFER_BETWEEN_ESTABLISHMENTS", recipientDocNumber: RUC }),
    ).toEqual([]);
  });

  it("el traslado no puede empezar antes de la emisión", () => {
    expect(issues({ ...base, issueDate: "2026-11-12", transferDate: "2026-11-10" })).toContain(
      "transferDate",
    );
    expect(issues({ ...base, issueDate: "2026-11-10", transferDate: "2026-11-10" })).toEqual([]);
  });

  it("valida la serie", () => {
    expect(createDispatchGuideSchema.parse({ ...base, series: "t002" }).series).toBe("T002");
    expect(issues({ ...base, series: "F001" })).toContain("series");
  });

  it("la anulación exige un motivo", () => {
    const guideId = "0190a1c2-0000-7000-8000-000000000001";
    expect(voidDispatchGuideSchema.safeParse({ guideId, reason: "x" }).success).toBe(false);
    expect(voidDispatchGuideSchema.safeParse({ guideId, reason: "Error de datos" }).success).toBe(
      true,
    );
  });
});

describe("proveedor simulado de GRE", () => {
  const payload: DispatchPayload = {
    issuerRuc: RUC,
    series: "T001",
    correlative: 7,
    issueDate: "2026-11-10",
    transferDate: "2026-11-10",
    reasonCode: "01",
    reasonNote: null,
    transportModeCode: "02",
    grossWeightKg: "10.000",
    packages: null,
    origin: { address: "Av. Industrial 123", ubigeo: "150103" },
    destination: { address: "Jr. Comercio 456", ubigeo: "150122" },
    recipient: { docType: "RUC", docNumber: OTHER_RUC, name: "Cliente SAC" },
    carrier: null,
    driver: { dni: "45871236", name: "Juan", license: null },
    vehiclePlate: "ABC123",
    items: [{ description: "Filtro", sku: null, unit: "UND", quantity: "1.0000" }],
  };
  const provider = new SimulatedDispatchProvider();

  it("acepta una guía correcta con un hash estable", async () => {
    const a = await provider.submit(payload);
    expect(a).toMatchObject({ outcome: "ACCEPTED", providerRef: "SIM-GRE-T001-7" });
    expect((await provider.submit(payload)).hash).toBe(a.hash);
    expect((await provider.submit({ ...payload, correlative: 8 })).hash).not.toBe(a.hash);
  });

  it("rechaza lo que SUNAT rechazaría", async () => {
    expect((await provider.submit({ ...payload, series: "F001" })).outcome).toBe("REJECTED");
    expect((await provider.submit({ ...payload, grossWeightKg: "0" })).code).toBe("2406");
    expect(
      (await provider.submit({ ...payload, origin: { address: "x", ubigeo: "1" } })).code,
    ).toBe("2402");
    expect((await provider.submit({ ...payload, items: [] })).code).toBe("2407");
    expect((await provider.submit({ ...payload, transportModeCode: "01" })).code).toBe("2420");
    expect((await provider.submit({ ...payload, vehiclePlate: null })).code).toBe("2421");
  });
});
