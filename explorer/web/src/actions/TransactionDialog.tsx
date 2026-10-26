import { Box, Button, Flex, Stack, Text } from "@chakra-ui/react";
import { useRouterAddresses } from "../app/queries";
import { buildConfirmView, type ConfirmLine, type ConfirmView } from "../tx/confirm-model";
import type { WebStep } from "../tx/bridge-steps";
import type { SequenceState } from "../tx/transaction-sequence";
import { formatUnits, shortenHex } from "../ui/format";
import { Modal } from "../ui/Modal";
import { DataRow, Mono, Notice } from "../ui/primitives";
import { useTransactionSequence } from "./use-transaction-sequence";

/** Props of {@link TransactionDialog}. */
export type TransactionDialogProps = {
  readonly steps: readonly WebStep[];
  readonly onClose: () => void;
};

const LineList = ({ title, lines }: { readonly title: string; readonly lines: readonly ConfirmLine[] }) => (
  <Box marginTop="3">
    <Text fontWeight="medium" fontSize="sm">
      {title}
    </Text>
    {lines.map((line) => (
      <DataRow key={line.label} label={line.label}>
        <Text as="span" fontSize="sm">
          {line.text}
        </Text>
      </DataRow>
    ))}
  </Box>
);

type ReviewProps = {
  readonly view: ConfirmView;
  readonly prepared: NonNullable<SequenceState["prepared"]>;
  readonly position: string | null;
};

