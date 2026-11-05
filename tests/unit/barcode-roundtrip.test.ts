import {
  BarcodeFormat,
  BinaryBitmap,
  DecodeHintType,
  HybridBinarizer,
  MultiFormatReader,
  RGBLuminanceSource,
} from "@zxing/library";
import { describe, expect, it } from "vitest";
import { barcodeModules, internalEan13 } from "@/lib/barcode";

/** Rasteriza los módulos (zona de silencio incluida) y los lee con ZXing, el motor del escáner del POS. */
function decode(value: string): { text: string; format: BarcodeFormat } {
  const { modules } = barcodeModules(value);
  const quiet = 10;
  const scale = 4;
  const width = (modules.length + quiet * 2) * scale;
  const height = 120;
  const pixels = new Uint8ClampedArray(width * height).fill(255);
  modules.forEach((module, index) => {
    if (module !== 1) return;
    for (let y = 0; y < height; y += 1)
      for (let x = 0; x < scale; x += 1) pixels[y * width + (index + quiet) * scale + x] = 0;
  });
  const reader = new MultiFormatReader();
  reader.setHints(
    new Map<DecodeHintType, unknown>([
      [DecodeHintType.POSSIBLE_FORMATS, [BarcodeFormat.EAN_13, BarcodeFormat.CODE_128]],
      [DecodeHintType.TRY_HARDER, true],
    ]),
  );
  const result = reader.decode(
    new BinaryBitmap(new HybridBinarizer(new RGBLuminanceSource(pixels, width, height))),
  );
  return { text: result.getText(), format: result.getBarcodeFormat() };
}

describe("los códigos generados se pueden escanear", () => {
  it.each([
    "7750001112228",
    "5901234123457",
    "4006381333931",
    internalEan13(1),
    internalEan13(48_213),
  ])("EAN-13 %s", (code) => {
    expect(decode(code)).toEqual({ text: code, format: BarcodeFormat.EAN_13 });
  });

  it.each(["FIL-ACE-001", "PAS-FRE_014", "llanta 205/55 R16", "A"])("Code 128 «%s»", (code) => {
    expect(decode(code)).toEqual({ text: code, format: BarcodeFormat.CODE_128 });
  });
});
