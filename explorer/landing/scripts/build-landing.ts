/**
 * The build of the landing page, with its folders and settings given in. `build.ts` reads them from the environment;
 * the tests give them from made folders.
 */
import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { join } from "node:path";
import { socialMeta } from "./social-meta.ts";

/** Where the page is built from and to, and which settings it bakes in. */
export type BuildOptions = {
  /** The folder of the page: `index.html`, `src`, `public` and the settings files. */
  readonly root: string;
  /** The output folder. It is emptied first. */
  readonly dist: string;
  /** The settings file, relative to `root`. */
  readonly configFile: string;
  /** The folder with the snapshot files, or undefined (or empty) for a page without a snapshot. */
  readonly snapshotDirectory: string | undefined;
};

/**
 * The options of a build from the environment: `LANDING_OUT` (default `dist` below the root), `LANDING_CONFIG` (default
 * `landing.config.json`) and `LANDING_SNAPSHOT_DIR`.
 *
 * @param environment The environment variables.
 * @param root The folder of the page.
 */
export function optionsFromEnvironment(environment: Readonly<Record<string, string | undefined>>, root: string): BuildOptions {
  return {
    root,
    dist: environment.LANDING_OUT ?? join(root, "dist"),
    configFile: environment.LANDING_CONFIG ?? "landing.config.json",
    snapshotDirectory: environment.LANDING_SNAPSHOT_DIR,
  };
}

/** Turns `.ts` import paths into `.js` so the browser finds the stripped files. */
export function rewriteImports(source: string): string {
  return source.replace(/(from\s+["']\.\/[^"']+)\.ts(["'])/g, "$1.js$2");
}

/** Builds the page into `options.dist`. */
export async function buildLanding({ root, dist, configFile, snapshotDirectory }: BuildOptions): Promise<void> {
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
}
