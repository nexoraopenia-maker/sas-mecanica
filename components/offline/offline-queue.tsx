"use client";

import Link from "next/link";
import { useOffline } from "@/components/offline/offline-provider";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardTitle } from "@/components/ui/card";
import { es } from "@/lib/i18n/es";
import type { OutboxEntry } from "@/lib/offline/outbox";
import { cn } from "@/lib/utils";

const STATUS_STYLE: Record<OutboxEntry["status"], string> = {
  PENDING: "bg-warning/15 text-warning",
  SYNCING: "bg-primary/15 text-foreground",
  FAILED: "bg-danger/15 text-danger",
  SYNCED: "bg-success/15 text-success",
};

const time = (iso: string) =>
  new Date(iso).toLocaleString("es-PE", {
    timeZone: "America/Lima",
    dateStyle: "short",
    timeStyle: "short",
  });

/** Ventas guardadas en este dispositivo: pendientes, rechazadas (para revisar) y recién sincronizadas. */
export function OfflineQueue() {
  const t = es.offline;
  const offline = useOffline();
  const visible = offline.entries.filter(
    (entry) => entry.status !== "SYNCED" || offline.entries.length <= 5,
  );
  if (!offline.supported || offline.entries.length === 0) return null;

  return (
    <Card className="space-y-3" data-testid="offline-queue">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <CardTitle className="mb-0">{t.queueTitle}</CardTitle>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={
            !offline.online ||
            offline.syncing ||
            offline.counts.pending + offline.counts.syncing === 0
          }
          onClick={() => void offline.syncNow()}
        >
          {offline.syncing ? t.syncing : t.syncNow}
        </Button>
      </div>
      {offline.authRequired ? (
        <Alert tone="error">
          {t.authRequired}{" "}
          <Link className="text-primary underline" href="/login?next=/app/pos">
            {t.signIn}
          </Link>
        </Alert>
      ) : null}
      {!offline.online ? <Alert tone="info">{t.offlineNote}</Alert> : null}
      <ul className="divide-y divide-border">
        {visible.map((entry) => (
          <li
            key={entry.id}
            className="space-y-1 py-2"
            data-testid="offline-entry"
            data-status={entry.status}
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="font-medium">
                {t.sale} {entry.id.slice(0, 8).toUpperCase()} · S/ {entry.summary.total}
              </p>
              <span className={cn("rounded-full px-3 py-1 text-xs", STATUS_STYLE[entry.status])}>
                {t.status[entry.status]}
              </span>
            </div>
            <p className="text-xs text-muted-foreground">
              {time(entry.occurredAt)} ·{" "}
              {
                es.pos[
                  entry.summary.documentType === "FACTURA"
                    ? "factura"
                    : entry.summary.documentType === "BOLETA"
                      ? "boleta"
                      : "saleNote"
                ]
              }{" "}
              · {entry.summary.items} {t.items}
              {entry.result?.documentNumber ? ` · ${entry.result.documentNumber}` : ""}
            </p>
            {entry.lastError && entry.status !== "SYNCED" ? (
              <p
                className={cn(
                  "text-sm",
                  entry.status === "FAILED" ? "text-danger" : "text-muted-foreground",
                )}
              >
                {entry.lastError}
              </p>
            ) : null}
            {entry.status === "FAILED" ? (
              <div className="flex flex-wrap gap-2 pt-1">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => void offline.retry(entry.id)}
                >
                  {t.retry}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="destructive"
                  onClick={() => {
                    if (window.confirm(t.discardConfirm)) void offline.discard(entry.id);
                  }}
                >
                  {t.discard}
                </Button>
              </div>
            ) : null}
          </li>
        ))}
      </ul>
    </Card>
  );
}
