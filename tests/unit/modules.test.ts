import { describe, expect, it } from "vitest";
import {
  ALL_PERMISSION_KEYS,
  CUSTOM_ROLE_TEMPLATES,
  MODULE_ACTIONS,
  PERMISSION_CATALOG,
} from "@/lib/auth/permissions";
import { AppModule } from "@/lib/db/enums";
import {
  BUSINESS_PRESETS,
  LOCKED_MODULES,
  MODULE_GROUPS,
  MODULE_LABEL,
  disabledFromGroups,
  effectiveModuleList,
  groupStates,
} from "@/lib/modules";

const ALL = Object.values(AppModule) as AppModule[];
const BASIC: AppModule[] = [
  "USERS",
  "CUSTOMERS",
  "CATALOG",
  "INVENTORY",
  "WARRANTIES",
  "POS",
  "CASH",
  "BILLING",
  "REPORTS",
  "SETTINGS",
  "AUDIT",
];

describe("catálogo de módulos", () => {
  it("cada módulo no fijo pertenece a exactamente una casilla del SuperAdmin", () => {
    const grouped = MODULE_GROUPS.flatMap((g) => [...g.modules]);
    for (const item of ALL.filter((m) => !LOCKED_MODULES.includes(m)))
      expect(
        grouped.filter((m) => m === item),
        item,
      ).toHaveLength(1);
    for (const item of LOCKED_MODULES) expect(grouped).not.toContain(item);
  });
  it("todos los módulos tienen etiqueta y permisos definidos", () => {
    for (const item of ALL) {
      expect(MODULE_LABEL[item], item).toBeTruthy();
      expect(MODULE_ACTIONS[item].length, item).toBeGreaterThan(0);
    }
  });
  it("los módulos comerciales nuevos están en el catálogo de permisos", () => {
    for (const key of [
      "whatsapp:ver",
      "whatsapp:editar",
      "accounting:ver",
      "accounting:crear",
      "accounting:eliminar",
      "branches:ver",
      "branches:crear",
      "branches:editar",
    ] as const)
      expect(ALL_PERMISSION_KEYS.has(key), key).toBe(true);
    expect(PERMISSION_CATALOG.length).toBeGreaterThanOrEqual(60);
  });
  it("la plantilla «Contador» solo trae permisos válidos y nada de ventas ni inventario", () => {
    const contador = CUSTOM_ROLE_TEMPLATES.find((t) => t.id === "contador");
    expect(contador).toBeDefined();
    for (const key of contador?.permissions ?? [])
      expect(ALL_PERMISSION_KEYS.has(key), key).toBe(true);
    expect(contador?.permissions).toEqual(
      expect.arrayContaining([
        "accounting:ver",
        "accounting:crear",
        "accounting:eliminar",
        "reports:ver",
      ]),
    );
    for (const forbidden of [
      "pos:crear",
      "inventory:editar",
      "inventory:crear",
      "settings:editar",
      "users:crear",
    ] as const)
      expect(contador?.permissions).not.toContain(forbidden);
  });
});

describe("módulos efectivos", () => {
  it("sin ajustes son los del plan", () => {
    expect(effectiveModuleList(BASIC)).toEqual(BASIC);
  });
  it("lo apagado por el SuperAdmin desaparece, salvo los módulos fijos", () => {
    const result = effectiveModuleList(BASIC, ["WARRANTIES", "USERS", "SETTINGS", "BILLING"]);
    expect(result).not.toContain("WARRANTIES");
    expect(result).not.toContain("BILLING");
    for (const locked of LOCKED_MODULES) expect(result).toContain(locked);
  });
  it("al subir de plan se activan solos los módulos nuevos (no estaban apagados)", () => {
    const disabled: AppModule[] = ["WARRANTIES"];
    const upgraded = [...BASIC, "WORKSHOP", "AI_AGENT"] as AppModule[];
    const result = effectiveModuleList(upgraded, disabled);
    expect(result).toEqual(expect.arrayContaining(["WORKSHOP", "AI_AGENT"]));
    expect(result).not.toContain("WARRANTIES");
  });
  it("al bajar de plan se pierden los módulos que ya no incluye", () => {
    expect(effectiveModuleList(BASIC, [])).not.toContain("AI_AGENT");
  });
  it("respeta la lista blanca heredada (si existe)", () => {
    const result = effectiveModuleList(BASIC, [], ["USERS", "POS"]);
    expect(result).toEqual(expect.arrayContaining(["POS", "USERS", "SETTINGS", "AUDIT"]));
    expect(result).not.toContain("CASH");
  });
});

describe("casillas por plan y rubro", () => {
  it("las casillas que el plan no incluye aparecen como no incluidas", () => {
    const states = groupStates(BASIC);
    const byId = Object.fromEntries(states.map((s) => [s.group.id, s]));
    expect(byId.core).toMatchObject({ included: true, active: true });
    expect(byId.ai).toMatchObject({ included: false, active: false });
    expect(byId.accounting).toMatchObject({ included: false, active: false });
    expect(byId.whatsapp).toMatchObject({ included: false });
  });
  it("una casilla apagada figura incluida pero inactiva", () => {
    const states = groupStates(BASIC, ["WARRANTIES"]);
    expect(states.find((s) => s.group.id === "warranties")).toMatchObject({
      included: true,
      active: false,
    });
  });
  it("de las casillas marcadas se deducen los módulos a apagar (solo del plan)", () => {
    const premium: AppModule[] = [
      ...BASIC,
      "WORKSHOP",
      "PURCHASING",
      "AI_AGENT",
      "WHATSAPP",
      "ACCOUNTING",
      "BRANCHES",
    ];
    const disabled = disabledFromGroups(premium, ["core", "billing", "reports"]);
    expect(disabled).toEqual(
      expect.arrayContaining([
        "WORKSHOP",
        "AI_AGENT",
        "WHATSAPP",
        "ACCOUNTING",
        "BRANCHES",
        "PURCHASING",
        "WARRANTIES",
      ]),
    );
    for (const kept of ["POS", "CASH", "BILLING", "REPORTS", "USERS", "SETTINGS", "AUDIT"] as const)
      expect(disabled).not.toContain(kept);
  });
  it("el rubro «Tienda de autopartes» no incluye Taller ni Garantías", () => {
    expect(BUSINESS_PRESETS.AUTOPARTS).not.toContain("workshop");
    expect(BUSINESS_PRESETS.AUTOPARTS).not.toContain("warranties");
    expect(BUSINESS_PRESETS.AUTOPARTS).toEqual(
      expect.arrayContaining(["core", "billing", "accounting"]),
    );
    expect(BUSINESS_PRESETS.MIXED).toEqual(MODULE_GROUPS.map((g) => g.id));
    expect(BUSINESS_PRESETS.WORKSHOP).toEqual(expect.arrayContaining(["workshop", "warranties"]));
  });
});
