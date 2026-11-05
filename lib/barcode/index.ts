/**
 * Códigos de barras 1D en SVG, sin dependencias: EAN-13 y Code 128 (juego B).
 * Cada codificador devuelve los módulos (1 = barra, 0 = espacio) y `barcodeSvg` los dibuja.
 */

const EAN_L = [
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
const EAN_G = [
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
const EAN_R = [
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
/** Paridad (L/G) de los 6 dígitos de la izquierda según el primer dígito. */
const EAN_PARITY = [
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

/** Dígito verificador EAN/UPC de los primeros 12 dígitos. */
export function ean13CheckDigit(first12: string): number {
  if (!/^\d{12}$/.test(first12)) throw new Error("Se esperaban 12 dígitos");
  let sum = 0;
  for (let i = 0; i < 12; i += 1) sum += Number(first12[i]) * (i % 2 === 0 ? 1 : 3);
  return (10 - (sum % 10)) % 10;
}

export function isValidEan13(code: string): boolean {
  return /^\d{13}$/.test(code) && ean13CheckDigit(code.slice(0, 12)) === Number(code[12]);
}

/** Máximo de correlativos que caben en un EAN-13 interno (prefijo 2 + 11 dígitos). */
export const MAX_INTERNAL_EAN_SEQUENCE = 99_999_999_999;

/**
 * EAN-13 de uso interno: el prefijo 2 está reservado por GS1 para códigos de la tienda, así que nunca
 * choca con un código de fábrica. El correlativo es por empresa.
 */
export function internalEan13(sequence: number): string {
  if (!Number.isInteger(sequence) || sequence < 1 || sequence > MAX_INTERNAL_EAN_SEQUENCE)
    throw new Error("Correlativo de código de barras fuera de rango");
  const body = `2${String(sequence).padStart(11, "0")}`;
  return `${body}${ean13CheckDigit(body)}`;
}

export function ean13Modules(code: string): number[] {
  if (!isValidEan13(code)) throw new Error("EAN-13 inválido");
  const parity = EAN_PARITY[Number(code[0])] as string;
  let bits = "101";
  for (let i = 0; i < 6; i += 1) {
    const digit = Number(code[i + 1]);
    bits += (parity[i] === "L" ? EAN_L : EAN_G)[digit];
  }
  bits += "01010";
  for (let i = 7; i < 13; i += 1) bits += EAN_R[Number(code[i])];
  bits += "101";
  return [...bits].map(Number);
}

// Code 128: patrones de 11 módulos (anchos de barra/espacio alternados) para los valores 0–105 y STOP.
const C128 = [
  "212222",
  "222122",
  "222221",
  "121223",
  "121322",
  "131222",
  "122213",
  "122312",
  "132212",
  "221213",
  "221312",
  "231212",
  "112232",
  "122132",
  "122231",
  "113222",
  "123122",
  "123221",
  "223211",
  "221132",
  "221231",
  "213212",
  "223112",
  "312131",
  "311222",
  "321122",
  "321221",
  "312212",
  "322112",
  "322211",
  "212123",
  "212321",
  "232121",
  "111323",
  "131123",
  "131321",
  "112313",
  "132113",
  "132311",
  "211313",
  "231113",
  "231311",
  "112133",
  "112331",
  "132131",
  "113123",
  "113321",
  "133121",
  "313121",
  "211331",
  "231131",
  "213113",
  "213311",
  "213131",
  "311123",
  "311321",
  "331121",
  "312113",
  "312311",
  "332111",
  "314111",
  "221411",
  "431111",
  "111224",
  "111422",
  "121124",
  "121421",
  "141122",
  "141221",
  "112214",
  "112412",
  "122114",
  "122411",
  "142112",
  "142211",
  "241211",
  "221114",
  "413111",
  "241112",
  "134111",
  "111242",
  "121142",
  "121241",
  "114212",
  "124112",
  "124211",
  "411212",
  "421112",
  "421211",
  "212141",
  "214121",
  "412121",
  "111143",
  "111341",
  "131141",
  "114113",
  "114311",
  "411113",
  "411311",
  "113141",
  "114131",
  "311141",
  "411131",
  "211412",
  "211214",
  "211232",
];
const C128_STOP = "2331112";
const START_B = 104;

/** Code 128 juego B: ASCII imprimible (32–126). */
export function isCode128Text(text: string): boolean {
  return text.length > 0 && text.length <= 40 && /^[\x20-\x7e]+$/.test(text);
}

export function code128Modules(text: string): number[] {
  if (!isCode128Text(text)) throw new Error("Texto no soportado por Code 128");
  const values = [START_B, ...[...text].map((ch) => ch.charCodeAt(0) - 32)];
  const checksum =
    values.reduce((acc, value, index) => acc + value * (index === 0 ? 1 : index), 0) % 103;
  values.push(checksum);
  const widths = values.map((value) => C128[value] as string).join("") + C128_STOP;
  const modules: number[] = [];
  [...widths].forEach((width, index) => {
    for (let i = 0; i < Number(width); i += 1) modules.push(index % 2 === 0 ? 1 : 0);
  });
  return modules;
}

export type BarcodeFormat = "EAN13" | "CODE128";

/** EAN-13 si el valor lo es (13 dígitos con verificador correcto); si no, Code 128. */
export function detectFormat(value: string): BarcodeFormat {
  return isValidEan13(value) ? "EAN13" : "CODE128";
}

export function barcodeModules(value: string): { format: BarcodeFormat; modules: number[] } {
  const format = detectFormat(value);
  return { format, modules: format === "EAN13" ? ean13Modules(value) : code128Modules(value) };
}

const QUIET_ZONE = 10;

/** Geometría del código: ancho total (con zona de silencio) y trazado de las barras para un SVG. */
export function barcodePath(
  value: string,
  height = 60,
): { format: BarcodeFormat; width: number; height: number; d: string } {
  const { format, modules } = barcodeModules(value);
  let d = "";
  let index = 0;
  while (index < modules.length) {
    if (modules[index] === 1) {
      let run = 1;
      while (modules[index + run] === 1) run += 1;
      d += `M${index + QUIET_ZONE} 0h${run}v${height}h-${run}z`;
      index += run;
    } else index += 1;
  }
  return { format, width: modules.length + QUIET_ZONE * 2, height, d };
}

/** SVG autónomo en negro sobre blanco (el lector necesita contraste y zona de silencio, sin colores del tema). */
export function barcodeSvg(
  value: string,
  options: { height?: number; label?: string } = {},
): string {
  const { width, height, d } = barcodePath(value, options.height ?? 60);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" role="img" aria-label="${escapeXml(options.label ?? value)}" shape-rendering="crispEdges"><rect width="${width}" height="${height}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
}

function escapeXml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
}
