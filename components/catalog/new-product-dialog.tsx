"use client";

import { Plus, X } from "lucide-react";
import { useRef } from "react";
import { ProductForm } from "@/components/forms/product-form";
import { Button, type ButtonProps } from "@/components/ui/button";
import { es } from "@/lib/i18n/es";

/** Botón «Nuevo producto» que abre el formulario completo en una ventana modal (`<dialog>` nativo). */
export function NewProductDialog({
  canSeeCost,
  variant,
  label = es.catalog.newProduct,
}: {
  canSeeCost: boolean;
  variant?: ButtonProps["variant"];
  label?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  return (
    <>
      <Button type="button" variant={variant} onClick={() => ref.current?.showModal()}>
        <Plus className="size-4" aria-hidden /> {label}
      </Button>
      <dialog
        ref={ref}
        aria-labelledby="new-product-title"
        className="m-auto max-h-[92dvh] w-[min(56rem,calc(100vw-1.5rem))] overflow-y-auto rounded-xl border border-border bg-card p-5 text-foreground backdrop:bg-background/80"
        onClick={(event) => {
          if (event.target === ref.current) ref.current?.close();
        }}
      >
        <div className="mb-4 flex items-center justify-between gap-3">
          <h2 id="new-product-title" className="text-lg font-semibold">
            {es.catalog.newProduct}
          </h2>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={es.catalog.closeDialog}
            onClick={() => ref.current?.close()}
          >
            <X className="size-5" aria-hidden />
          </Button>
        </div>
        <ProductForm canSeeCost={canSeeCost} />
      </dialog>
    </>
  );
}
