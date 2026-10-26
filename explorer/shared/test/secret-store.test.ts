import { mkdtemp, readFile, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  chooseSecretStore,
  createEncryptedFileStore,
  createKeychainStore,
  createSecretServiceStore,
  decryptSecrets,
  encryptSecrets,
  REDACTED,
  resolveSecretReference,
  SecretResolutionError,
  SecretStoreError,
  SERVICE_NAME,
  spawnRunner,
  WrongPasswordError,
  type CommandResult,
  type CommandRunner,
  type SecretStore,
} from "../src/config/index.js";

const result = (code: number, stdout = "", stderr = ""): CommandResult => ({ code, stdout, stderr });
const runnerReturning = (answer: CommandResult) => vi.fn<CommandRunner>(async () => answer);

describe("spawnRunner exit by signal", () => {
  it("answers code 1 when a signal ends the process and no exit code exists", async () => {
    const answer = await spawnRunner(process.execPath, ["-e", "process.kill(process.pid, 'SIGKILL')"]);
    expect(answer.code).toBe(1);
  });
});

describe("createKeychainStore", () => {
  it("reads a value from `security` and removes one trailing line break", async () => {
    const run = runnerReturning(result(0, "the-value\n"));
    expect(await createKeychainStore(run).get("name")).toBe("the-value");
    expect(run).toHaveBeenCalledWith("security", ["find-generic-password", "-a", "name", "-s", SERVICE_NAME, "-w"]);
  });

  it("answers null when the item is not found (code 44)", async () => {
    expect(await createKeychainStore(runnerReturning(result(44))).get("name")).toBeNull();
  });

  it("throws a SecretStoreError with the exit code and the standard error for another failure", async () => {
    const store = createKeychainStore(runnerReturning(result(1, "", " denied \n")));
    await expect(store.get("name")).rejects.toThrow(new SecretStoreError("Reading the Keychain failed (exit 1): denied"));
  });

  it("writes through the standard input and never through the arguments", async () => {
    const run = runnerReturning(result(0));
    await createKeychainStore(run).set("name", "s3cret-value");
    expect(run).toHaveBeenCalledWith(
      "security",
      ["-i"],
      `add-generic-password -U -a "name" -s "${SERVICE_NAME}" -w "s3cret-value"\n`,
    );
  });

  it.each(['a"b', "a\\b", "a\nb", "a\rb"])("refuses to write the value %j, which could break out of the command", async (value) => {
    const run = runnerReturning(result(0));
    await expect(createKeychainStore(run).set("name", value)).rejects.toThrow("cannot hold a value with a quote");
    expect(run).not.toHaveBeenCalled();
  });

  it("fails a write on a non zero exit and redacts the value from the message", async () => {
    const store = createKeychainStore(runnerReturning(result(1, "", "could not store s3cret-value")));
    await expect(store.set("name", "s3cret-value")).rejects.toThrow(`Writing the Keychain failed (exit 1): could not store ${REDACTED}`);
  });

  it("fails a write when the exit code is zero but the standard error reports an error", async () => {
    const store = createKeychainStore(runnerReturning(result(0, "", "security: error: duplicate")));
    await expect(store.set("name", "s3cret-value")).rejects.toThrow("Writing the Keychain failed");
  });

  it("deletes, and treats a missing item as deleted", async () => {
    const run = runnerReturning(result(44));
    await createKeychainStore(run).delete("name");
    expect(run).toHaveBeenCalledWith("security", ["delete-generic-password", "-a", "name", "-s", SERVICE_NAME]);
    await createKeychainStore(runnerReturning(result(0))).delete("name");
  });

  it("fails a delete on another error", async () => {
    await expect(createKeychainStore(runnerReturning(result(2, "", "no"))).delete("name")).rejects.toThrow(
      "Deleting from the Keychain failed (exit 2): no",
    );
  });

  it("names its kind", () => {
    expect(createKeychainStore(runnerReturning(result(0))).kind).toBe("macos-keychain");
  });
});

