import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { refuseSecretsPlugin } from "../refuse-secrets";

const folders: string[] = [];
const folderWith = (line: string): string => {
  const folder = mkdtempSync(join(tmpdir(), "docs-secrets-"));
  folders.push(folder);
  writeFileSync(join(folder, [".", "env"].join("")), line);
  return folder;
};
const runConfig = (folder: string): void => {
  const hook = refuseSecretsPlugin(folder).config as (config: object, environment: { mode: string; command: string }) => void;
  hook({}, { mode: "production", command: "build" });
};

afterEach(() => folders.splice(0).forEach((folder) => rmSync(folder, { recursive: true, force: true })));

describe("refuseSecretsPlugin", () => {
  it("stops the build when a VITE_ variable looks like a key, and never prints the value", () => {
    const folder = folderWith(`VITE_RPC=https://one.valve.city/rpc/${"a1".repeat(14)}/evm/1\n`);
    expect(() => runConfig(folder)).toThrow(/Refusing to build[\s\S]*VITE_RPC/);
    expect(() => runConfig(folder)).not.toThrow(/a1a1a1/);
  });

  it("lets a build with no secret-like variable go on", () => {
    expect(() => runConfig(folderWith("VITE_TITLE=hello\n"))).not.toThrow();
  });
});
