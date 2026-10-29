import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const gate = join(dirname(fileURLToPath(import.meta.url)), "../../../script/check-docs-public.sh");
const folders: string[] = [];

/**
 * A fresh repository with the gate script, one clean tracked page, and the given untracked page. `privatePatterns` is
 * the text of `.git/info/forbidden-patterns`; null leaves the file out.
 */
const repositoryWith = (untrackedText: string, privatePatterns: string | null = "# none yet\n"): string => {
  const root = mkdtempSync(join(tmpdir(), "docs-gate-"));
  folders.push(root);
  mkdirSync(join(root, "script"));
  mkdirSync(join(root, "docs"));
  copyFileSync(gate, join(root, "script/check-docs-public.sh"));
  writeFileSync(join(root, "docs/clean.md"), "# Clean\n");
  const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t.invalid", ...args], { cwd: root, stdio: "pipe" });
  git("init", "-q");
  git("add", "docs", "script");
  git("commit", "-q", "-m", "x", "--no-gpg-sign");
  writeFileSync(join(root, "docs/new.md"), untrackedText);
  if (privatePatterns !== null) writeFileSync(join(root, ".git/info/forbidden-patterns"), privatePatterns);
  return root;
};
const runGate = (root: string, env: Record<string, string> = {}): number => {
  try {
    execFileSync("bash", [join(root, "script/check-docs-public.sh")], { cwd: root, stdio: "pipe", env: { ...process.env, ...env } });
    return 0;
  } catch (error) {
    return (error as { status: number }).status;
  }
};

afterEach(() => folders.splice(0).forEach((folder) => rmSync(folder, { recursive: true, force: true })));

describe("the public-docs gate", () => {
  it("fails on an untracked docs file that holds a forbidden pattern, because the site builds from the working tree", () => {
    expect(runGate(repositoryWith(`# New\n\nSee ${["", "Users", "someone"].join("/")}/notes\n`))).toBe(1);
  });

  it("passes when the untracked file is clean", () => {
    expect(runGate(repositoryWith("# New\n"))).toBe(0);
  });

  it("fails when the private patterns file is missing, unless the run says on purpose that it has none", () => {
    expect(runGate(repositoryWith("# New\n", null))).toBe(2);
    expect(runGate(repositoryWith("# New\n", null), { DOCS_GATE_WITHOUT_PRIVATE_PATTERNS: "1" })).toBe(0);
  });

  it("applies the private patterns in any case, and skips comments, blank lines and carriage returns", () => {
    expect(runGate(repositoryWith("# New\n\nOur host Secret-Box-7 serves it.\n", "# hosts\n\nsecret-box-7\r\n"))).toBe(1);
    expect(runGate(repositoryWith("# New\n\nThe hosts are listed elsewhere.\n", "# hosts\n"))).toBe(0);
  });

  it("fails when a pattern does not compile, instead of treating the error as no match", () => {
    expect(runGate(repositoryWith("# New\n", "foo(\n"))).toBe(2);
  });

  it("allows a password manager placeholder but still reports a secret on the same line", () => {
    expect(runGate(repositoryWith("Use op://vault/item/field here.\n"))).toBe(0);
    expect(runGate(repositoryWith(`Use op://vault/item/field, or ask ${["ops", "example.com"].join("@")}.\n`))).toBe(1);
    expect(runGate(repositoryWith("Use op://vault/item/field or op://Private/key.\n"))).toBe(1);
  });
});
