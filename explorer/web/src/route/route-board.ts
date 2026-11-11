/**
 * Every pending step the page can offer: the backend's list plus the seal steps that the page adds itself, from the
 * seal offer of the Forks section (a gate whose seal call would succeed from the visitor's account now). The backend does
 * not list a seal, because the evidence of a seal is read from a beacon node or the registry in the browser.
 */
import { useEffect, useState } from "react";
import { blockingStepOf, stepIdOf, type RouteStep } from "@zk-bridge/shared";
import type { ChainConfig } from "@terminal/model/types";
import { useServices } from "../app/services";
import { useForkChainState, useSealOffer } from "../fork/use-fork";
import { useWallet } from "../wallet/wallet-port";
import { useRouteSteps, type RouteStepsReading } from "./route-port";

const sealStepOf = (chain: ChainConfig, gas: bigint): RouteStep => ({
  id: stepIdOf("seal", String(chain.chainId)),
  kind: "seal",
  subject: String(chain.chainId),
  direction: null,
  chainId: chain.chainId,
  target: chain.contracts.gate,
  messageId: null,
  situation: { since: null, behindSeconds: null, waitingTransfers: 0, blocks: [], strandsAt: null, layoutRows: null, activeVersion: null, recordedVersion: null },
  constraints: { finality: null, gpu: null, job: null, proofReady: true, posting: { gas: gas.toString(), gasSource: "simulated", gasPriceWei: null, costWei: null }, after: null },
  fallback: { by: "backend", at: null },
});

/** The seal step of one chain: present while its gate is not sealed and the seal call would succeed from the account. */
const useSealStep = (chain: ChainConfig): RouteStep | null => {
  const wallet = useWallet();
  const gate = useForkChainState(chain.chainId)?.gate ?? null;
  const offer = useSealOffer(chain.chainId, wallet.account, gate !== null && !gate.sealed);
  return gate !== null && !gate.sealed && offer !== undefined && offer.kind === "ready" ? sealStepOf(chain, offer.gas) : null;
};

/** What the page offers: the backend reading, and every step with the seal steps after the backend's. */
export type RouteBoard = { readonly reading: RouteStepsReading; readonly steps: readonly RouteStep[] };

/** The pending steps of the route, the backend's and the page's own. */
export const useRouteBoard = (): RouteBoard => {
  const { pair } = useServices();
  const reading = useRouteSteps();
  const first = useSealStep(pair.first);
  const second = useSealStep(pair.second);
  const own = [first, second].filter((step): step is RouteStep => step !== null);
  return { reading, steps: [...(reading.kind === "ready" ? reading.steps : []), ...own] };
};

/** The step that holds up a transfer, as the page shows it. */
export type BlockingView = { readonly step: RouteStep; readonly pending: RouteStep | null; readonly steps: readonly RouteStep[] };

/**
 * The one step that holds up a transfer (`blockingStepOf`), kept after it leaves the list so its card can say that someone
 * else posted it, or show the visitor's own transaction. A list that could not be read fully does not count the step as posted.
 *
 * @param transfer The transfer, or null while it is not loaded.
 */
export const useBlockingStep = (transfer: { readonly messageId: string; readonly direction: "first-to-second" | "second-to-first"; readonly covered: boolean } | null): BlockingView | null => {
  const board = useRouteBoard();
  const current = transfer === null ? null : blockingStepOf(board.steps, transfer);
  const [kept, setKept] = useState<RouteStep | null>(null);
  const currentId = current?.id ?? null;
  useEffect(() => {
    if (current !== null) setKept(current);
    // The id is the identity of a step; the list gives a new object at each read.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentId]);
  const step = current ?? kept;
  if (step === null) return null;
  const unsure = board.reading.kind !== "ready" || board.reading.unread.length > 0;
  return { step, pending: current ?? (unsure ? step : null), steps: board.steps };
};
