import { describe, expect, it } from "vitest";
import {
  documentError,
  isValidRuc,
  normalizeDocument,
  normalizeWhatsapp,
} from "@/lib/workshop/documents";
import {
  EXTENSION,
  MAX_SIGNATURE_BYTES,
  parseSignatureDataUrl,
  sniffImage,
} from "@/lib/workshop/image";
import { formatPlate, isValidPlate, normalizePlate } from "@/lib/workshop/plate";
import { isReminderDue, nextDue, REMINDER_LEAD_DAYS } from "@/lib/workshop/reminders-math";
import { canTransition, EDITABLE_STATUSES, OPEN_WORK_ORDER_STATUSES } from "@/lib/workshop/state";
import { computeTotals, type TotalsItem } from "@/lib/workshop/totals";
import { addMonths, computeWindow, coverage, daysUntil } from "@/lib/workshop/warranty-math";

describe("placas", () => {
  it("normaliza y valida", () => {
    expect(normalizePlate(" abc-123 ")).toBe("ABC123");
    expect(normalizePlate("a1b.234")).toBe("A1B234");
    for (const ok of ["ABC123", "A1B234", "1234AB", "ABC12"])
      expect(isValidPlate(ok), ok).toBe(true);
    for (const bad of ["AB1", "ABCDEFGH", "AB-123", "ÑAB123", ""])
      expect(isValidPlate(bad), bad).toBe(false);
    expect(formatPlate("ABC123")).toBe("ABC-123");
    expect(formatPlate("ABC12")).toBe("ABC12");
  });
});

describe("documentos del cliente", () => {
  it("valida el dígito verificador del RUC (módulo 11 de SUNAT)", () => {
    // RUC de SUNAT: 20100070970 (Supermercados Peruanos) y 20131312955 (SUNAT).
    for (const ruc of ["20100070970", "20131312955", "10456789012"].slice(0, 2))
      expect(isValidRuc(ruc), ruc).toBe(true);
    expect(isValidRuc("20100070971")).toBe(false); // dígito verificador alterado
    expect(isValidRuc("30100070970")).toBe(false); // prefijo inválido
    expect(isValidRuc("2010007097")).toBe(false);
    expect(isValidRuc("abcdefghijk")).toBe(false);
  });

  it("valida cada tipo de documento", () => {
    expect(documentError("DNI", "45678123")).toBeNull();
    expect(documentError("DNI", "4567812")).toMatch(/8 dígitos/);
    expect(documentError("RUC", "20131312955")).toBeNull();
    expect(documentError("RUC", "20131312950")).toMatch(/RUC inválido/);
    expect(documentError("CE", "001234567")).toBeNull();
    expect(documentError("CE", "123")).toMatch(/extranjería/);
    expect(documentError("PASSPORT", "ab123456")).toBeNull();
    expect(documentError("OTHER", "x")).toMatch(/inválido/);
    expect(normalizeDocument("DNI", " 4567 8123 ")).toBe("45678123");
    expect(normalizeDocument("PASSPORT", "ab-123 456")).toBe("AB123456");
  });

  it("normaliza WhatsApp (Perú por defecto)", () => {
    expect(normalizeWhatsapp("987654321")).toBe("51987654321");
    expect(normalizeWhatsapp("+51 987 654 321")).toBe("51987654321");
    expect(normalizeWhatsapp("+1 (305) 555-0100")).toBe("13055550100");
    expect(normalizeWhatsapp("12345")).toBeNull();
    expect(normalizeWhatsapp("")).toBeNull();
  });
});

describe("máquina de estados de la OT", () => {
  it("permite el flujo completo y bloquea saltos", () => {
    const path = [
      "RECEIVED",
      "DIAGNOSING",
      "AWAITING_APPROVAL",
      "IN_REPAIR",
      "READY",
      "DELIVERED",
    ] as const;
    for (let i = 0; i < path.length - 1; i += 1)
      expect(canTransition(path[i]!, path[i + 1]!), `${path[i]}→${path[i + 1]}`).toBe(true);
    expect(canTransition("RECEIVED", "DELIVERED")).toBe(false);
    expect(canTransition("DIAGNOSING", "READY")).toBe(false);
    expect(canTransition("DELIVERED", "CANCELLED")).toBe(false);
    expect(canTransition("CANCELLED", "RECEIVED")).toBe(false);
    expect(canTransition("IN_REPAIR", "AWAITING_APPROVAL")).toBe(true); // trabajo adicional
    expect(canTransition("READY", "AWAITING_APPROVAL")).toBe(true);
  });

  it("agrupa estados abiertos y editables", () => {
    expect(OPEN_WORK_ORDER_STATUSES).not.toContain("DELIVERED");
    expect(OPEN_WORK_ORDER_STATUSES).not.toContain("CANCELLED");
    expect(EDITABLE_STATUSES).not.toContain("READY");
    expect(EDITABLE_STATUSES).not.toContain("DELIVERED");
  });
});

