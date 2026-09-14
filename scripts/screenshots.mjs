#!/usr/bin/env node
/**
 * Regenerates docs/screenshots/*.png from a running dev server (`make dev-bg`), signed in
 * as the local admin, at 1280×860 and 2× so the README stays sharp on any display.
 *
 *   SHOT_EMAIL=admin@local.test SHOT_PASSWORD=... node scripts/screenshots.mjs
 *
 * Optional: SHOT_BASE (default http://localhost:3000) and SHOT_CHROME, the path of a
 * Chromium binary when the one Playwright installs is not on this machine.
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
await shoot(page, "studio", "/", 2500);
for (const section of ["overview", "datasources", "approvals", "operations", "monitoring", "security", "audit"]) {
  await shoot(page, `admin-${section}`, `/admin/${section}`);
}
await browser.close();
