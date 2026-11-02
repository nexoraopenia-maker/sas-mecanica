"use client";

import {
  startTransition,
  useActionState,
  useEffect,
  useRef,
  type FormEvent,
  type ReactNode,
} from "react";
import { Alert } from "@/components/ui/alert";
import { Button, type ButtonProps } from "@/components/ui/button";
import type { ActionState, FormAction } from "@/lib/action";

interface ActionFormProps {
  action: FormAction;
  submitLabel: string;
  pendingLabel?: string;
  variant?: ButtonProps["variant"];
  size?: ButtonProps["size"];
  className?: string;
  children?: ReactNode;
}

/**
 * Formulario con Server Action: muestra errores/avisos tipados y deshabilita el botón mientras envía.
 *
 * React 19 limpia el formulario tras CUALQUIER acción, también si falló, y en una entrada de
 * mercadería eso haría perder todos los datos por un DOT mal escrito. Por eso se envía con
 * `startTransition` (sin el reseteo automático) y solo se limpia cuando la acción tuvo éxito.
 */
export function ActionForm({
  action,
  submitLabel,
  pendingLabel = "Procesando…",
  variant,
  size,
  className,
  children,
}: ActionFormProps) {
  const [state, formAction, pending] = useActionState<ActionState, FormData>(action, {});
  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    if (state.message && !state.error) formRef.current?.reset();
  }, [state]);

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    startTransition(() => formAction(data));
  }

  return (
    <form ref={formRef} onSubmit={onSubmit} className={className ?? "space-y-4"}>
      {children}
      {state.error ? <Alert tone="error">{state.error}</Alert> : null}
      {state.message ? <Alert tone="success">{state.message}</Alert> : null}
      <Button
        type="submit"
        disabled={pending}
        variant={variant}
        size={size}
        className="w-full sm:w-auto"
      >
        {pending ? pendingLabel : submitLabel}
      </Button>
    </form>
  );
}
