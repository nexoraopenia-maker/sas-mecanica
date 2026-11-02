import { describe, expect, it } from "vitest";
import { daysToDue, DUE_SOON_DAYS, trafficLight } from "@/lib/pos/receivable-light";

const now = new Date("2026-11-10T15:00:00Z");
const inDays = (d: number, extraMs = 0) => new Date(now.getTime() + d * 86_400_000 + extraMs);

describe("semáforo de cuentas por cobrar", () => {
  it("rojo si ya venció, ámbar dentro de los 3 días previos (incluido el límite), verde si hay más margen", () => {
    expect(DUE_SOON_DAYS).toBe(3);
    expect(trafficLight(inDays(-1), now)).toBe("RED");
    expect(trafficLight(new Date(now.getTime() - 1), now)).toBe("RED");
    expect(trafficLight(now, now)).toBe("AMBER"); // vence exactamente ahora: aún no está vencida
    expect(trafficLight(inDays(1), now)).toBe("AMBER");
    expect(trafficLight(inDays(3), now)).toBe("AMBER");
    expect(trafficLight(inDays(3, 1), now)).toBe("GREEN");
    expect(trafficLight(inDays(20), now)).toBe("GREEN");
  });

  it("días hasta el vencimiento: positivo a futuro, negativo si ya venció", () => {
    expect(daysToDue(inDays(5), now)).toBe(5);
    expect(daysToDue(inDays(0, 3_600_000), now)).toBe(1);
    expect(daysToDue(inDays(-2), now)).toBe(-2);
  });
});
