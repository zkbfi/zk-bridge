import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  configDirectory,
  emptyProverSetup,
  encryptedSecretsPath,
  loadProverSetup,
  ProverSetupError,
  saveProverSetup,
  setupFilePath,
} from "../src/config/index.js";

describe("configDirectory", () => {
  it("prefers EXPLORER_CONFIG_DIR", () => {
    expect(configDirectory({ EXPLORER_CONFIG_DIR: "/a", XDG_CONFIG_HOME: "/b" })).toBe("/a");
  });

  it("uses the XDG directory when no explicit directory is set", () => {
    expect(configDirectory({ XDG_CONFIG_HOME: "/b" })).toBe("/b/zk-bridge-explorer");
  });

  it("falls back to the .config directory of the home directory", () => {
    expect(configDirectory({})).toBe(join(homedir(), ".config", "zk-bridge-explorer"));
  });

  it("treats an empty variable as unset", () => {
    expect(configDirectory({ EXPLORER_CONFIG_DIR: "", XDG_CONFIG_HOME: "" })).toBe(join(homedir(), ".config", "zk-bridge-explorer"));
  });
});

describe("file paths", () => {
  it("puts the setup and the encrypted secrets in the configuration directory", () => {
    const environment = { EXPLORER_CONFIG_DIR: "/c" };
    expect(setupFilePath(environment)).toBe("/c/prover-setup.json");
    expect(encryptedSecretsPath(environment)).toBe("/c/secrets.enc.json");
  });
});

describe("loadProverSetup and saveProverSetup", () => {
  it("gives the empty setup for a missing file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "setup-"));
    expect(await loadProverSetup(join(directory, "none.json"))).toEqual(emptyProverSetup());
  });

  it("rethrows a read error that is not a missing file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "setup-"));
    await expect(loadProverSetup(directory)).rejects.toMatchObject({ code: "EISDIR" });
  });

  it("saves with mode 0600 in a new directory and loads the same setup back", async () => {
    const directory = await mkdtemp(join(tmpdir(), "setup-"));
    const path = join(directory, "nested", "prover-setup.json");
    const setup = { ...emptyProverSetup("a-b"), endpointUrl: "https://x.api.runpod.ai" };
    await saveProverSetup(path, setup);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await loadProverSetup(path)).toEqual(setup);
    expect((await readFile(path, "utf8")).endsWith("}\n")).toBe(true);
  });

  it("refuses to save an invalid setup and writes nothing", async () => {
    const directory = await mkdtemp(join(tmpdir(), "setup-"));
    const path = join(directory, "prover-setup.json");
    const invalid = { ...emptyProverSetup(), endpointUrl: "http://example.com" };
    await expect(saveProverSetup(path, invalid)).rejects.toThrow(ProverSetupError);
    await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses to load a file that holds a bare secret in place of a reference", async () => {
    const directory = await mkdtemp(join(tmpdir(), "setup-"));
    const path = join(directory, "prover-setup.json");
    await writeFile(path, JSON.stringify({ ...emptyProverSetup(), runpodApiKey: "rpa_plain" }));
    await expect(loadProverSetup(path)).rejects.toThrow("setup.runpodApiKey must be an object.");
  });
});
