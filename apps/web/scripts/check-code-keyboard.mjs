// Keyboard check for code samples, against a running site (BASE_URL): at phone width, Tab from each block's copy button
// to its <pre>; the focus ring shows; ArrowRight scrolls the sample; the copy button does not move. Used for #286.
import { chromium } from '@playwright/test';

const base = process.env.BASE_URL;
const browser = await chromium.launch();
const failures = [];
try {
  const expected = { '/use-cases/compliance-evidence': 2, '/use-cases/customer-audit-logs': 4 };
  for (const [path, blocks] of Object.entries(expected)) {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    const response = await page.goto(new URL(path, base).href, { waitUntil: 'networkidle' });
    const count = await page.locator('.site-code').count();
    if (!response?.ok() || count !== blocks) {
      failures.push(`${path}: status ${response?.status()}, ${count} code blocks (expected ${blocks})`);
      await page.close();
      continue;
    }
    for (let i = 0; i < count; i++) {
      const block = page.locator('.site-code').nth(i);
      const button = block.getByRole('button', { name: 'Copy code' });
      const pre = block.locator('pre');
      await button.focus();
      const where = () =>
        button.evaluate((el) => {
          const r = el.getBoundingClientRect();
          return { x: Math.round(r.left + scrollX), y: Math.round(r.top + scrollY) };
        });
      const before = await where();
      await page.keyboard.press('Tab');
      const focused = await pre.evaluate((el) => document.activeElement === el);
      // A visible ring: a style other than none, a positive width and a colour that is not transparent.
      const ring = await pre.evaluate((el) => {
        const style = getComputedStyle(el);
        return { style: style.outlineStyle, width: Number.parseFloat(style.outlineWidth), color: style.outlineColor };
      });
      const transparent = /^(transparent|rgba\([^)]*,\s*0\))$/.test(ring.color.replace(/\s+/g, ' '));
      const visibleRing = ring.style !== 'none' && ring.width > 0 && !transparent;
      const outline = `${ring.style} ${ring.width}px ${ring.color}`;
      const overflow = await pre.evaluate((el) => el.scrollWidth - el.clientWidth);
      for (let k = 0; k < 8; k++) await page.keyboard.press('ArrowRight');
      await page.waitForTimeout(700); // scrolling is smooth: let it settle
      const scrolled = await pre.evaluate((el) => el.scrollLeft);
      const after = await where();
      const stays = before && after && before.x === after.x && before.y === after.y;
      // Every sample on these pages is wider than a phone, so each must overflow and actually scroll.
      const ok = focused && visibleRing && stays && overflow > 0 && scrolled > 0;
      console.log(
        `${path} block ${i + 1}: focus=${focused} outline=${outline} overflow=${overflow}px scrolled=${scrolled}px copyButtonStays=${stays} ${ok ? 'OK' : 'FAIL'}`,
      );
      if (!ok) failures.push(`${path} block ${i + 1}`);
    }
    await page.close();
  }
} finally {
  await browser.close();
}
if (failures.length) {
  console.error(`failed: ${failures.join(', ')}`);
  process.exit(1);
}
