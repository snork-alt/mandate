#!/usr/bin/env node
/**
 * List alignment checker (headless Playwright): for every list page at several viewport widths, checks that
 *   - the left x of every column (`[data-col]` children of `.lr` rows) is identical across rows,
 *   - no two columns of a row overlap,
 *   - nothing exceeds the row bounds, the time / people columns are never clipped, and visible chips stay inside
 *     their column,
 *   - every row has a people badge (avatar, stack or agent avatar),
 *   - the column header row (`.lr-head`) exists, its labels sit on the same left x as the row columns (it is one of
 *     the measured rows) and are never clipped,
 *   - no chip sliver: visible chips are whole, the chip column is at least a "+N" wide,
 *   - spec rows keep the maturity label visible while the maturity column shows.
 * Reports the title column's share of the row (L3).
 * --rail open|closed|both (default both): sets localStorage `mandate.rail.collapsed` before the app loads.
 * Optionally saves screenshots (light + dark) at one width.
 *
 * Usage:
 *   node scripts/check-list-alignment.mjs --cookies <playwright-cookies.json> [--base http://localhost:5173]
 *     [--project snork-alt] [--widths 1300,1480,1900] [--shots <dir> --shot-width 1480] [--pages feedback,specs]
 *
 * The cookie file comes from `npm run mandate -- session create <project> --out <file>` (never print it).
 * Chromium: PLAYWRIGHT_CHROMIUM or the newest ~/Library/Caches/ms-playwright/chromium_headless_shell-*.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';

const args = Object.fromEntries(
  process.argv
    .slice(2)
    .reduce((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : 'true']] : acc), []),
);
const base = args.base ?? 'http://localhost:5173';
const project = args.project ?? 'default';
const widths = (args.widths ?? '1300,1480,1900').split(',').map(Number);
const PAGES = {
  specs: '/specs',
  standards: '/standards',
  components: '/components?view=list',
  'work-orders': '/work-orders',
  feedback: '/feedback',
  audits: '/audits',
};
const pages = args.pages ? args.pages.split(',') : Object.keys(PAGES);
const railModes = (args.rail ?? 'both') === 'both' ? ['open', 'closed'] : [args.rail];

function chromePath() {
  if (process.env.PLAYWRIGHT_CHROMIUM) return process.env.PLAYWRIGHT_CHROMIUM;
  const root = path.join(os.homedir(), 'Library/Caches/ms-playwright');
  const dirs = fs.existsSync(root) ? fs.readdirSync(root).filter((d) => d.startsWith('chromium_headless_shell-')).sort().reverse() : [];
  for (const d of dirs) {
    for (const sub of fs.readdirSync(path.join(root, d))) {
      const p = path.join(root, d, sub, 'chrome-headless-shell');
      if (fs.existsSync(p)) return p;
    }
  }
  return undefined;
}

/** Runs in the page: geometry problems of the `.lr` rows. */
function measure() {
  const problems = [];
  const rows = [...document.querySelectorAll('.lr[data-list]')].filter((r) => r.getBoundingClientRect().height > 0);
  const lefts = new Map();
  const shares = [];
  if (rows.length && !rows.some((r) => r.classList.contains('lr-head'))) problems.push('no column header row');
  const vis = (el) => {
    const r = el.getBoundingClientRect();
    return getComputedStyle(el).display !== 'none' && r.width > 0 ? r : null;
  };
  rows.forEach((row, i) => {
    const head = row.classList.contains('lr-head');
    const rr = row.getBoundingClientRect();
    const cs = getComputedStyle(row);
    const inner = { left: rr.left + parseFloat(cs.paddingLeft) - 0.5, right: rr.right - parseFloat(cs.paddingRight) + 0.5 };
    const cols = [...row.children].filter((c) => c.dataset.col).map((c) => ({ key: c.dataset.col, el: c, r: vis(c) })).filter((c) => c.r);
    let prev = null;
    for (const c of cols) {
      if (!lefts.has(c.key)) lefts.set(c.key, new Map());
      const x = Math.round(c.r.left * 2) / 2;
      const m = lefts.get(c.key);
      m.set(x, [...(m.get(x) ?? []), i]);
      if (c.r.left < inner.left || c.r.right > inner.right) problems.push(`row ${i}: column ${c.key} exceeds the row (${c.r.left.toFixed(1)}-${c.r.right.toFixed(1)} vs ${inner.left.toFixed(1)}-${inner.right.toFixed(1)})`);
      if (prev && c.r.left < prev.r.right - 0.5) problems.push(`row ${i}: ${prev.key} overlaps ${c.key} (${prev.r.right.toFixed(1)} > ${c.r.left.toFixed(1)})`);
      if ((c.key === 'time' || c.key === 'people') && c.el.scrollWidth > c.el.clientWidth + 1) problems.push(`row ${i}: ${c.key} clipped (${c.el.scrollWidth} > ${c.el.clientWidth}): "${c.el.textContent}"`);
      if (head) {
        const l = c.el.querySelector('.lr-head-label');
        if (l && l.scrollWidth > l.clientWidth + 1) problems.push(`header label "${l.textContent}" clipped (${l.scrollWidth} > ${l.clientWidth})`);
        prev = c;
        continue;
      }
      if (c.key === 'main') shares.push(c.r.width / (inner.right - inner.left));
      if (c.key === 'progress' && row.dataset.list === 'specs') {
        const lab = c.el.querySelector('.maturity-label');
        if (lab && !(lab.getBoundingClientRect().width > 8)) problems.push(`row ${i}: maturity label hidden`);
      }
      if (c.key === 'chips') {
        if (c.r.width < 35.5) problems.push(`row ${i}: chip column ${c.r.width.toFixed(1)}px (narrower than a "+N")`);
        if (c.el.querySelector(':scope > .lr-chip[data-single]')) problems.push(`row ${i}: ellipsized single chip`);
        for (const chip of c.el.querySelectorAll(':scope > .lr-chip:not([data-single]), :scope > .lr-more')) {
          const cr = chip.getBoundingClientRect();
          if (cr.right > c.r.right + 0.5) problems.push(`row ${i}: chip "${chip.textContent}" cut at the column edge`);
          const t = chip.firstElementChild;
          if (t && t.scrollWidth > t.clientWidth + 1) problems.push(`row ${i}: chip "${chip.textContent}" ellipsized`);
        }
      }
      if (c.key === 'people' && !c.el.querySelector('[data-testid=avatar-stack],[data-testid=agent-avatar],.pp-slot')) problems.push(`row ${i}: no people badge`);
      prev = c;
    }
  });
  for (const [key, m] of lefts) {
    if (m.size > 1) problems.push(`column ${key}: ${m.size} different left x: ${[...m.entries()].map(([x, rs]) => `${x} (${rs.length} rows)`).join(', ')}`);
  }
  const share = shares.length ? shares.reduce((a, b) => a + b, 0) / shares.length : 0;
  return { rows: rows.length, problems, share };
}

