/**
 * Enlace de WhatsApp del equipo comercial para "Activar plan" en cuentas demo.
 * El número viene de NEXT_PUBLIC_SALES_WHATSAPP (con código de país, p. ej. +51 987 654 321).
 * Devuelve null si no está definido o no parece un número válido: el botón cae a /app/configuracion?tab=plan.
 */
export function salesWhatsappUrl(rawNumber: string | undefined, tenantName: string): string | null {
  const name = tenantName.trim() || "sin nombre";
  return whatsappLink(
    rawNumber,
    `Hola, quiero activar el plan para mi taller (cuenta demo: ${name})`,
  );
}

/** Mismo número, para pedir un cambio de plan desde Configuración → Plan. */
export function planChangeWhatsappUrl(
  rawNumber: string | undefined,
  tenantName: string,
  currentPlan: string,
): string | null {
  const name = tenantName.trim() || "sin nombre";
  return whatsappLink(
    rawNumber,
    `Hola, quiero cambiar el plan de mi taller (${name}, plan actual: ${currentPlan})`,
  );
}

function whatsappLink(rawNumber: string | undefined, message: string): string | null {
  const digits = (rawNumber ?? "").replace(/[\s().-]/g, "").replace(/^\+/, "");
  if (!/^\d{8,15}$/.test(digits)) return null;
  return `https://wa.me/${digits}?text=${encodeURIComponent(message)}`;
}
