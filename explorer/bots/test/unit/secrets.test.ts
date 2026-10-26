import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BotConfigError } from "../../src/config/bot-config.ts";
import { createSecretVault, openSecretStore } from "../../src/runtime/secrets.ts";

const scratch: string[] = [];
afterEach(async () => {
  await Promise.all(scratch.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

const unavailable = async () => {
  throw new Error("command not found");
};
const works = async () => ({ code: 0, stdout: "", stderr: "" });

describe("the secret vault", () => {
  it("never remembers an empty value, because the logger would remove every empty match", () => {
    const vault = createSecretVault({ store: null, environment: {}, run: works });
    vault.remember("");
    vault.remember("s3cret-value");
    expect(vault.knownSecrets()).toEqual(["s3cret-value"]);
  });

  it("remembers a derived secret once, however often it is registered", () => {
    const vault = createSecretVault({ store: null, environment: {}, run: works });
    vault.remember("derived");
    vault.remember("derived");
    expect(vault.knownSecrets()).toEqual(["derived"]);
  });

  it("resolves an optional reference that is undefined to null, and reads one that is set", async () => {
    const vault = createSecretVault({ store: null, environment: { TOKEN: "abc123" }, run: works });
    expect(await vault.resolveOptional(undefined)).toBeNull();
    expect(await vault.resolveOptional({ source: "environment", variable: "TOKEN" })).toBe("abc123");
    expect(vault.knownSecrets()).toEqual(["abc123"]);
  });
});

describe("openSecretStore", () => {
  it("returns no store when the configuration says none", async () => {
    expect(await openSecretStore({ settings: { kind: "none" }, environment: {}, platform: "linux", run: works })).toBeNull();
  });

  it("refuses the encrypted file when no password variable is named", async () => {
    const open = openSecretStore({ settings: { kind: "encrypted-file", file: "/unused" }, environment: { PASSWORD: "x" }, platform: "linux", run: works });
    await expect(open).rejects.toThrow(BotConfigError);
    await expect(open).rejects.toThrow("secretStore.passwordVariable must name a set environment variable for the encrypted file.");
  });

  it("refuses the encrypted file when the named variable is empty", async () => {
    const open = openSecretStore({ settings: { kind: "encrypted-file", file: "/unused", passwordVariable: "PASSWORD" }, environment: { PASSWORD: "" }, platform: "linux", run: works });
    await expect(open).rejects.toThrow(BotConfigError);
  });

  it("puts the encrypted file in the default path of the dashboard when the configuration names no file", async () => {
    const home = await mkdtemp(join(tmpdir(), "secrets-home-"));
    scratch.push(home);
    const environment = { EXPLORER_CONFIG_DIR: home, PASSWORD: "correct horse battery" };
    const store = await openSecretStore({ settings: { kind: "encrypted-file", passwordVariable: "PASSWORD" }, environment, platform: "linux", run: works });
    await store?.set("name", "value");
    expect((await stat(join(home, "secrets.enc.json"))).isFile()).toBe(true);
  });

  it("uses the Secret Service on Linux when secret-tool works", async () => {
    const store = await openSecretStore({ settings: { kind: "system" }, environment: {}, platform: "linux", run: works });
    expect(store?.kind).toBe("secret-service");
  });

  it("uses the Keychain on macOS when the security command works", async () => {
    const store = await openSecretStore({ settings: { kind: "system" }, environment: {}, platform: "darwin", run: works });
    expect(store?.kind).toBe("macos-keychain");
  });

  it("falls back to the encrypted file when the platform has no system store", async () => {
    const directory = await mkdtemp(join(tmpdir(), "secrets-fallback-"));
    scratch.push(directory);
    const store = await openSecretStore({
      settings: { kind: "system", file: join(directory, "secrets.enc.json"), passwordVariable: "PASSWORD" },
      environment: { PASSWORD: "correct horse battery" },
      platform: "linux",
      run: unavailable,
    });
    expect(store?.kind).toBe("encrypted-file");
  });

  it("refuses the fallback file without a password when the system has no store", async () => {
    const open = openSecretStore({ settings: { kind: "system" }, environment: {}, platform: "win32", run: unavailable });
    await expect(open).rejects.toThrow(BotConfigError);
  });
});
