import type { SecretVault } from "../runtime/secrets.ts";
import type { Logger } from "../logging/logger.ts";
import type { SignerConfig } from "../config/bot-config.ts";
// The signers of the terminal dashboard: the same interface, the same key readers. The terminal package keeps its own
// lockfile and is not a dependency of this one, so the import is by path. When the terminal joins the workspace, move
// `signer.ts`, `key-material.ts`, `key-sources.ts`, `keystore.ts` and `mnemonic.ts` to `explorer/shared`.
import { signerFromKeystoreFile, signerFromPrivateKeyText } from "../../../terminal/src/signing/key-sources.ts";
import { createMnemonicSource, expandPath } from "../../../terminal/src/signing/mnemonic.ts";
import type { Signer } from "../../../terminal/src/signing/signer.ts";

export type { Signer } from "../../../terminal/src/signing/signer.ts";
export { assertSignedTransactionMatches } from "../../../terminal/src/signing/signer.ts";

/** Input of {@link openSigner}. */
export interface OpenSignerInput {
  readonly settings: SignerConfig;
  readonly vault: SecretVault;
  readonly logger: Logger;
}

/**
 * Opens the signer that the configuration names. Secrets come from the vault, so a key can live in the secret store,
 * an environment variable or a 1Password item. Hardware wallets load on demand, because their libraries open a device
 * connection.
 *
 * @throws Error when a secret is missing, a key or mnemonic is invalid, or the device refuses.
 */
export async function openSigner(input: OpenSignerInput): Promise<Signer> {
  const { settings, vault } = input;
  if (settings.kind === "private-key") return signerFromPrivateKeyText(await vault.resolve(settings.key));
  if (settings.kind === "keystore") return signerFromKeystoreFile(settings.file, await vault.resolve(settings.password));
  if (settings.kind === "mnemonic") {
    const mnemonic = await vault.resolve(settings.mnemonic);
    const passphrase = settings.passphrase === undefined ? undefined : await vault.resolve(settings.passphrase);
    const source = createMnemonicSource({ mnemonic, passphrase });
    return source.openSigner(expandPath(settings.pathTemplate, settings.index));
  }
  const path = expandPath(settings.pathTemplate, settings.index);
  const onDevicePrompt = (message: string): void => input.logger.warn("device_prompt", { message });
  if (settings.kind === "ledger") {
    const { createLedgerSource } = await import("../../../terminal/src/signing/ledger.ts");
    return createLedgerSource({ onDevicePrompt }).openSigner(path);
  }
  const { createTrezorSource } = await import("../../../terminal/src/signing/trezor.ts");
  return createTrezorSource({ onDevicePrompt }).openSigner(path);
}
