/**
 * Builds the landing page: type-stripped JavaScript, the page, and the settings baked into `main.js`.
 *
 * LANDING_CONFIG  the settings file, relative to explorer/landing (default landing.config.json, production;
 *                 landing.next.config.json is the staging site next.zkb.fi, which trusts only the staging key)
 * LANDING_SNAPSHOT_DIR  a directory with snapshot-light.webp, snapshot-dark.webp and snapshot.json ({"width","height"}),
 *                 made by script/release/snapshot.sh. When all three are there they are copied into the site and the
 *                 page shows them; otherwise the page has no snapshot block. A snapshot-og.jpg (1200x630) beside them,
 *                 with "siteUrl" in the settings, becomes the og:image and twitter:image of the page; without it the
 *                 page has no such tags.
 * LANDING_OUT     the output directory (default dist/)
 */
import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { socialMeta } from "./social-meta.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = process.env.LANDING_OUT ?? join(root, "dist");
const snapshotDirectory = process.env.LANDING_SNAPSHOT_DIR;
const configFile = process.env.LANDING_CONFIG ?? "landing.config.json";

/** Turns `.ts` import paths into `.js` so the browser finds the stripped files. */
function rewriteImports(source: string): string {
  return source.replace(/(from\s+["']\.\/[^"']+)\.ts(["'])/g, "$1.js$2");
}

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });

const config = JSON.parse(await readFile(join(root, configFile), "utf8")) as { title: string; siteUrl?: string; snapshot?: unknown };

/** The snapshot files, when the release made them. A missing or broken set means no snapshot, never a failed build. */
async function readSnapshot(): Promise<{ light: string; dark: string; width: number; height: number } | null> {
  if (snapshotDirectory === undefined || snapshotDirectory === "") return null;
  try {
    const size = JSON.parse(await readFile(join(snapshotDirectory, "snapshot.json"), "utf8")) as { width?: unknown; height?: unknown };
    if (!Number.isInteger(size.width) || !Number.isInteger(size.height)) return null;
    for (const file of ["snapshot-light.webp", "snapshot-dark.webp"]) {
      await cp(join(snapshotDirectory, file), join(dist, file));
    }
    return { light: "./snapshot-light.webp", dark: "./snapshot-dark.webp", width: size.width as number, height: size.height as number };
  } catch {
    return null;
  }
}

for (const file of (await readdir(join(root, "src"))).filter((name) => name.endsWith(".ts"))) {
  const source = await readFile(join(root, "src", file), "utf8");
  const stripped = rewriteImports(stripTypeScriptTypes(source, { mode: "strip" }));
  await writeFile(join(dist, file.replace(/\.ts$/, ".js")), stripped);
}

// the favicons and touch icon, served from the site root
await cp(join(root, "public"), dist, { recursive: true });

/** The social preview image, copied into the site when it exists. Needs an absolute site address for its URL. */
async function readPreviewMeta(): Promise<string> {
  if (snapshotDirectory === undefined || snapshotDirectory === "" || config.siteUrl === undefined) return "";
  try {
    await cp(join(snapshotDirectory, "snapshot-og.jpg"), join(dist, "snapshot-og.jpg"));
  } catch {
    return "";
  }
  return socialMeta(config.title, new URL("snapshot-og.jpg", config.siteUrl).href);
}

const snapshot = await readSnapshot();
const previewMeta = snapshot === null ? "" : await readPreviewMeta();
if (snapshot !== null) config.snapshot = snapshot;
else delete config.snapshot;

const html = (await readFile(join(root, "index.html"), "utf8"))
  .replace("{{title}}", () => config.title.replace(/[&<>"']/g, ""))
  .replace("{{meta}}", () => previewMeta);
await writeFile(join(dist, "index.html"), html);
await writeFile(
  join(dist, "main.js"),
  `import { startLanding } from "./page.js";\nstartLanding(${JSON.stringify(config)});\n`,
);
