// Screenshots for zkb.fi/ui's "As built" section. Needs the app with sample data running (the docs are its #/docs route):
//   (explorer/web)  VITE_EXPLORER_DATA=fixture npx vite --port 5210 --strictPort
// Usage: node design/ui/shots.mjs <explorer/web dir>   -> design/ui/built/<screen>-<phone|desktop>.png
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const [webDir] = process.argv.slice(2);
const { chromium } = createRequire(`${webDir}/package.json`)("@playwright/test");
const out = join(dirname(fileURLToPath(import.meta.url)), "built");
mkdirSync(out, { recursive: true });
const APP = "http://localhost:5210/";
const DOCS = APP + "#/docs";
const views = {
  phone: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, colorScheme: "dark", hasTouch: true },
  desktop: { viewport: { width: 1280, height: 860 }, colorScheme: "light" },
};
const screens = [
  ["bridge", APP + "#/bridge/eth-pls?bridge.amount=250"],
  ["fee", APP + "#/bridge/eth-pls?bridge.amount=500", async (p) => p.locator('[data-fee="tip"]').first().click()],
  ["blocked", APP + "#/bridge/eth-pls?bridge.amount=500&tip.mode=percentage&tip.percent=2.4"],
  ["search", APP + "#/bridge/eth-pls", async (p) => { await p.keyboard.press("Control+k"); await p.keyboard.type("us"); }],
  ["settings", APP + "#/explore", async (p) => p.getByRole("link", { name: /Change in Settings/ }).first().click()],
  ["explore", APP + "#/explore"],
  ["message", APP + "#/message/0x0000000000000000000000000000000000000000000000000000000000000105"],
  ["docs-home", DOCS],
  ["docs-article", DOCS, async (p) => p.getByRole("link", { name: /Fees/ }).first().click()],
];
const browser = await chromium.launch({ executablePath: `${process.env.HOME}/Library/Caches/ms-playwright/chromium_headless_shell-1217/chrome-headless-shell-mac-x64/chrome-headless-shell` });
for (const [view, options] of Object.entries(views)) {
  for (const [name, url, act] of screens) {
    const page = await (await browser.newContext(options)).newPage();
    await page.goto(url); await page.waitForLoadState("networkidle"); await page.waitForTimeout(1000);
    if (act) { try { await act(page); await page.waitForTimeout(700); } catch (e) { console.log(`${name} ${view}: ${e.message.split("\n")[0]}`); } }
    await page.screenshot({ path: join(out, `${name}-${view}.png`) });
    await page.close();
  }
}
await browser.close();
console.log("saved to", out);
