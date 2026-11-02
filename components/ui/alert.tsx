import * as React from "react";
import { cn } from "@/lib/utils";

export function Alert({
  className,
  tone = "info",
  ...props
}: React.ComponentProps<"div"> & { tone?: "info" | "error" | "success" }) {
  const tones = {
    info: "border-border bg-muted",
    error: "border-destructive/40 bg-destructive/10 text-destructive",
    success: "border-green-600/30 bg-green-600/10 text-green-800",
  } as const;
  return (
    <div
      role={tone === "error" ? "alert" : "status"}
      className={cn("rounded-lg border p-3 text-sm", tones[tone], className)}
      {...props}
    />
  );
}
