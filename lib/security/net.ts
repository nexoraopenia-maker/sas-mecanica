import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

/** IPv4/IPv6 privadas, de loopback, link-local, CGNAT o reservadas: destinos prohibidos (SSRF). */
export function isPrivateIp(address: string): boolean {
  const version = isIP(address);
  if (version === 4) {
    const [a = 0, b = 0] = address.split(".").map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    );
  }
  if (version === 6) {
    const lower = address.toLowerCase();
    if (lower === "::" || lower === "::1") return true;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
    if (mapped?.[1]) return isPrivateIp(mapped[1]);
    return (
      lower.startsWith("fc") ||
      lower.startsWith("fd") ||
      lower.startsWith("fe8") ||
      lower.startsWith("fe9") ||
      lower.startsWith("fea") ||
      lower.startsWith("feb") ||
      lower.startsWith("ff")
    );
  }
  return true; // lo que no es una IP válida se trata como no seguro
}

export type Resolver = (hostname: string) => Promise<string[]>;

export const defaultResolver: Resolver = async (hostname) =>
  (await lookup(hostname, { all: true })).map((entry) => entry.address);

export class UnsafeUrlError extends Error {
  constructor(reason: string) {
    super(`Destino no permitido: ${reason}`);
    this.name = "UnsafeUrlError";
  }
}

/** Solo HTTPS, sin credenciales en la URL y con TODAS las IPs resueltas públicas. */
export async function assertPublicUrl(
  raw: string,
  resolve: Resolver = defaultResolver,
): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UnsafeUrlError("URL inválida");
  }
  if (url.protocol !== "https:") throw new UnsafeUrlError("debe usar HTTPS");
  if (url.username || url.password)
    throw new UnsafeUrlError("no se permiten credenciales en la URL");
  await assertPublicHost(url.hostname.replace(/^\[|\]$/g, ""), resolve);
  return url;
}

export async function assertPublicHost(
  hostname: string,
  resolve: Resolver = defaultResolver,
): Promise<void> {
  const addresses = isIP(hostname) ? [hostname] : await resolve(hostname).catch(() => []);
  if (addresses.length === 0) throw new UnsafeUrlError("no se pudo resolver el servidor");
  if (addresses.some(isPrivateIp)) throw new UnsafeUrlError("apunta a una red privada o interna");
}
