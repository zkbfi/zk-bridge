import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  encodeAbiParameters,
  encodePacked,
  hexToBigInt,
  keccak256,
  parseAbi,
  sha256,
  toHex,
  type Abi,
  type Address,
  type Hex,
} from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { beaconLightClientAbi, buildMessageId, messageBridgeAbi, tokenMediatorAbi } from "@zk-bridge/shared";
import { compileSyntheticContracts, connectChain, type ChainHandle } from "./support/chains";
import { REPOSITORY_ROOT, startAnvil, startIndexer, startPostgres, waitFor, type RunningIndexer, type Stoppable } from "./support/processes";

/**
 * The sent side and the light client against the REAL contracts, deployed by `docker/deploy.sh` on two Anvil chains.
 *
 * What it covers: real `MessageBridge` sends (token relays in both directions and an arbitrary message), real
 * `TokenMediator` events, message identifiers that must match the contract, real escrow balances read from the
 * mediator, and real `BeaconLightClient.update` transactions with the oracle verifier of the local stack, so that the
 * head update events, their gas and their poster are real.
 *
 * What it does not cover: delivery. `executeMessage` needs a proof of the source block, and the local chains have no
 * beacon chain. `synthetic.test.ts` covers the delivered side with test doubles.
 *
 * Two shortcuts, both on the local chains only: the bridges start locked until `openDeposits` gets a proof, so the
 * test writes the `depositsOpen` storage flag; and the gate of chain A is enforcing, so the test replaces its code with
 * a gate that admits every send. Neither shortcut touches what the indexer reads.
 */

const PRICE_ONE = 10n ** 18n;
const erc20Abi = parseAbi([
  "function mint(address to, uint256 amount)",
  "function approve(address spender, uint256 amount) returns (bool)",
]);
const mediatorViews = tokenMediatorAbi;

const stoppables: Stoppable[] = [];
let indexer: RunningIndexer;
let chainA: ChainHandle;
let chainB: ChainHandle;

const api = async <body>(path: string): Promise<body> => (await (await fetch(`${indexer.apiUrl}${path}`)).json()) as body;

type DeploymentSection = {
  token: Address;
  bridge: Address;
  mediator: Address;
  gate: Address;
  light_client: Address;
};
type Feed = {
  items: {
    messageId: Hex;
    kind: string;
    status: string;
    sender: string;
    executor: string;
    gasLimit: number;
    direction: { label: string };
    sent: { blockNumber: number } | null;
    transfer: null | {
      value: string;
      sender: string;
      recipient: string;
      handler: string;
      sourceToken: { symbol: string; decimals: number; name: string } | null;
    };
  }[];
};

/** The mnemonic of the local stack, read from the compose file that defines it. */
const localMnemonic = (): string => {
  const compose = readFileSync(join(REPOSITORY_ROOT, "docker", "compose.yaml"), "utf8");
  const match = /x-anvil-mnemonic: &anvil-mnemonic "([^"]+)"/.exec(compose);
  if (match === null) throw new Error("docker/compose.yaml does not define x-anvil-mnemonic");
  return match[1] as string;
};

/** Sets the `depositsOpen` flag of a bridge by finding its storage slot: the flag sits at byte 8 of the nonce word. */
const openSends = async (chain: ChainHandle, bridge: Address): Promise<void> => {
  for (let slot = 0; slot < 24; slot++) {
    const slotHex = toHex(slot, { size: 32 });
    await chain.publicClient.request({ method: "anvil_setStorageAt" as never, params: [bridge, slotHex, toHex(1n << 64n, { size: 32 })] as never });
    const open = await chain.publicClient.readContract({ address: bridge, abi: messageBridgeAbi, functionName: "depositsOpen" });
    if (open) return;
    await chain.publicClient.request({ method: "anvil_setStorageAt" as never, params: [bridge, slotHex, toHex(0n, { size: 32 })] as never });
  }
  throw new Error(`could not find the depositsOpen slot of ${bridge}`);
};

