import { Box, Button, Flex, Stack, Text } from "@chakra-ui/react";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import type { Hex } from "viem";
import { proofStartProblem } from "@zk-bridge/shared";
import { TransactionDialog } from "../actions/TransactionDialog";
import { useHeads } from "../app/queries";
import { useServices } from "../app/services";
import type { MessageDetail } from "../data/message-detail";
import type { WebStep } from "../tx/bridge-steps";
import { DataRow, Mono, Notice, Panel } from "../ui/primitives";
import { useWallet } from "../wallet/wallet-port";
import {
  FINAL_REQUEST_STATUSES,
  REQUEST_STATUS_TEXT,
  STAGES,
  backendClientOf,
  chosenDeliverySteps,
  deliverAvailability,
  directionOf,
  messageStage,
  planDelivery,
  planProofUpdate,
  postUpdateAvailability,
  readEvidence,
  readLatestProof,
  requestProofAvailability,
  type Availability,
  type AvailabilityInput,
} from "./proof-panel-model";

const POLL_MILLISECONDS = 15_000;
const REQUEST_POLL_MILLISECONDS = 5_000;

/** What the request button did. */
type RequestState =
  | { readonly kind: "idle" }
  | { readonly kind: "sending" }
  | { readonly kind: "accepted"; readonly requestId: string }
  | { readonly kind: "rate-limited"; readonly retryAfterSeconds: number }
  | { readonly kind: "nothing-to-prove" }
  | { readonly kind: "cannot-check"; readonly retryAfterSeconds: number }
  | { readonly kind: "failed" };

/** What the post button did. */
type PostState = { readonly kind: "idle" } | { readonly kind: "checking" } | { readonly kind: "blocked"; readonly reason: string };

const WhyOff = ({ availability, id }: { readonly availability: Availability; readonly id: string }) =>
  availability.enabled ? null : (
    <Text id={id} fontSize="sm" color="fg.muted" data-testid={id}>
      {availability.reason}
    </Text>
  );

/**
 * The proof panel of the message page: where the message is, the latest proof of its direction, a button to ask for a
 * proof, and the two write actions. Every transaction goes through the confirm dialog. The panel holds no key.
 *
 * @param props The message.
 */
