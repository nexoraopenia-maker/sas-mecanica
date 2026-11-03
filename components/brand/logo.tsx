import Image from "next/image";
import { es } from "@/lib/i18n/es";
import { cn } from "@/lib/utils";

/** Dimensiones reales de `public/aima-logo.png` (PNG con transparencia, < 100 KB). */
const LOGO_WIDTH = 1536;
const LOGO_HEIGHT = 480;

/** Logo AIMA Automatizaciones: se funde con cualquier fondo, también sobre vidrio. */
export function Logo({
  className,
  priority = false,
  sizes = "(max-width: 448px) 100vw, 384px",
}: {
  className?: string;
  priority?: boolean;
  sizes?: string;
}) {
  return (
    <Image
      src="/aima-logo.png"
      alt={es.app.logoAlt}
      width={LOGO_WIDTH}
      height={LOGO_HEIGHT}
      priority={priority}
      sizes={sizes}
      className={cn("h-auto w-full", className)}
    />
  );
}
