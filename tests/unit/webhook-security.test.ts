import { describe, expect, it } from "vitest";
import { assertPublicHost, assertPublicUrl, isPrivateIp, UnsafeUrlError } from "@/lib/security/net";
import {
  signWebhook,
  verifyWebhook,
  WEBHOOK_TOLERANCE_SECONDS,
} from "@/lib/security/webhook-signature";

const secret = "s3cr3t-compartido-con-n8n";
const body = JSON.stringify({ externalId: "m-1", from: "+51987000001", text: "Hola" });
const now = 1_760_000_000_000;
const ts = String(Math.floor(now / 1000));

describe("firma de webhooks", () => {
  it("acepta una firma válida y fresca (segundos o milisegundos)", () => {
    expect(
      verifyWebhook({
        secret,
        timestamp: ts,
        signature: signWebhook(secret, ts, body),
        rawBody: body,
        nowMs: now,
      }),
    ).toBe("ok");
    const ms = String(now);
    expect(
      verifyWebhook({
        secret,
        timestamp: ms,
        signature: signWebhook(secret, ms, body),
        rawBody: body,
        nowMs: now,
      }),
    ).toBe("ok");
  });

  it("rechaza cuerpo alterado, secreto incorrecto y formato raro", () => {
    const signature = signWebhook(secret, ts, body);
    expect(
      verifyWebhook({ secret, timestamp: ts, signature, rawBody: body + " ", nowMs: now }),
    ).toBe("invalid");
    expect(
      verifyWebhook({ secret: "otro", timestamp: ts, signature, rawBody: body, nowMs: now }),
    ).toBe("invalid");
    expect(
      verifyWebhook({ secret, timestamp: ts, signature: "sha256=zzzz", rawBody: body, nowMs: now }),
    ).toBe("invalid");
    expect(
      verifyWebhook({
        secret,
        timestamp: ts,
        signature: signature.replace("sha256=", ""),
        rawBody: body,
        nowMs: now,
      }),
    ).toBe("invalid");
    expect(verifyWebhook({ secret, timestamp: "abc", signature, rawBody: body, nowMs: now })).toBe(
      "invalid",
    );
  });

  it("exige firma y timestamp", () => {
    expect(
      verifyWebhook({ secret, timestamp: null, signature: "sha256=x", rawBody: body, nowMs: now }),
    ).toBe("missing");
    expect(
      verifyWebhook({ secret, timestamp: ts, signature: null, rawBody: body, nowMs: now }),
    ).toBe("missing");
  });

  it("anti-replay: rechaza mensajes viejos o del futuro lejano", () => {
    const old = String(Math.floor(now / 1000) - WEBHOOK_TOLERANCE_SECONDS - 5);
    expect(
      verifyWebhook({
        secret,
        timestamp: old,
        signature: signWebhook(secret, old, body),
        rawBody: body,
        nowMs: now,
      }),
    ).toBe("stale");
    const future = String(Math.floor(now / 1000) + WEBHOOK_TOLERANCE_SECONDS + 5);
    expect(
      verifyWebhook({
        secret,
        timestamp: future,
        signature: signWebhook(secret, future, body),
        rawBody: body,
        nowMs: now,
      }),
    ).toBe("stale");
    const edge = String(Math.floor(now / 1000) - WEBHOOK_TOLERANCE_SECONDS + 5);
    expect(
      verifyWebhook({
        secret,
        timestamp: edge,
        signature: signWebhook(secret, edge, body),
        rawBody: body,
        nowMs: now,
      }),
    ).toBe("ok");
  });

  it("el timestamp está firmado: no se puede reutilizar un cuerpo viejo con un timestamp nuevo", () => {
    const oldTs = String(Math.floor(now / 1000) - 3600);
    const signature = signWebhook(secret, oldTs, body);
    expect(verifyWebhook({ secret, timestamp: ts, signature, rawBody: body, nowMs: now })).toBe(
      "invalid",
    );
  });
});

describe("protección SSRF", () => {
  it.each([
    "127.0.0.1",
    "10.1.2.3",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.10",
    "169.254.169.254",
    "100.64.0.1",
    "0.0.0.0",
    "224.0.0.1",
    "::1",
    "::",
    "fc00::1",
    "fd12::1",
    "fe80::1",
    "::ffff:10.0.0.1",
    "no-es-ip",
  ])("%s es privada o no válida", (ip) => {
    expect(isPrivateIp(ip)).toBe(true);
  });

  it.each(["8.8.8.8", "172.32.0.1", "172.15.255.255", "1.1.1.1", "2606:4700:4700::1111"])(
    "%s es pública",
    (ip) => {
      expect(isPrivateIp(ip)).toBe(false);
    },
  );

  const publicResolver = async () => ["93.184.216.34"];

  it("solo HTTPS, sin credenciales, con destino público", async () => {
    await expect(
      assertPublicUrl("https://hooks.ejemplo.com/wa", publicResolver),
    ).resolves.toBeInstanceOf(URL);
    await expect(assertPublicUrl("http://hooks.ejemplo.com/wa", publicResolver)).rejects.toThrow(
      /HTTPS/,
    );
    await expect(
      assertPublicUrl("https://user:pw@hooks.ejemplo.com/", publicResolver),
    ).rejects.toThrow(/credenciales/);
    await expect(assertPublicUrl("ftp://x.com", publicResolver)).rejects.toBeInstanceOf(
      UnsafeUrlError,
    );
    await expect(assertPublicUrl("no es url", publicResolver)).rejects.toBeInstanceOf(
      UnsafeUrlError,
    );
  });

  it("bloquea IP literales internas y hosts que resuelven a redes privadas (incluido DNS rebinding parcial)", async () => {
    await expect(assertPublicUrl("https://127.0.0.1/hook", publicResolver)).rejects.toThrow(
      /privada/,
    );
    await expect(assertPublicUrl("https://[::1]/hook", publicResolver)).rejects.toThrow(/privada/);
    await expect(
      assertPublicUrl("https://169.254.169.254/latest/meta-data", publicResolver),
    ).rejects.toThrow(/privada/);
    await expect(
      assertPublicUrl("https://interno.ejemplo.com/", async () => ["10.0.0.5"]),
    ).rejects.toThrow(/privada/);
    // Si UNA de las direcciones es privada se rechaza todo.
    await expect(
      assertPublicUrl("https://mixto.ejemplo.com/", async () => ["93.184.216.34", "192.168.0.9"]),
    ).rejects.toThrow(/privada/);
    await expect(assertPublicUrl("https://no-existe.ejemplo.com/", async () => [])).rejects.toThrow(
      /resolver/,
    );
    await expect(
      assertPublicHost("smtp.interno", async () => ["127.0.0.1"]),
    ).rejects.toBeInstanceOf(UnsafeUrlError);
  });
});
