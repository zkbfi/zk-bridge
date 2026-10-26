import { Box, Heading, Stack, Text } from "@chakra-ui/react";
import type { Hex } from "viem";
import { useMessage } from "../app/queries";
import { useServices } from "../app/services";
import { chainNameOf } from "../data/message-detail";
import { formatAmountWithSymbol, formatTimestamp, STATUS_MEANINGS } from "../ui/format";
import { DataRow, Mono, Notice, Panel, StatusBadge } from "../ui/primitives";

const callOutcomeText = (succeeded: boolean | null): string => {
  if (succeeded === null) return "unknown";
  return succeeded ? "succeeded" : "reverted";
};

/**
 * The page of one transfer or message: the status, the facts of both chains and the transfer.
 *
 * @param props The message identifier.
 */
export const MessageView = ({ messageId }: { readonly messageId: Hex }) => {
  const { pair } = useServices();
  const message = useMessage(messageId);
  if (message.error !== null && message.data === undefined) return <Notice tone="error">The message did not load: {message.error.message}</Notice>;
  if (message.data === undefined) return <Text color="fg.muted">Loading…</Text>;
  if (message.data === null) return <Notice tone="warning">The indexer does not know the message <Mono>{messageId}</Mono>.</Notice>;
  const detail = message.data;
  const source = chainNameOf(pair, detail.sourceChainId);
  const destination = chainNameOf(pair, detail.destinationChainId);
  return (
    <Stack gap="3">
      <Box>
        <Heading as="h1" size="lg">
          {detail.kind === "token" ? "Transfer" : "Message"}
        </Heading>
        <Mono>{detail.id}</Mono>
        <Box marginTop="2">
          <StatusBadge status={detail.status} />
          <Text fontSize="sm" color="fg.muted" marginTop="1">
            {STATUS_MEANINGS[detail.status]}
          </Text>
        </Box>
      </Box>
      <Panel title={`Sent on ${source}`}>
        <DataRow label="Time">{formatTimestamp(detail.sentAt)} UTC</DataRow>
        <DataRow label="Block">{detail.sentBlockNumber}</DataRow>
        <DataRow label="Transaction"><Mono>{detail.sourceTransactionHash}</Mono></DataRow>
        <DataRow label="Sender"><Mono>{detail.sender}</Mono></DataRow>
      </Panel>
      <Panel title="Covered by a stored light client head">
        {detail.coveredByHeadSlot === null ? <Text fontSize="sm" color="fg.muted">Not yet. The light client on {destination} has not stored a head that covers this send.</Text> : (
          <>
            <DataRow label="Head slot">{detail.coveredByHeadSlot}</DataRow>
            <DataRow label="Time">{detail.coveredAt === null ? "unknown" : `${formatTimestamp(detail.coveredAt)} UTC`}</DataRow>
          </>
        )}
      </Panel>
      <Panel title={`Delivered on ${destination}`}>
        {detail.deliveredAt === null ? <Text fontSize="sm" color="fg.muted">Not delivered yet.</Text> : (
          <>
            <DataRow label="Time">{formatTimestamp(detail.deliveredAt)} UTC</DataRow>
            <DataRow label="Transaction">{detail.destinationTransactionHash === null ? "unknown" : <Mono>{detail.destinationTransactionHash}</Mono>}</DataRow>
            <DataRow label="Call">{callOutcomeText(detail.deliverySucceeded)}</DataRow>
            <DataRow label="Delivered by">{detail.executedBy === null ? "unknown" : <Mono>{detail.executedBy}</Mono>}</DataRow>
          </>
        )}
      </Panel>
      {detail.transfer === null ? (
        <Panel title="Target and gas">
          <DataRow label="Target"><Mono>{detail.executor}</Mono></DataRow>
          <DataRow label="Gas">{detail.gasLimit ?? "unknown"}</DataRow>
        </Panel>
      ) : (
        <Panel title="Amounts and recipient">
          <DataRow label="Amount sent on">{formatAmountWithSymbol(detail.transfer.value, detail.transfer.sourceToken)} (after the source fee)</DataRow>
          <DataRow label="Delivered">{detail.transfer.deliveredValue === null ? "not yet" : formatAmountWithSymbol(detail.transfer.deliveredValue, detail.transfer.destinationToken)}</DataRow>
          <DataRow label="Recipient"><Mono>{detail.transfer.recipient}</Mono></DataRow>
          <DataRow label="Fallback"><Mono>{detail.transfer.fallbackRecipient}</Mono></DataRow>
          <DataRow label="With callback">{detail.transfer.hasCallback ? "yes" : "no"}</DataRow>
        </Panel>
      )}
    </Stack>
  );
};