/** Replaces the gate code with a gate that admits every send. */
const admitEverySend = async (chain: ChainHandle, gate: Address, artifacts: ReturnType<typeof compileSyntheticContracts>): Promise<void> => {
  const copy = await chain.deploy("AdmitAllGate");
  const code = await chain.publicClient.getCode({ address: copy });
  await chain.publicClient.request({ method: "anvil_setCode" as never, params: [gate, code] as never });
  void artifacts;
};

/**
 * Posts a head to a light client with a proof that the oracle verifier accepts: a signature of the oracle over
 * `keccak256(programVKey, sha256(publicValues))`. The values name the stored head as the start, so the contract
 * accepts them like a real update.
 */
const postHead = async (input: {
  chain: ChainHandle;
  lightClient: Address;
  oracleKey: ReturnType<typeof mnemonicToAccount>;
  slot: bigint;
  executionBlockNumber: bigint;
  poster: number;
}): Promise<void> => {
  const read = <value>(functionName: string, args: readonly unknown[] = []) =>
    input.chain.publicClient.readContract({ address: input.lightClient, abi: beaconLightClientAbi, functionName, args } as never) as Promise<value>;
  const [genesisValidatorsRoot, head, programVKey, slotsPerPeriod] = await Promise.all([
    read<Hex>("genesisValidatorsRoot"),
    read<bigint>("head"),
    read<Hex>("programVKey"),
    read<bigint>("slotsPerPeriod"),
  ]);
  const period = head / slotsPerPeriod;
  const [previousHeaderRoot, committee, nextCommittee] = await Promise.all([
    read<Hex>("headers", [head]),
    read<Hex>("syncCommittees", [period]),
    read<Hex>("syncCommittees", [period + 1n]),
  ]);
  const types = [
    "bytes32", "bytes32", "uint64", "bytes32", "bytes32", "bytes32", "uint64", "bytes32", "uint64", "bytes32", "bytes32",
  ].map((type) => ({ type }));
  const publicValues = encodeAbiParameters(types, [
    genesisValidatorsRoot,
    previousHeaderRoot,
    head,
    committee,
    nextCommittee,
    keccak256(toHex(`header-${input.slot}`)),
    input.slot,
    keccak256(toHex(`execution-${input.slot}`)),
    input.executionBlockNumber,
    committee,
    `0x${"00".repeat(32)}`,
  ]);
  const digest = keccak256(encodePacked(["bytes32", "bytes32"], [programVKey, sha256(publicValues)]));
  const proof = await input.oracleKey.sign({ hash: digest });
  await input.chain.write(input.lightClient, beaconLightClientAbi as Abi, "update", [proof, publicValues], input.poster);
};

