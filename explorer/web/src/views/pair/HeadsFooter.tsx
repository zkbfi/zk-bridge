import { Box, Flex, Text } from "@chakra-ui/react";
import type { LightClientHead, PairConfig } from "@terminal/model/types";
import { formatAge, formatLag, formatSlot, lagSeverity } from "../../ui/format";

/** Props of {@link HeadsFooter}. */
export type HeadsFooterProps = {
  readonly pair: PairConfig;
  readonly heads: readonly LightClientHead[] | undefined;
  readonly now: number;
};

const SEVERITY_COLORS = { unknown: "fg.muted", good: "green.fg", warning: "orange.fg", bad: "red.fg" } as const;

/**
 * The footer: the light client head of each chain. The chain that stores the head names the chain that it tracks.
 *
 * @param props The pair, the heads and the clock.
 */
export const HeadsFooter = ({ pair, heads, now }: HeadsFooterProps) => (
  <Box as="footer" aria-label="Light client heads" borderTopWidth="1px" borderColor="border" paddingY="2" fontSize="sm">
    <Flex gap={{ base: "2", md: "8" }} flexWrap="wrap">
      {(["first", "second"] as const).map((side) => {
        const holder = side === "first" ? pair.first : pair.second;
        const tracked = side === "first" ? pair.second : pair.first;
        const head = heads?.find((candidate) => candidate.side === side);
        if (head === undefined) {
          return (
            <Text key={side} color="fg.muted">
              {holder.name} stores no head of {tracked.name} yet.
            </Text>
          );
        }
        return (
          <Text key={side}>
            <strong>{holder.name}</strong> stores {tracked.name}: head {head.storedHeadSlot === null ? "none" : formatSlot(head.storedHeadSlot)}, finalized {head.finalizedSlot === null ? "unknown" : formatSlot(head.finalizedSlot)}, lag{" "}
            <Text as="span" color={SEVERITY_COLORS[lagSeverity(head)]}>
              {formatLag(head)}
            </Text>
            , updated {head.lastUpdateAt === null ? "never" : formatAge(now, head.lastUpdateAt)}
          </Text>
        );
      })}
    </Flex>
  </Box>
);
