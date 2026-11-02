/**
 * Cálculo del stock mínimo y el punto de reorden a partir de la rotación.
 * Función pura: el servicio solo aporta las estadísticas de ventas.
 */
export const REORDER_CONFIG = {
  /** Peso de la rotación reciente (30 días) frente a la de 90 días. */
  weight30: 0.6,
  weight90: 0.4,
  /** Nivel de servicio del 95 % (z de la normal). */
  serviceZ: 1.65,
  /** Días de demanda que el mínimo debe cubrir además del stock de seguridad. */
  minCoverDays: 3,
  /** Plazo de entrega si no hay proveedor con dato. */
  defaultLeadTimeDays: 7,
  windowShort: 30,
  windowLong: 90,
  minSeasonality: 0.25,
  maxSeasonality: 4,
} as const;

export interface DemandStats {
  /** Salidas netas (ventas + consumo en OT − devoluciones) en los últimos 30 días. */
  netOut30: number;
  /** Ídem en 90 días. */
  netOut90: number;
  /** Suma de los cuadrados de la salida diaria en 90 días (días sin venta aportan 0). */
  sumSquares90: number;
}

export interface ReorderResult {
  avgDailySales30: number;
  avgDailySales90: number;
  /** Demanda diaria ponderada y ajustada por estacionalidad. */
  dailyDemand: number;
  safetyStock: number;
  leadTimeDays: number;
  minStock: number;
  reorderPoint: number;
}

const round4 = (value: number): number => Math.round(value * 10_000) / 10_000;

export function clampSeasonality(factor: number): number {
  if (!Number.isFinite(factor)) return 1;
  return Math.min(REORDER_CONFIG.maxSeasonality, Math.max(REORDER_CONFIG.minSeasonality, factor));
}

/**
 *   demanda      = estacionalidad · (0.6·d30 + 0.4·d90)
 *   seguridad    = z · σ_diaria(90d) · √plazo · estacionalidad
 *   reorden      = ⌈demanda · plazo + seguridad⌉
 *   mínimo       = ⌈seguridad + demanda · 3 días⌉     (nunca por encima del reorden)
 * Las salidas netas negativas (más devoluciones que ventas) se tratan como 0.
 */
export function computeReorder(
  stats: DemandStats,
  leadTimeDays: number,
  seasonality = 1,
): ReorderResult {
  const {
    weight30,
    weight90,
    serviceZ,
    minCoverDays,
    windowShort,
    windowLong,
    defaultLeadTimeDays,
  } = REORDER_CONFIG;
  const lead = leadTimeDays > 0 ? leadTimeDays : defaultLeadTimeDays;
  const season = clampSeasonality(seasonality);

  const d30 = Math.max(0, stats.netOut30) / windowShort;
  const d90 = Math.max(0, stats.netOut90) / windowLong;
  const demand = season * (weight30 * d30 + weight90 * d90);

  const mean90 = Math.max(0, stats.netOut90) / windowLong;
  const variance = Math.max(
    0,
    (stats.sumSquares90 - windowLong * mean90 * mean90) / (windowLong - 1),
  );
  const safety = serviceZ * Math.sqrt(variance) * Math.sqrt(lead) * season;

  const reorderPoint = Math.ceil(round4(demand * lead + safety));
  const minStock = Math.min(reorderPoint, Math.ceil(round4(safety + demand * minCoverDays)));
  return {
    avgDailySales30: round4(d30),
    avgDailySales90: round4(d90),
    dailyDemand: round4(demand),
    safetyStock: round4(safety),
    leadTimeDays: lead,
    minStock,
    reorderPoint,
  };
}

/** Días que dura el stock actual al ritmo de venta (null si no hay ventas). */
export function daysOfCover(quantity: number, dailyDemand: number): number | null {
  if (dailyDemand <= 0) return null;
  return Math.max(0, quantity) / dailyDemand;
}
