import { buildPairConfig } from "@terminal/config/pairs";

const section = (chainId: number, letter: string) => ({
  chain_id: chainId,
  bridge: `0x${letter.repeat(40)}`,
  mediator: `0x${letter.repeat(40)}`,
  light_client: `0x${letter.repeat(40)}`,
});
/** The testnet pair of the faucet tests: Sepolia and PulseChain testnet v4, with made-up contract addresses. */
export const TESTNET = buildPairConfig("sepolia-pls943", { chain_a: section(11155111, "a"), chain_b: section(943, "b") });

