import { describe, expect, it } from "vitest";
import { salesWhatsappUrl } from "@/lib/sales-whatsapp";

describe("salesWhatsappUrl", () => {
  it("arma el enlace con el mensaje y el nombre del taller codificados", () => {
    const url = salesWhatsappUrl("+51 987-654-321", "Taller Ñandú & Hijos");
    expect(url).toBe(
      `https://wa.me/51987654321?text=${encodeURIComponent("Hola, quiero activar el plan para mi taller (cuenta demo: Taller Ñandú & Hijos)")}`,
    );
  });
  it("acepta solo dígitos y paréntesis", () => {
    expect(salesWhatsappUrl("(51) 987654321", "X")).toContain("wa.me/51987654321?");
  });
  it.each([undefined, "", "abc", "123", "+51 98", "5198765432109876"])(
    "sin número válido (%j) devuelve null para caer a /app/subscription",
    (value) => {
      expect(salesWhatsappUrl(value, "X")).toBeNull();
    },
  );
  it("un nombre vacío no rompe el mensaje", () => {
    expect(decodeURIComponent(salesWhatsappUrl("51987654321", "  ") ?? "")).toContain(
      "cuenta demo: sin nombre",
    );
  });
});
