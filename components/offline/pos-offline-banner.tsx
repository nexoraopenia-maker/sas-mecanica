"use client";

import { useOffline } from "@/components/offline/offline-provider";
import { Alert } from "@/components/ui/alert";
import { es } from "@/lib/i18n/es";

/** Aviso fijo del mostrador cuando no hay conexión, o cuando todavía no hay catálogo guardado para vender sin ella. */
export function PosOfflineBanner() {
  const { online, catalog, supported } = useOffline();
  if (!online)
    return (
      <Alert tone="info" data-testid="pos-offline-banner">
        {es.offline.banner}
        {!catalog ? ` ${es.offline.noSnapshot}` : ""}
      </Alert>
    );
  if (supported && !catalog) return null;
  return null;
}
