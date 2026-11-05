"use client";

import { useId, useState } from "react";
import { Label, Select } from "@/components/ui/input";
import type { AppModule } from "@/lib/db/enums";
import {
  BUSINESS_PRESETS,
  BUSINESS_TYPE_LABEL,
  LOCKED_MODULES,
  MODULE_GROUPS,
  MODULE_LABEL,
  type BusinessType,
} from "@/lib/modules";
import { cn } from "@/lib/utils";

export interface PickerPlan {
  code: string;
  name: string;
  included: AppModule[];
}

const offeredBy = (plan: PickerPlan | undefined, groupId: string): boolean => {
  const group = MODULE_GROUPS.find((g) => g.id === groupId);
  return Boolean(plan && group?.modules.some((m) => plan.included.includes(m)));
};

/**
 * Rubro + casillas de módulos. Al elegir el rubro se marcan las casillas habituales de ese negocio (se pueden
 * ajustar una a una). Las casillas que el plan no incluye aparecen bloqueadas: para activarlas se cambia el plan.
 * Envía `businessType` y un campo `group` por casilla marcada (y `planCode` si se elige el plan aquí).
 */
export function ModulePicker({
  plans,
  planCode,
  selectablePlan = false,
  businessType,
  activeGroups,
}: {
  plans: PickerPlan[];
  planCode: string;
  /** Muestra el selector de plan (alta de cuentas); en la ficha del cliente el plan es fijo. */
  selectablePlan?: boolean;
  businessType: BusinessType;
  activeGroups: string[];
}) {
  const id = useId();
  const [plan, setPlan] = useState(planCode);
  const [rubro, setRubro] = useState<BusinessType>(businessType);
  const [checked, setChecked] = useState<Set<string>>(new Set(activeGroups));
  const current = plans.find((p) => p.code === plan);

  const apply = (type: BusinessType, forPlan: PickerPlan | undefined) =>
    new Set(BUSINESS_PRESETS[type].filter((groupId) => offeredBy(forPlan, groupId)));

  return (
    <div className="space-y-4" data-testid="module-picker">
      <div className="grid gap-3 sm:grid-cols-2">
        {selectablePlan ? (
          <div>
            <Label htmlFor={`${id}-plan`}>Plan</Label>
            <Select
              id={`${id}-plan`}
              name="planCode"
              value={plan}
              onChange={(event) => {
                const next = event.target.value;
                setPlan(next);
                const nextPlan = plans.find((p) => p.code === next);
                setChecked(
                  (prev) => new Set([...prev].filter((groupId) => offeredBy(nextPlan, groupId))),
                );
              }}
            >
              {plans.map((p) => (
                <option key={p.code} value={p.code}>
                  {p.name}
                </option>
              ))}
            </Select>
          </div>
        ) : null}
        <div>
          <Label htmlFor={`${id}-rubro`}>Rubro del negocio</Label>
          <Select
            id={`${id}-rubro`}
            name="businessType"
            value={rubro}
            onChange={(event) => {
              const next = event.target.value as BusinessType;
              setRubro(next);
              setChecked(apply(next, current));
            }}
          >
            {(Object.keys(BUSINESS_TYPE_LABEL) as BusinessType[]).map((type) => (
              <option key={type} value={type}>
                {BUSINESS_TYPE_LABEL[type]}
              </option>
            ))}
          </Select>
        </div>
      </div>

      <fieldset className="grid gap-2 sm:grid-cols-2">
        <legend className="mb-2 text-sm font-medium">Rubros y módulos activos</legend>
        {MODULE_GROUPS.map((group) => {
          const offered = offeredBy(current, group.id);
          const on = offered && checked.has(group.id);
          return (
            <label
              key={group.id}
              className={cn(
                "flex min-h-14 items-start gap-3 rounded-lg border p-3 transition-colors",
                on ? "border-primary/50 bg-primary/10" : "border-border",
                offered ? "cursor-pointer" : "cursor-not-allowed opacity-60",
              )}
              data-testid={`module-${group.id}`}
            >
              <input
                type="checkbox"
                name="group"
                value={group.id}
                checked={on}
                disabled={!offered}
                className="mt-1 size-5"
                onChange={(event) =>
                  setChecked((prev) => {
                    const next = new Set(prev);
                    if (event.target.checked) next.add(group.id);
                    else next.delete(group.id);
                    return next;
                  })
                }
              />
              <span>
                <span className="block font-medium">{group.label}</span>
                <span className="block text-xs text-muted-foreground">
                  {offered
                    ? group.description
                    : `No incluido en el plan ${current?.name ?? ""}: cambia el plan para activarlo`}
                </span>
              </span>
            </label>
          );
        })}
      </fieldset>
      <p className="text-xs text-muted-foreground">
        Siempre activos: {LOCKED_MODULES.map((m) => MODULE_LABEL[m]).join(", ")}.
      </p>
    </div>
  );
}
