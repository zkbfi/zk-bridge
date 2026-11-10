/**
 * Takes the landing page's screenshots of the app: the bridge screen once the loader has finished, light and dark, at
 * desktop width. Run by script/release/snapshot.sh, never by hand in a release.
 *
 * Usage: node scripts/capture-snapshot.ts <built-dapp-directory> <output-directory>
 *
 * The dapp must be built with VITE_EXPLORER_DATA=fixture (sample data, no network, no wallet). The output is
 * snapshot-light.webp, snapshot-dark.webp (each under 200 kB) and snapshot.json ({"width","height"}),
 * and snapshot-og.jpg (1200x630, under 150 kB) for link previews.
 * It drives the installed Google Chrome like the end-to-end tests (SNAPSHOT_CHROME names another browser program;
 * without either, Playwright's own Chromium).
 */
import { createServer } from "node:http";
import type { Server } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { chromium } from "@playwright/test";
import type { Browser } from "@playwright/test";

const WIDTH = 1280;
const HEIGHT = 800;
const MAXIMUM_BYTES = 200 * 1024;
/** The link-preview image: 1200x630 cut from the light screenshot, as a JPEG under this size. */
const PREVIEW_BYTES = 150 * 1024;
const TYPES: Record<string, string> = {
  ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png",
  ".json": "application/json", ".woff2": "font/woff2", ".webp": "image/webp", ".txt": "text/plain", ".ico": "image/x-icon",
};

const [directory, output] = process.argv.slice(2);
if (directory === undefined || output === undefined) {
  console.error("usage: node capture-snapshot.ts <built-dapp-directory> <output-directory>");
  process.exit(2);
}

/** A static server for the built dapp. */
function serve(root: string): Promise<{ server: Server; port: number }> {
  const server = createServer((request, response) => {
    const path = normalize(decodeURIComponent((request.url ?? "/").split("?")[0] ?? "/")).replace(/^(\.\.[/\\])+/, "");
    const file = join(root, path.endsWith("/") ? `${path}index.html` : path);
    readFile(file).then(
      (bytes) => response.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" }).end(bytes),
      () => response.writeHead(404).end("not found"),
    );
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, port: (server.address() as { port: number }).port })));
}

/** Re-encodes a PNG as WebP in the browser, lowering the quality until the file is small enough. */
async function toWebp(browser: Browser, png: Buffer, type = "image/webp", limit = MAXIMUM_BYTES): Promise<Buffer> {
  const page = await browser.newPage();
  try {
    const dataUrl = await page.evaluate(
      async ({ source, limit, mime }) => {
        const image = new Image();
        image.src = source;
        await image.decode();
        const canvas = document.createElement("canvas");
        canvas.width = image.width;
        canvas.height = image.height;
        canvas.getContext("2d")!.drawImage(image, 0, 0);
        let last = "";
        for (const quality of [0.9, 0.8, 0.7, 0.6, 0.5, 0.4, 0.3]) {
          last = canvas.toDataURL(mime, quality);
          if ((last.length * 3) / 4 <= limit) break;
        }
        return last;
      },
      { source: `data:image/png;base64,${png.toString("base64")}`, limit, mime: type },
    );
    return Buffer.from(dataUrl.split(",")[1] ?? "", "base64");
  } finally {
    await page.close();
  }
}

const { server, port } = await serve(directory);
/** SNAPSHOT_CHROME names a browser program; otherwise installed Chrome, otherwise Playwright's own Chromium. */
async function launch(): Promise<Browser> {
  const executablePath = process.env.SNAPSHOT_CHROME;
  if (executablePath !== undefined && executablePath !== "") return chromium.launch({ executablePath });
  try {
    return await chromium.launch({ channel: "chrome" });
  } catch {
    return chromium.launch();
  }
}

const browser = await launch();
try {
  await mkdir(output, { recursive: true });
  for (const scheme of ["light", "dark"] as const) {
    const context = await browser.newContext({ viewport: { width: WIDTH, height: HEIGHT }, colorScheme: scheme, deviceScaleFactor: 1 });
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${port}/`);
    // Past the loader: its image leaves the page when the app mounts. Then the sample data and the fonts settle.
    // The page's own errors fail the capture: a blank screen must never be published as the snapshot.
    const problems: string[] = [];
    page.on("pageerror", (error) => problems.push(error.message));
    await page.waitForSelector('#root img[src$="loader.svg"]', { state: "detached", timeout: 30_000 });
    await page.getByRole("button", { name: "Connect wallet" }).first().waitFor({ state: "visible", timeout: 30_000 });
    if (problems.length > 0) throw new Error(`the page failed: ${problems[0]}`);
    await page.waitForLoadState("networkidle");
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(1500);
    const png = await page.screenshot({ type: "png" });
    const webp = await toWebp(browser, png);
    if (webp.length === 0 || webp.length > MAXIMUM_BYTES) throw new Error(`the ${scheme} snapshot is ${webp.length} bytes, over the ${MAXIMUM_BYTES} limit`);
    await writeFile(join(output, `snapshot-${scheme}.webp`), webp);
    if (scheme === "light") {
      const preview = await toWebp(browser, await page.screenshot({ type: "png", clip: { x: 40, y: 0, width: 1200, height: 630 } }), "image/jpeg", PREVIEW_BYTES);
      if (preview.length === 0 || preview.length > PREVIEW_BYTES) throw new Error(`the preview image is ${preview.length} bytes, over the ${PREVIEW_BYTES} limit`);
      await writeFile(join(output, "snapshot-og.jpg"), preview);
      console.log(`snapshot-og.jpg ${preview.length} bytes`);
    }
    console.log(`snapshot-${scheme}.webp ${webp.length} bytes`);
    await context.close();
  }
  await writeFile(join(output, "snapshot.json"), JSON.stringify({ width: WIDTH, height: HEIGHT }));
} finally {
  await browser.close();
  server.close();
}
