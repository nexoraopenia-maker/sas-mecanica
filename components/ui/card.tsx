import * as React from "react";
import { cn } from "@/lib/utils";

/** Único contenedor del sistema: vidrio oscuro con borde fino, esquinas redondeadas y halo. */
export function Card({ className, ...props }: React.ComponentProps<"section">) {
  return (
    <section
      className={cn(
        "rounded-xl border border-border bg-card p-5 shadow-glass backdrop-blur-[14px] print:shadow-none print:backdrop-blur-none",
        className,
      )}
      {...props}
    />
  );
}

export function CardTitle({ className, ...props }: React.ComponentProps<"h2">) {
  return <h2 className={cn("mb-3 text-lg font-semibold", className)} {...props} />;
}
