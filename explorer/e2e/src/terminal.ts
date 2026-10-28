/**
 * Sends token transfers through the plan code of the terminal dashboard, as a person would.
 *
 * Real: `buildServices` (the pair, the RPC data source and the chain access of the terminal), `buildBridgeSteps` (the form
 * logic that builds the approval and the relay, with the delivery fee terms), `createTransactionFlow` (prepare, sign, send)
 * and the signer of the mnemonic source. Nothing here re-implements an encoding: the terminal does it.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { decodeEventLog, type Address, type Hex, type TransactionReceipt } from "viem";
import { messageBridgeAbi } from "@zk-bridge/shared";
import { buildBridgeSteps, deliveryRouterOf, tokenChoiceValue, type BridgeContext } from "../../terminal/src/app/actions";
import { buildServices } from "../../terminal/src/app/bootstrap";
import { createTransactionFlow, type FlowState } from "../../terminal/src/flow/transaction-flow";
import type { ChainSide, PairConfig, TokenInfo } from "../../terminal/src/model/types";
import { createMnemonicSource } from "../../terminal/src/signing/mnemonic";
import type { Signer } from "../../terminal/src/signing/signer";
import { ANVIL_MNEMONIC, ACCOUNT_INDEX, chainOf, type Context, type Role, type Side } from "./context.ts";

/** The services of the terminal, built once from the deployment file and the RPC URLs of the run. */
export type TerminalServices = Awaited<ReturnType<typeof buildServices>>["services"];

/** The side of the pair of the terminal for a chain of the run. Chain A (1) is the first chain. */
export const sideOf = (side: Side): ChainSide => (side === "a" ? "first" : "second");

/**
 * Builds the services of the terminal for the run. The indexer URL is a port that nothing listens on until the run starts
 * the indexer, so the data source reads by RPC first (the label says so) and the indexer afterwards.
 *
 * @param context The run.
 * @param indexerUrl The URL of the indexer.
 * @param valuationsWei The value of one whole token in wei, by token address, for the tip suggestions.
 */
export const startTerminalServices = async (context: Context, input: { readonly indexerUrl: string; readonly valuationsWei: Readonly<Record<string, string>> }): Promise<TerminalServices> => {
  const environment: Record<string, string | undefined> = {
    EXPLORER_PAIR: "eth-pls",
    EXPLORER_DEPLOYMENT_FILE: join(context.stateDirectory, "deployment.json"),
    EXPLORER_RPC_URL_1: context.a.rpcUrl,
    EXPLORER_RPC_URL_369: context.b.rpcUrl,
    EXPLORER_INDEXER_URL: input.indexerUrl,
    EXPLORER_TOKEN_VALUATIONS_WEI: JSON.stringify(input.valuationsWei),
    EXPLORER_FINALITY_SECONDS_1: "60",
    EXPLORER_FINALITY_SECONDS_369: "60",
  };
  const noStore = async (): Promise<never> => {
    throw new Error("the end-to-end run uses no secret store");
  };
  const { services } = await buildServices({
    environment,
    workingDirectory: context.stateDirectory,
    readTextFile: (path) => readFile(path, "utf8"),
    now: () => Math.floor(Date.now() / 1000),
    proverSetup: {
      environment,
      run: (async () => {
        throw new Error("no command runs in the end-to-end run");
      }) as never,
      http: (async () => {
        throw new Error("no request runs in the end-to-end run");
      }) as never,
      load: async () => {
        throw new Error("no setup file");
      },
      save: async () => undefined,
      openSecretStore: noStore,
    },
  });
  return services;
};

/** A signer of the mnemonic source for a role, through the code that the terminal uses. */
export const signerFor = async (role: Role): Promise<Signer> => {
  const source = createMnemonicSource({ mnemonic: ANVIL_MNEMONIC, passphrase: "" });
  return source.openSigner(`m/44'/60'/0'/0/${ACCOUNT_INDEX[role]}`);
};

/** One step that the terminal sent. */
export interface TerminalStep {
  readonly title: string;
  readonly status: "success" | "reverted" | "skipped";
  readonly transactionHash: Hex | null;
}

