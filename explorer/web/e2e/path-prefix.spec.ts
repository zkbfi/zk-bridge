import { execFileSync } from "node:child_process";
import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

const PREFIX = "/ipfs/bafytest/";
const WEB_ROOT = fileURLToPath(new URL("..", import.meta.url));
const DIST = join(WEB_ROOT, "test-results", "path-prefix-dist");
const TYPES: Readonly<Record<string, string>> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml" };

let server: Server;
let origin = "";

test.beforeAll(async () => {
  // A sample-data build in its own folder, so it never replaces the `dist` folder of the real build.
  execFileSync("pnpm", ["exec", "vite", "build", "--outDir", DIST, "--emptyOutDir"], { cwd: WEB_ROOT, env: { ...process.env, VITE_EXPLORER_DATA: "fixture" }, stdio: "pipe" });
  server = createServer((request, response) => {
    const path = decodeURIComponent((request.url ?? "/").split("?")[0] ?? "/");
    if (!path.startsWith(PREFIX)) return void response.writeHead(404).end();
    const relative = normalize(path.slice(PREFIX.length)).replace(/^(\.\.[/\\])+/, "");
    const file = join(DIST, relative === "" || relative === "." ? "index.html" : relative);
    if (!existsSync(file) || !statSync(file).isFile()) return void response.writeHead(404).end();
    response.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" });
    createReadStream(file).pipe(response);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  origin = typeof address === "object" && address !== null ? `http://127.0.0.1:${address.port}` : "";
});

test.afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

test("the dapp loads, routes by hash and shows no failed asset request", async ({ page }) => {
  const failures: string[] = [];
  page.on("requestfailed", (request) => failures.push(`failed ${request.url()}`));
  page.on("response", (response) => {
    if (response.status() >= 400) failures.push(`${response.status()} ${response.url()}`);
  });
  await page.goto(`${origin}${PREFIX}#/pair/eth-pls`);
  await expect(page.getByRole("heading", { name: "Summary" })).toBeVisible();
  await page.goto(`${origin}${PREFIX}#/`);
  await expect(page.getByRole("heading", { name: "Global view" })).toBeVisible();
  expect(failures).toEqual([]);
});