const cookieFile = args.cookies;
if (!cookieFile) {
  console.error('--cookies <file> is required');
  process.exit(2);
}
const browser = await chromium.launch({ executablePath: chromePath() });
let failed = 0;
try {
  for (const rail of railModes)
  for (const scheme of args.shots ? ['light', 'dark'] : ['light']) {
    const ctx = await browser.newContext({ colorScheme: scheme, viewport: { width: 1480, height: 1000 } });
    await ctx.addCookies(JSON.parse(fs.readFileSync(cookieFile, 'utf8')));
    await ctx.addInitScript((v) => {
      try {
        localStorage.setItem('mandate.rail.collapsed', v);
      } catch {}
    }, rail === 'closed' ? '1' : '0');
    const page = await ctx.newPage();
    for (const name of pages) {
      await page.goto(`${base}/p/${encodeURIComponent(project)}${PAGES[name]}`, { waitUntil: 'domcontentloaded' });
      try {
        await page.waitForSelector('.lr[data-list]', { timeout: 60_000 });
      } catch {
        console.log(`✗ [rail ${rail}] ${name}: no rows`);
        failed++;
        continue;
      }
      // Contributors load in batches (slow under load): wait until every row shows its people badge.
      const PEOPLE = '[data-testid=avatar-stack],[data-testid=agent-avatar],.pp-slot';
      await page
        .waitForFunction((sel) => [...document.querySelectorAll('.lr[data-list] [data-col=people]')].every((c) => c.querySelector(sel)), PEOPLE, { timeout: 45_000 })
        .catch(() => undefined);
      await page.waitForTimeout(300);
      for (const w of scheme === 'light' ? widths : []) {
        await page.setViewportSize({ width: w, height: 1000 });
        await page.waitForTimeout(250);
        const { rows, problems, share } = await page.evaluate(measure);
        if (problems.length) failed++;
        console.log(`${problems.length ? '✗' : '✓'} [rail ${rail}] ${name} @${w}: ${rows} rows, title ${Math.round(share * 100)}%${problems.length ? `, ${problems.length} problems` : ''}`);
        for (const p of problems.slice(0, 12)) console.log(`    ${p}`);
      }
      if (args.shots) {
        const sw = Number(args['shot-width'] ?? 1480);
        await page.setViewportSize({ width: sw, height: 1000 });
        await page.waitForTimeout(400);
        fs.mkdirSync(args.shots, { recursive: true });
        await page.screenshot({ path: path.join(args.shots, `lists-${name}-${scheme}-rail-${rail}.png`) });
      }
    }
    await ctx.close();
  }
} finally {
  await browser.close();
}
process.exit(failed ? 1 : 0);
