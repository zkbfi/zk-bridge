import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const gate = join(dirname(fileURLToPath(import.meta.url)), "../../../script/check-docs-public.sh");
const folders: string[] = [];

/** A fresh repository with the gate script, one clean tracked page, and the given untracked page. */
const repositoryWith = (untrackedText: string): string => {
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
  return root;
};
const runGate = (root: string): number => {
  try {
    execFileSync("bash", [join(root, "script/check-docs-public.sh")], { cwd: root, stdio: "pipe" });
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
});
