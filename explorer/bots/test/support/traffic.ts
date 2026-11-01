import { encodeAbiParameters, encodeEventTopics, getAddress, type Address, type Hex } from "viem";
import { vi } from "vitest";
import { messageBridgeAbi } from "@zk-bridge/shared";
import type { FeeQuote, ReceiptLog, ReceiptSummary, SendRequest, Simulation, TransactionPort } from "../../src/chain/transactions.ts";
import type { TrafficReader } from "../../src/traffic/chain.ts";

/** The test tokens of the examples: the addresses a fresh local chain gives the first two deployments. */
export const DOLLAR = getAddress("0x5FbDB2315678afecb367f032d93F642f64180aa3");
export const PLAIN = getAddress("0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512");

/** The shape that `script/testnet/DeployTestTokens.s.sol` wrote on two local chains, for the pair eth-pls (1 and 369). */
export function tokenFile(chains: readonly [number, number] = [1, 369]) {
  const section = (chainId: number) => ({
    chain_id: chainId,
    minter: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
    tokens: {
      tTKN: { address: PLAIN, decimals: 18, name: "zkb Test Token", symbol: "tTKN" },
      tUSD: { address: DOLLAR, decimals: 6, name: "zkb Test Dollar", symbol: "tUSD" },
    },
    traffic_wallet: "0x70997970c51812dc3A010c54a5bB0de5E1F6e2B0",
  });
  return { [String(chains[0])]: section(chains[0]), [String(chains[1])]: section(chains[1]) };
}

/** The address of the bridged copy on `chainId` of a token native on `homeChainId`: a stable made-up address. */
export function copyAddressOf(chainId: number, homeChainId: number, nativeToken: Address): Address {
  const seed = `${chainId.toString(16)}${homeChainId.toString(16)}${nativeToken.slice(2, 10)}`;
  return getAddress(`0x${seed.padEnd(40, "c").slice(0, 40)}`);
}

/** A reader whose balances the test sets. Keys are lowercase token addresses. */
export interface FakeReaderState {
  native: bigint;
  balances: Map<string, bigint>;
  allowances: Map<string, bigint>;
  /** Lowercase addresses that hold code. Default: every address. */
  code?: Set<string>;
  /** What the mediator records of a native token, by lowercase address. Default: relayed before, and acknowledged. */
  records?: Map<string, { registered: boolean; acknowledged: boolean }>;
}

/** A reader over a state that the test changes. */
export function fakeReader(chainId: number, state: FakeReaderState): TrafficReader & { readonly state: FakeReaderState } {
  return {
    state,
    nativeRecord: async (_mediator, token) => state.records?.get(token.toLowerCase()) ?? { registered: true, acknowledged: true },
    hasCode: async (address) => state.code === undefined || state.code.has(address.toLowerCase()),
    nativeBalance: async () => state.native,
    tokenBalance: async (token) => state.balances.get(token.toLowerCase()) ?? 0n,
    allowance: async (token) => state.allowances.get(token.toLowerCase()) ?? 0n,
    copyAddress: async ({ homeChainId, nativeToken }) => copyAddressOf(chainId, homeChainId, nativeToken),
  };
}

/** A `UserRequestForAffirmation` log of the bridge. */
export function requestLog(bridge: Address, messageId: Hex): ReceiptLog {
  const topics = encodeEventTopics({ abi: messageBridgeAbi, eventName: "UserRequestForAffirmation", args: { messageId } }) as Hex[];
  return { address: bridge, topics, data: encodeAbiParameters([{ type: "bytes" }], ["0x1234"]) };
}

/** A transaction port whose answers the test sets: simulations by target, and a receipt for each send. */
export interface FakePort extends TransactionPort {
  readonly sent: SendRequest[];
  simulations: Map<string, Simulation>;
  receipts: Array<Partial<ReceiptSummary>>;
  quote: FeeQuote;
}

export function fakePort(chainId: number, account: Address): FakePort {
  const port: FakePort = {
    chainId,
    account,
    sent: [],
    simulations: new Map(),
    receipts: [],
    quote: { baseFee: 10n, priorityFee: 2n },
    simulate: vi.fn(async (request) => port.simulations.get(request.to.toLowerCase()) ?? ({ ok: true, gas: 100_000n } as const)),
    call: vi.fn(async () => "0x" as Hex),
    feeQuote: vi.fn(async () => port.quote),
    send: vi.fn(async (request: SendRequest) => {
      port.sent.push(request);
      const next = port.receipts.shift() ?? {};
      return { hash: `0x${String(port.sent.length).padStart(64, "0")}` as Hex, success: true, gasUsed: 50_000n, effectiveGasPrice: 12n, blockNumber: 7n, logs: [], ...next };
    }),
  };
  return port;
}
