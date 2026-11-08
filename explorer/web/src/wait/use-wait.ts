import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { useServices } from "../app/services";
import { chainsFor } from "../bridge/bridge-model";
import { backendClientOf } from "../views/proof-panel-model";
import { buildTimeline, provingOf, ruleOf, timingFor, type FeeReading, type Timeline, type WaitInputs } from "./wait-model";

type Direction = "first-to-second" | "second-to-first";

/** How long the 7-day figures are kept before they are read again: they move by minutes, not seconds. */
export const WAIT_REFRESH_MILLISECONDS = 5 * 60_000;

/**
 * The data behind a direction's timeline: the indexer's last 7 days of deliveries from the source chain, and the
 * backend's proof rule and proving times. Each source that cannot be read leaves its part null, and the timeline then
 * falls back to the chain's and the rule's own figures. Read once per five minutes and shared by every use.
 *
 * @param direction The direction.
 */
export const useWaitInputs = (direction: Direction): WaitInputs => {
  const { pair, explore, endpoints, transport } = useServices();
  const { source } = chainsFor(pair, direction);
  const keep = { staleTime: WAIT_REFRESH_MILLISECONDS, refetchInterval: WAIT_REFRESH_MILLISECONDS, retry: false } as const;
  const delivered = useQuery({ queryKey: ["wait", "delivered", pair.id], queryFn: () => explore.delivered(), ...keep });
  const backend = useQuery({
    queryKey: ["wait", "backend", pair.id, direction],
    queryFn: async () => {
      const client = backendClientOf(endpoints(), transport);
      if (client === null) return null;
      // One of the two may fail without taking the other: a rule without timings still tells the batch wait.
      const [pipeline, benchmarks] = await Promise.allSettled([client.pipeline(direction), client.benchmarks("7d")]);
      return {
        rule: pipeline.status === "fulfilled" ? ruleOf(pipeline.value.rule) : null,
        proving: benchmarks.status === "fulfilled" ? provingOf(benchmarks.value.byDirection[direction]) : null,
      };
    },
    ...keep,
  });
  return useMemo(
    () => ({ sourceChainId: source.chainId, timing: timingFor(delivered.data ?? [], source.chainId), rule: backend.data?.rule ?? null, proving: backend.data?.proving ?? null }),
    [source.chainId, delivered.data, backend.data],
  );
};

/**
 * The timeline of a direction for a fee.
 *
 * @param direction The direction.
 * @param fee What the user pays, when known.
 */
export const useTimeline = (direction: Direction, fee: FeeReading): Timeline => {
  const inputs = useWaitInputs(direction);
  const key = fee.kind === "known" ? `${fee.feeUsd}/${fee.costUsd}` : fee.kind;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => buildTimeline(inputs, fee), [inputs, key]);
};
