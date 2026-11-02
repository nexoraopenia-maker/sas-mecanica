import { randomBytes, randomUUID } from "node:crypto";
import { SignJWT } from "jose";
import { beforeAll, describe, expect, it } from "vitest";
import { signSession, verifySession } from "@/lib/auth/token";

describe("cookie de sesión (JWT HS256)", () => {
  beforeAll(() => {
    process.env.DATABASE_URL = "postgresql://a:b@localhost:5432/x";
    process.env.ADMIN_DATABASE_URL = "postgresql://a:b@localhost:5432/x";
    process.env.ENCRYPTION_KEY = randomBytes(32).toString("base64");
    process.env.SESSION_SECRET = randomBytes(32).toString("base64url");
    process.env.APP_URL = "http://localhost:3000";
  });

  const claims = () => ({ sub: randomUUID(), tid: randomUUID(), sv: 3, mfa: true });

  it("firma y verifica las claims, sin permisos dentro del token", async () => {
    const original = claims();
    const token = await signSession(original);
    expect(await verifySession(token)).toMatchObject(original);
    const payload = JSON.parse(
      Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8"),
    ) as Record<string, unknown>;
    expect(Object.keys(payload).sort()).toEqual(["exp", "iat", "mfa", "sub", "sv", "tid"]);
  });

  it("rechaza token vacío, alterado, expirado o firmado con otro secreto", async () => {
    const token = await signSession(claims());
    expect(await verifySession(undefined)).toBeNull();
    expect(await verifySession("")).toBeNull();
    expect(await verifySession(`${token}x`)).toBeNull();
    expect(await verifySession(await signSession(claims(), -10))).toBeNull();
    const forged = await new SignJWT({ ...claims() })
      .setProtectedHeader({ alg: "HS256" })
      .setExpirationTime("1h")
      .sign(new TextEncoder().encode("otro-secreto-distinto-de-32-caracteres-xx"));
    expect(await verifySession(forged)).toBeNull();
  });

  it("rechaza algoritmo none y claims con forma inválida", async () => {
    const none = `${Buffer.from('{"alg":"none"}').toString("base64url")}.${Buffer.from(JSON.stringify({ ...claims(), exp: 9_999_999_999 })).toString("base64url")}.`;
    expect(await verifySession(none)).toBeNull();
    const bad = await new SignJWT({ sub: "no-uuid", tid: null, sv: "x", mfa: 1 })
      .setProtectedHeader({ alg: "HS256" })
      .setExpirationTime("1h")
      .sign(new TextEncoder().encode(process.env.SESSION_SECRET ?? ""));
    expect(await verifySession(bad)).toBeNull();
  });

  it("el SuperAdmin sin tenant y la impersonación viajan en las claims", async () => {
    const imp = randomUUID();
    const token = await signSession({ sub: randomUUID(), tid: null, sv: 1, mfa: false });
    expect(await verifySession(token)).toMatchObject({ tid: null, mfa: false });
    const withImp = await signSession({ ...claims(), imp });
    expect(await verifySession(withImp)).toMatchObject({ imp });
  });
});
