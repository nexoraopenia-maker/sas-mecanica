/** Imágenes mínimas pero con cabeceras válidas, para probar la validación del logo sin decodificar píxeles. */

export function png(width: number, height: number, extra = 0): Uint8Array {
  const b = Buffer.alloc(33 + extra);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write("IHDR", 12, "ascii");
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  b[24] = 8;
  b[25] = 6;
  return new Uint8Array(b);
}

export function jpeg(width: number, height: number): Uint8Array {
  const b = Buffer.alloc(40);
  Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]).copy(b, 0); // SOI + APP0 (longitud 16)
  b.write("JFIF", 6, "ascii");
  Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08]).copy(b, 20); // SOF0
  b.writeUInt16BE(height, 25);
  b.writeUInt16BE(width, 27);
  return new Uint8Array(b);
}

export function webpLossy(width: number, height: number): Uint8Array {
  const b = Buffer.alloc(40);
  b.write("RIFF", 0, "ascii");
  b.write("WEBP", 8, "ascii");
  b.write("VP8 ", 12, "ascii");
  b.writeUInt16LE(width & 0x3fff, 26);
  b.writeUInt16LE(height & 0x3fff, 28);
  return new Uint8Array(b);
}

export function webpExtended(width: number, height: number): Uint8Array {
  const b = Buffer.alloc(40);
  b.write("RIFF", 0, "ascii");
  b.write("WEBP", 8, "ascii");
  b.write("VP8X", 12, "ascii");
  b.writeUIntLE(width - 1, 24, 3);
  b.writeUIntLE(height - 1, 27, 3);
  return new Uint8Array(b);
}

export const SVG = new TextEncoder().encode(
  '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><script>alert(1)</script></svg>',
);
