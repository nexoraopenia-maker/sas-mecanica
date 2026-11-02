import type { AdminClient, AppModule } from "@/lib/db";
import { PERMISSION_CATALOG } from "@/lib/auth/permissions";

const BASE_MODULES: AppModule[] = [
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
const PRO_MODULES: AppModule[] = [...BASE_MODULES, "WORKSHOP", "PURCHASING"];
const ALL_MODULES: AppModule[] = [...PRO_MODULES, "AI_AGENT"];

/** Techo de tokens de IA para cuentas demo (también aplicado por resolveAiPolicy). */
export const DEMO_AI_TOKEN_CAP = 20_000;

const PLANS = [
  {
    code: "basic",
    name: "Básico",
    description: "1 sucursal y 3 usuarios",
    priceMonthly: "99.00",
    maxBranches: 1,
    maxUsers: 3,
    maxWarehouses: 1,
    monthlyAiTokens: 0,
    multiWarehouse: false,
    fullWorkshop: false,
    stockAlerts: false,
    aiPurchasingAgent: false,
    includedModules: BASE_MODULES,
    sortOrder: 1,
    isActive: true,
  },
  {
    code: "pro",
    name: "Pro",
    description: "Multialmacén, taller completo y alertas de stock",
    priceMonthly: "249.00",
    maxBranches: 3,
    maxUsers: 10,
    maxWarehouses: null,
    monthlyAiTokens: 0,
    multiWarehouse: true,
    fullWorkshop: true,
    stockAlerts: true,
    aiPurchasingAgent: false,
    includedModules: PRO_MODULES,
    sortOrder: 2,
    isActive: true,
  },
  {
    code: "enterprise",
    name: "Enterprise / IA",
    description: "Usuarios ilimitados y agente de compras con IA",
    priceMonthly: "599.00",
    maxBranches: null,
    maxUsers: null,
    maxWarehouses: null,
    monthlyAiTokens: 2_000_000,
    multiWarehouse: true,
    fullWorkshop: true,
    stockAlerts: true,
    aiPurchasingAgent: true,
    includedModules: ALL_MODULES,
    sortOrder: 3,
    isActive: true,
  },
  {
    code: "demo",
    name: "Demo",
    description: "Sandbox temporal con límites estrictos",
    priceMonthly: "0.00",
    maxBranches: 2,
    maxUsers: 10,
    maxWarehouses: 3,
    monthlyAiTokens: DEMO_AI_TOKEN_CAP,
    multiWarehouse: true,
    fullWorkshop: true,
    stockAlerts: true,
    aiPurchasingAgent: true,
    includedModules: ALL_MODULES,
    sortOrder: 99,
    isActive: false,
  },
] as const;

/** Idempotente: planes por defecto y catálogo global de permisos. Los planes ya editados por el SuperAdmin no se pisan. */
export async function seedPlatform(db: AdminClient): Promise<void> {
  for (const plan of PLANS) {
    const { code, ...data } = plan;
    await db.plan.upsert({
      where: { code },
      update: {},
      create: { code, ...data, includedModules: [...data.includedModules] },
    });
  }
  for (const entry of PERMISSION_CATALOG) {
    await db.permission.upsert({
      where: { module_action: { module: entry.module, action: entry.action } },
      update: {},
      create: { module: entry.module, action: entry.action },
    });
  }
}
