import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const VERSION = "v1";
const IV_BYTES = 12;
const KEY_BYTES = 32;

function loadKey(base64Key: string): Buffer {
  const key = Buffer.from(base64Key, "base64");
  if (key.length !== KEY_BYTES) {
    throw new Error("La clave de cifrado debe ser de 32 bytes (base64)");
  }
  return key;
}

/**
 * Cifra con AES-256-GCM. Formato: `v1:<iv>:<tag>:<ciphertext>` (base64).
 * `context` (p. ej. `tenant:<id>:openai`) se autentica como AAD: un texto
 * cifrado no puede copiarse a otro tenant o campo sin que el descifrado falle.
 */
export function encryptSecret(plaintext: string, base64Key: string, context: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", loadKey(base64Key), iv);
  cipher.setAAD(Buffer.from(context, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    VERSION,
    iv.toString("base64"),
    tag.toString("base64"),
    ciphertext.toString("base64"),
  ].join(":");
}

export function decryptSecret(payload: string, base64Key: string, context: string): string {
  const [version, iv, tag, ciphertext] = payload.split(":");
  if (version !== VERSION || !iv || !tag || !ciphertext) {
    throw new Error("Formato de secreto cifrado no válido");
  }
  const decipher = createDecipheriv("aes-256-gcm", loadKey(base64Key), Buffer.from(iv, "base64"));
  decipher.setAAD(Buffer.from(context, "utf8"));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(ciphertext, "base64")),
    decipher.final(),
  ]);
  return plaintext.toString("utf8");
}

/** Muestra solo los últimos 4 caracteres: `••••••••abcd`. */
export function maskSecret(plaintext: string): string {
  const tail = plaintext.slice(-4);
  return `${"•".repeat(8)}${tail}`;
}

/** Los últimos 4 caracteres se guardan en claro (columna `*Hint`) para poder mostrar el valor enmascarado sin descifrar. */
export function secretHint(plaintext: string): string {
  return plaintext.slice(-4);
}