/** The outcome of a relay through the terminal: all steps and the receipt of the last one. */
export interface TerminalRelay {
  readonly steps: readonly TerminalStep[];
  readonly relayHash: Hex;
  readonly receipt: TransactionReceipt;
  /** The index of the bridge's `UserRequestForAffirmation` log inside the receipt. */
  readonly messageLogIndex: number;
  readonly messageId: Hex;
}

/** What a relay needs. `values` are the form values of the bridge form of the terminal. */
export interface RelayRequest {
  readonly from: Side;
  readonly role: Role;
  readonly values: Readonly<Record<string, string>>;
  readonly tokens: readonly TokenInfo[];
  readonly label: string;
}

const waitForPhase = (flow: ReturnType<typeof createTransactionFlow>, phases: readonly FlowState["phase"][]): Promise<FlowState> =>
  new Promise((resolve) => {
    const check = (): boolean => {
      const state = flow.getState();
      if (!phases.includes(state.phase)) return false;
      resolve(state);
      return true;
    };
    if (check()) return;
    const stop = flow.subscribe(() => {
      if (check()) stop();
    });
  });

/**
 * Builds the steps of the bridge form, then confirms each one the way a person would on the review screen.
 *
 * @throws Error when the form refuses the input, a step fails to prepare, or a step reverts.
 */
export const relayThroughTerminal = async (context: Context, services: TerminalServices, request: RelayRequest): Promise<TerminalRelay> => {
  const signer = await signerFor(request.role);
  const source = chainOf(context, request.from);
  const destination = chainOf(context, request.from === "a" ? "b" : "a");
  const snapshots = await services.chainAccess.readSnapshots({ account: signer.address, tokens: request.tokens });
  const deliveryCost = await services.dataSource.getDeliveryCost(destination.deployment.chain_id);
  const bridgeContext: BridgeContext = {
    pair: services.pair as PairConfig,
    snapshots,
    signerAddress: signer.address,
    deliveryCost,
    tokenValuationsWei: services.tokenValuationsWei,
  };
  const router = deliveryRouterOf(request.values, request.tokens, bridgeContext);
  const routerAddresses = router === null ? undefined : await services.chainAccess.readRouterAddresses(router);
  const steps = buildBridgeSteps(request.values, request.tokens, { ...bridgeContext, ...(routerAddresses === undefined ? {} : { routerAddresses }) });

  const flow = createTransactionFlow({ signer, clientFor: (chainId) => services.chainAccess.flowClient(chainId) });
  flow.start(steps);
  for (let index = 0; index < steps.length; index += 1) {
    const state = await waitForPhase(flow, ["review", "error", "finished"]);
    if (state.phase === "error") throw new Error(`${request.label}: ${state.error ?? "the flow failed"}`);
    flow.confirm();
  }
  const final = await waitForPhase(flow, ["finished", "error"]);
  if (final.phase === "error") throw new Error(`${request.label}: ${final.error ?? "the flow failed"}`);
  const sent = final.outcomes.map((outcome) => ({ title: outcome.title, status: outcome.status, transactionHash: outcome.transactionHash as Hex | null }));
  const last = sent[sent.length - 1];
  if (last === undefined || last.transactionHash === null) throw new Error(`${request.label}: the flow sent nothing`);
  const receipt = await source.publicClient.getTransactionReceipt({ hash: last.transactionHash });
  const message = findMessageLog(receipt, source.deployment.bridge);
  return { steps: sent, relayHash: last.transactionHash, receipt, ...message };
};

/** Finds the `UserRequestForAffirmation` log of the bridge in a receipt. */
export const findMessageLog = (receipt: TransactionReceipt, bridge: Address): { readonly messageLogIndex: number; readonly messageId: Hex } => {
  for (const [position, log] of receipt.logs.entries()) {
    if (log.address.toLowerCase() !== bridge.toLowerCase()) continue;
    try {
      const decoded = decodeEventLog({ abi: messageBridgeAbi, data: log.data, topics: log.topics });
      if (decoded.eventName === "UserRequestForAffirmation") return { messageLogIndex: position, messageId: (decoded.args as { messageId: Hex }).messageId };
    } catch {
      // Another event of the bridge. Keep looking.
    }
  }
  throw new Error(`the receipt ${receipt.transactionHash} holds no UserRequestForAffirmation log of ${bridge}`);
};

/** The form value for a token of a side. */
export const tokenChoice = (token: TokenInfo): string => tokenChoiceValue(token);
