"use client";

import Link from "next/link";
import { WifiOff, RefreshCw } from "lucide-react";
import { useOffline } from "@/components/offline/offline-provider";
import { es } from "@/lib/i18n/es";

/** Indicador de la barra superior: sin conexión y/o ventas esperando a sincronizarse. No ocupa nada si todo está al día. */
export function SyncBadge() {
  const t = es.offline;
  const { online, counts, syncing } = useOffline();
  const waiting = counts.pending + counts.syncing;
  if (online && waiting === 0 && counts.failed === 0) return null;
  const label = !online
    ? waiting > 0
      ? t.badgeOfflinePending(waiting)
      : t.badgeOffline
    : counts.failed > 0
      ? t.badgeFailed(counts.failed)
      : t.badgePending(waiting);
  return (
    <Link
      href="/app/pos"
      data-testid="sync-badge"
      className="inline-flex min-h-10 items-center gap-2 rounded-full border border-warning/40 bg-warning/10 px-3 text-sm text-warning outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      {online ? (
        <RefreshCw
          className={syncing ? "size-4 animate-spin motion-reduce:animate-none" : "size-4"}
          aria-hidden
        />
      ) : (
        <WifiOff className="size-4" aria-hidden />
      )}
      <span className="hidden sm:inline">{label}</span>
      <span className="sr-only sm:hidden">{label}</span>
    </Link>
  );
}
