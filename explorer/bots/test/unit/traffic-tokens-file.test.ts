import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BotConfigError } from "../../src/config/bot-config.ts";
import { loadTestTokens, parseTestTokens } from "../../src/traffic/tokens-file.ts";
import { DOLLAR, PLAIN, tokenFile } from "../support/traffic.ts";

/** The shape that `script/testnet/DeployTestTokens.s.sol` writes, as it wrote it on two local chains. */
const TOKEN_FILE = {
  ...tokenFile([11155111, 943]),
  "943": { chain_id: 943, minter: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266", tokens: { tUSD: { address: DOLLAR, decimals: 6, name: "zkb Test Dollar", symbol: "tUSD" } } },
};

const directories: string[] = [];
afterEach(async () => {
  while (directories.length > 0) await rm(directories.pop() as string, { recursive: true, force: true });
});

async function fileWith(text: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "traffic-tokens-"));
  directories.push(directory);
  const path = join(directory, "test-tokens.json");
  await writeFile(path, text);
  return path;
}

describe("the test token file", () => {
  it("lists every native token with its home chain", () => {
    expect(parseTestTokens(TOKEN_FILE)).toEqual([
      { chainId: 943, symbol: "tUSD", name: "zkb Test Dollar", decimals: 6, address: DOLLAR },
      { chainId: 11155111, symbol: "tTKN", name: "zkb Test Token", decimals: 18, address: PLAIN },
      { chainId: 11155111, symbol: "tUSD", name: "zkb Test Dollar", decimals: 6, address: DOLLAR },
    ]);
  });

  it("names the first invalid field", () => {
    expect(() => parseTestTokens({ "943": { chain_id: 943, tokens: { tUSD: { address: "0x12", decimals: 6, name: "x", symbol: "tUSD" } } } })).toThrow(
      new BotConfigError("tokensFile.943.tokens.tUSD.address: must be a 20 byte hex address"),
    );
  });

  it("refuses a section whose key is not its chain id", () => {
    expect(() => parseTestTokens({ "943": { ...TOKEN_FILE["943"], chain_id: 369 } })).toThrow("tokensFile.943: chain_id is 369, not 943.");
  });

  it("loads the file", async () => {
    expect(await loadTestTokens(await fileWith(JSON.stringify(TOKEN_FILE)))).toHaveLength(3);
  });

  it("says when the file is missing or not JSON", async () => {
    await expect(loadTestTokens("/nonexistent/test-tokens.json")).rejects.toThrow(/Cannot read the test token file at \/nonexistent\/test-tokens.json/);
    const path = await fileWith("{");
    await expect(loadTestTokens(path)).rejects.toThrow(`The test token file at ${path} is not valid JSON.`);
  });
});
