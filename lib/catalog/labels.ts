import { z } from "zod";

/** Formatos de etiqueta para impresoras térmicas (rollos continuos con corte por etiqueta). */
export const LABEL_FORMATS = {
  "50x25": { widthMm: 50, heightMm: 25, label: "50 × 25 mm", barHeight: 34 },
  "40x30": { widthMm: 40, heightMm: 30, label: "40 × 30 mm", barHeight: 36 },
  "60x40": { widthMm: 60, heightMm: 40, label: "60 × 40 mm", barHeight: 48 },
} as const;
export type LabelFormatId = keyof typeof LABEL_FORMATS;
export const LABEL_FORMAT_IDS = Object.keys(LABEL_FORMATS) as LabelFormatId[];
export const MAX_LABEL_COPIES = 50;
/** Tope de etiquetas por impresión (productos × copias): evita páginas gigantes por error. */
export const MAX_LABELS_PER_JOB = 500;

const one = (value: unknown) => (Array.isArray(value) ? value : value === undefined ? [] : [value]);

/** Parámetros de la pantalla de etiquetas (ids repetidos o separados por coma). */
export const labelParamsSchema = z.object({
  ids: z
    .preprocess(
      (value) =>
        one(value)
          .flatMap((item) => String(item).split(","))
          .map((item) => item.trim())
          .filter(Boolean),
      z.array(z.uuid()).max(200),
    )
    .default([]),
  copies: z.coerce.number().int().min(1).max(MAX_LABEL_COPIES).catch(1),
  format: z.enum(LABEL_FORMAT_IDS as [LabelFormatId, ...LabelFormatId[]]).catch("50x25"),
});
export type LabelParams = z.output<typeof labelParamsSchema>;

/** Expande productos × copias respetando el tope por impresión. */
export function expandLabels<T>(items: readonly T[], copies: number): T[] {
  const out: T[] = [];
  for (const item of items)
    for (let i = 0; i < copies && out.length < MAX_LABELS_PER_JOB; i += 1) out.push(item);
  return out;
}

/** Nombre recortado para que quepa en la etiqueta sin desbordar. */
export function labelName(name: string, max = 34): string {
  const clean = name.replace(/\s+/g, " ").trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 1).trimEnd()}…`;
}
