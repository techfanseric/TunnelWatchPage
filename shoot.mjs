import { chromium } from 'playwright';

const url = process.argv[2] || 'http://127.0.0.1:8788/';
const out = process.argv[3] || '/tmp/tw-region/screenshot.png';
const width = parseInt(process.argv[4] || '1400', 10);
const after = process.argv[5]; // optional: '24h' | '7d' | '30d'
const fullPage = process.argv[6] !== 'false';
const timeout = parseInt(process.argv[7] || '15000', 10);

const browser = await chromium.launch({
  executablePath: '/Users/ericyim/Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
});
const ctx = await browser.newContext({ viewport: { width, height: 900 } });
const page = await ctx.newPage();
page.on('pageerror', e => console.error('PAGEERROR:', e.message));
page.on('console', m => { if (m.type() === 'error') console.error('CONSOLE-ERR:', m.text()); });

await page.goto(url, { waitUntil: 'networkidle', timeout });
try {
  await page.waitForFunction(
    () => {
      const sel = document.getElementById('device-select');
      return sel && sel.options.length > 0 && sel.value && !sel.value.startsWith('加载中');
    },
    { timeout: 10000 }
  );
} catch (e) {
  console.error('device-select never populated:', e.message);
}
await page.waitForTimeout(1800);

if (after) {
  const hours = { '24h': 24, '7d': 168, '30d': 720 }[after];
  if (hours) {
    const btn = await page.$(`#view-switcher button[data-hours="${hours}"]`);
    if (btn) {
      await btn.click();
      await page.waitForTimeout(2200);
    }
  }
}

await page.screenshot({ path: out, fullPage });
console.log('OK', out);
await browser.close();
