// Enregistre l'image au temps donné (s) dans un PNG, avec le moteur d'export (Edge headless).
import { writeFileSync } from 'node:fs';
import { chromium } from 'playwright-core';

const [origin, seconds, out] = [process.argv[2], Number(process.argv[3]), process.argv[4]];
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const page = await browser.newPage();
await page.goto(`${origin}/export.html`);
await page.waitForFunction('window.__ready === true', undefined, { timeout: 60000 });
const fps = (await (await fetch(`${origin}/api/project`)).json()).project.fps;
const url = await page.evaluate((i) => window.__frame(i, 0.9), Math.round(seconds * fps));
writeFileSync(out, Buffer.from(url.split(',')[1], 'base64'));
console.log('missing:', await page.evaluate('window.__missing'));
await browser.close();
