import { describe, expect, it } from "vitest";
import {
  expandLabels,
  LABEL_FORMATS,
  labelName,
  labelParamsSchema,
  MAX_LABELS_PER_JOB,
} from "@/lib/catalog/labels";

const id = "0190a1c2-0000-7000-8000-000000000001";
const id2 = "0190a1c2-0000-7000-8000-000000000002";

describe("parámetros de etiquetas", () => {
  it("acepta ids repetidos o separados por coma", () => {
    expect(labelParamsSchema.parse({ ids: [id, id2] }).ids).toEqual([id, id2]);
    expect(labelParamsSchema.parse({ ids: `${id},${id2}` }).ids).toEqual([id, id2]);
    expect(labelParamsSchema.parse({}).ids).toEqual([]);
  });

  it("usa valores seguros ante copias o formato inválidos", () => {
    const parsed = labelParamsSchema.parse({ ids: id, copies: "999", format: "99x99" });
    expect(parsed.copies).toBe(1);
    expect(parsed.format).toBe("50x25");
    expect(labelParamsSchema.parse({ ids: id, copies: "3", format: "40x30" })).toMatchObject({
      copies: 3,
      format: "40x30",
    });
  });

  it("rechaza ids que no son UUID", () => {
    expect(labelParamsSchema.safeParse({ ids: "no-es-uuid" }).success).toBe(false);
  });

  it("incluye el formato térmico 50x25", () => {
    expect(LABEL_FORMATS["50x25"]).toMatchObject({ widthMm: 50, heightMm: 25 });
  });
});

describe("expansión y nombre", () => {
  it("repite cada producto por sus copias respetando el tope", () => {
    expect(expandLabels(["a", "b"], 2)).toEqual(["a", "a", "b", "b"]);
    const many = expandLabels(
      Array.from({ length: 200 }, (_v, i) => i),
      50,
    );
    expect(many).toHaveLength(MAX_LABELS_PER_JOB);
  });

  it("recorta nombres largos sin cortar a la mitad de un espacio", () => {
    expect(labelName("Filtro  de aceite")).toBe("Filtro de aceite");
    const long = labelName("Llanta Michelin Primacy 4 205/55 R16 91V reforzada");
    expect(long.length).toBeLessThanOrEqual(34);
    expect(long.endsWith("…")).toBe(true);
  });
});
