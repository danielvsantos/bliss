#!/usr/bin/env node
/**
 * Generates the home-screen / manifest icons from the capybara mascot (#155).
 *
 *   pnpm --filter @bliss/web pwa:icons
 *
 * The outputs are committed: the Docker build installs with --ignore-scripts on
 * alpine, where a sharp step is fragile, and the icons only change when the
 * mascot does. Re-run this script and commit the PNGs when the source changes.
 *
 * The source lives in pwa-assets/ (outside public/) so it is never served.
 * favicon.* is deliberately not generated here — the browser-tab icon stays.
 */

import sharp from 'sharp';
import { mkdirSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const SOURCE = resolve(root, 'pwa-assets/icon-source.jpg');

// Square crops in source pixels (the source is 2000×2000).
// HEAD_CROP: face, glasses and ears; the "bliss" name tag is too small to read
// at 180/192 px and is left out.
const HEAD_CROP = { left: 330, top: 240, width: 1480, height: 1480 };
// The source's flat background colour, sampled from its top-left corner.
const SOURCE_BACKGROUND = { r: 105, g: 94, b: 111 };
// MASKABLE: the head does not fit the central 80% safe zone of any crop of the
// 2000 px source, so the canvas is first extended by MASKABLE_PAD on the top
// and left (which are plain background) and then cropped to MASKABLE_CROP.
// Android masks (circle, squircle) then never clip the glasses or the ears.
const MASKABLE_PAD = 300;
const MASKABLE_CROP = { left: 0, top: 0, width: 2300, height: 2300 };

const OUTPUTS = [
  { file: 'public/icons/icon-192.png', size: 192, crop: HEAD_CROP },
  { file: 'public/icons/icon-512.png', size: 512, crop: null },
  { file: 'public/icons/icon-maskable-512.png', size: 512, crop: MASKABLE_CROP, pad: MASKABLE_PAD },
  // iOS ignores transparency and adds its own rounding: keep it opaque.
  { file: 'public/apple-touch-icon.png', size: 180, crop: HEAD_CROP },
];

for (const { file, size, crop, pad } of OUTPUTS) {
  const outputPath = resolve(root, file);
  mkdirSync(dirname(outputPath), { recursive: true });
  let image = sharp(SOURCE);
  if (pad) {
    // extend() and extract() in one pipeline apply in a fixed order, so the
    // padded canvas is materialised first.
    const padded = await image
      .extend({ top: pad, left: pad, background: SOURCE_BACKGROUND })
      .toBuffer();
    image = sharp(padded);
  }
  if (crop) image = image.extract(crop);
  await image
    .resize(size, size, { kernel: 'lanczos3' })
    .flatten({ background: SOURCE_BACKGROUND })
    .png({ compressionLevel: 9, palette: true, quality: 90 })
    .toFile(outputPath);
  console.log(`[pwa:icons] wrote ${file} (${size}×${size})`);
}