export const ProofPanel = ({ detail }: { readonly detail: MessageDetail }) => {
  const services = useServices();
  const { pair } = services;
  const wallet = useWallet();
  const endpoints = services.endpoints();
  const direction = directionOf(pair, detail.sourceChainId);
  const destinationSide = detail.destinationChainId === pair.first.chainId ? "first" : "second";
  const heads = useHeads(pair.id);
  const headSlot = heads.data?.find((head) => head.side === destinationSide)?.storedHeadSlot ?? null;
  const client = backendClientOf(endpoints, services.transport);

  const proofReading = useQuery({
    queryKey: ["latest-proof", pair.id, direction, headSlot?.toString() ?? "unknown"],
    queryFn: () => readLatestProof({ endpoints, pair: pair.id, direction, headSlot, transport: services.transport }),
    refetchInterval: POLL_MILLISECONDS,
  });
  const evidenceReading = useQuery({
    queryKey: ["evidence", pair.id, detail.id],
    queryFn: () => readEvidence({ endpoints, messageId: detail.id, transport: services.transport }),
    refetchInterval: POLL_MILLISECONDS,
  });
  const deliveryPlan = useMemo(() => (evidenceReading.data === undefined ? null : planDelivery(evidenceReading.data, pair, { messageId: detail.id, sourceTransactionHash: detail.sourceTransactionHash })), [evidenceReading.data, pair, detail.id, detail.sourceTransactionHash]);

  const stage = messageStage({ status: detail.status, headSlot, sourceSlot: deliveryPlan?.kind === "ready" ? deliveryPlan.sourceSlot : null });
  const proof = proofReading.data?.kind === "found" ? proofReading.data : null;
  const facts: AvailabilityInput = { stage, backendSet: client !== null, walletConnected: wallet.status === "connected", proof: proof?.message ?? null, delivery: deliveryPlan };

  const [requestState, setRequestState] = useState<RequestState>({ kind: "idle" });
  const [postState, setPostState] = useState<PostState>({ kind: "idle" });
  const [reviewSteps, setReviewSteps] = useState<readonly WebStep[] | null>(null);
  const [skipped, setSkipped] = useState<readonly string[]>([]);

  const requestId = requestState.kind === "accepted" ? requestState.requestId : null;
  const requestStatus = useQuery({
    queryKey: ["request-status", requestId],
    queryFn: () => (client as NonNullable<typeof client>).requestStatus(requestId as string),
    enabled: requestId !== null && client !== null,
    refetchInterval: (query) => (FINAL_REQUEST_STATUSES.includes(query.state.data?.status ?? "") ? false : REQUEST_POLL_MILLISECONDS),
  });

  const requestAvailability = requestProofAvailability(facts);
  const updateAvailability = postUpdateAvailability(facts);
  const deliveryAvailability = deliverAvailability(facts);

  const requestProof = async (): Promise<void> => {
    // The button is off while there is no backend, while a request is sending and once one is accepted.
    setRequestState({ kind: "sending" });
    try {
      const answer = await (client as NonNullable<typeof client>).requestProof({ pair: pair.id, direction, reason: "message", messageId: detail.id as Hex });
      if (!("refused" in answer)) setRequestState({ kind: "accepted", requestId: answer.requestId });
      else if (answer.refused === "nothing-to-prove") setRequestState({ kind: "nothing-to-prove" });
      else setRequestState({ kind: answer.refused, retryAfterSeconds: answer.retryAfterSeconds });
    } catch {
      setRequestState({ kind: "failed" });
    }
  };

  const postUpdate = async (): Promise<void> => {
    // The button is off while there is no proof.
    const found = proof as NonNullable<typeof proof>;
    setPostState({ kind: "checking" });
    // The contract refuses an update that does not start at its current head, so read the head again from the chain.
    const current = await services.readLightClientHead(detail.destinationChainId).catch(() => null);
    if (current === null) {
      setPostState({ kind: "blocked", reason: "The page could not read the head of the light client. Check the RPC setting for the chain in Connections." });
      return;
    }
    const problem = proofStartProblem(found.message, current);
    if (problem !== null) {
      setPostState({ kind: "blocked", reason: problem });
      void proofReading.refetch();
      return;
    }
    setPostState({ kind: "idle" });
    // The proof came through the decoder, which checks its public values, so the plan cannot refuse it.
    setReviewSteps([planProofUpdate(found.message, pair)]);
  };

  const deliveryRows = deliveryPlan?.kind === "ready" ? deliveryPlan.steps : [];
  const deliver = (): void => {
    setReviewSteps(chosenDeliverySteps(deliveryRows, skipped));
  };
  const toggleSkip = (data: string): void => setSkipped((current) => (current.includes(data) ? current.filter((entry) => entry !== data) : [...current, data]));

  return (
    <Panel title="Proof and delivery">
      <Stack gap="3">
        <Box>
          <Flex gap="3" flexWrap="wrap" aria-label="Where the message is" data-testid="stage-list">
            {STAGES.map((entry) => (
              <Text key={entry.stage} as="span" fontSize="sm" fontWeight={entry.stage === stage ? "bold" : "normal"} color={entry.stage === stage ? "fg" : "fg.muted"} aria-current={entry.stage === stage ? "step" : undefined}>
                {entry.label}
              </Text>
            ))}
          </Flex>
          <Text fontSize="sm" color="fg.muted" data-testid="stage-meaning">
            {STAGES.find((entry) => entry.stage === stage)?.meaning}
          </Text>
        </Box>

        <Box data-testid="latest-proof">
          <Text fontWeight="medium" fontSize="sm">
            Latest proof for this direction
          </Text>
          {proofReading.data === undefined && proofReading.error === null ? <Text fontSize="sm" color="fg.muted">Looking for the latest proof…</Text> : null}
          {proof === null ? null : (
            <>
              <DataRow label="From">{proof.source}</DataRow>
              <DataRow label="Moves the head">from slot {proof.message.startSlot.toString()} to slot {proof.message.newSlot.toString()}</DataRow>
              <DataRow label="New head root"><Mono>{proof.message.newRoot}</Mono></DataRow>
              {proof.headCheckedAt === null ? null : <DataRow label="Checked">The indexer read the head of the light client just before it answered. The page reads it again before it posts.</DataRow>}
            </>
          )}
          {proofReading.data?.kind === "none" ? (
            <Stack gap="1">
              <Text fontSize="sm" color="fg.muted">No usable proof was found.</Text>
              {proofReading.data.notes.map((note) => (
                <Text key={note} fontSize="sm" color="fg.muted">{note}</Text>
              ))}
            </Stack>
          ) : null}
          {proofReading.error === null ? null : <Notice tone="error">The latest proof did not load.</Notice>}
        </Box>

        <Flex gap="4" flexWrap="wrap" alignItems="flex-start">
          <Stack gap="1" maxWidth="18rem">
            <Button size="sm" variant="outline" disabled={!requestAvailability.enabled || requestState.kind === "sending" || requestState.kind === "accepted"} aria-describedby="why-request-off" onClick={() => void requestProof()}>
              Request a proof
            </Button>
            <WhyOff availability={requestAvailability} id="why-request-off" />
          </Stack>
          <Stack gap="1" maxWidth="18rem">
            <Button size="sm" colorPalette="blue" disabled={!updateAvailability.enabled || postState.kind === "checking"} aria-describedby="why-update-off" onClick={() => void postUpdate()}>
              Post the light client update
            </Button>
            <WhyOff availability={updateAvailability} id="why-update-off" />
          </Stack>
        </Flex>

        {requestState.kind === "sending" ? <Text fontSize="sm">Sending the request…</Text> : null}
        {requestState.kind === "failed" ? <Notice tone="error">The backend did not accept the request. Try again later.</Notice> : null}
        {requestState.kind === "rate-limited" ? <Notice tone="warning">The backend limits requests. Try again in {requestState.retryAfterSeconds} seconds.</Notice> : null}
        {requestState.kind === "nothing-to-prove" ? (
          <Notice tone="info">The backend sees no message waiting for a proof, so it starts no proving run. Its chain indexer may not have seen this message as final yet.</Notice>
        ) : null}
        {requestState.kind === "cannot-check" ? (
          <Notice tone="warning">The backend could not check whether a proof is needed. Try again in {requestState.retryAfterSeconds} seconds.</Notice>
        ) : null}
        {requestState.kind === "accepted" ? (
          <Box data-testid="request-status">
            <DataRow label="Request"><Mono>{requestState.requestId}</Mono></DataRow>
            {requestStatus.data === undefined && requestStatus.error === null ? <Text fontSize="sm" color="fg.muted">Asking for the status…</Text> : null}
            {requestStatus.data === undefined ? null : (
              <>
                <DataRow label="Status">{REQUEST_STATUS_TEXT[requestStatus.data.status]}</DataRow>
                {requestStatus.data.error === null ? null : <DataRow label="Reason">{requestStatus.data.error}</DataRow>}
              </>
            )}
            {requestStatus.error === null ? null : <Notice tone="error">The status of the request did not load.</Notice>}
          </Box>
        ) : null}
        {postState.kind === "blocked" ? <Notice tone="warning">{postState.reason}</Notice> : null}

        <Box>
          <Text fontWeight="medium" fontSize="sm">
            Deliver the message
          </Text>
          {deliveryRows.length > 1 ? (
            <Stack gap="1" marginY="2" data-testid="delivery-steps">
              {deliveryRows.map((row) => (
                <label key={row.step.plan.data}>
                  <input type="checkbox" checked={!skipped.includes(row.step.plan.data)} disabled={row.role === "execute"} onChange={() => toggleSkip(row.step.plan.data)} /> {row.step.plan.title}
                  {row.reason === null ? "" : ` (${row.reason})`}
                </label>
              ))}
              <Text fontSize="sm" color="fg.muted">Clear a layout row that the chain already holds. The delivery itself always runs.</Text>
            </Stack>
          ) : null}
          <Stack gap="1" maxWidth="18rem">
            <Button size="sm" colorPalette="blue" disabled={!deliveryAvailability.enabled} aria-describedby="why-deliver-off" onClick={deliver}>
              Deliver the message
            </Button>
            <WhyOff availability={deliveryAvailability} id="why-deliver-off" />
          </Stack>
        </Box>
      </Stack>
      {reviewSteps === null ? null : <TransactionDialog steps={reviewSteps} onClose={() => setReviewSteps(null)} />}
    </Panel>
  );
};
