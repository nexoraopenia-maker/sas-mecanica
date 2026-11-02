import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret, maskSecret, secretHint } from "@/lib/security/crypto";

const key = randomBytes(32).toString("base64");

describe("AES-256-GCM", () => {
  it("cifra y descifra", () => {
    const encrypted = encryptSecret("sk-proj-abcdef1234", key, "tenant:1:openai");
    expect(encrypted.startsWith("v1:")).toBe(true);
    expect(encrypted).not.toContain("sk-proj");
    expect(decryptSecret(encrypted, key, "tenant:1:openai")).toBe("sk-proj-abcdef1234");
  });

  it("usa IV aleatorio: dos cifrados del mismo texto difieren", () => {
    expect(encryptSecret("x", key, "c")).not.toBe(encryptSecret("x", key, "c"));
  });

  it("falla con otra clave, otro contexto (otro tenant) o datos alterados", () => {
    const encrypted = encryptSecret("secreto", key, "tenant:1:openai");
    expect(() =>
      decryptSecret(encrypted, randomBytes(32).toString("base64"), "tenant:1:openai"),
    ).toThrow();
    expect(() => decryptSecret(encrypted, key, "tenant:2:openai")).toThrow();
    const parts = encrypted.split(":");
    parts[3] = Buffer.from("alterado").toString("base64");
    expect(() => decryptSecret(parts.join(":"), key, "tenant:1:openai")).toThrow();
    expect(() => decryptSecret("basura", key, "tenant:1:openai")).toThrow(/Formato/);
  });

  it("exige una clave de 32 bytes", () => {
    expect(() => encryptSecret("x", Buffer.from("corta").toString("base64"), "c")).toThrow(
      /32 bytes/,
    );
  });

  it("enmascara mostrando solo los últimos 4", () => {
    expect(maskSecret("sk-proj-abcdef1234")).toBe("••••••••1234");
    expect(secretHint("sk-proj-abcdef1234")).toBe("1234");
  });
});
