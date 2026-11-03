// Diagnostic : rend quelques images dans Edge headless et mesure le temps de chacune.
import { chromium } from 'playwright-core';

const origin = process.argv[2] ?? 'http://localhost:5173';
const frames = (process.argv[3] ?? '140,150,152,153').split(',').map(Number);
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const page = await browser.newPage();
page.on('console', (m) => console.log('[page]', m.text()));
await page.goto(`${origin}/export.html`);
await page.waitForFunction('window.__ready === true', undefined, { timeout: 30000 });
for (const i of frames) {
  const t0 = Date.now();
  const r = await Promise.race([
    page.evaluate((n) => window.__frame(n, 0.9).then((d) => d.length), i),
    new Promise((res) => setTimeout(() => res('TIMEOUT'), 5000)),
  ]);
  console.log(i, r, Date.now() - t0, 'ms');
  if (r === 'TIMEOUT') break;
}
await browser.close();
