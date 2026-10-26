import { Box, Flex, Text } from "@chakra-ui/react";
import type { ReactNode } from "react";
import type { GateStatus, PairConfig, PairSummary } from "@terminal/model/types";
import type { PartialFigure } from "@zk-bridge/shared";
import { formatAge, formatAmountWithSymbol } from "../../ui/format";
import { Notice } from "../../ui/primitives";

/** Props of {@link SummaryBar}. */
export type SummaryBarProps = {
  readonly pair: PairConfig;
  readonly summary: PairSummary | undefined;
  readonly error: string | null;
  readonly now: number;
};

const GATE_WORDS: Readonly<Record<GateStatus, string>> = {
  open: "open",
  warn: "not enforcing yet",
  stop: "sends closed",
  sealed: "sealed",
  stale: "stale",
  unknown: "unknown",
};

const GATE_PALETTES: Readonly<Record<GateStatus, string>> = {
  open: "green.fg",
  warn: "orange.fg",
  stop: "red.fg",
  sealed: "red.fg",
  stale: "orange.fg",
  unknown: "fg.muted",
};

const Stat = ({ term, children }: { readonly term: string; readonly children: ReactNode }) => (
  <Box minWidth="0">
    <Text as="dt" fontSize="xs" color="fg.muted">
      {term}
    </Text>
    <Text as="dd" fontSize="sm" fontWeight="medium" margin="0">
      {children}
    </Text>
  </Box>
);

/**
 * The summary across the top: pair, transfers in flight, volume of 24 hours, fees accrued, gate state and the last
 * light client update.
 *
 * @param props The pair, the summary and the clock.
 */
export const SummaryBar = ({ pair, summary, error, now }: SummaryBarProps) => {
  if (summary === undefined) {
    return error === null ? <Text fontSize="sm" color="fg.muted">Loading the summary…</Text> : <Notice tone="error">The summary did not load: {error}</Notice>;
  }
  const updates = summary.heads.flatMap((head) => (head.lastUpdateAt === null ? [] : [head.lastUpdateAt]));
  const lastUpdate = updates.length === 0 ? null : Math.max(...updates);
  const volume = summary.volume24h.byToken.map((entry) => formatAmountWithSymbol(entry.amount, entry.token)).join(" · ");
  const partial = summary.partial ?? [];
  const atLeast = (figure: PartialFigure): string => (partial.includes(figure) ? "at least " : "");
  const anyPartial = (["volume24h", "inFlight", "feesAccrued"] as const).some((figure) => partial.includes(figure));
  const fees = summary.feesAccrued.map((entry) => formatAmountWithSymbol(entry.amount, entry.token)).join(" · ");
  return (
    <Box>
      {error === null ? null : <Notice tone="warning">The last refresh failed ({error}). The numbers below are the last good ones.</Notice>}
      <Flex as="dl" margin="0" gap={{ base: "3", md: "6" }} flexWrap="wrap" alignItems="flex-start" aria-label="Summary">
        <Stat term="Pair">
          {pair.id}: {pair.first.name} and {pair.second.name}
        </Stat>
        <Stat term="In flight">
          {atLeast("inFlight")}
          {summary.inFlight}
        </Stat>
        <Stat term="Volume, 24 hours">
          {atLeast("volume24h")}
          {summary.volume24h.transferCount} transfers{volume === "" ? "" : `, ${volume}`}
        </Stat>
        <Stat term="Fees accrued">
          {fees === "" ? "none" : `${atLeast("feesAccrued")}${fees}`}
        </Stat>
        {(["first", "second"] as const).map((side) => {
          const chain = side === "first" ? pair.first : pair.second;
          return (
            <Stat key={side} term={`Gate on ${chain.name}`}>
              <Text as="span" color={GATE_PALETTES[summary.gates[side]]}>
                {GATE_WORDS[summary.gates[side]]}
              </Text>
            </Stat>
          );
        })}
        <Stat term="Last light client update">{lastUpdate === null ? "none seen" : formatAge(now, lastUpdate)}</Stat>
      </Flex>
      {anyPartial ? (
        <Text fontSize="xs" color="fg.muted" marginTop="1">
          RPC fallback: recent history only
        </Text>
      ) : null}
    </Box>
  );
};
