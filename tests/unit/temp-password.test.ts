import { describe, expect, it } from "vitest";
import { passwordSchema } from "@/lib/auth/password";
import { generateTempPassword } from "@/lib/auth/temp-password";

describe("contraseña temporal", () => {
  it("cumple siempre la política (10+ caracteres con letras y números)", () => {
    for (let i = 0; i < 300; i += 1) {
      const password = generateTempPassword();
      expect(passwordSchema.safeParse(password).success, password).toBe(true);
      expect(password).toHaveLength(14);
      expect(password).toMatch(/[A-Z]/);
      expect(password).toMatch(/[a-z]/);
      expect(password).toMatch(/\d/);
    }
  });
  it("evita caracteres que se confunden al dictarlos (0 O 1 l I)", () => {
    for (let i = 0; i < 300; i += 1) expect(generateTempPassword()).not.toMatch(/[0O1lI]/);
  });
  it("es distinta cada vez", () => {
    expect(new Set(Array.from({ length: 200 }, () => generateTempPassword())).size).toBe(200);
  });
  it("admite otra longitud mínima", () => {
    expect(generateTempPassword(20)).toHaveLength(20);
  });
});
