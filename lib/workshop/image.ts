export type ImageType = "image/jpeg" | "image/png" | "image/webp";

export const MAX_PHOTO_BYTES = 5 * 1024 * 1024;
export const MAX_SIGNATURE_BYTES = 300 * 1024;

/**
 * Detecta el tipo REAL por los primeros bytes (no confía en la extensión ni en el Content-Type
 * que declara el cliente): evita subir HTML/SVG/ejecutables disfrazados de imagen.
 */
export function sniffImage(bytes: Uint8Array): ImageType | null {
  const b = bytes;
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (
    b.length >= 8 &&
    b[0] === 0x89 &&
    b[1] === 0x50 &&
    b[2] === 0x4e &&
    b[3] === 0x47 &&
    b[4] === 0x0d &&
    b[5] === 0x0a &&
    b[6] === 0x1a &&
    b[7] === 0x0a
  )
    return "image/png";
  if (
    b.length >= 12 &&
    b[0] === 0x52 &&
    b[1] === 0x49 &&
    b[2] === 0x46 &&
    b[3] === 0x46 &&
    b[8] === 0x57 &&
    b[9] === 0x45 &&
    b[10] === 0x42 &&
    b[11] === 0x50
  )
    return "image/webp";
  return null;
}

export const EXTENSION: Record<ImageType, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

/** Decodifica `data:image/png;base64,...` (firma manuscrita tomada en pantalla). Solo PNG. */
export function parseSignatureDataUrl(dataUrl: string): Uint8Array | null {
  const match = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (!match?.[1]) return null;
  const bytes = new Uint8Array(Buffer.from(match[1], "base64"));
  if (bytes.length === 0 || bytes.length > MAX_SIGNATURE_BYTES) return null;
  return sniffImage(bytes) === "image/png" ? bytes : null;
}