describe("totales de la cuenta mixta", () => {
  const item = (over: Partial<TotalsItem>): TotalsItem => ({
    quantity: 1,
    unitPrice: 100,
    discount: 0,
    taxable: true,
    approvalStatus: "APPROVED",
    returned: false,
    ...over,
  });

  it("suma mano de obra y repuestos con IGV solo en lo gravado", () => {
    const totals = computeTotals(
      [
        item({ quantity: 2, unitPrice: 179 }),
        item({ unitPrice: 40 }),
        item({ unitPrice: 50, taxable: false }),
      ],
      0.18,
    );
    expect(totals).toEqual({ subtotal: 448, taxTotal: 71.64, total: 519.64 });
  });

  it("aplica descuentos por línea sin dejar valores negativos", () => {
    expect(computeTotals([item({ unitPrice: 100, discount: 30 })], 0.18).subtotal).toBe(70);
    expect(computeTotals([item({ unitPrice: 100, discount: 500 })], 0.18).total).toBe(0);
  });

  it("ignora lo rechazado por el cliente y lo devuelto al almacén, pero cuenta lo pendiente", () => {
    const totals = computeTotals(
      [
        item({ approvalStatus: "REJECTED" }),
        item({ returned: true }),
        item({ approvalStatus: "PENDING", unitPrice: 10 }),
      ],
      0,
    );
    expect(totals.subtotal).toBe(10);
  });

  it("redondea a 2 decimales", () => {
    expect(computeTotals([item({ unitPrice: 33.333, quantity: 3 })], 0.18)).toEqual({
      subtotal: 100,
      taxTotal: 18,
      total: 118,
    });
  });
});

describe("vigencia de garantías", () => {
  it("suma meses sin desbordar el calendario", () => {
    expect(addMonths(new Date("2026-01-31T12:00:00Z"), 1).toISOString()).toBe(
      "2026-02-28T12:00:00.000Z",
    );
    expect(addMonths(new Date("2024-01-31T12:00:00Z"), 1).toISOString()).toBe(
      "2024-02-29T12:00:00.000Z",
    );
    expect(addMonths(new Date("2026-10-20T00:00:00Z"), 12).toISOString()).toBe(
      "2027-10-20T00:00:00.000Z",
    );
    expect(addMonths(new Date("2026-11-30T00:00:00Z"), 3).toISOString()).toBe(
      "2027-02-28T00:00:00.000Z",
    );
  });

  it("calcula la ventana por fecha y/o kilometraje", () => {
    const start = new Date("2026-10-20T00:00:00Z");
    expect(computeWindow(start, { months: 3, kilometers: 5000 }, 50_000)).toMatchObject({
      expiresAtMileage: 55_000,
    });
    expect(
      computeWindow(start, { months: 3, kilometers: 5000 }, 50_000).expiresAt?.toISOString(),
    ).toBe("2027-01-20T00:00:00.000Z");
    expect(computeWindow(start, { months: null, kilometers: 5000 }, 1000)).toMatchObject({
      expiresAt: null,
      expiresAtMileage: 6000,
    });
    expect(computeWindow(start, { months: 12, kilometers: null }, null)).toMatchObject({
      expiresAtMileage: null,
    });
    expect(
      computeWindow(start, { months: null, kilometers: 5000 }, null).expiresAtMileage,
    ).toBeNull(); // sin km de inicio no se puede acotar
  });

  it("vence por lo PRIMERO que ocurra: fecha o kilometraje", () => {
    const base = {
      status: "ACTIVE" as const,
      startsAt: new Date("2026-01-01T00:00:00Z"),
      expiresAt: new Date("2027-01-01T00:00:00Z"),
      startMileage: 10_000,
      expiresAtMileage: 15_000,
    };
    const now = new Date("2026-06-01T00:00:00Z");
    expect(coverage(base, { now, mileage: 12_000 })).toEqual({ covered: true, reasons: [] });
    expect(coverage(base, { now, mileage: 15_001 })).toEqual({
      covered: false,
      reasons: ["EXPIRED_BY_MILEAGE"],
    });
    expect(coverage(base, { now: new Date("2027-01-02T00:00:00Z"), mileage: 12_000 })).toEqual({
      covered: false,
      reasons: ["EXPIRED_BY_DATE"],
    });
    expect(
      coverage(base, { now: new Date("2027-01-02T00:00:00Z"), mileage: 99_999 }).reasons,
    ).toEqual(["EXPIRED_BY_DATE", "EXPIRED_BY_MILEAGE"]);
    expect(coverage(base, { now, mileage: 15_000 }).covered).toBe(true); // el límite exacto aún cubre
    expect(coverage({ ...base, status: "VOID" }, { now, mileage: null }).reasons).toEqual(["VOID"]);
    expect(
      coverage({ ...base, startsAt: new Date("2026-12-01T00:00:00Z") }, { now, mileage: null })
        .reasons,
    ).toEqual(["NOT_STARTED"]);
    expect(coverage(base, { now, mileage: null }).covered).toBe(true); // sin km actual solo cuenta la fecha
  });

  it("cuenta días restantes", () => {
    expect(daysUntil(new Date("2026-10-30T00:00:00Z"), new Date("2026-10-20T00:00:00Z"))).toBe(10);
    expect(daysUntil(new Date("2026-10-19T00:00:00Z"), new Date("2026-10-20T00:00:00Z"))).toBe(-1);
  });
});

