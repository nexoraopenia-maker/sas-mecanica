import { describe, expect, it } from "vitest";
import { clampSeasonality, computeReorder, daysOfCover } from "@/lib/inventory/reorder-math";
import { effectiveThresholds, stockStatus } from "@/lib/inventory/status";

const dec = (value: number | null) => (value === null ? null : { toString: () => String(value) });

describe("motor de reorden", () => {
  it("venta constante de 2/día y plazo de 5 días: sin variabilidad, sin stock de seguridad", () => {
    // 90 días × 2 u: suma de cuadrados = 90 · 4 = 360 → varianza 0.
    const result = computeReorder({ netOut30: 60, netOut90: 180, sumSquares90: 360 }, 5);
    expect(result).toMatchObject({
      avgDailySales30: 2,
      avgDailySales90: 2,
      dailyDemand: 2,
      safetyStock: 0,
      leadTimeDays: 5,
    });
    expect(result.reorderPoint).toBe(10); // 2 · 5
    expect(result.minStock).toBe(6); // 0 + 2 · 3 días
  });

  it("con variabilidad suma stock de seguridad (z = 1.65, σ de 90 días)", () => {
    // Días alternados de 0 y 4: media 2, Σx² = 45 · 16 = 720 → σ² = (720 − 360)/89.
    const result = computeReorder({ netOut30: 60, netOut90: 180, sumSquares90: 720 }, 4);
    const sigma = Math.sqrt(360 / 89);
    expect(result.safetyStock).toBeCloseTo(1.65 * sigma * 2, 3);
    expect(result.reorderPoint).toBe(15); // ⌈8 + 6.637⌉
    expect(result.minStock).toBe(13); // ⌈6.637 + 6⌉
  });

  it("pondera 60 % la rotación de 30 días y 40 % la de 90 días", () => {
    // 30d: 6/día; 90d: 2/día → 0.6·6 + 0.4·2 = 4.4
    const result = computeReorder({ netOut30: 180, netOut90: 180, sumSquares90: 90 * 4 }, 10);
    expect(result.dailyDemand).toBeCloseTo(4.4 - 0.4 * 0, 1);
    expect(result.avgDailySales30).toBe(6);
    expect(result.avgDailySales90).toBe(2);
  });

  it("la estacionalidad escala demanda y seguridad", () => {
    const base = computeReorder({ netOut30: 60, netOut90: 180, sumSquares90: 720 }, 4, 1);
    const peak = computeReorder({ netOut30: 60, netOut90: 180, sumSquares90: 720 }, 4, 1.5);
    expect(peak.dailyDemand).toBeCloseTo(base.dailyDemand * 1.5, 3);
    expect(peak.reorderPoint).toBe(22);
    expect(peak.minStock).toBe(19);
    expect(
      computeReorder({ netOut30: 60, netOut90: 180, sumSquares90: 720 }, 4, 0.5).reorderPoint,
    ).toBeLessThan(base.reorderPoint);
  });

  it("sin historial el mínimo y el reorden son 0", () => {
    expect(computeReorder({ netOut30: 0, netOut90: 0, sumSquares90: 0 }, 7)).toMatchObject({
      minStock: 0,
      reorderPoint: 0,
      dailyDemand: 0,
    });
  });

  it("salidas netas negativas (más devoluciones que ventas) se tratan como 0", () => {
    expect(computeReorder({ netOut30: -5, netOut90: -5, sumSquares90: 0 }, 7)).toMatchObject({
      minStock: 0,
      reorderPoint: 0,
    });
  });

  it("el mínimo nunca supera al punto de reorden (plazo corto)", () => {
    const result = computeReorder({ netOut30: 300, netOut90: 300, sumSquares90: 3000 }, 1);
    expect(result.minStock).toBeLessThanOrEqual(result.reorderPoint);
  });

  it("usa el plazo por defecto si el dato es inválido y acota la estacionalidad", () => {
    expect(computeReorder({ netOut30: 30, netOut90: 90, sumSquares90: 90 }, 0).leadTimeDays).toBe(
      7,
    );
    expect(clampSeasonality(100)).toBe(4);
    expect(clampSeasonality(0)).toBe(0.25);
    expect(clampSeasonality(Number.NaN)).toBe(1);
  });

  it("días de cobertura", () => {
    expect(daysOfCover(20, 2)).toBe(10);
    expect(daysOfCover(-3, 2)).toBe(0);
    expect(daysOfCover(10, 0)).toBeNull();
  });
});

describe("semáforo", () => {
  const t = { minStock: 6, reorderPoint: 10 };
  it("crítico ≤ mínimo, reorden ≤ punto de reorden, óptimo por encima", () => {
    expect(stockStatus(0, t)).toBe("CRITICAL");
    expect(stockStatus(6, t)).toBe("CRITICAL");
    expect(stockStatus(7, t)).toBe("REORDER");
    expect(stockStatus(10, t)).toBe("REORDER");
    expect(stockStatus(11, t)).toBe("OPTIMAL");
  });

  it("sin umbrales solo alerta cuando se agota", () => {
    expect(stockStatus(0, effectiveThresholds(null))).toBe("CRITICAL");
    expect(stockStatus(1, effectiveThresholds(null))).toBe("OPTIMAL");
  });

  it("AUTO usa lo calculado; MANUAL lo del usuario (con respaldo al calculado)", () => {
    const base = {
      manualMinStock: dec(20),
      manualReorderPoint: dec(30),
      computedMinStock: dec(6),
      computedReorderPoint: dec(10),
    };
    expect(effectiveThresholds({ ...base, mode: "AUTO" })).toEqual({
      minStock: 6,
      reorderPoint: 10,
    });
    expect(effectiveThresholds({ ...base, mode: "MANUAL" })).toEqual({
      minStock: 20,
      reorderPoint: 30,
    });
    expect(effectiveThresholds({ ...base, mode: "MANUAL", manualReorderPoint: null })).toEqual({
      minStock: 20,
      reorderPoint: 20,
    });
    expect(
      effectiveThresholds({
        ...base,
        mode: "MANUAL",
        manualMinStock: null,
        manualReorderPoint: null,
      }),
    ).toEqual({ minStock: 6, reorderPoint: 10 });
  });
});
