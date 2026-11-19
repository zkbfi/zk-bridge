/**
 * The facts of the bridge that pages and tools share: the chains (from the shared chain metadata) and the contracts
 * (from `deploy/deployments/*.json`). They are written to `/data/chains.json` and `/data/contracts.json`, and a page
 * may embed one with a placeholder such as `{{contracts.11155111.bridge}}` that the build resolves.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CHAIN_METADATA } from "../../data/src/chain-metadata.ts";
import { defaultFinalitySeconds, secondsPerSlot } from "../../data/src/status.ts";

export { resolvePlaceholders } from "./placeholders.ts";

/** One chain of `chains.json`. */
export type ChainFact = {
  readonly id: number;
  readonly name: string;
  readonly nativeSymbol: string;
  readonly explorers: readonly { readonly name: string; readonly base: string; readonly hashRouter: boolean }[];
  /** Seconds of one beacon slot. */
  readonly slotSeconds: number;
  /** Seconds a send waits for finality: two epochs of 32 slots. */
  readonly finalitySeconds: number;
};

export type ChainsFile = { readonly schema: 1; readonly chains: Readonly<Record<string, ChainFact>> };

/** One test token of a deployment. */
export type TestTokenFact = { readonly address: string; readonly decimals: number; readonly name: string; readonly symbol: string };

export type DeployedContractFact = { readonly name: string; readonly address: string; readonly group: string; readonly role: string };

/** The contracts of one chain of a deployed pair. */
export type ChainContractsFact = {
  readonly chainId: number;
  readonly name: string;
  readonly pair: string;
  readonly bridge: string;
  readonly lightClient: string;
  readonly mediator: string;
  readonly deliveryRouter: string | null;
  readonly tokenFactory: string;
  readonly gate: string;
  readonly wrappedNative: string;
  readonly forkRegistry: string | null;
  readonly startBlock: number;
  /** Every contract of the chain's `contracts` list in the deployment file (libraries, verifier, tokens, retired contracts), without verification status; the page `deployed-contracts` shows the status. */
  readonly deployedContracts: readonly DeployedContractFact[];
  readonly testTokens: Readonly<Record<string, TestTokenFact>>;
};

export type ContractsFile = { readonly schema: 1; readonly pairs: readonly string[]; readonly chains: Readonly<Record<string, ChainContractsFact>> };

/** Both fact files together. */
export type Facts = { readonly chains: ChainsFile; readonly contracts: ContractsFile };

/** The chains.json document, from the shared chain metadata. */
export const buildChainsFile = (): ChainsFile => ({
  schema: 1,
  chains: Object.fromEntries(
    Object.entries(CHAIN_METADATA).map(([id, chain]) => [
      id,
      {
        id: Number(id),
        name: chain.name,
        nativeSymbol: chain.nativeSymbol,
        explorers: chain.explorers.map((explorer) => ({ name: explorer.name, base: explorer.base, hashRouter: explorer.hashRouter })),
        slotSeconds: secondsPerSlot(Number(id)),
        finalitySeconds: defaultFinalitySeconds(Number(id)),
      } satisfies ChainFact,
    ]),
  ),
});

const addressOf = (value: unknown, what: string): string => {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(value)) throw new Error(`${what} must be a 20 byte hex address`);
  return value;
};

const optionalAddressOf = (value: unknown, what: string): string | null => (value === undefined || value === null ? null : addressOf(value, what));

/**
 * The contracts.json document: every deployment file in the folder (a pair the dapp ships), one entry per chain, with
 * the test tokens of `<pair>.test-tokens.json` when it exists. The traffic wallet and the minter of the test tokens are
 * left out.
 *
 * @param deploymentsFolder The `deploy/deployments` folder.
 */
export const buildContractsFile = (deploymentsFolder: string): ContractsFile => {
  const files = readdirSync(deploymentsFolder).filter((file) => file.endsWith(".json") && !file.endsWith(".test-tokens.json")).sort();
  const chains: Record<string, ChainContractsFact> = {};
  const pairs: string[] = [];
  for (const file of files) {
    const pair = file.replace(/\.json$/, "");
    pairs.push(pair);
    const deployment = JSON.parse(readFileSync(join(deploymentsFolder, file), "utf8")) as Record<string, Record<string, unknown>>;
    let tokens: Record<string, { tokens?: Record<string, TestTokenFact> }> = {};
    try {
      tokens = JSON.parse(readFileSync(join(deploymentsFolder, `${pair}.test-tokens.json`), "utf8")) as typeof tokens;
    } catch {
      // A pair without test tokens is fine.
    }
    for (const section of Object.values(deployment)) {
      const chainId = section.chain_id;
      if (typeof chainId !== "number") continue;
      const where = `${file}, chain ${chainId}`;
      if (String(chainId) in chains) throw new Error(`chain ${chainId} appears in two deployments`);
      chains[String(chainId)] = {
        chainId,
        name: CHAIN_METADATA[chainId]?.name ?? `chain ${chainId}`,
        pair,
        bridge: addressOf(section.bridge, `${where}: bridge`),
        lightClient: addressOf(section.light_client, `${where}: light_client`),
        mediator: addressOf(section.mediator, `${where}: mediator`),
        deliveryRouter: optionalAddressOf(section.delivery_router, `${where}: delivery_router`),
        tokenFactory: addressOf(section.token_factory, `${where}: token_factory`),
        gate: addressOf(section.gate, `${where}: gate`),
        wrappedNative: addressOf(section.wrapped_native, `${where}: wrapped_native`),
        forkRegistry: optionalAddressOf(section.fork_registry, `${where}: fork_registry`),
        startBlock: typeof section.start_block === "number" ? section.start_block : 0,
        deployedContracts: (Array.isArray(section.contracts) ? (section.contracts as Record<string, unknown>[]) : []).map((entry, index) => ({
          name: String(entry.name),
          address: addressOf(entry.address, `${where}: contracts[${index}].address`),
          group: String(entry.group),
          role: String(entry.role),
        })),
        testTokens: Object.fromEntries(
          Object.entries(tokens[String(chainId)]?.tokens ?? {}).map(([symbol, token]) => [
            symbol,
            { address: addressOf(token.address, `${pair} test token ${symbol}`), decimals: token.decimals, name: token.name, symbol: token.symbol },
          ]),
        ),
      };
    }
  }
  return { schema: 1, pairs, chains };
};

/** Every address of the contracts file, lowercase. */
export const allContractAddresses = (contracts: ContractsFile): Set<string> => {
  const found = new Set<string>();
  for (const chain of Object.values(contracts.chains)) {
    for (const value of [chain.bridge, chain.lightClient, chain.mediator, chain.deliveryRouter, chain.tokenFactory, chain.gate, chain.wrappedNative, chain.forkRegistry]) {
      if (value !== null) found.add(value.toLowerCase());
    }
    for (const token of Object.values(chain.testTokens)) found.add(token.address.toLowerCase());
    for (const contract of chain.deployedContracts) found.add(contract.address.toLowerCase());
  }
  return found;
};

/** Reads both fact files from a deployments folder. */
export const loadFactsFrom = (deploymentsFolder: string): Facts => ({ chains: buildChainsFile(), contracts: buildContractsFile(deploymentsFolder) });

/** Reads both fact files for a repository. */
export const loadFacts = (repositoryRoot: string): Facts => loadFactsFrom(join(repositoryRoot, "deploy/deployments"));
