/**
 * Genera el «video» que Chromium usa como cámara falsa en las pruebas del escáner: un EAN-13 nítido (MJPEG).
 *   node scripts/generate-scan-fixture.mjs [código de 12 o 13 dígitos]
 * Usa `sharp` (ya instalado con Next.js). El resultado va a tests/fixtures/ean13.mjpeg.
 */
import { writeFileSync } from "node:fs";
import sharp from "sharp";

const L = [
  "0001101",
  "0011001",
  "0010011",
  "0111101",
  "0100011",
  "0110001",
  "0101111",
  "0111011",
  "0110111",
  "0001011",
];
const G = [
  "0100111",
  "0110011",
  "0011011",
  "0100001",
  "0011101",
  "0111001",
  "0000101",
  "0010001",
  "0001001",
  "0010111",
];
const R = [
  "1110010",
  "1100110",
  "1101100",
  "1000010",
  "1011100",
  "1001110",
  "1010000",
  "1000100",
  "1001000",
  "1110100",
];
const PARITY = [
  "LLLLLL",
  "LLGLGG",
  "LLGGLG",
  "LLGGGL",
  "LGLLGG",
  "LGGLLG",
  "LGGGLL",
  "LGLGLG",
  "LGLGGL",
  "LGGLGL",
];

function withCheckDigit(code) {
  const digits = code.slice(0, 12).split("").map(Number);
  const sum = digits.reduce((acc, d, i) => acc + d * (i % 2 === 0 ? 1 : 3), 0);
  return code.slice(0, 12) + String((10 - (sum % 10)) % 10);
}

export function ean13Modules(code13) {
  const d = code13.split("").map(Number);
  const parity = PARITY[d[0]];
  let bits = "101";
  for (let i = 0; i < 6; i += 1) bits += (parity[i] === "L" ? L : G)[d[i + 1]];
  bits += "01010";
  for (let i = 0; i < 6; i += 1) bits += R[d[i + 7]];
  return bits + "101";
}

const code = withCheckDigit((process.argv[2] ?? "775000111222").padStart(12, "0"));
const bits = ean13Modules(code);
const barWidth = 5;
const left = Math.round((640 - bits.length * barWidth) / 2);
const bars = [...bits]
  .map((bit, i) =>
    bit === "1"
      ? `<rect x="${left + i * barWidth}" y="110" width="${barWidth}" height="230" fill="black"/>`
      : "",
  )
  .join("");
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="480"><rect width="640" height="480" fill="white"/>${bars}<text x="320" y="390" font-size="34" font-family="monospace" text-anchor="middle">${code}</text></svg>`;
const frame = await sharp(Buffer.from(svg)).jpeg({ quality: 70 }).toBuffer();
// Chromium repite el archivo en bucle: unos cuantos cuadros iguales bastan.
writeFileSync("tests/fixtures/ean13.mjpeg", Buffer.concat(Array.from({ length: 3 }, () => frame)));
console.log(`EAN-13 ${code} → tests/fixtures/ean13.mjpeg (${frame.length * 30} bytes)`);
