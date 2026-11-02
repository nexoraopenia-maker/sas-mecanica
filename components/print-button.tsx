"use client";

import { Button } from "@/components/ui/button";

/** Abre el diálogo de impresión del navegador (ticket térmico o «Guardar como PDF»). */
export function PrintButton({ label }: { label: string }) {
  return (
    <Button type="button" className="mb-3 print:hidden" onClick={() => window.print()}>
      {label}
    </Button>
  );
}
