// Renders web/icons/icon.svg to the PNG sizes iOS and the manifest need.
import { chromium } from 'playwright';
import fs from 'node:fs';

const svg = fs.readFileSync('web/icons/icon.svg', 'utf8');
const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
for (const [file, size] of [['icon-192.png', 192], ['icon-512.png', 512], ['apple-touch-icon.png', 180]]) {
  const page = await browser.newPage({ viewport: { width: size, height: size } });
  await page.setContent(`<style>html,body{margin:0}svg{display:block;width:${size}px;height:${size}px}</style>${svg}`);
  await page.screenshot({ path: `web/icons/${file}` });
  await page.close();
}
await browser.close();
