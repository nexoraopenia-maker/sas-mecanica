/**
 * Enlace de WhatsApp del equipo comercial para "Activar plan" en cuentas demo.
 * El número viene de NEXT_PUBLIC_SALES_WHATSAPP (con código de país, p. ej. +51 987 654 321).
 * Devuelve null si no está definido o no parece un número válido: el botón cae a /app/subscription.
 */
export function salesWhatsappUrl(rawNumber: string | undefined, tenantName: string): string | null {
  const digits = (rawNumber ?? "").replace(/[\s().-]/g, "").replace(/^\+/, "");
  if (!/^\d{8,15}$/.test(digits)) return null;
  const name = tenantName.trim() || "sin nombre";
  const message = `Hola, quiero activar el plan para mi taller (cuenta demo: ${name})`;
  return `https://wa.me/${digits}?text=${encodeURIComponent(message)}`;
}
