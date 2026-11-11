import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { MachineSources } from "../machine/site-files";

/** Writes files (path to text) into a fresh temp folder and returns the folder. */
export const writeTree = (files: Record<string, string>): string => {
  const root = mkdtempSync(join(tmpdir(), "machine-tree-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
};

export const pageText = (title = "A page", extra = ""): string =>
  `---\ntitle: ${title}\nsummary: "One line."\naudience: [user]\nchains: all\nverified_release: 0.1.0\n${extra}---\n\n# ${title}\n\nBody.\n`;

export const deployment = (overrides: Record<string, unknown> = {}, chainId: number | string = 943): string =>
  JSON.stringify({
    chain_a: {
      bridge: "0x1111111111111111111111111111111111111111",
      chain_id: chainId,
      gate: "0x3333333333333333333333333333333333333333",
      light_client: "0x4444444444444444444444444444444444444444",
      mediator: "0x5555555555555555555555555555555555555555",
      token_factory: "0x6666666666666666666666666666666666666666",
      wrapped_native: "0x7777777777777777777777777777777777777777",
      ...overrides,
    },
  });

/** A complete sources tree from files (path to text); `pages`, `skills`, `operator` and `deployments` are subfolders. */
export const sourcesOf = (files: Record<string, string>): MachineSources => {
  const root = writeTree({ "public-pages.json": '{"operator":[]}', ...files });
  return {
    pagesFolder: join(root, "pages"),
    skillsFolder: join(root, "skills"),
    docsFolder: join(root, "operator"),
    publicPagesFile: join(root, "public-pages.json"),
    deploymentsFolder: join(root, "deployments"),
  };
};
