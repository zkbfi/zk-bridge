import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, test, vi } from "vitest";
import { buildLanding, optionsFromEnvironment, rewriteImports } from "../scripts/build-landing.ts";
import { socialMeta } from "../scripts/social-meta.ts";

const temp = (): string => mkdtempSync(join(tmpdir(), "landing-"));
function write(root: string, files: Record<string, string | Buffer>): void {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
}

/** A page folder: two modules where one imports the other, a text file that is not code, a favicon and settings. */
function page(config: Record<string, unknown> = { title: "Rel <&> \"eases\" 'x'", siteUrl: "https://example.org/" }): string {
  const root = temp();
  write(root, {
    "index.html": "<title>{{title}}</title>\n{{meta}}\n<div id=app></div>",
    "landing.config.json": JSON.stringify(config),
    "landing.next.config.json": JSON.stringify({ title: "Next" }),
    "src/a.ts": 'import { b } from "./b.ts";\nexport const a: number = b + 1;\n',
    "src/b.ts": "export const b: number = 1;\n",
    "src/notes.txt": "not code",
    "public/favicon.svg": "<svg/>",
  });
  return root;
}

function snapshot(files: Record<string, string> = {}): string {
  const directory = temp();
  write(directory, { "snapshot-light.webp": "light", "snapshot-dark.webp": "dark", "snapshot.json": '{"width":800,"height":600}', "snapshot-og.jpg": "og", ...files });
  return directory;
}

const options = (root: string, extra: Partial<Parameters<typeof buildLanding>[0]> = {}) => ({ root, dist: join(temp(), "out"), configFile: "landing.config.json", snapshotDirectory: undefined, ...extra });
const read = (path: string): string => readFileSync(path, "utf8");

afterEach(() => vi.restoreAllMocks());

test("builds type-stripped modules with .js imports, the favicons, the title without markup characters and the settings in main.js", async () => {
  const given = options(page({ title: "Rel <&> \"eases\" 'x'", snapshot: { stale: true } }));
  await buildLanding(given);
  assert.deepEqual(readdirSync(given.dist).sort(), ["a.js", "b.js", "favicon.svg", "index.html", "main.js"]);
  assert.match(read(join(given.dist, "a.js")), /import \{ b \} from "\.\/b\.js";/);
  assert.ok(!read(join(given.dist, "a.js")).includes(": number"));
  assert.equal(read(join(given.dist, "index.html")), "<title>Rel  eases x</title>\n\n<div id=app></div>");
  assert.equal(read(join(given.dist, "main.js")), `import { startLanding } from "./page.js";\nstartLanding({"title":"Rel <&> \\"eases\\" 'x'"});\n`);
});

test("empties the output folder first", async () => {
  const given = options(page());
  write(given.dist, { "old.js": "old" });
  await buildLanding(given);
  assert.equal(existsSync(join(given.dist, "old.js")), false);
});

test("builds with the settings file it is given", async () => {
  const given = options(page(), { configFile: "landing.next.config.json" });
  await buildLanding(given);
  assert.ok(read(join(given.dist, "index.html")).startsWith("<title>Next</title>"));
});

test("with a snapshot, copies both images, bakes their size into main.js and adds the preview tags from the site address", async () => {
  const directory = snapshot();
  const given = options(page(), { snapshotDirectory: directory });
  await buildLanding(given);
  assert.equal(read(join(given.dist, "snapshot-light.webp")), "light");
  assert.equal(read(join(given.dist, "snapshot-dark.webp")), "dark");
  assert.equal(read(join(given.dist, "snapshot-og.jpg")), "og");
  assert.ok(read(join(given.dist, "main.js")).includes('"snapshot":{"light":"./snapshot-light.webp","dark":"./snapshot-dark.webp","width":800,"height":600}'));
  assert.ok(read(join(given.dist, "index.html")).includes('<meta property="og:image" content="https://example.org/snapshot-og.jpg" />'));
});

test("a snapshot without a site address has no preview tags and no preview image", async () => {
  const given = options(page({ title: "T" }), { snapshotDirectory: snapshot() });
  await buildLanding(given);
  assert.ok(read(join(given.dist, "main.js")).includes('"snapshot"'));
  assert.ok(!read(join(given.dist, "index.html")).includes("og:image"));
  assert.equal(existsSync(join(given.dist, "snapshot-og.jpg")), false);
});

