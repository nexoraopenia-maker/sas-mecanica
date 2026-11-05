import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildZip, crc32 } from "@/lib/ple/zip";

describe("ZIP de los libros PLE", () => {
  it("CRC-32 con el vector estándar", () => {
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
    expect(crc32(new Uint8Array())).toBe(0);
  });

  it("estructura válida: cabeceras, directorio central y fin de archivo", () => {
    const zip = buildZip([
      { name: "LE20100070970202603001401000011.TXT", data: Buffer.from("a|b|\r\n", "latin1") },
      { name: "LE20100070970202603000801000011.TXT", data: Buffer.from("") },
    ]);
    expect(zip.readUInt32LE(0)).toBe(0x04034b50);
    const end = zip.length - 22;
    expect(zip.readUInt32LE(end)).toBe(0x06054b50);
    expect(zip.readUInt16LE(end + 10)).toBe(2); // entradas
    const centralOffset = zip.readUInt32LE(end + 16);
    expect(zip.readUInt32LE(centralOffset)).toBe(0x02014b50);
  });

  it("rechaza nombres con rutas o caracteres raros", () => {
    for (const name of ["../x.txt", "a/b.txt", "ñ.txt", "a b.txt"])
      expect(() => buildZip([{ name, data: new Uint8Array([1]) }])).toThrow(/no válido/);
  });

  it("un descompresor real lo abre y los bytes coinciden", () => {
    const dir = mkdtempSync(join(tmpdir(), "ple-zip-"));
    const file = join(dir, "libros.zip");
    const sales = Buffer.from("20260300|1|M1|15/03/2026|\r\n", "latin1");
    writeFileSync(
      file,
      buildZip([
        { name: "ventas.txt", data: sales },
        { name: "compras.txt", data: Buffer.from("x") },
      ]),
    );
    try {
      const test = execFileSync("unzip", ["-t", file], { encoding: "utf8" });
      expect(test).toContain("No errors detected");
      const extracted = execFileSync("unzip", ["-p", file, "ventas.txt"]);
      expect(Buffer.compare(extracted, sales)).toBe(0);
    } catch (error) {
      // Sin `unzip` en el equipo no se puede comprobar con un descompresor externo.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      expect(readFileSync(file).length).toBeGreaterThan(0);
    }
  });
});
