import { Prisma, type TenantTx } from "@/lib/db";

const clean = (value: string): string => new Prisma.Decimal(value).toString();

export interface StockDiscrepancy {
  scope: "balance" | "lot";
  warehouseId: string;
  productId: string;
  lotId: string | null;
  balance: string;
  ledger: string;
}

/**
 * Verifica que saldo = suma de movimientos, por producto/almacén y por lote.
 * Cualquier diferencia indica manipulación fuera del kardex (o un bug) y es crítica.
 */
export async function reconcileStock(tx: TenantTx): Promise<StockDiscrepancy[]> {
  const balances = await tx.$queryRaw<
    Array<{ warehouseId: string; productId: string; balance: string; ledger: string }>
  >`
    SELECT COALESCE(b."warehouseId", k."warehouseId") AS "warehouseId", COALESCE(b."productId", k."productId") AS "productId",
           COALESCE(b.quantity, 0)::text AS balance, COALESCE(k.total, 0)::text AS ledger
    FROM stock_balances b
    FULL OUTER JOIN (
      SELECT "warehouseId", "productId", SUM("quantityDelta") AS total
      FROM kardex_movements WHERE "tenantId" = app_current_tenant() GROUP BY 1, 2
    ) k ON k."warehouseId" = b."warehouseId" AND k."productId" = b."productId"
    WHERE COALESCE(b.quantity, 0) <> COALESCE(k.total, 0)`;
  const lots = await tx.$queryRaw<
    Array<{
      warehouseId: string;
      productId: string;
      lotId: string;
      balance: string;
      ledger: string;
    }>
  >`
    SELECT COALESCE(b."warehouseId", k."warehouseId") AS "warehouseId", COALESCE(b."productId", k."productId") AS "productId",
           COALESCE(b."lotId", k."lotId") AS "lotId", COALESCE(b.quantity, 0)::text AS balance, COALESCE(k.total, 0)::text AS ledger
    FROM stock_lot_balances b
    FULL OUTER JOIN (
      SELECT "warehouseId", "productId", "lotId", SUM("quantityDelta") AS total
      FROM kardex_movements WHERE "tenantId" = app_current_tenant() AND "lotId" IS NOT NULL GROUP BY 1, 2, 3
    ) k ON k."warehouseId" = b."warehouseId" AND k."lotId" = b."lotId"
    WHERE COALESCE(b.quantity, 0) <> COALESCE(k.total, 0)`;
  return [
    ...balances.map((row): StockDiscrepancy => ({
      scope: "balance",
      ...row,
      lotId: null,
      balance: clean(row.balance),
      ledger: clean(row.ledger),
    })),
    ...lots.map((row): StockDiscrepancy => ({
      scope: "lot",
      ...row,
      balance: clean(row.balance),
      ledger: clean(row.ledger),
    })),
  ];
}

/** Ejecuta la conciliación y deja una notificación CRÍTICA (una por día) si encuentra diferencias. */
export async function reconcileAndNotify(
  tx: TenantTx,
  now: Date = new Date(),
): Promise<StockDiscrepancy[]> {
  const discrepancies = await reconcileStock(tx);
  if (discrepancies.length > 0) {
    await tx.notification.createMany({
      data: [
        {
          kind: "stock.reconciliation",
          severity: "CRITICAL",
          title: `Conciliación de stock: ${discrepancies.length} diferencia(s)`,
          body: "El saldo no coincide con la suma del kardex. Revisa la auditoría de inventario.",
          data: { discrepancies: discrepancies.slice(0, 20).map((d) => ({ ...d })) },
          dedupeKey: `reconciliation:${now.toISOString().slice(0, 10)}`,
        },
      ],
      skipDuplicates: true,
    });
  }
  return discrepancies;
}
