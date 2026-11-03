/**
 * Genera los íconos de la PWA a partir de public/aima-logo.png (logo con transparencia).
 * Uso (una sola vez, o al cambiar el logo):  node scripts/generate-pwa-icons.mjs
 * Usa `sharp`, que ya viene instalado junto con Next.js (optimización de imágenes); no es una dependencia nueva.
 */
import sharp from "sharp";

const BACKGROUND = "#050508"; // fondo de la marca
const logo = await sharp("public/aima-logo.png").trim().toBuffer();

async function icon(size, ratio, file) {
  const inner = Math.round(size * ratio);
  const mark = await sharp(logo).resize({ width: inner, height: inner, fit: "inside" }).toBuffer();
  await sharp({ create: { width: size, height: size, channels: 4, background: BACKGROUND } })
    .composite([{ input: mark, gravity: "center" }])
    .png({ compressionLevel: 9 })
    .toFile(`public/icons/${file}`);
}

await icon(192, 0.8, "icon-192.png");
await icon(512, 0.8, "icon-512.png");
// «Maskable»: el sistema recorta hasta un 20 % por lado, así que el logo ocupa solo la zona segura central.
await icon(512, 0.56, "maskable-512.png");
await icon(180, 0.8, "apple-touch-icon.png");
