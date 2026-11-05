"use client";

import { Store } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { switchBranchAction } from "@/app/actions/tenant";
import { es } from "@/lib/i18n/es";

export interface BranchContext {
  active: { id: string; name: string } | null;
  branches: Array<{ id: string; name: string }>;
  canSwitch: boolean;
}

/** Sucursal de trabajo en la barra superior: quien puede, cambia de sede; los demás ven la suya. */
export function BranchSwitcher({ context }: { context: BranchContext }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  if (!context.active || context.branches.length < 2) return null;
  const t = es.branches;

  if (!context.canSwitch)
    return (
      <span
        className="hidden items-center gap-2 text-sm text-muted-foreground sm:inline-flex"
        data-testid="branch-chip"
      >
        <Store className="size-4" aria-hidden />
        {context.active.name}
      </span>
    );

  return (
    <div className="flex items-center gap-2" data-testid="branch-switcher">
      <Store className="hidden size-4 text-muted-foreground sm:block" aria-hidden />
      <select
        aria-label={t.switchLabel}
        value={context.active.id}
        disabled={pending}
        onChange={(event) => {
          const data = new FormData();
          data.set("branchId", event.target.value);
          setError(null);
          startTransition(async () => {
            const result = await switchBranchAction({}, data);
            if (result.error) setError(result.error);
            else router.refresh();
          });
        }}
        className="h-10 max-w-40 rounded-lg border border-border bg-input px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring sm:max-w-56"
      >
        {context.branches.map((branch) => (
          <option key={branch.id} value={branch.id}>
            {branch.name}
          </option>
        ))}
      </select>
      {error ? (
        <span role="alert" className="max-w-52 text-xs text-danger">
          {error}
        </span>
      ) : null}
    </div>
  );
}
