import { createHash, randomBytes } from "node:crypto";

/** Token aleatorio de un solo uso. Solo el hash SHA-256 se guarda en la BD. */
export function generateToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString("base64url");
  return { token, hash: hashToken(token) };
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
