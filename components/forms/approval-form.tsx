"use client";

import { startTransition, useActionState, useState } from "react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import type { ActionState, FormAction } from "@/lib/action";
import { computeTotals } from "@/lib/workshop/totals";

interface Item {
  id: string;
  type: "LABOR" | "PART";
  description: string;
  quantity: string;
  unitPrice: string;
  unitPriceLabel: string;
  discount: string;
  taxed: boolean;
}

/** Presupuesto público: el cliente desmarca lo que no quiere y aprueba el resto, o lo rechaza todo. */
export function ApprovalForm({
  action,
  token,
  items,
  taxRate,
  labels,
}: {
  action: FormAction;
  token: string;
  items: Item[];
  taxRate: number;
  labels: { include: string; yourName: string; approve: string; reject: string; total: string };
}) {
  const [state, formAction, pending] = useActionState<ActionState, FormData>(action, {});
  const [included, setIncluded] = useState<Set<string>>(
    () => new Set(items.map((item) => item.id)),
  );
  const totals = computeTotals(
    items.map((item) => ({
      quantity: Number(item.quantity),
      unitPrice: Number(item.unitPrice),
      discount: Number(item.discount),
      taxable: item.taxed,
      approvalStatus: included.has(item.id) ? ("PENDING" as const) : ("REJECTED" as const),
      returned: false,
    })),
    taxRate,
  );

  function submit(decision: "APPROVE" | "REJECT", form: HTMLFormElement) {
    const data = new FormData(form);
    data.set("decision", decision);
    data.set("token", token);
    for (const item of items) if (!included.has(item.id)) data.append("rejected", item.id);
    startTransition(() => formAction(data));
  }

  if (state.message && !state.error) return <Alert tone="success">{state.message}</Alert>;

  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        submit("APPROVE", event.currentTarget);
      }}
    >
      <ul className="divide-y divide-border rounded-xl border border-border">
        {items.map((item) => (
          <li key={item.id} className="p-3">
            <label className="flex items-start gap-3">
              <input
                type="checkbox"
                className="mt-1 size-5"
                checked={included.has(item.id)}
                aria-label={`${labels.include}: ${item.description}`}
                onChange={(event) =>
                  setIncluded((current) => {
                    const next = new Set(current);
                    if (event.target.checked) next.add(item.id);
                    else next.delete(item.id);
                    return next;
                  })
                }
              />
              <span className="flex-1">
                {item.description}
                <span className="block text-sm text-muted-foreground">
                  {item.quantity} × {item.unitPriceLabel}
                </span>
              </span>
            </label>
          </li>
        ))}
      </ul>
      <p className="text-right text-lg font-semibold" data-testid="approval-total">
        {labels.total}: S/ {totals.total.toFixed(2)}
      </p>
      <div>
        <Label htmlFor="approver">{labels.yourName}</Label>
        <Input
          id="approver"
          name="name"
          required
          minLength={3}
          maxLength={120}
          autoComplete="name"
        />
      </div>
      {state.error ? <Alert tone="error">{state.error}</Alert> : null}
      <div className="flex flex-col gap-2 sm:flex-row">
        <Button type="submit" disabled={pending || included.size === 0}>
          {pending ? "Enviando…" : labels.approve}
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={pending}
          onClick={(event) => {
            const form = event.currentTarget.form;
            if (form && form.reportValidity()) submit("REJECT", form);
          }}
        >
          {labels.reject}
        </Button>
      </div>
    </form>
  );
}
