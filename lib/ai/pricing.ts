/**
 * Costo ESTIMADO de una llamada a la API (USD por millón de tokens). Son tarifas de
 * referencia para controlar el gasto; la factura real de OpenAI manda. Los modelos
 * son configurables por tenant: uno desconocido usa la tarifa de respaldo (la más alta).
 */
export interface ModelPrice {
  inputPerMillion: number;
  outputPerMillion: number;
}

export const MODEL_PRICING: Record<string, ModelPrice> = {
  "gpt-4o-mini": { inputPerMillion: 0.15, outputPerMillion: 0.6 },
  "gpt-4o": { inputPerMillion: 2.5, outputPerMillion: 10 },
  "gpt-4.1-mini": { inputPerMillion: 0.4, outputPerMillion: 1.6 },
  "gpt-4.1": { inputPerMillion: 2, outputPerMillion: 8 },
};

export const FALLBACK_PRICE: ModelPrice = { inputPerMillion: 2.5, outputPerMillion: 10 };

export function estimateCostUsd(
  model: string,
  promptTokens: number,
  completionTokens: number,
): number {
  const price = MODEL_PRICING[model] ?? FALLBACK_PRICE;
  const cost =
    (promptTokens * price.inputPerMillion + completionTokens * price.outputPerMillion) / 1_000_000;
  return Math.round(cost * 1_000_000) / 1_000_000;
}
