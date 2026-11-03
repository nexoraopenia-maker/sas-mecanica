import * as React from "react";
import { cn } from "@/lib/utils";

export function Alert({
  className,
  tone = "info",
  ...props
}: React.ComponentProps<"div"> & { tone?: "info" | "error" | "success" }) {
  const tones = {
    info: "border-border bg-muted",
    error: "border-danger/40 bg-danger/10 text-danger",
    success: "border-success/30 bg-success/10 text-success",
  } as const;
  return (
    <div
      role={tone === "error" ? "alert" : "status"}
      className={cn("rounded-lg border p-3 text-sm", tones[tone], className)}
      {...props}
    />
  );
}
