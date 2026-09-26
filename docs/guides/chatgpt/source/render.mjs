// Renders guide.html to the Letter-size vendor guide PDF with headless Chromium.
// Usage: node render.mjs <input.html> <output.pdf>   (or: npm run build)
import { chromium } from 'playwright';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const [input = 'guide.html', output = '../splitt-chatgpt-vendor-guide.pdf'] = process.argv.slice(2);

// CHROMIUM_PATH lets you point at an already-installed Chromium instead of
// running `npx playwright install chromium`.
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
try {
  const page = await browser.newPage();
  await page.goto(pathToFileURL(path.resolve(input)).href, { waitUntil: 'networkidle' });
  await page.evaluate(() => document.fonts.ready);
  await page.pdf({ path: output, preferCSSPageSize: true, printBackground: true, tagged: true, outline: true });
} finally {
  await browser.close();
}
