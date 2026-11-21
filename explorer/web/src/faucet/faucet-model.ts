/**
 * The testnet faucet token (tFAU) and the gas faucets, as the dapp and the docs use them. tFAU is an open-mint ERC-20 on
 * Sepolia and PulseChain testnet v4 (`src/testnet/FaucetToken.sol`): anyone mints, at most 1,000 a call. Everything here
 * is gated by the pair: only the testnet pair has a tFAU, so a build on any other pair shows none of it.
 *
 * The addresses are kept here, not read from the deployment file, so the bridge screen's first bundle does not carry the
 * facts of every deployment. `test/faucet/faucet-model.test.ts` compares them with `deploy/deployments/sepolia-pls943.json`.
 */
import { encodeFunctionData, parseAbi, type Address } from "viem";
import type { ChainSnapshotResult } from "@terminal/chain/live-reads";
import type { ChainConfig, ChainSide, PairConfig, TokenInfo } from "@terminal/model/types";
import type { WebStep } from "../tx/bridge-steps";

/** The symbol of the faucet token. */
export const FAUCET_SYMBOL = "tFAU";

/** The decimals of the faucet token. */
export const FAUCET_DECIMALS = 18;

/** What one mint asks for: 1,000 tFAU, which is the most one call may mint (`MAX_MINT`). */
export const MINT_UNITS = 1_000n * 10n ** 18n;

/** The docs page that explains the faucets. */
export const FAUCET_DOCS_HREF = "#/docs/get-testnet-tokens";

/** The tFAU contract of each testnet chain (the same address on both: one deployer and nonce). */
export const FAUCET_TOKEN_ADDRESS: Readonly<Record<number, Address>> = {
  11155111: "0x077b01ea09cd6261428166558Cced08f6697f8EB",
  943: "0x077b01ea09cd6261428166558Cced08f6697f8EB",
};

/** A gas faucet: where to get the coin of a testnet chain. */
export type GasFaucet = {
  readonly url: string;
  /** The coin, as a sentence names it: `Sepolia ETH`. */
  readonly coin: string;
};

/** The gas faucets by chain id. Each opens in a new tab. */
export const GAS_FAUCETS: Readonly<Record<number, GasFaucet>> = {
  11155111: {
    url: "https://sepolia-faucet.pk910.de/",
    coin: "Sepolia ETH",
  },
  943: {
    url: "https://faucet.v4.testnet.pulsechain.com/",
    coin: "testnet PLS",
  },
};

/** The calls of tFAU that the confirm dialog decodes, and the one error it reads plainly. */
export const faucetAbi = parseAbi(["function mint(uint256 amount)", "function mint(address to, uint256 amount)", "error AboveMaxMint(uint256 amount, uint256 cap)"]);

/**
 * Whether the pair is a testnet pair: both of its chains have a faucet token. A pair on a main network has none.
 *
 * @param pair The pair the page runs on.
 */
export const isTestnetPair = (pair: PairConfig): boolean => [pair.first, pair.second].every((chain) => FAUCET_TOKEN_ADDRESS[chain.chainId] !== undefined);

/**
 * The tFAU of each chain of the pair, as bridge tokens. Empty unless the pair is a testnet pair.
 *
 * @param pair The pair the page runs on.
 */
export const faucetTokensOf = (pair: PairConfig): readonly TokenInfo[] =>
  isTestnetPair(pair)
    ? ([pair.first, pair.second] as const).map((chain) => ({
        address: FAUCET_TOKEN_ADDRESS[chain.chainId] as Address,
        symbol: FAUCET_SYMBOL,
        decimals: FAUCET_DECIMALS,
        side: chain.side,
        counterpart: null,
      }))
    : [];

const keyOf = (token: TokenInfo): string => `${token.side}:${token.address.toLowerCase()}`;

/**
 * The listed tokens plus the tFAU of each chain that the list does not hold yet (the indexer lists a token once it has
 * been bridged, so a fresh tFAU is not in it). A tFAU that the list holds keeps its own row, with its counterpart.
 *
 * @param listed The tokens of the data source.
 * @param faucet The tFAU tokens of the pair (see {@link faucetTokensOf}).
 */
export const withFaucetTokens = (listed: readonly TokenInfo[], faucet: readonly TokenInfo[]): readonly TokenInfo[] => {
  const held = new Set(listed.map(keyOf));
  const missing = faucet.filter((token) => !held.has(keyOf(token)));
  return missing.length === 0 ? listed : [...listed, ...missing];
};

/**
 * Whether a token is the tFAU of the pair.
 *
 * @param token The token.
 * @param faucet The tFAU tokens of the pair.
 */
export const isFaucetToken = (token: TokenInfo, faucet: readonly TokenInfo[]): boolean => faucet.some((candidate) => keyOf(candidate) === keyOf(token));

/**
 * The balance of the native coin on one side, from the snapshots; null while that side is unread.
 *
 * @param side The chain side.
 * @param snapshots The balances read for the account.
 */
export const nativeBalanceOf = (side: ChainSide, snapshots: readonly ChainSnapshotResult[]): bigint | null => {
  const found = snapshots.find((result) => result.status === "ok" && result.snapshot.chain.side === side);
  return found === undefined || found.status !== "ok" ? null : found.snapshot.nativeBalance;
};

/**
 * The step that mints 1,000 tFAU to the sender on one chain, for the confirm dialog.
 *
 * @param pair The pair the page runs on.
 * @param chainId The chain to mint on.
 * @returns The step, or null when the pair is not a testnet pair or the chain is not in it.
 */
export const mintStepOf = (pair: PairConfig, chainId: number): WebStep | null => {
  const chain: ChainConfig | undefined = [pair.first, pair.second].find((candidate) => candidate.chainId === chainId);
  if (chain === undefined || !isTestnetPair(pair)) return null;
  return {
    plan: {
      title: `Mint 1,000 ${FAUCET_SYMBOL} on ${chain.name}`,
      chain,
      to: FAUCET_TOKEN_ADDRESS[chainId] as Address,
      contractLabel: "zkb Faucet Token",
      functionSignature: "mint(uint256)",
      functionName: "mint",
      data: encodeFunctionData({ abi: faucetAbi, functionName: "mint", args: [MINT_UNITS] }),
      value: 0n,
      arguments: [{ name: "amount", type: "uint256", value: MINT_UNITS.toString(), meaning: `1,000 ${FAUCET_SYMBOL}` }],
      notes: [`${FAUCET_SYMBOL} is a test token with no value. Anyone can mint it, at most 1,000 in one call. This sends nothing but the gas of the call.`],
    },
    disclosure: { feesApplyTo: "this-transaction", destinationNativeSymbol: null, destinationChainId: null, amountToken: { symbol: FAUCET_SYMBOL, decimals: FAUCET_DECIMALS }, delivery: null },
  };
};
