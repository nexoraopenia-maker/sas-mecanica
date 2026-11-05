"use client";

import { Printer } from "lucide-react";
import { Button } from "@/components/ui/button";

export function PrintButton({ label }: { label: string }) {
  return (
    <Button type="button" onClick={() => window.print()} data-testid="print-labels">
      <Printer className="size-4" aria-hidden /> {label}
    </Button>
  );
}
