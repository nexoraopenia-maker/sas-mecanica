import { STOCK_LIGHT_LABEL, type StockIndicator } from "@/lib/catalog/stock-light";
import { cn } from "@/lib/utils";

const FILL = { GREEN: "bg-success", AMBER: "bg-warning", RED: "bg-danger" } as const;
const TEXT = { GREEN: "text-success", AMBER: "text-warning", RED: "text-danger" } as const;

/**
 * Semáforo de stock: texto + barra (el color nunca es lo único que informa). Sin punto de
 * reposición no se dibuja la barra.
 */
export function StockBar({
  info,
  unit,
  testId,
}: {
  info: StockIndicator & { quantity: number; reorderPoint: number };
  unit: string;
  testId?: string;
}) {
  const { light, bar, mark, quantity, reorderPoint } = info;
  return (
    <div className="space-y-1" data-testid={testId} data-light={light}>
      <div className="flex items-baseline justify-between gap-2 text-sm">
        <span className={cn("font-medium", TEXT[light])}>{STOCK_LIGHT_LABEL[light]}</span>
        <span className="text-muted-foreground">
          {quantity} {unit}
          {reorderPoint > 0 ? ` · repos. ${reorderPoint}` : ""}
        </span>
      </div>
      {bar !== null ? (
        <div
          role="meter"
          aria-label={STOCK_LIGHT_LABEL[light]}
          aria-valuemin={0}
          aria-valuemax={reorderPoint * 2}
          aria-valuenow={Math.min(Math.max(quantity, 0), reorderPoint * 2)}
          className="relative h-2 overflow-hidden rounded-full bg-muted"
        >
          <div
            className={cn("h-full rounded-full", FILL[light])}
            style={{ width: `${bar * 100}%` }}
          />
          {mark !== null ? (
            <span
              aria-hidden
              className="absolute inset-y-0 w-px bg-foreground/60"
              style={{ left: `${mark * 100}%` }}
            />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