describe("createSecretServiceStore", () => {
  const attributes = ["service", SERVICE_NAME, "account", "name"];

  it("looks a value up by service and account", async () => {
    const run = runnerReturning(result(0, "v\n"));
    expect(await createSecretServiceStore(run).get("name")).toBe("v");
    expect(run).toHaveBeenCalledWith("secret-tool", ["lookup", ...attributes]);
  });

  it("answers null when the lookup fails with no output", async () => {
    expect(await createSecretServiceStore(runnerReturning(result(1))).get("name")).toBeNull();
  });

  it("stores through the standard input with a label", async () => {
    const run = runnerReturning(result(0));
    await createSecretServiceStore(run).set("name", "value-123");
    expect(run).toHaveBeenCalledWith("secret-tool", ["store", `--label=${SERVICE_NAME} name`, ...attributes], "value-123");
  });

  it("fails a store and redacts the value", async () => {
    const store = createSecretServiceStore(runnerReturning(result(1, "", "bad value-123")));
    await expect(store.set("name", "value-123")).rejects.toThrow(`Writing the Secret Service failed (exit 1): bad ${REDACTED}`);
  });

  it("clears a value and fails on a non zero exit", async () => {
    const run = runnerReturning(result(0));
    await createSecretServiceStore(run).delete("name");
    expect(run).toHaveBeenCalledWith("secret-tool", ["clear", ...attributes]);
    await expect(createSecretServiceStore(runnerReturning(result(3, "", "x"))).delete("name")).rejects.toThrow(
      "Deleting from the Secret Service failed (exit 3): x",
    );
  });

  it("names its kind", () => {
    expect(createSecretServiceStore(runnerReturning(result(0))).kind).toBe("secret-service");
  });
});

describe("encryptSecrets and decryptSecrets", () => {
  it("round trips and holds no secret in plain text", async () => {
    const text = await encryptSecrets({ a: "plain-secret-value" }, "pw");
    expect(text).not.toContain("plain-secret-value");
    expect(await decryptSecrets(text, "pw")).toEqual({ a: "plain-secret-value" });
  });

  it("uses a new salt and nonce on every call", async () => {
    const first = JSON.parse(await encryptSecrets({}, "pw"));
    const second = JSON.parse(await encryptSecrets({}, "pw"));
    expect(first.salt).not.toBe(second.salt);
    expect(first.nonce).not.toBe(second.nonce);
  });

  it("throws WrongPasswordError for a wrong password", async () => {
    const text = await encryptSecrets({ a: "b" }, "right");
    await expect(decryptSecrets(text, "wrong")).rejects.toThrow(new WrongPasswordError());
  });

  it("throws WrongPasswordError when the ciphertext is damaged", async () => {
    const file = JSON.parse(await encryptSecrets({ a: "b" }, "pw"));
    file.ciphertext = "00" + file.ciphertext.slice(2);
    await expect(decryptSecrets(JSON.stringify(file), "pw")).rejects.toBeInstanceOf(WrongPasswordError);
  });

  it.each([{ version: 2 }, { kdf: "pbkdf2" }, { cipher: "aes-128-cbc" }])("refuses an unsupported format %j", async (change) => {
    const file = { ...JSON.parse(await encryptSecrets({}, "pw")), ...change };
    await expect(decryptSecrets(JSON.stringify(file), "pw")).rejects.toThrow("unsupported format");
  });
});

describe("createEncryptedFileStore", () => {
  const open = async () => {
    const directory = await mkdtemp(join(tmpdir(), "secrets-"));
    const path = join(directory, "nested", "secrets.enc.json");
    return { directory, path, store: createEncryptedFileStore({ path, password: "pw" }) };
  };

  it("answers null for a missing file and a missing name", async () => {
    const { store } = await open();
    expect(await store.get("a")).toBeNull();
    await store.set("b", "1");
    expect(await store.get("a")).toBeNull();
  });

  it("keeps earlier values when it sets another, and writes the file with mode 0600", async () => {
    const { store, path } = await open();
    await store.set("a", "1");
    await store.set("b", "2");
    expect(await store.get("a")).toBe("1");
    expect(await store.get("b")).toBe("2");
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await readFile(path, "utf8")).not.toContain('"1"');
  });

  it("deletes one name and keeps the others", async () => {
    const { store } = await open();
    await store.set("a", "1");
    await store.set("b", "2");
    await store.delete("a");
    expect(await store.get("a")).toBeNull();
    expect(await store.get("b")).toBe("2");
  });

  it("leaves no temporary file after a write", async () => {
    const { store, path } = await open();
    await store.set("a", "1");
    expect(await readdir(join(path, ".."))).toEqual(["secrets.enc.json"]);
  });

  it("rethrows a read error that is not a missing file", async () => {
    const { directory } = await open();
    const store = createEncryptedFileStore({ path: directory, password: "pw" });
    await expect(store.get("a")).rejects.toMatchObject({ code: "EISDIR" });
  });

  it("fails with WrongPasswordError for another password and does not change the file", async () => {
    const { store, path } = await open();
    await store.set("a", "1");
    const before = await readFile(path, "utf8");
    const other = createEncryptedFileStore({ path, password: "other" });
    await expect(other.set("b", "2")).rejects.toBeInstanceOf(WrongPasswordError);
    expect(await readFile(path, "utf8")).toBe(before);
  });

  it("names its kind", async () => {
    expect((await open()).store.kind).toBe("encrypted-file");
  });
});

