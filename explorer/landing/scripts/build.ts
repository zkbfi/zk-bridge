/** Builds `dist/`: type-stripped JavaScript, the page, and the settings baked into `main.js`. */
import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");

/** Turns `.ts` import paths into `.js` so the browser finds the stripped files. */
function rewriteImports(source: string): string {
  return source.replace(/(from\s+["']\.\/[^"']+)\.ts(["'])/g, "$1.js$2");
}

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });

const config = JSON.parse(await readFile(join(root, "landing.config.json"), "utf8")) as { title: string };

for (const file of (await readdir(join(root, "src"))).filter((name) => name.endsWith(".ts"))) {
  const source = await readFile(join(root, "src", file), "utf8");
  const stripped = rewriteImports(stripTypeScriptTypes(source, { mode: "strip" }));
  await writeFile(join(dist, file.replace(/\.ts$/, ".js")), stripped);
}

// the favicons and touch icon, served from the site root
await cp(join(root, "public"), dist, { recursive: true });

const html = (await readFile(join(root, "index.html"), "utf8")).replace("{{title}}", () =>
  config.title.replace(/[&<>"']/g, ""),
);
await writeFile(join(dist, "index.html"), html);
await writeFile(
  join(dist, "main.js"),
  `import { startLanding } from "./page.js";\nstartLanding(${JSON.stringify(config)});\n`,
);
