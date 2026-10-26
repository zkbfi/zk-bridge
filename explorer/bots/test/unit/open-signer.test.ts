import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SignerConfig } from "../../src/config/bot-config.ts";
import { createSecretVault } from "../../src/runtime/secrets.ts";
import { openSigner } from "../../src/signing/open-signer.ts";
import { memoryLogger } from "../support/builders.ts";

const openLedgerSigner = vi.fn();
const openTrezorSigner = vi.fn();
const createLedgerSource = vi.fn((_input: unknown) => ({ openSigner: openLedgerSigner }));
const createTrezorSource = vi.fn((_input: unknown) => ({ openSigner: openTrezorSigner }));
vi.mock("../../../terminal/src/signing/ledger.ts", () => ({ createLedgerSource: (input: unknown) => createLedgerSource(input) }));
vi.mock("../../../terminal/src/signing/trezor.ts", () => ({ createTrezorSource: (input: unknown) => createTrezorSource(input) }));

// The public development keys of Anvil. None holds funds on a live chain.
const ANVIL_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const ANVIL_ADDRESS = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const ANVIL_ADDRESS_ONE = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const ANVIL_MNEMONIC = "test test test test test test test test test test test junk";
const CAST_PASSWORD = "correct horse battery staple";
const castKeystorePath = new URL("../../../terminal/test/fixtures/cast-keystore.json", import.meta.url).pathname;

const scratch: string[] = [];
afterEach(async () => {
  vi.clearAllMocks();
  await Promise.all(scratch.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function open(settings: SignerConfig, environment: Record<string, string>) {
  const { logger, events } = memoryLogger();
  const vault = createSecretVault({ store: null, environment, run: async () => ({ stdout: "", stderr: "", exitCode: 1 }) as never });
  return { opened: openSigner({ settings, vault, logger }), events };
}

describe("openSigner with a software key", () => {
  it("opens a private key that the vault resolves from the environment", async () => {
    const { opened } = open({ kind: "private-key", key: { source: "environment", variable: "KEY" } }, { KEY: ANVIL_KEY });
    const signer = await opened;
    expect(signer.kind).toBe("private-key");
    expect(signer.address).toBe(ANVIL_ADDRESS);
  });

  it("refuses text that is not a private key", async () => {
    const { opened } = open({ kind: "private-key", key: { source: "environment", variable: "KEY" } }, { KEY: "not-a-key" });
    await expect(opened).rejects.toThrow();
  });

  it("opens the keystore that Foundry wrote, with the password from the vault", async () => {
    const settings: SignerConfig = { kind: "keystore", file: castKeystorePath, password: { source: "environment", variable: "PASSWORD" } };
    const signer = await open(settings, { PASSWORD: CAST_PASSWORD }).opened;
    expect(signer.kind).toBe("keystore");
    expect(signer.address).toBe(ANVIL_ADDRESS);
  });

  it("rejects a keystore password that is wrong", async () => {
    const settings: SignerConfig = { kind: "keystore", file: castKeystorePath, password: { source: "environment", variable: "PASSWORD" } };
    await expect(open(settings, { PASSWORD: "wrong" }).opened).rejects.toThrow("Wrong password");
  });

  it("derives the account of the index from the mnemonic and the path template", async () => {
    const base = { kind: "mnemonic", mnemonic: { source: "environment", variable: "WORDS" }, pathTemplate: "m/44'/60'/0'/0/{index}" } as const;
    const first = await open({ ...base, index: 0 }, { WORDS: ANVIL_MNEMONIC }).opened;
    const second = await open({ ...base, index: 1 }, { WORDS: ANVIL_MNEMONIC }).opened;
    expect(first.address).toBe(ANVIL_ADDRESS);
    expect(first.derivationPath).toBe("m/44'/60'/0'/0/0");
    expect(second.address).toBe(ANVIL_ADDRESS_ONE);
    expect(second.derivationPath).toBe("m/44'/60'/0'/0/1");
  });

  it("changes the account when the mnemonic has a passphrase", async () => {
    const settings: SignerConfig = {
      kind: "mnemonic",
      mnemonic: { source: "environment", variable: "WORDS" },
      passphrase: { source: "environment", variable: "PASSPHRASE" },
      pathTemplate: "m/44'/60'/0'/0/{index}",
      index: 0,
    };
    const signer = await open(settings, { WORDS: ANVIL_MNEMONIC, PASSPHRASE: "extra" }).opened;
    expect(signer.address).not.toBe(ANVIL_ADDRESS);
  });

  it("registers every secret it resolved with the vault, so the logger removes it", async () => {
    const { logger } = memoryLogger();
    const vault = createSecretVault({ store: null, environment: { KEY: ANVIL_KEY }, run: async () => ({}) as never });
    await openSigner({ settings: { kind: "private-key", key: { source: "environment", variable: "KEY" } }, vault, logger });
    expect(vault.knownSecrets()).toEqual([ANVIL_KEY]);
  });

  it("refuses a keystore file that holds no keystore", async () => {
    const directory = await mkdtemp(join(tmpdir(), "open-signer-"));
    scratch.push(directory);
    await writeFile(join(directory, "broken.json"), "{}");
    const settings: SignerConfig = { kind: "keystore", file: join(directory, "broken.json"), password: { source: "environment", variable: "PASSWORD" } };
    await expect(open(settings, { PASSWORD: CAST_PASSWORD }).opened).rejects.toThrow();
  });
});

describe("openSigner with a hardware wallet", () => {
  const device = { pathTemplate: "m/44'/60'/0'/0/{index}", index: 3 } as const;

  it("opens the ledger at the expanded path and forwards device prompts to the log as warnings", async () => {
    const ledgerSigner = { kind: "ledger" };
    openLedgerSigner.mockResolvedValue(ledgerSigner);
    const { opened, events } = open({ kind: "ledger", ...device }, {});
    expect(await opened).toBe(ledgerSigner);
    expect(openLedgerSigner).toHaveBeenCalledWith("m/44'/60'/0'/0/3");
    expect(createTrezorSource).not.toHaveBeenCalled();
    const { onDevicePrompt } = createLedgerSource.mock.calls[0]![0] as { onDevicePrompt: (message: string) => void };
    onDevicePrompt("Approve on the device");
    expect(events()).toEqual([{ time: "1970-01-01T00:00:00.000Z", level: "warn", event: "device_prompt", message: "Approve on the device" }]);
  });

  it("opens the trezor at the expanded path", async () => {
    const trezorSigner = { kind: "trezor" };
    openTrezorSigner.mockResolvedValue(trezorSigner);
    expect(await open({ kind: "trezor", ...device }, {}).opened).toBe(trezorSigner);
    expect(openTrezorSigner).toHaveBeenCalledWith("m/44'/60'/0'/0/3");
    expect(createLedgerSource).not.toHaveBeenCalled();
  });
});
