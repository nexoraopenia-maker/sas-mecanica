import { sniffImage, type ImageType } from "@/lib/workshop/image";

/** Límites del logo del taller: PNG, JPG o WebP (nunca SVG, que puede llevar scripts). */
export const LOGO_MAX_BYTES = 1_048_576;
export const LOGO_MIN_SIDE = 64;
export const LOGO_MAX_SIDE = 2048;
export const LOGO_MAX_ASPECT = 6;

export interface LogoInfo {
  type: ImageType;
  width: number;
  height: number;
}

const u16be = (b: Uint8Array, i: number) => ((b[i] ?? 0) << 8) | (b[i + 1] ?? 0);
const u32be = (b: Uint8Array, i: number) => u16be(b, i) * 65536 + u16be(b, i + 2);
const u16le = (b: Uint8Array, i: number) => (b[i] ?? 0) | ((b[i + 1] ?? 0) << 8);
const u24le = (b: Uint8Array, i: number) => u16le(b, i) | ((b[i + 2] ?? 0) << 16);

/** Alto y ancho leídos de la cabecera (sin decodificar la imagen). Null si la cabecera es inválida. */
export function imageDimensions(
  bytes: Uint8Array,
  type: ImageType,
): { width: number; height: number } | null {
  if (type === "image/png") {
    if (bytes.length < 24 || u32be(bytes, 8) !== 13) return null;
    return { width: u32be(bytes, 16), height: u32be(bytes, 20) };
  }
  if (type === "image/jpeg") {
    let i = 2;
    while (i + 9 < bytes.length) {
      if (bytes[i] !== 0xff) {
        i += 1;
        continue;
      }
      const marker = bytes[i + 1] ?? 0;
      if (marker === 0xff) {
        i += 1;
        continue;
      }
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        i += 2;
        continue;
      }
      const length = u16be(bytes, i + 2);
      const isFrame = marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
      if (isFrame) return { height: u16be(bytes, i + 5), width: u16be(bytes, i + 7) };
      if (length < 2) return null;
      i += 2 + length;
    }
    return null;
  }
  const chunk = String.fromCharCode(...bytes.slice(12, 16));
  if (chunk === "VP8 " && bytes.length >= 30)
    return { width: u16le(bytes, 26) & 0x3fff, height: u16le(bytes, 28) & 0x3fff };
  if (chunk === "VP8L" && bytes.length >= 25) {
    const bits = u16le(bytes, 21) | (u16le(bytes, 23) << 16);
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  if (chunk === "VP8X" && bytes.length >= 30)
    return { width: u24le(bytes, 24) + 1, height: u24le(bytes, 27) + 1 };
  return null;
}

/** Valida tipo real (por bytes), peso y dimensiones. Devuelve un mensaje claro en español si no sirve. */
export function checkLogo(
  bytes: Uint8Array,
): { ok: true; info: LogoInfo } | { ok: false; error: string } {
  if (bytes.length === 0) return { ok: false, error: "Elige una imagen para el logo" };
  if (bytes.length > LOGO_MAX_BYTES)
    return { ok: false, error: "El logo pesa más de 1 MB. Reduce su tamaño e inténtalo de nuevo" };
  const type = sniffImage(bytes);
  if (!type) return { ok: false, error: "El logo debe ser PNG, JPG o WebP (no se admite SVG)" };
  const size = imageDimensions(bytes, type);
  if (!size || size.width <= 0 || size.height <= 0)
    return { ok: false, error: "No se pudo leer la imagen: el archivo parece dañado" };
  if (size.width < LOGO_MIN_SIDE || size.height < LOGO_MIN_SIDE)
    return {
      ok: false,
      error: `El logo es muy pequeño: mínimo ${LOGO_MIN_SIDE} × ${LOGO_MIN_SIDE} px`,
    };
  if (size.width > LOGO_MAX_SIDE || size.height > LOGO_MAX_SIDE)
    return {
      ok: false,
      error: `El logo es muy grande: máximo ${LOGO_MAX_SIDE} × ${LOGO_MAX_SIDE} px`,
    };
  if (Math.max(size.width / size.height, size.height / size.width) > LOGO_MAX_ASPECT)
    return { ok: false, error: "Las proporciones del logo son demasiado alargadas" };
  return { ok: true, info: { type, ...size } };
}
