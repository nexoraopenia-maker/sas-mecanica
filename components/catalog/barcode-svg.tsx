import { barcodePath } from "@/lib/barcode";

/** Código de barras escaneable: siempre negro sobre blanco, con zona de silencio (no usa colores del tema). */
export function BarcodeSvg({
  value,
  height = 40,
  className,
}: {
  value: string;
  height?: number;
  className?: string;
}) {
  const { width, d } = barcodePath(value, height);
  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      role="img"
      aria-label={`Código de barras ${value}`}
      shapeRendering="crispEdges"
      className={className}
    >
      <rect width={width} height={height} style={{ fill: "var(--paper)" }} />
      <path d={d} style={{ fill: "var(--ink)" }} />
    </svg>
  );
}
