import {
  chooseSecretStore,
  createEncryptedFileStore,
  encryptedSecretsPath,
  resolveSecretReference,
  type CommandRunner,
  type SecretReference,
  type SecretStore,
} from "@zk-bridge/shared/config";
import type { z } from "zod";
import { BotConfigError, type secretStoreSchema } from "../config/bot-config.ts";

/** A mutable view of the environment. Tests pass a plain object. */
export type Environment = Readonly<Record<string, string | undefined>>;

/**
 * Resolves references to secrets and remembers every value it returned. The logger asks `knownSecrets` for the values
 * to remove from each line.
 */
export interface SecretVault {
  /** Reads the value that a reference points to. The caller must not log it. */
  resolve(reference: SecretReference): Promise<string>;
  /** Like `resolve`, and null for a missing reference. */
  resolveOptional(reference: SecretReference | null | undefined): Promise<string | null>;
  /** Registers a secret that did not come from a reference, such as a derived value. */
  remember(value: string): void;
  /** Every secret value resolved so far. */
  knownSecrets(): readonly string[];
}

/** Input of {@link createSecretVault}. */
export interface SecretVaultInput {
  readonly store: SecretStore | null;
  readonly environment: Environment;
  readonly run: CommandRunner;
}

/** Builds a vault over a store, the environment and the 1Password command. */
export function createSecretVault(input: SecretVaultInput): SecretVault {
  const known = new Set<string>();
  const remember = (value: string): void => {
    if (value !== "") known.add(value);
  };
  const resolve = async (reference: SecretReference): Promise<string> => {
    const value = await resolveSecretReference(reference, input);
    remember(value);
    return value;
  };
  return {
    resolve,
    resolveOptional: async (reference) => (reference === null || reference === undefined ? null : resolve(reference)),
    remember,
    knownSecrets: () => [...known],
  };
}

/** Input of {@link openSecretStore}. */
export interface OpenSecretStoreInput {
  readonly settings: z.infer<typeof secretStoreSchema>;
  readonly environment: Environment;
  readonly platform: NodeJS.Platform;
  readonly run: CommandRunner;
}

/**
 * Opens the secret store that the configuration names.
 *
 * @returns The store, or null when the configuration says `none`.
 * @throws BotConfigError when the encrypted file needs a password and the variable is not set.
 */
export async function openSecretStore(input: OpenSecretStoreInput): Promise<SecretStore | null> {
  const { settings, environment } = input;
  if (settings.kind === "none") return null;
  const encryptedFile = async (): Promise<SecretStore> => {
    const variable = settings.passwordVariable;
    const password = variable === undefined ? undefined : environment[variable];
    if (password === undefined || password === "") {
      throw new BotConfigError("secretStore.passwordVariable must name a set environment variable for the encrypted file.");
    }
    return createEncryptedFileStore({ path: settings.file ?? encryptedSecretsPath(environment), password });
  };
  if (settings.kind === "encrypted-file") return encryptedFile();
  return chooseSecretStore({ platform: input.platform, run: input.run, fallback: encryptedFile });
}