describe("the indexer follows the real contracts of the local stack", () => {
  let a: DeploymentSection;
  let b: DeploymentSection;
  const sends: Record<string, { id: Hex; block: number }> = {};

  beforeAll(async () => {
    const artifacts = compileSyntheticContracts();
    const [anvilA, anvilB, postgres] = await Promise.all([
      startAnvil(1, "cancun", { blockTimeSeconds: 1 }),
      startAnvil(369, "shanghai", { blockTimeSeconds: 1 }),
      startPostgres(),
    ]);
    stoppables.push(anvilA, anvilB, postgres);

    const stateDirectory = mkdtempSync(join(tmpdir(), "explorer-state-"));
    try {
      execFileSync("bash", [join(REPOSITORY_ROOT, "docker", "deploy.sh")], {
        env: { ...process.env, STATE_DIR: stateDirectory, RPC_A: anvilA.url, RPC_B: anvilB.url, REPO: REPOSITORY_ROOT },
        stdio: "ignore",
        timeout: 280_000,
      });
    } finally {
      // The script writes a derived file into the repository. Remove it again.
      rmSync(join(REPOSITORY_ROOT, "script", "hardened", "local.config.json"), { force: true });
    }
    const deploymentFile = join(stateDirectory, "deployment.json");
    const deployment = JSON.parse(readFileSync(deploymentFile, "utf8")) as { chain_a: DeploymentSection; chain_b: DeploymentSection };
    a = deployment.chain_a;
    b = deployment.chain_b;

    chainA = await connectChain(1, anvilA.url, artifacts);
    chainB = await connectChain(369, anvilB.url, artifacts);
    await admitEverySend(chainA, a.gate, artifacts);
    await openSends(chainA, a.bridge);
    await openSends(chainB, b.bridge);

    indexer = await startIndexer({
      databaseUrl: postgres.connectionString,
      schema: "realstack",
      environment: {
        EXPLORER_DEPLOYMENT_FILE: deploymentFile,
        EXPLORER_FINALITY_SECONDS_1: "3600",
        EXPLORER_FINALITY_SECONDS_369: "3600",
        EXPLORER_TIP_INTERVAL_BLOCKS: "2",
      },
    });
    stoppables.push(indexer);
  });

  afterAll(async () => {
    for (const stoppable of stoppables.reverse()) await stoppable.stop().catch(() => undefined);
  });

  const relay = async (chain: ChainHandle, side: DeploymentSection, value: bigint) => {
    const receiver = chainA.accounts[1] as Address;
    await chain.write(side.token, erc20Abi as Abi, "mint", [chain.accounts[0], value]);
    await chain.write(side.token, erc20Abi as Abi, "approve", [side.mediator, value]);
    return chain.write(side.mediator, mediatorViews as Abi, "relayTokens", [side.token, receiver, value]);
  };

  it("indexes a real token relay from A to B with the identifier, decoded recipient and token metadata", async () => {
    const receipt = await relay(chainA, a, 5n * PRICE_ONE);
    sends.relayA = { id: buildMessageId(1n, a.bridge, 0n), block: Number(receipt.blockNumber) };
    const item = await waitFor("the relay in the feed", async () => {
      const feed = await api<Feed>("/api/feed");
      return feed.items.find((entry) => entry.messageId === sends.relayA?.id && entry.transfer?.sourceToken?.symbol);
    });
    expect(item).toMatchObject({
      kind: "token",
      status: "sent",
      direction: { label: "1>369" },
      sender: a.mediator.toLowerCase(),
      executor: b.mediator.toLowerCase(),
    });
    expect(item.sent?.blockNumber).toBe(sends.relayA?.block);
    expect(item.gasLimit).toBeGreaterThan(0);
    expect(item.transfer).toMatchObject({
      value: (5n * PRICE_ONE).toString(),
      sender: (chainA.accounts[0] as string).toLowerCase(),
      recipient: (chainA.accounts[1] as string).toLowerCase(),
      sourceToken: { symbol: "TKNA", name: "Token A", decimals: 18 },
    });
    expect(item.transfer?.handler).toMatch(/^deployAndHandleBridgedTokens/);
  });

  it("reads the real escrow from the mediator and balances the audit with the transfer still pending", async () => {
    const row = await waitFor("the escrow row", async () => {
      const audit = await api<{ tokens: { token: { address: string }; escrow: string; pendingForward: string; bridgedSupply: string; mismatch: boolean }[] }>("/api/audit");
      return audit.tokens.find((entry) => entry.token.address === a.token.toLowerCase());
    });
    const onChain = await chainA.publicClient.readContract({ address: a.mediator, abi: tokenMediatorAbi, functionName: "mediatorBalance", args: [a.token] });
    expect(onChain).toBe(5n * PRICE_ONE);
    expect(row).toMatchObject({ escrow: onChain.toString(), pendingForward: onChain.toString(), bridgedSupply: "0", mismatch: false });
  });

  it("indexes a relay back direction from B, an arbitrary message, and keeps identifiers in step with each bridge", async () => {
    const receipt = await relay(chainB, b, 2n * PRICE_ONE);
    sends.relayB = { id: buildMessageId(369n, b.bridge, 0n), block: Number(receipt.blockNumber) };
    const target = chainB.accounts[6] as Address;
    const message = await chainA.write(a.bridge, messageBridgeAbi as Abi, "requireToPassMessage", [target, "0x1234", 200_000n], 2);
    sends.message = { id: buildMessageId(1n, a.bridge, 1n), block: Number(message.blockNumber) };
    const items = await waitFor("all three sends", async () => {
      const feed = await api<Feed>("/api/feed");
      return feed.items.length === 3 && feed.items.every((entry) => entry.status !== undefined) ? feed.items : undefined;
    });
    const byId = new Map(items.map((entry) => [entry.messageId, entry]));
    expect(byId.get(sends.relayB?.id as Hex)).toMatchObject({ kind: "token", direction: { label: "369>1" }, executor: a.mediator.toLowerCase() });
    expect(byId.get(sends.message?.id as Hex)).toMatchObject({
      kind: "message",
      sender: (chainA.accounts[2] as string).toLowerCase(),
      executor: target.toLowerCase(),
      gasLimit: 200_000,
      transfer: null,
    });
  });

  it("covers sends when the real light client stores a head, and records the real gas and poster", async () => {
    const oracleKey = mnemonicToAccount(localMnemonic(), { addressIndex: 1 });
    await postHead({
      chain: chainB,
      lightClient: b.light_client,
      oracleKey,
      slot: 100n,
      executionBlockNumber: BigInt(sends.message?.block as number),
      poster: 3,
    });
    // The head covers every send of chain A up to the arbitrary message. The send on chain B is not covered yet.
    await waitFor("the sends of chain A to be covered", async () => {
      const feed = await api<Feed>("/api/feed?direction=1>369");
      return feed.items.length === 2 && feed.items.every((entry) => entry.status === "covered") ? true : undefined;
    });
    const back = await api<Feed>("/api/feed?direction=369>1");
    expect(back.items.map((entry) => entry.status)).toEqual(["sent"]);

    await postHead({
      chain: chainA,
      lightClient: a.light_client,
      oracleKey,
      slot: 100n,
      executionBlockNumber: BigInt(sends.relayB?.block as number),
      poster: 4,
    });
    await waitFor("the send of chain B to be covered", async () => {
      const feed = await api<Feed>("/api/feed?direction=369>1");
      return feed.items[0]?.status === "covered" ? true : undefined;
    });

    const updates = await api<{ items: { chainId: number; slot: number; poster: string; gasUsed: string; costWei: string; executionBlockNumber: number; transactionHash: string }[] }>("/api/head-updates");
    expect(updates.items).toHaveLength(2);
    const onB = updates.items.find((item) => item.chainId === 369);
    expect(onB).toMatchObject({ slot: 100, poster: (chainA.accounts[3] as string).toLowerCase(), executionBlockNumber: sends.message?.block });
    const receipt = await chainB.publicClient.getTransactionReceipt({ hash: onB?.transactionHash as Hex });
    // The indexed gas is the gas of the real transaction, not an estimate.
    expect(BigInt(onB?.gasUsed ?? "0")).toBe(receipt.gasUsed);
    expect(BigInt(onB?.costWei ?? "0")).toBe(receipt.gasUsed * receipt.effectiveGasPrice);

    const heads = await api<{ heads: { chainId: number; storedHeadSlot: number; storedHeadExecutionBlock: number; updateCount: number }[] }>("/api/heads");
    expect(heads.heads.find((head) => head.chainId === 369)).toMatchObject({ storedHeadSlot: 100, storedHeadExecutionBlock: sends.message?.block, updateCount: 1 });
    void hexToBigInt;
  });

  it("serves the pair description without endpoint URLs", async () => {
    const text = await (await fetch(`${indexer.apiUrl}/api/pair`)).text();
    expect(JSON.parse(text).name).toBe("eth-pls");
    expect(text).not.toContain("127.0.0.1");
  });
});