test("a snapshot without a preview image has no preview tags", async () => {
  const without = temp();
  write(without, { "snapshot-light.webp": "l", "snapshot-dark.webp": "d", "snapshot.json": '{"width":1,"height":2}' });
  const given = options(page(), { snapshotDirectory: without });
  await buildLanding(given);
  assert.ok(read(join(given.dist, "main.js")).includes('"snapshot"'));
  assert.ok(!read(join(given.dist, "index.html")).includes("og:image"));
});

test("a missing, broken or incomplete snapshot never fails the build, and the page has no snapshot", async () => {
  const cases: Record<string, string | undefined> = {
    none: undefined,
    empty: "",
    "no folder": join(temp(), "missing"),
    "bad json": (() => { const d = temp(); write(d, { "snapshot.json": "{" }); return d; })(),
    "no size": (() => { const d = temp(); write(d, { "snapshot.json": "{}", "snapshot-light.webp": "l", "snapshot-dark.webp": "d" }); return d; })(),
    "fractional size": (() => { const d = temp(); write(d, { "snapshot.json": '{"width":1.5,"height":2}', "snapshot-light.webp": "l", "snapshot-dark.webp": "d" }); return d; })(),
    "no height": (() => { const d = temp(); write(d, { "snapshot.json": '{"width":1}', "snapshot-light.webp": "l", "snapshot-dark.webp": "d" }); return d; })(),
    "no image": (() => { const d = temp(); write(d, { "snapshot.json": '{"width":1,"height":2}', "snapshot-light.webp": "l" }); return d; })(),
  };
  for (const [name, snapshotDirectory] of Object.entries(cases)) {
    const given = options(page({ title: "T", siteUrl: "https://example.org/", snapshot: { old: 1 } }), { snapshotDirectory });
    await buildLanding(given);
    assert.ok(!read(join(given.dist, "main.js")).includes("snapshot"), name);
    assert.ok(!read(join(given.dist, "index.html")).includes("og:image"), name);
  }
});

test("rewrites only relative .ts imports", () => {
  assert.equal(rewriteImports('import a from "./a.ts";\nimport b from \'./b.ts\';\nimport c from "pkg/c.ts";\nimport d from "../d.ts";'), 'import a from "./a.js";\nimport b from \'./b.js\';\nimport c from "pkg/c.ts";\nimport d from "../d.ts";');
});

test("reads the options from the environment, with the defaults of the production build", () => {
  assert.deepEqual(optionsFromEnvironment({}, "/page"), { root: "/page", dist: join("/page", "dist"), configFile: "landing.config.json", snapshotDirectory: undefined });
  assert.deepEqual(optionsFromEnvironment({ LANDING_OUT: "/out", LANDING_CONFIG: "landing.next.config.json", LANDING_SNAPSHOT_DIR: "/snap" }, "/page"), {
    root: "/page",
    dist: "/out",
    configFile: "landing.next.config.json",
    snapshotDirectory: "/snap",
  });
});

test("build.ts builds the real page into LANDING_OUT", async () => {
  const out = join(temp(), "site");
  vi.stubEnv("LANDING_OUT", out);
  vi.stubEnv("LANDING_CONFIG", "landing.next.config.json");
  vi.stubEnv("LANDING_SNAPSHOT_DIR", "");
  vi.spyOn(process, "emitWarning").mockImplementation(() => undefined);
  await import("../scripts/build.ts");
  assert.ok(read(join(out, "main.js")).startsWith('import { startLanding } from "./page.js";'));
  assert.ok(existsSync(join(out, "favicon.svg")));
  vi.unstubAllEnvs();
});

test("the preview tags escape the title and the address, and name the 1200 by 630 image", () => {
  const tags = socialMeta('A "<b>" & \'c\'', "https://example.org/a?x=1&y=2");
  assert.ok(tags.includes('<meta property="og:title" content="A &#34;&#60;b&#62;&#34; &#38; &#39;c&#39;" />'));
  assert.ok(tags.includes('<meta property="og:image" content="https://example.org/a?x=1&#38;y=2" />'));
  assert.ok(tags.includes('<meta name="twitter:image" content="https://example.org/a?x=1&#38;y=2" />'));
  assert.ok(tags.includes('content="1200"') && tags.includes('content="630"'));
  assert.equal(tags.split("\n").length, 7);
});
