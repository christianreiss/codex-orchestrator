// Run against a local static server or either live deployment.
// node scripts/test-website-language.mjs https://example.org/path/
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(new URL('../frontend/package.json', import.meta.url));
const { chromium } = require('playwright');
const base = new URL(process.argv[2]);
const browser = await chromium.launch({ executablePath: process.env.CHROME_BIN || undefined });
try {
  for (const [languages, expected] of [
    [['fr-CA', 'en-GB', 'de'], 'en'],
    [['fr', 'de-AT', 'en-US'], 'de'],
    [['ja', 'es'], 'de'],
  ]) {
    const context = await browser.newContext({ viewport: { width: 320, height: 800 } });
    await context.addInitScript(list => Object.defineProperty(navigator, 'languages', { get: () => JSON.parse(sessionStorage.getItem('testLanguages')) || list }), languages);
    const page = await context.newPage();
    await page.goto(new URL('#vergleich', base).href);
    await page.waitForFunction(lang => document.documentElement.lang === lang, expected);
    assert.equal(new URL(page.url()).hash, '#vergleich');
    assert.equal(await page.locator('html').evaluate(el => el.scrollWidth <= innerWidth), true);
    const label = await page.locator('td').first().evaluate(el => getComputedStyle(el, '::before').content);
    assert.ok(label.includes(expected === 'en' ? 'Standalone CLIs' : 'Native CLIs einzeln'));
    const other = expected === 'de' ? 'en' : 'de';
    await page.locator('[data-language][lang="' + other + '"]').click();
    await page.waitForFunction(lang => document.documentElement.lang === lang, other);
    assert.equal(new URL(page.url()).hash, '#vergleich');
    // An explicit URL must never pin the neutral landing page to that language.
    await page.goto(base.href);
    await page.waitForFunction(lang => document.documentElement.lang === lang, expected);
    await page.evaluate(lang => sessionStorage.setItem('testLanguages', JSON.stringify(['it', lang])), other);
    await page.goto(base.href);
    await page.waitForFunction(lang => document.documentElement.lang === lang, other);
    console.log(base.pathname, languages.join(', '), '→', expected, '→ explicit', other, '→ neutral', expected, '→ changed browser', other);
    await context.close();
  }
  const context = await browser.newContext({ javaScriptEnabled: false, locale: 'en-GB' });
  const page = await context.newPage();
  await page.goto(base.href);
  for (const lang of ['de', 'en', 'de']) {
    await page.locator('[data-language][lang="' + lang + '"]').click();
    assert.equal(await page.locator('html').getAttribute('lang'), lang);
    assert.match(await page.title(), lang === 'de' ? /Deine/ : /Your/);
    assert.equal(await page.locator('main table tbody tr').count(), 4);
    assert.ok(new URL(page.url()).pathname.startsWith(base.pathname));
  }
  console.log(base.pathname, 'no-JS links passed');
} finally {
  await browser.close();
}