describe("recordatorios de mantenimiento", () => {
  const now = new Date("2026-10-20T00:00:00Z");

  it("avisa 7 días antes por fecha o 500 km antes por kilometraje", () => {
    expect(REMINDER_LEAD_DAYS).toBe(7);
    expect(
      isReminderDue({ dueDate: new Date("2026-10-27T00:00:00Z"), dueMileage: null }, null, now),
    ).toBe(true);
    expect(
      isReminderDue({ dueDate: new Date("2026-10-28T00:00:00Z"), dueMileage: null }, null, now),
    ).toBe(false);
    expect(isReminderDue({ dueDate: null, dueMileage: 60_000 }, 59_500, now)).toBe(true);
    expect(isReminderDue({ dueDate: null, dueMileage: 60_000 }, 59_499, now)).toBe(false);
    expect(isReminderDue({ dueDate: null, dueMileage: 60_000 }, null, now)).toBe(false);
    expect(
      isReminderDue({ dueDate: new Date("2027-01-01T00:00:00Z"), dueMileage: 60_000 }, 61_000, now),
    ).toBe(true); // cualquiera de las dos
  });

  it("calcula el próximo servicio", () => {
    expect(nextDue({ date: now, mileage: 50_000 }, { months: 6, km: 5000 })).toEqual({
      dueDate: new Date("2027-04-20T00:00:00Z"),
      dueMileage: 55_000,
    });
    expect(nextDue({ date: now, mileage: null }, { months: null, km: 5000 })).toEqual({
      dueDate: null,
      dueMileage: null,
    });
  });
});

describe("imágenes", () => {
  const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
  const jpg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]);
  const webp = Uint8Array.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);

  it("detecta el tipo por contenido, no por lo que declare el archivo", () => {
    expect(sniffImage(png)).toBe("image/png");
    expect(sniffImage(jpg)).toBe("image/jpeg");
    expect(sniffImage(webp)).toBe("image/webp");
    expect(sniffImage(new TextEncoder().encode("<svg onload=alert(1)></svg>"))).toBeNull();
    expect(sniffImage(new TextEncoder().encode("<html><script>"))).toBeNull();
    expect(sniffImage(Uint8Array.from([0x4d, 0x5a, 0x90, 0]))).toBeNull(); // ejecutable de Windows
    expect(sniffImage(new Uint8Array())).toBeNull();
    expect(EXTENSION["image/jpeg"]).toBe("jpg");
  });

  it("acepta solo firmas PNG en base64", () => {
    const ok = `data:image/png;base64,${Buffer.from(png).toString("base64")}`;
    expect(parseSignatureDataUrl(ok)).toHaveLength(png.length);
    expect(
      parseSignatureDataUrl(`data:image/jpeg;base64,${Buffer.from(jpg).toString("base64")}`),
    ).toBeNull();
    expect(
      parseSignatureDataUrl(`data:image/png;base64,${Buffer.from("<svg/>").toString("base64")}`),
    ).toBeNull(); // dice PNG pero no lo es
    expect(parseSignatureDataUrl("data:image/png;base64,@@@")).toBeNull();
    expect(parseSignatureDataUrl("https://evil.example/x.png")).toBeNull();
    const huge = Buffer.concat([Buffer.from(png), Buffer.alloc(MAX_SIGNATURE_BYTES)]);
    expect(parseSignatureDataUrl(`data:image/png;base64,${huge.toString("base64")}`)).toBeNull();
  });
});
