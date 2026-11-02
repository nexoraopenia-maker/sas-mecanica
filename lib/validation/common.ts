import { z } from "zod";

export const uuidSchema = z.uuid();

/** Cantidad/importe decimal como string (nunca Float) con hasta 4 decimales. */
export const decimalStringSchema = z
  .string()
  .regex(/^-?\d{1,10}(\.\d{1,4})?$/, "Número decimal inválido");
