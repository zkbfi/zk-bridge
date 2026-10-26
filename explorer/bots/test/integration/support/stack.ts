import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeAbiParameters, encodePacked, keccak256, sha256, toHex, type Abi, type Address, type Hex } from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { beaconLightClientAbi } from "@zk-bridge/shared";
import { connectChain, type ChainHandle, type SyntheticArtifacts } from "../../../../indexer/test/integration/support/chains";
import { REPOSITORY_ROOT, startAnvil, type AnvilChain } from "../../../../indexer/test/integration/support/processes";

/** The published development mnemonic of Anvil and of `docker/compose.yaml`. It holds no value. */
export const ANVIL_MNEMONIC = "test test test test test test test test test test test junk";

/**
 * Accounts of the stack, by index of the mnemonic. Account 0 deploys. The reward account receives the tips: the router
 * names it at its construction. The runner is a hot key that only pays gas. The copier is any other account that sends
 * the same delivery.
 */
export const ACCOUNT = { deployer: 0, oracle: 1, runner: 2, recipient: 3, reward: 4, failedDelivery: 5, copier: 6 } as const;

const ARTIFACTS: ReadonlyArray<readonly [name: string, file: string]> = [
  ["ProofSizedVerifier", "StackDoubles.sol/ProofSizedVerifier.json"],
  ["StubMediatorBridge", "StackDoubles.sol/StubMediatorBridge.json"],
  ["BeaconLightClient", "BeaconLightClient.sol/BeaconLightClient.json"],
  ["DeliveryRouter", "DeliveryRouter.sol/DeliveryRouter.json"],
  ["Multicall3", "Multicall3.sol/Multicall3.json"],
  ["MockERC20", "MockERC20.sol/MockERC20.json"],
  ["MockWrappedNative", "MockWrappedNative.sol/MockWrappedNative.json"],
];

/**
 * Compiles the doubles of `test/integration/contracts` and the real contracts they import, with Foundry, into a
 * temporary output directory. The first run compiles the whole repository, and takes a minute or two.
 */
export function compileStackContracts(): SyntheticArtifacts {
  const out = join(tmpdir(), "explorer-bots-out");
  execFileSync(
    "forge",
    [
      "build",
      "--root",
      REPOSITORY_ROOT,
      "--contracts",
      "explorer/bots/test/integration/contracts",
      // The Foundry tests and scripts of the repository are not needed, and they make up most of the build.
      "--skip",
      "test",
      "--skip",
      "script",
      "--out",
      out,
      "--cache-path",
      join(tmpdir(), "explorer-bots-cache"),
    ],
    { stdio: "ignore", timeout: 580_000 },
  );
  return Object.fromEntries(
    ARTIFACTS.map(([name, file]) => {
      const artifact = JSON.parse(readFileSync(join(out, file), "utf8")) as { abi: Abi; bytecode: { object: Hex } };
      return [name, { abi: artifact.abi, bytecode: artifact.bytecode.object }];
    }),
  );
}

/** The contracts of the stack on the destination chain (369). */
export interface Stack {
  readonly anvil: AnvilChain;
  readonly chain: ChainHandle;
  readonly lightClient: Address;
  readonly verifier: Address;
  readonly deliveryRouter: Address;
  readonly multicall3: Address;
  readonly mediatorBridge: Address;
  readonly wrappedNative: Address;
  readonly token: Address;
  readonly programKey: Hex;
}

/** The accounts of the mnemonic. */
export const account = (index: number) => mnemonicToAccount(ANVIL_MNEMONIC, { addressIndex: index });

/**
 * Starts Anvil as chain 369 and deploys: the real `BeaconLightClient` with the proof-sized oracle verifier, the real
 * `DeliveryRouter`, a stub mediator and bridge, a wrapped native token and a token. The light client starts at slot 100.
 */
export async function startStack(artifacts: SyntheticArtifacts): Promise<Stack> {
  const anvil = await startAnvil(369, "shanghai");
  const chain = await connectChain(369, anvil.url, artifacts);
  const programKey = keccak256(toHex("light-client-program"));
  const verifier = await chain.deploy("ProofSizedVerifier", [account(ACCOUNT.oracle).address]);
  const lightClient = await chain.deploy("BeaconLightClient", [
    verifier,
    programKey,
    keccak256(toHex("genesis")),
    8192n,
    1_600_000_000n,
    12n,
    100n,
    keccak256(toHex("checkpoint")),
    keccak256(toHex("committee")),
    keccak256(toHex("next-committee")),
  ]);
  const mediatorBridge = await chain.deploy("StubMediatorBridge");
  const wrappedNative = await chain.deploy("MockWrappedNative");
  const deliveryRouter = await chain.deploy("DeliveryRouter", [mediatorBridge, wrappedNative, account(ACCOUNT.reward).address, account(ACCOUNT.failedDelivery).address]);
  const multicall3 = await chain.deploy("Multicall3");
  const token = await chain.deploy("MockERC20", ["Fee Token", "FEE"]);
  return { anvil, chain, lightClient, verifier, deliveryRouter, multicall3, mediatorBridge, wrappedNative, token, programKey };
}

/** An update that the stack accepts, with the pieces that a proof package carries. */
export interface OracleUpdate {
  readonly startSlot: bigint;
  readonly startRoot: Hex;
  readonly newSlot: bigint;
  readonly newRoot: Hex;
  readonly publicValues: Hex;
  /** 356 bytes: four bytes of selector, the 65 byte oracle signature, and padding. */
  readonly proof: Hex;
}

/**
 * Builds an update from the stored head to `newSlot`. The public values name the stored head as the start, so the real
 * contract accepts them. SYNTHETIC: no beacon chain stands behind these values, and the "proof" is an oracle signature.
 */
export async function buildOracleUpdate(stack: Stack, newSlot: bigint): Promise<OracleUpdate> {
  const read = <Value>(functionName: string, args: readonly unknown[] = []) =>
    stack.chain.publicClient.readContract({ address: stack.lightClient, abi: beaconLightClientAbi, functionName, args } as never) as Promise<Value>;
  const [genesisValidatorsRoot, head, slotsPerPeriod] = await Promise.all([read<Hex>("genesisValidatorsRoot"), read<bigint>("head"), read<bigint>("slotsPerPeriod")]);
  const period = head / slotsPerPeriod;
  const [startRoot, committee, nextCommittee] = await Promise.all([read<Hex>("headers", [head]), read<Hex>("syncCommittees", [period]), read<Hex>("syncCommittees", [period + 1n])]);
  const newRoot = keccak256(toHex(`header-${newSlot}`));
  const publicValues = encodeAbiParameters(
    ["bytes32", "bytes32", "uint64", "bytes32", "bytes32", "bytes32", "uint64", "bytes32", "uint64", "bytes32", "bytes32"].map((type) => ({ type })),
    [genesisValidatorsRoot, startRoot, head, committee, nextCommittee, newRoot, newSlot, keccak256(toHex(`execution-${newSlot}`)), newSlot, committee, `0x${"00".repeat(32)}`],
  );
  const digest = keccak256(encodePacked(["bytes32", "bytes32"], [stack.programKey, sha256(publicValues)]));
  const signature = await account(ACCOUNT.oracle).sign({ hash: digest });
  const proof: Hex = `0x00000000${signature.slice(2)}${"00".repeat(356 - 4 - 65)}`;
  return { startSlot: head, startRoot, newSlot, newRoot, publicValues, proof };
}
