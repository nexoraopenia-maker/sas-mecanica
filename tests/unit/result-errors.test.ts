import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  InsufficientStockError,
  PermissionDeniedError,
  PlanLimitError,
  toDomainError,
} from "@/lib/errors";
import { buildLogger } from "@/lib/logger";
import { toResult } from "@/lib/result";

describe("Result y errores de dominio", () => {
  it("devuelve ok con los datos", async () => {
    expect(await toResult(async () => 42)).toEqual({ ok: true, data: 42 });
  });

  it("convierte errores de dominio en { ok: false }", async () => {
    expect(
      await toResult(async () => Promise.reject(new PermissionDeniedError("ventas:anular_venta"))),
    ).toEqual({
      ok: false,
      error: { code: "PERMISSION_DENIED", message: expect.stringContaining("ventas:anular_venta") },
    });
    const limit = await toResult(async () => Promise.reject(new PlanLimitError("usuarios", 3)));
    expect(limit).toMatchObject({ ok: false, error: { code: "PLAN_LIMIT" } });
  });

  it("relanza errores desconocidos (no se esconden bugs)", async () => {
    await expect(toResult(async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
  });

  it("traduce el error del trigger de stock", () => {
    const mapped = toDomainError(new Error("ERROR: insufficient_stock: producto x"));
    expect(mapped).toBeInstanceOf(InsufficientStockError);
  });
});

describe("logger estructurado", () => {
  it("incluye tenantId/requestId y censura secretos", () => {
    const lines: string[] = [];
    const sink = new Writable({
      write(chunk: Buffer, _enc, cb) {
        lines.push(chunk.toString());
        cb();
      },
    });
    const log = buildLogger(sink, "info").child({ tenantId: "t-1", requestId: "r-1" });
    log.info(
      { settings: { openaiApiKey: "sk-secreto", apiKey: "otro" }, password: "123456" },
      "config guardada",
    );
    const entry = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
    expect(entry).toMatchObject({ tenantId: "t-1", requestId: "r-1", msg: "config guardada" });
    expect(lines[0]).not.toContain("sk-secreto");
    expect(lines[0]).not.toContain("123456");
    expect(lines[0]).toContain("[REDACTED]");
  });
});
