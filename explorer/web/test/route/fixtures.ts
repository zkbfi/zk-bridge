import type { RouteStep, RouteStepKind } from "@zk-bridge/shared";
import { FIXTURE_NOW, FIXTURE_PAIR } from "@terminal/data/fixtures";

/** The page clock of the fixture pair, in milliseconds. */
export const NOW_MS = FIXTURE_NOW * 1_000;
export const MESSAGE = `0x${"ab".repeat(32)}`;

type Over = {
  readonly situation?: Partial<RouteStep["situation"]>;
  readonly constraints?: Partial<RouteStep["constraints"]>;
  readonly fallback?: RouteStep["fallback"];
} & Partial<Omit<RouteStep, "situation" | "constraints" | "fallback">>;

const SUBJECTS: Record<RouteStepKind, { subject: string; direction: RouteStep["direction"]; chainId: number; messageId: string | null }> = {
  "light-client-update": { subject: "first-to-second", direction: "first-to-second", chainId: FIXTURE_PAIR.second.chainId, messageId: null },
  "registry-light-client-update": { subject: String(FIXTURE_PAIR.second.chainId), direction: null, chainId: FIXTURE_PAIR.second.chainId, messageId: null },
  "fork-observation": { subject: String(FIXTURE_PAIR.second.chainId), direction: null, chainId: FIXTURE_PAIR.second.chainId, messageId: null },
  "open-deposits": { subject: "first-to-second", direction: "first-to-second", chainId: FIXTURE_PAIR.second.chainId, messageId: null },
  "layout-rows": { subject: MESSAGE, direction: "first-to-second", chainId: FIXTURE_PAIR.second.chainId, messageId: MESSAGE },
  deliver: { subject: MESSAGE, direction: "first-to-second", chainId: FIXTURE_PAIR.second.chainId, messageId: MESSAGE },
  seal: { subject: String(FIXTURE_PAIR.first.chainId), direction: null, chainId: FIXTURE_PAIR.first.chainId, messageId: null },
};

/** A pending step of a kind, with the numbers of a typical day; `over` changes any part. */
export const stepOf = (kind: RouteStepKind, over: Over = {}): RouteStep => {
  const base = SUBJECTS[kind];
  const { situation, constraints, fallback, ...rest } = over;
  return {
    id: `${kind}:${base.subject}`,
    kind,
    subject: base.subject,
    direction: base.direction,
    chainId: base.chainId,
    target: null,
    messageId: base.messageId,
    situation: { since: NOW_MS - 19 * 3_600_000, behindSeconds: 19 * 3600, waitingTransfers: 3, blocks: [], strandsAt: NOW_MS + 8 * 3_600_000, layoutRows: null, activeVersion: null, recordedVersion: null, ...situation },
    constraints: {
      finality: { finalizedSlot: 11_530_720, nextAt: NOW_MS + 12 * 60_000 },
      gpu: { warmMs: 60_000, coldMs: 300_000, workerWarm: false, budgetUsd: 5, spentUsd: 1.6, leftUsd: 3.4 },
      job: null,
      proofReady: false,
      posting: { gas: "310000", gasSource: "simulated", gasPriceWei: "2000000000", costWei: "620000000000000" },
      after: null,
      ...constraints,
    },
    fallback: fallback === undefined ? { by: "backend", at: NOW_MS + 3 * 3_600_000 } : fallback,
    ...rest,
  };
};
