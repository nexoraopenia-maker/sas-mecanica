import type { DecodeHintType } from "@zxing/library";

/**
 * Motor de lectura de códigos con la cámara. Usa el `BarcodeDetector` nativo del navegador cuando existe
 * (Chrome/Edge/Android: rápido y sin descargar nada) y, si no, ZXing cargado bajo demanda (iPhone/Safari,
 * Firefox): el decodificador solo se descarga la primera vez que alguien abre el escáner.
 */

export type ScanFormat =
  "qr_code" | "ean_13" | "ean_8" | "upc_a" | "upc_e" | "code_128" | "code_39" | "itf";

export const SCAN_FORMATS: readonly ScanFormat[] = [
  "qr_code",
  "ean_13",
  "ean_8",
  "upc_a",
  "upc_e",
  "code_128",
  "code_39",
  "itf",
];

export interface CodeDetector {
  readonly engine: "native" | "zxing";
  /** Códigos leídos en el cuadro actual del video (vacío si no hay ninguno). */
  detect(video: HTMLVideoElement): Promise<string[]>;
}

interface NativeDetector {
  detect(source: CanvasImageSource): Promise<Array<{ rawValue: string }>>;
}
interface NativeDetectorConstructor {
  new (options: { formats: string[] }): NativeDetector;
  getSupportedFormats?: () => Promise<string[]>;
}

async function nativeDetector(): Promise<CodeDetector | null> {
  const Ctor = (globalThis as { BarcodeDetector?: NativeDetectorConstructor }).BarcodeDetector;
  if (!Ctor) return null;
  try {
    const supported = (await Ctor.getSupportedFormats?.()) ?? [...SCAN_FORMATS];
    const formats = SCAN_FORMATS.filter((f) => supported.includes(f));
    if (formats.length === 0) return null;
    const detector = new Ctor({ formats });
    return {
      engine: "native",
      async detect(video) {
        const found = await detector.detect(video);
        return found.map((item) => item.rawValue).filter(Boolean);
      },
    };
  } catch {
    return null;
  }
}

async function zxingDetector(): Promise<CodeDetector> {
  const zx = await import("@zxing/library");
  const reader = new zx.MultiFormatReader();
  const hints = new Map<unknown, unknown>();
  hints.set(zx.DecodeHintType.POSSIBLE_FORMATS, [
    zx.BarcodeFormat.QR_CODE,
    zx.BarcodeFormat.EAN_13,
    zx.BarcodeFormat.EAN_8,
    zx.BarcodeFormat.UPC_A,
    zx.BarcodeFormat.UPC_E,
    zx.BarcodeFormat.CODE_128,
    zx.BarcodeFormat.CODE_39,
    zx.BarcodeFormat.ITF,
  ]);
  hints.set(zx.DecodeHintType.TRY_HARDER, true);
  reader.setHints(hints as Map<DecodeHintType, unknown>);
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d", { willReadFrequently: true });
  return {
    engine: "zxing",
    async detect(video) {
      if (!context || video.videoWidth === 0) return [];
      // Se reduce el cuadro (máx. 960 px de ancho): decodificar menos píxeles es mucho más rápido en un celular.
      const scale = Math.min(1, 960 / video.videoWidth);
      canvas.width = Math.round(video.videoWidth * scale);
      canvas.height = Math.round(video.videoHeight * scale);
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
      const luminance = new Uint8ClampedArray(canvas.width * canvas.height);
      for (let i = 0, p = 0; i < data.length; i += 4, p += 1)
        luminance[p] =
          ((data[i] ?? 0) * 77 + (data[i + 1] ?? 0) * 151 + (data[i + 2] ?? 0) * 28) >> 8;
      const source = new zx.RGBLuminanceSource(luminance, canvas.width, canvas.height);
      try {
        return [reader.decode(new zx.BinaryBitmap(new zx.HybridBinarizer(source))).getText()];
      } catch {
        return []; // NotFoundException: no hay código en este cuadro
      }
    },
  };
}

export async function createDetector(): Promise<CodeDetector> {
  return (await nativeDetector()) ?? (await zxingDetector());
}
