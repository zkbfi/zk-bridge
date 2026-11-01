import { readFile } from "node:fs/promises";
import type { Address } from "viem";
import { z } from "zod";
import { BotConfigError } from "../config/bot-config.ts";

/**
 * The test token file that `script/testnet/DeployTestTokens.s.sol` writes: one section for each chain id, with the native
 * test tokens of that chain by symbol.
 *
 *     { "943": { "chain_id": 943, "minter": "0x..", "traffic_wallet": "0x..",
 *                "tokens": { "tUSD": { "name": "zkb Test Dollar", "symbol": "tUSD", "decimals": 6, "address": "0x.." } } } }
 */

const addressSchema = z.string().regex(/^0x[0-9a-fA-F]{40}$/, "must be a 20 byte hex address");

const tokenSchema = z.object({
  name: z.string().min(1),
  symbol: z.string().min(1),
  decimals: z.number().int().min(0).max(77),
  address: addressSchema,
});

const sectionSchema = z.object({
  chain_id: z.number().int().positive(),
  tokens: z.record(z.string().min(1), tokenSchema),
});

const fileSchema = z.record(z.string().regex(/^\d+$/, "must be a chain id"), sectionSchema);

/** One native test token on its home chain. */
export interface TestToken {
  /** The chain where the token is native. Its bridged copy lives on the other chain of the pair. */
  readonly chainId: number;
  readonly symbol: string;
  readonly name: string;
  readonly decimals: number;
  readonly address: Address;
}

/**
 * Reads the test tokens from the parsed file.
 *
 * @throws BotConfigError naming the first invalid field, or a section whose key is not its `chain_id`.
 */
export function parseTestTokens(value: unknown): readonly TestToken[] {
  const result = fileSchema.safeParse(value);
  if (!result.success) {
    // A failed parse holds at least one issue.
    const issue = result.error.issues[0] as (typeof result.error.issues)[number];
    throw new BotConfigError(`tokensFile.${issue.path.join(".")}: ${issue.message}`);
  }
  const tokens: TestToken[] = [];
  for (const [key, section] of Object.entries(result.data)) {
    if (String(section.chain_id) !== key) throw new BotConfigError(`tokensFile.${key}: chain_id is ${section.chain_id}, not ${key}.`);
    for (const token of Object.values(section.tokens)) {
      tokens.push({ chainId: section.chain_id, symbol: token.symbol, name: token.name, decimals: token.decimals, address: token.address as Address });
    }
  }
  return tokens;
}

/**
 * Reads and parses the test token file.
 *
 * @throws BotConfigError when the file is missing, is not JSON, or is not valid.
 */
export async function loadTestTokens(path: string): Promise<readonly TestToken[]> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    throw new BotConfigError(`Cannot read the test token file at ${path}: ${(error as Error).message}`);
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new BotConfigError(`The test token file at ${path} is not valid JSON.`);
  }
  return parseTestTokens(value);
}
