"use client";

import { useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";

/**
 * Lienzo para que el cliente firme con el dedo o el lápiz. La firma viaja como PNG en un campo
 * oculto (`name`); si el lienzo está vacío el campo queda vacío y el servidor lo rechaza.
 */
export function SignaturePad({
  name,
  label,
  clearLabel,
}: {
  name: string;
  label: string;
  clearLabel: string;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const drawing = useRef(false);

  useEffect(() => {
    const el = canvas.current;
    const ctx = el?.getContext("2d");
    if (!el || !ctx) return;
    ctx.lineWidth = 2.5;
    ctx.lineCap = "round";
    ctx.strokeStyle = "#111827";
    const point = (event: PointerEvent) => {
      const rect = el.getBoundingClientRect();
      return {
        x: ((event.clientX - rect.left) * el.width) / rect.width,
        y: ((event.clientY - rect.top) * el.height) / rect.height,
      };
    };
    const down = (event: PointerEvent) => {
      drawing.current = true;
      el.setPointerCapture(event.pointerId);
      const { x, y } = point(event);
      ctx.beginPath();
      ctx.moveTo(x, y);
    };
    const move = (event: PointerEvent) => {
      if (!drawing.current) return;
      const { x, y } = point(event);
      ctx.lineTo(x, y);
      ctx.stroke();
    };
    const up = () => {
      if (!drawing.current) return;
      drawing.current = false;
      if (input.current) input.current.value = el.toDataURL("image/png");
    };
    el.addEventListener("pointerdown", down);
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
    return () => {
      el.removeEventListener("pointerdown", down);
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
    };
  }, []);

  function clear() {
    const el = canvas.current;
    el?.getContext("2d")?.clearRect(0, 0, el.width, el.height);
    if (input.current) input.current.value = "";
  }

  return (
    <div className="space-y-2">
      <p className="text-sm font-medium">{label}</p>
      <canvas
        ref={canvas}
        width={600}
        height={200}
        className="h-40 w-full touch-none rounded-lg border border-border bg-white"
        data-testid="signature-canvas"
        aria-label={label}
      />
      <input ref={input} type="hidden" name={name} defaultValue="" />
      <Button type="button" variant="outline" size="sm" onClick={clear}>
        {clearLabel}
      </Button>
    </div>
  );
}
