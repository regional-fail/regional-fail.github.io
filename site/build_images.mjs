// Render the icon and link-preview banner from their SVG sources (run after editing the SVGs; PNGs are committed).
// Usage: npm run images
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Resvg } from '@resvg/resvg-js';

const IMG = path.join(path.dirname(fileURLToPath(import.meta.url)), 'img');
const render = (src, out, width) => {
  const png = new Resvg(fs.readFileSync(path.join(IMG, src)), { fitTo: { mode: 'width', value: width }, font: { loadSystemFonts: true } }).render().asPng();
  fs.writeFileSync(path.join(IMG, out), png);
  console.log(`${out}: ${width}px, ${(png.length / 1024).toFixed(0)} KB`);
};
render('og-banner.svg', 'og-banner.png', 1200);
render('favicon.svg', 'icon-192.png', 192);
render('favicon.svg', 'apple-touch-icon.png', 180);
render('favicon.svg', 'favicon-32.png', 32);
