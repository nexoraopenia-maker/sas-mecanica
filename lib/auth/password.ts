import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from "node:crypto";
import { z } from "zod";

const KEY_LENGTH = 64;
const PARAMS = { N: 16_384, r: 8, p: 1 } as const;

function derive(
  password: string,
  salt: Buffer,
  params: ScryptOptions,
  keyLength: number,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password.normalize("NFKC"), salt, keyLength, params, (error, key) =>
      error ? reject(error) : resolve(key),
    );
  });
}

/** Política de contraseñas: 10–128 caracteres con letras y números. */
export const passwordSchema = z
  .string()
  .min(10, "La contraseña debe tener al menos 10 caracteres")
  .max(128, "La contraseña es demasiado larga")
  .regex(/[A-Za-z]/, "La contraseña debe incluir letras")
  .regex(/\d/, "La contraseña debe incluir números");

/** Formato: `scrypt$N$r$p$salt$hash` (base64). Los parámetros viajan con el hash para poder subirlos después. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(password, salt, PARAMS, KEY_LENGTH);
  return [
    "scrypt",
    PARAMS.N,
    PARAMS.r,
    PARAMS.p,
    salt.toString("base64"),
    key.toString("base64"),
  ].join("$");
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, n, r, p, salt, hash] = stored.split("$");
  if (scheme !== "scrypt" || !n || !r || !p || !salt || !hash) return false;
  const expected = Buffer.from(hash, "base64");
  const actual = await derive(
    password,
    Buffer.from(salt, "base64"),
    { N: Number(n), r: Number(r), p: Number(p) },
    expected.length,
  );
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

let dummyHash: Promise<string> | undefined;

/** Verifica contra un hash falso para que "usuario inexistente" tarde lo mismo que "contraseña incorrecta". */
export async function verifyAgainstDummy(password: string): Promise<void> {
  dummyHash ??= hashPassword(randomBytes(12).toString("hex"));
  await verifyPassword(password, await dummyHash);
}