const Review = ({ view, prepared, position }: ReviewProps) => {
  const native = prepared.plan.chain.nativeSymbol;
  return (
    <Box data-testid="confirm-review">
      {position === null ? null : (
        <Text fontSize="sm" color="fg.muted">
          {position}
        </Text>
      )}
      <Text fontWeight="semibold">{view.title}</Text>
      <Box marginTop="2">
        <DataRow label="Chain">{view.chainText}</DataRow>
        <DataRow label="From">
          <Mono>{prepared.from}</Mono>
        </DataRow>
        <DataRow label="Contract">{view.contractText}</DataRow>
        <DataRow label="Function">
          <Mono>{view.functionSignature}</Mono>
        </DataRow>
        <DataRow label="Value sent">{view.valueText}</DataRow>
      </Box>
      <Box marginTop="3">
        <Text fontWeight="medium" fontSize="sm">
          Arguments, read from the bytes that your wallet will receive
        </Text>
        {view.arguments.map((argument) => (
          <DataRow key={argument.name} label={argument.name}>
            <Mono>{argument.value}</Mono>
            {argument.meaning === undefined ? null : (
              <Text as="span" fontSize="sm" color="fg.muted">
                {" "}
                ({argument.meaning})
              </Text>
            )}
          </DataRow>
        ))}
      </Box>

      {view.bridgeFees === null ? null : <LineList title={`Bridge fee (${view.bridgeFees.appliesTo})`} lines={view.bridgeFees.lines} />}

      {view.noRouterNotice === null ? null : (
        <Box marginTop="3" data-testid="confirm-no-router">
          <Notice tone="info">{view.noRouterNotice}</Notice>
        </Box>
      )}

      {view.delivery === null ? null : (
        <Box marginTop="3" borderWidth="1px" borderColor="border" borderRadius="md" padding="3" data-testid="confirm-delivery">
          <Text fontWeight="medium" fontSize="sm">
            Tip for delivery ({view.delivery.appliesTo})
          </Text>
          <DataRow label="Router">
            <Mono>{view.delivery.routerText}</Mono>
          </DataRow>
          {view.delivery.routerWarning === null ? null : (
            <Box data-testid="confirm-router-warning">
              <Notice tone="warning">{view.delivery.routerWarning}</Notice>
            </Box>
          )}
          <DataRow label="Tip goes to">
            <Mono>{view.delivery.rewardAddressText}</Mono>
          </DataRow>
          <DataRow label="If delivery fails">
            <Text as="span" data-testid="confirm-failed-delivery">
              {view.delivery.failedDeliveryText}
            </Text>
          </DataRow>
          {view.delivery.routerAddressesWarning === null ? null : (
            <Box data-testid="confirm-router-addresses-warning">
              <Notice tone="warning">{view.delivery.routerAddressesWarning}</Notice>
            </Box>
          )}
          <DataRow label="Tip mode">{view.delivery.tipMode}</DataRow>
          <DataRow label="Tip now">
            <Text as="span" data-testid="confirm-tip-now">
              {view.delivery.tipNow}
            </Text>
          </DataRow>
          <Text fontSize="sm" fontWeight="medium" data-testid="confirm-runner-maximum">
            {view.delivery.runnerMaximum}
          </Text>
          <Text fontSize="sm" color="fg.muted">
            It is {view.delivery.certaintyLabel}. How it is computed: {view.delivery.formula}.
          </Text>
          <Box fontSize="sm" color="fg.muted" data-testid="confirm-runner-notes">
            {view.delivery.runnerNotes.map((note) => (
              <Text key={note}>{note}</Text>
            ))}
          </Box>
          {view.delivery.costLines.length === 0 ? null : <LineList title="Cost lines" lines={view.delivery.costLines} />}
          <LineList title="Tip terms in the call data" lines={view.delivery.directorLines} />
          <Text fontSize="xs" color="fg.muted" marginTop="2">
            Data: {view.delivery.dataSource}. {view.delivery.baseFee}.
          </Text>
        </Box>
      )}

      <Box marginTop="3">
        <Text fontWeight="medium" fontSize="sm">
          Network fee
        </Text>
        <DataRow label="Gas">
          estimate {prepared.gasEstimate.toString()}, limit {prepared.gasLimit.toString()}
        </DataRow>
        <DataRow label="At most">
          {formatUnits(prepared.maximumNetworkFee, 18)} {native} (max fee {formatUnits(prepared.unsigned.maxFeePerGas ?? 0n, 9)} gwei, tip {formatUnits(prepared.unsigned.maxPriorityFeePerGas ?? 0n, 9)} gwei)
        </DataRow>
      </Box>
      {view.notes.length === 0 ? null : (
        <Stack as="ul" gap="1" marginTop="3" paddingLeft="4" fontSize="sm" color="orange.fg">
          {view.notes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </Stack>
      )}
    </Box>
  );
};

/**
 * The confirm dialog. It prepares each transaction, shows it in full, and hands it to the wallet only when the user
 * presses the send button. With several steps (an allowance, then the relay) it shows each one in turn.
 *
 * @param props The planned transactions and the close handler.
 */
export const TransactionDialog = ({ steps, onClose }: TransactionDialogProps) => {
  const { state, sequence } = useTransactionSequence(steps);
  const step = state.steps[state.stepIndex];
  const delivery = step?.disclosure.delivery ?? null;
  const routerAddresses = useRouterAddresses(step?.disclosure.destinationChainId ?? null, delivery?.router ?? null, { enabled: delivery !== null });
  const view = step === undefined ? null : buildConfirmView(step, routerAddresses.data);
  const blockedMessage = state.phase === "review" && view !== null ? view.blockedReason : null;
  const cancel = (): void => {
    sequence.cancel();
    onClose();
  };
  const position = state.steps.length > 1 ? `Step ${Math.min(state.stepIndex + 1, state.steps.length)} of ${state.steps.length}` : null;

  return (
    <Modal title="Review before you sign" width="46rem" onClose={onClose}>
      <Box aria-live="polite">
        {state.phase === "preparing" ? <Text>Preparing the transaction: estimating gas and fees…</Text> : null}
        {state.phase === "wallet" ? <Notice tone="info">Confirm in your wallet. With a hardware wallet, read the screen of the device too.</Notice> : null}
        {state.phase === "confirming" ? <Notice tone="info">Submitted{state.submittedHash === null ? "" : ` as ${shortenHex(state.submittedHash, 8)}`}. Waiting for the chain to confirm it…</Notice> : null}
        {state.phase === "error" ? <Notice tone="error">{state.error}</Notice> : null}
        {state.phase === "finished" ? <Notice tone="info">Done. Every transaction is confirmed.</Notice> : null}
      </Box>

      {view !== null && state.prepared !== null && (state.phase === "review" || state.phase === "wallet" || state.phase === "confirming") ? (
        <Review view={view} prepared={state.prepared} position={position} />
      ) : null}

      {state.outcomes.length === 0 ? null : (
        <Box marginTop="3">
          <Text fontWeight="medium" fontSize="sm">
            Sent so far
          </Text>
          {state.outcomes.map((outcome) => (
            <DataRow key={outcome.transactionHash} label={outcome.status}>
              {outcome.title}: <Mono>{outcome.transactionHash}</Mono>
            </DataRow>
          ))}
        </Box>
      )}

      {blockedMessage === null ? null : <Notice tone="error">{blockedMessage}</Notice>}

      <Flex gap="2" marginTop="4" justifyContent="flex-end" flexWrap="wrap">
        {state.phase === "review" ? (
          <>
            <Button variant="outline" onClick={cancel}>
              Cancel
            </Button>
            <Button colorPalette="blue" disabled={view === null || view.blockedReason !== null} onClick={() => sequence.confirm()}>
              Send to wallet
            </Button>
          </>
        ) : null}
        {state.phase === "error" ? (
          <>
            <Button variant="outline" onClick={onClose}>
              Close
            </Button>
            {state.outcomes.some((outcome) => outcome.status === "reverted") ? null : <Button onClick={() => sequence.retry()}>Try again</Button>}
          </>
        ) : null}
        {state.phase === "finished" || state.phase === "cancelled" ? <Button onClick={onClose}>Close</Button> : null}
        {state.phase === "preparing" ? (
          <Button variant="outline" onClick={cancel}>
            Cancel
          </Button>
        ) : null}
      </Flex>
    </Modal>
  );
};
