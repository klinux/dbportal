#!/usr/bin/env node
/**
 * Regenerates docs/screenshots/*.png from a running server (`make dev-bg`, or a `bun run
 * start` on another port with SHOT_BASE), signed in as the local admin, at 1280×860 and 2×
 * so the README stays sharp on any display. Every admin section, the operations Backups
 * tab, the datasource sheet, and the alerts page with its Channels tab.
 *
 *   SHOT_EMAIL=admin@local.test SHOT_PASSWORD=... node scripts/screenshots.mjs
 *
 * Optional: SHOT_BASE (default http://localhost:3000), SHOT_CHROME, the path of a Chromium
 * binary when the one Playwright installs is not on this machine, and SHOT_SQL, the
 * statement the studio picture shows run (one against the first datasource's tables).
 */
import { chromium } from "playwright";

const base = process.env.SHOT_BASE ?? "http://localhost:3000";
const email = process.env.SHOT_EMAIL;
const password = process.env.SHOT_PASSWORD;
if (!email || !password) {
  console.error("SHOT_EMAIL and SHOT_PASSWORD are required (the local admin from .env.local)");
  process.exit(1);
}
const out = new URL("../docs/screenshots/", import.meta.url).pathname;
const viewport = { width: 1280, height: 860 };
const browser = await chromium.launch(process.env.SHOT_CHROME ? { executablePath: process.env.SHOT_CHROME } : {});

async function shoot(page, name, path, settle = 1200) {
  await page.goto(base + path, { waitUntil: "networkidle" });
  await page.waitForTimeout(settle);
  // The Next.js dev-tools badge is not part of the product.
  await page.evaluate(() => document.querySelector("nextjs-portal")?.remove());
  await page.screenshot({ path: `${out}${name}.png` });
  console.log(name, page.url());
}

const anonymous = await browser.newContext({ viewport, deviceScaleFactor: 2 });
await shoot(await anonymous.newPage(), "login", "/login");
await anonymous.close();

const signedIn = await browser.newContext({ viewport, deviceScaleFactor: 2 });
const login = await signedIn.request.post(`${base}/api/auth/login`, { data: { email, password } });
if (!login.ok()) {
  console.error(`login failed: HTTP ${login.status()}`);
  process.exit(1);
}
const page = await signedIn.newPage();
// The studio with a statement run, not an empty editor: typed into Monaco and run with the shortcut.
await page.goto(`${base}/`, { waitUntil: "networkidle" });
await page.waitForTimeout(2500);
await page.locator(".monaco-editor").first().click();
await page.keyboard.type(process.env.SHOT_SQL ?? "SELECT id, name, created_at FROM app.categories ORDER BY id");
await page.keyboard.press("Control+Enter");
await page.waitForTimeout(2500);
// Monaco's completion list opens on the last word typed; it is not part of the picture.
await page.keyboard.press("Escape");
await page.waitForTimeout(300);
await page.evaluate(() => document.querySelector("nextjs-portal")?.remove());
await page.screenshot({ path: `${out}studio.png` });
console.log("studio", page.url());
for (const section of ["overview", "datasources", "approvals", "operations", "jobs", "monitoring", "security", "audit"]) {
  await shoot(page, `admin-${section}`, `/admin/${section}`);
}
/** A page with something clicked first: a sub-tab, a sheet. */
async function shootAfter(name, path, click, settle = 1200) {
  await page.goto(base + path, { waitUntil: "networkidle" });
  await page.waitForTimeout(600);
  await page.locator(click).first().click();
  await page.waitForTimeout(settle);
  await page.evaluate(() => document.querySelector("nextjs-portal")?.remove());
  await page.screenshot({ path: `${out}${name}.png` });
  console.log(name, page.url(), "after", click);
}
await shootAfter("admin-operations-backups", "/admin/operations", '[data-testid="operations-tab-backups"]');
await shootAfter("datasource-sheet", "/admin/datasources", "text=New datasource");
await shoot(page, "alerts", "/alerts");
await shootAfter("alerts-channels", "/alerts", '[data-testid="alerts-tab-channels"]');
await browser.close();