describe("chooseSecretStore", () => {
  const fallbackStore = { kind: "encrypted-file" } as SecretStore;
  const fallback = vi.fn(async () => fallbackStore);

  it("picks the Keychain on macOS when `security` runs", async () => {
    const run = runnerReturning(result(0));
    const store = await chooseSecretStore({ platform: "darwin", run, fallback });
    expect(store.kind).toBe("macos-keychain");
    expect(run).toHaveBeenCalledWith("security", ["help"]);
  });

  it("accepts a `security` that exits non zero but prints output", async () => {
    expect((await chooseSecretStore({ platform: "darwin", run: runnerReturning(result(1, "", "usage")), fallback })).kind).toBe("macos-keychain");
    expect((await chooseSecretStore({ platform: "darwin", run: runnerReturning(result(1, "usage", "")), fallback })).kind).toBe("macos-keychain");
  });

  it("picks the Secret Service on Linux when `secret-tool` runs", async () => {
    const run = runnerReturning(result(0));
    expect((await chooseSecretStore({ platform: "linux", run, fallback })).kind).toBe("secret-service");
    expect(run).toHaveBeenCalledWith("secret-tool", ["--version"]);
  });

  it("falls back when the command gives code 127 with no output", async () => {
    expect(await chooseSecretStore({ platform: "linux", run: runnerReturning(result(127)), fallback })).toBe(fallbackStore);
    expect(await chooseSecretStore({ platform: "darwin", run: runnerReturning(result(127)), fallback })).toBe(fallbackStore);
  });

  it("falls back when the runner throws", async () => {
    const run = vi.fn<CommandRunner>(async () => {
      throw new Error("spawn failed");
    });
    expect(await chooseSecretStore({ platform: "linux", run, fallback })).toBe(fallbackStore);
  });

  it("falls back on a platform with no system store, without running a command", async () => {
    const run = runnerReturning(result(0));
    expect(await chooseSecretStore({ platform: "win32", run, fallback })).toBe(fallbackStore);
    expect(run).not.toHaveBeenCalled();
  });
});

describe("resolveSecretReference", () => {
  const store = { get: vi.fn(async (name: string) => (name === "present" ? "stored-value" : null)) } as unknown as SecretStore;
  const base = { store, environment: { SET: "env-value", EMPTY: "" }, run: runnerReturning(result(0)) };

  it("reads an environment variable", async () => {
    expect(await resolveSecretReference({ source: "environment", variable: "SET" }, base)).toBe("env-value");
  });

  it.each(["EMPTY", "MISSING"])("refuses the environment variable %s that is empty or unset", async (variable) => {
    await expect(resolveSecretReference({ source: "environment", variable }, base)).rejects.toThrow(
      new SecretResolutionError(`The environment variable ${variable} is not set.`),
    );
  });

  it("reads a 1Password item through `op read` and keeps the value as is", async () => {
    const run = runnerReturning(result(0, "op-value"));
    expect(await resolveSecretReference({ source: "onepassword", reference: "op://v/i/f" }, { ...base, run })).toBe("op-value");
    expect(run).toHaveBeenCalledWith("op", ["read", "--no-newline", "op://v/i/f"]);
  });

  it("names the reference and redacts the standard error when `op read` fails", async () => {
    const run = runnerReturning(result(1, "", "denied for Bearer abcdefgh12345 \n"));
    await expect(resolveSecretReference({ source: "onepassword", reference: "op://v/i/f" }, { ...base, run })).rejects.toThrow(
      `op read op://v/i/f failed: denied for Bearer ${REDACTED}`,
    );
  });

  it("reads from the store", async () => {
    expect(await resolveSecretReference({ source: "store", name: "present" }, base)).toBe("stored-value");
  });

  it("refuses a store reference when no store is open", async () => {
    await expect(resolveSecretReference({ source: "store", name: "present" }, { ...base, store: null })).rejects.toThrow(
      "No secret store is open. Unlock it first.",
    );
  });

  it("refuses a store name with no value and names the reference, not a value", async () => {
    await expect(resolveSecretReference({ source: "store", name: "absent" }, base)).rejects.toThrow("Nothing is stored under absent.");
  });
});
