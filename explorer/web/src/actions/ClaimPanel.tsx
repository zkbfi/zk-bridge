import { Box, Button, Flex, Stack, Text } from "@chakra-ui/react";
import type { Address } from "viem";
import { buildClaimSteps, claimableEntries } from "@terminal/app/actions";
import type { ChainSnapshotResult } from "@terminal/chain/live-reads";
import type { PairConfig } from "@terminal/model/types";
import type { WebStep } from "../tx/bridge-steps";
import { formatAmountWithSymbol } from "../ui/format";

/** Props of {@link ClaimPanel}. */
export type ClaimPanelProps = {
  readonly pair: PairConfig;
  readonly snapshots: readonly ChainSnapshotResult[] | null;
  readonly account: Address;
  readonly onReview: (steps: readonly WebStep[]) => void;
};

const NO_DISCLOSURE = { feesApplyTo: "this-transaction", amountToken: null, destinationNativeSymbol: null, destinationChainId: null, bridgeFees: null, delivery: null } as const;

/**
 * The claimable balances of the account on both chains, one button each. The mediator pays only the account, whoever
 * sends the claim.
 *
 * @param props The pair, the live state and the review handler.
 */
export const ClaimPanel = ({ pair, snapshots, account, onReview }: ClaimPanelProps) => {
  const entries = claimableEntries(snapshots);
  if (entries.length === 0) {
    return (
      <Text fontSize="sm" color="fg.muted">
        Nothing is claimable for this account on either chain.
      </Text>
    );
  }
  return (
    <Stack gap="2" as="ul" listStyleType="none" margin="0" padding="0">
      {entries.map((entry) => {
        const chain = entry.side === "first" ? pair.first : pair.second;
        return (
          <Flex key={`${entry.side}-${entry.position.token.address}`} as="li" alignItems="center" justifyContent="space-between" gap="2" flexWrap="wrap">
            <Box>
              <Text fontSize="sm" fontWeight="medium">
                {formatAmountWithSymbol(entry.position.claimable, entry.position.token)}
              </Text>
              <Text fontSize="xs" color="fg.muted">
                on {chain.name}
              </Text>
            </Box>
            <Button size="sm" variant="outline" onClick={() => onReview(buildClaimSteps(entry, pair, account).map((step): WebStep => ({ plan: step.plan, disclosure: NO_DISCLOSURE })))}>
              Claim {entry.position.token.symbol}
            </Button>
          </Flex>
        );
      })}
    </Stack>
  );
};
