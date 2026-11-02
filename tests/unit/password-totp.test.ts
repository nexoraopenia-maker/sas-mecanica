import { describe, expect, it } from "vitest";
import { hashPassword, passwordSchema, verifyPassword } from "@/lib/auth/password";
import { generateToken, hashToken } from "@/lib/auth/secure-token";
import {
  base32Decode,
  base32Encode,
  generateTotpSecret,
  otpauthUri,
  totpCode,
  verifyTotp,
} from "@/lib/auth/totp";

describe("contraseñas (scrypt)", () => {
  it("hashea con sal y verifica", async () => {
    const hash = await hashPassword("Clave-Segura-2026");
    expect(hash.startsWith("scrypt$")).toBe(true);
    expect(hash).not.toContain("Clave-Segura");
    expect(await verifyPassword("Clave-Segura-2026", hash)).toBe(true);
    expect(await verifyPassword("clave-segura-2026", hash)).toBe(false);
    expect(await hashPassword("Clave-Segura-2026")).not.toBe(hash);
  });

  it("rechaza hashes mal formados sin lanzar", async () => {
    expect(await verifyPassword("x", "basura")).toBe(false);
    expect(await verifyPassword("x", "bcrypt$1$2$3$4$5")).toBe(false);
  });

  it("aplica la política de contraseñas", () => {
    expect(passwordSchema.safeParse("corta1").success).toBe(false);
    expect(passwordSchema.safeParse("sololetrasaqui").success).toBe(false);
    expect(passwordSchema.safeParse("1234567890123").success).toBe(false);
    expect(passwordSchema.safeParse("Taller2026Seguro").success).toBe(true);
  });
});

describe("tokens de un solo uso", () => {
  it("el hash no revela el token y es determinista", () => {
    const { token, hash } = generateToken();
    expect(hash).toBe(hashToken(token));
    expect(hash).not.toContain(token);
    expect(generateToken().token).not.toBe(token);
  });
});

describe("TOTP (RFC 6238)", () => {
  // Vector de prueba del RFC 6238 (SHA-1, secreto ASCII "12345678901234567890").
  const rfcSecret = base32Encode(Buffer.from("12345678901234567890"));

  it("coincide con los vectores del RFC", () => {
    expect(totpCode(rfcSecret, 59_000)).toBe("287082");
    expect(totpCode(rfcSecret, 1_111_111_109_000)).toBe("081804");
    expect(totpCode(rfcSecret, 2_000_000_000_000)).toBe("279037");
  });

  it("base32 hace ida y vuelta", () => {
    const secret = generateTotpSecret();
    expect(base32Encode(base32Decode(secret))).toBe(secret);
    expect(() => base32Decode("1!?")).toThrow();
  });

  it("acepta ±1 paso y rechaza el resto", () => {
    const now = 1_700_000_000_000;
    const code = totpCode(rfcSecret, now);
    expect(verifyTotp(rfcSecret, code, now)).toBe(true);
    expect(verifyTotp(rfcSecret, code, now + 30_000)).toBe(true);
    expect(verifyTotp(rfcSecret, code, now - 30_000)).toBe(true);
    expect(verifyTotp(rfcSecret, code, now + 90_000)).toBe(false);
    expect(verifyTotp(rfcSecret, "12345", now)).toBe(false);
    expect(verifyTotp(rfcSecret, "abcdef", now)).toBe(false);
  });

  it("arma el URI para apps autenticadoras", () => {
    const uri = otpauthUri("Mecania", "root@saas.pe", "ABC234");
    expect(uri).toContain("otpauth://totp/Mecania%3Aroot%40saas.pe");
    expect(uri).toContain("secret=ABC234");
  });
});
