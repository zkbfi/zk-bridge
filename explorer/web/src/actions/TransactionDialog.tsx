import { Button } from "@chakra-ui/react";
import { useEffect, type ReactNode } from "react";
import { useRouterAddresses } from "../app/queries";
import { buildConfirmView, type ConfirmLine, type ConfirmView, type DeliveryView } from "../tx/confirm-model";
import type { WebStep } from "../tx/bridge-steps";
import { canRetry, type SequenceState } from "../tx/transaction-sequence";
import { formatUnits, shortenHex } from "../ui/format";
import { Modal } from "../ui/Modal";
import { Notice } from "../ui/primitives";
import { useTransactionSequence } from "./use-transaction-sequence";
import { Sheet } from "../bridge/Sheet";
import { StepList } from "../bridge/StepList";
import { Chevron } from "../bridge/icons";
import "./review.css";

/** Props of {@link TransactionDialog}. */
export type TransactionDialogProps = {
  readonly steps: readonly WebStep[];
  readonly onClose: () => void;
  /**
   * `sheet`: the bridge screen's look (a square panel from the bottom edge on phones, a centred modal on desktop, pill
   * buttons, the transactions as a joined step list). `modal` (default): the explorer's dialog.
   */
  readonly variant?: "modal" | "sheet";
  /** Called once with the hash of the last transaction when every step is confirmed (the bridge records it as pending). */
  readonly onFinished?: (lastHash: string) => void;
};

/** One row of the review: a muted label and its value, as siblings. */
const Row = ({ label, children, testId }: { readonly label: string; readonly children: ReactNode; readonly testId?: string }) => (
  <div className="zb-rv-row">
    <span className="zb-rv-k">{label}</span>
    <span className="zb-rv-v" {...(testId === undefined ? {} : { "data-testid": testId })}>
      {children}
    </span>
  </div>
);

const Mono = ({ children }: { readonly children: ReactNode }) => <span className="zb-rv-mono">{children}</span>;

/** A disclosure: a pill summary with a centred chevron, its content under it. Closed unless `open`. */
const Disclosure = ({ summary, open = false, children, testId }: { readonly summary: string; readonly open?: boolean; readonly children: ReactNode; readonly testId?: string }) => (
  <details className="zb-rv-more" open={open} {...(testId === undefined ? {} : { "data-testid": testId })}>
    <summary>
      {summary}
      <Chevron />
    </summary>
    <div className="zb-rv-more-body">{children}</div>
  </details>
);

const LineList = ({ title, lines }: { readonly title: string; readonly lines: readonly ConfirmLine[] }) => (
  <div className="zb-rv-group">
    <h4 className="zb-rv-h">{title}</h4>
    {lines.map((line) => (
      <Row key={line.label} label={line.label}>
        {line.text}
      </Row>
    ))}
  </div>
);

/** The headline: what happens, the amount and where it goes. */
const Headline = ({ view }: { readonly view: ConfirmView }) => (
  <div className="zb-rv-head" data-testid="confirm-headline">
    <h3 className="zb-rv-title">{view.title}</h3>
    {view.amountText === null ? null : <p className="zb-rv-amount">{view.amountText}</p>}
    {view.destinationText === null ? null : <p className="zb-rv-dest">{view.destinationText}</p>}
  </div>
);

/** The tip of a relay: the router, the tip now and the most it can take, the warnings; the terms behind a disclosure. */
const DeliveryPanel = ({ delivery }: { readonly delivery: DeliveryView }) => (
  <section className="zb-rv-panel" data-testid="confirm-delivery">
    <h4 className="zb-rv-h">Tip for delivery ({delivery.appliesTo})</h4>
    <Row label="Tip now" testId="confirm-tip-now">
      {delivery.tipNow}
    </Row>
    <Row label="Tip at most">{delivery.tipLimitText}</Row>
    <Row label="Tip mode">{delivery.tipMode}</Row>
    <Row label="Router">
      <Mono>{delivery.routerText}</Mono>
    </Row>
    {delivery.routerWarning === null ? null : (
      <div data-testid="confirm-router-warning" className="zb-rv-warn" role="status">
        {delivery.routerWarning}
      </div>
    )}
    {delivery.routerAddressesWarning === null ? null : (
      <div data-testid="confirm-router-addresses-warning" className="zb-rv-warn" role="status">
        {delivery.routerAddressesWarning}
      </div>
    )}
    <Disclosure summary="Tip terms and costs">
      <Row label="Tip goes to">
        <Mono>{delivery.rewardAddressText}</Mono>
      </Row>
      <Row label="If delivery fails" testId="confirm-failed-delivery">
        {delivery.failedDeliveryText}
      </Row>
      <p className="zb-rv-p zb-rv-strong" data-testid="confirm-tip-maximum">
        {delivery.tipMaximum}
      </p>
      {delivery.gasModeHelp === null ? null : (
        <p className="zb-rv-p" data-testid="confirm-gas-mode-help">
          {delivery.gasModeHelp}
        </p>
      )}
      {delivery.gasNotice === null ? null : (
        <p className="zb-rv-p" data-testid="confirm-gas-notice">
          {delivery.gasNotice}
        </p>
      )}
      <p className="zb-rv-p">
        It is {delivery.certaintyLabel}. How it is computed: {delivery.formula}.
      </p>
      <div className="zb-rv-p" data-testid="confirm-tip-notes">
        {delivery.tipNotes.map((note) => (
          <p key={note}>{note}</p>
        ))}
      </div>
      {delivery.costLines.length === 0 ? null : <LineList title="Cost lines" lines={delivery.costLines} />}
      <LineList title="Tip terms in the call data" lines={delivery.directorLines} />
      {delivery.callLines.length === 0 ? null : (
        <div data-testid="confirm-delivery-call">
          <LineList title="Call after the delivery" lines={delivery.callLines} />
          <p className="zb-rv-p" data-testid="confirm-call-note">
            {delivery.callNote}
          </p>
        </div>
      )}
      <p className="zb-rv-p zb-rv-small">
        Data: {delivery.dataSource}. {delivery.baseFee}.
      </p>
    </Disclosure>
  </section>
);

/** The transactions of the sequence that are mined: their status as a pill, their title and their hash. */
const SentRows = ({ outcomes }: { readonly outcomes: SequenceState["outcomes"] }) => (
  <>
    {outcomes.map((outcome) => (
      <div key={outcome.transactionHash} className="zb-rv-sent">
        <span className="zb-rv-pill" data-status={outcome.status}>
          {outcome.status}
        </span>
        <span className="zb-rv-sent-text">
          {outcome.title}: <Mono>{outcome.transactionHash}</Mono>
        </span>
      </div>
    ))}
  </>
);

type ReviewProps = {
  readonly view: ConfirmView;
  readonly prepared: NonNullable<SequenceState["prepared"]>;
  readonly outcomes: SequenceState["outcomes"];
};

/**
 * The transaction under review: the key facts first (chain, contract, function, value, the most the network fee can
 * be), the tip of a relay, then everything the bytes say behind Details. The decoded arguments are always there.
 */
const Review = ({ view, prepared, outcomes }: ReviewProps) => {
  const native = prepared.plan.chain.nativeSymbol;
  return (
    <div data-testid="confirm-review" className="zb-rv-review">
      <section className="zb-rv-panel zb-rv-facts">
        <Row label="Chain">{view.chainText}</Row>
        <Row label="Contract">{view.contractText}</Row>
        <Row label="Function">
          <Mono>{view.functionSignature}</Mono>
        </Row>
        <Row label="Value sent">{view.valueText}</Row>
        <Row label="Network fee">
          at most {formatUnits(prepared.maximumNetworkFee, 18)} {native}
        </Row>
      </section>

      {view.noRouterNotice === null ? null : (
        <p className="zb-rv-p zb-rv-notice" data-testid="confirm-no-router">
          {view.noRouterNotice}
        </p>
      )}

      {view.delivery === null ? null : <DeliveryPanel delivery={view.delivery} />}

      <Disclosure summary="Details" testId="confirm-details">
        <div className="zb-rv-group">
          <h4 className="zb-rv-h">Arguments, read from the bytes that your wallet will receive</h4>
          {view.arguments.map((argument) => (
            <Row key={argument.name} label={argument.name}>
              <Mono>{argument.value}</Mono>
              {argument.meaning === undefined ? null : <span className="zb-rv-meaning"> ({argument.meaning})</span>}
            </Row>
          ))}
        </div>
        <div className="zb-rv-group">
          <h4 className="zb-rv-h">Sender and gas</h4>
          <Row label="From">
            <Mono>{prepared.from}</Mono>
          </Row>
          <Row label="Gas">
            estimate {prepared.gasEstimate.toString()}, limit {prepared.gasLimit.toString()}
          </Row>
          <Row label="Fee per gas">
            max fee {formatUnits(prepared.unsigned.maxFeePerGas ?? 0n, 9)} gwei, tip {formatUnits(prepared.unsigned.maxPriorityFeePerGas ?? 0n, 9)} gwei
          </Row>
          <Row label="Network fee in wei">{prepared.maximumNetworkFee.toString()}</Row>
        </div>
        {view.notes.length === 0 ? null : (
          <ul className="zb-rv-notes">
            {view.notes.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
        )}
        {outcomes.length === 0 ? null : (
          <div className="zb-rv-group" data-testid="confirm-sent">
            <h4 className="zb-rv-h">Sent so far</h4>
            <SentRows outcomes={outcomes} />
          </div>
        )}
      </Disclosure>
    </div>
  );
};

/** Props of {@link TransactionReview}. */
export type TransactionReviewProps = {
  readonly steps: readonly WebStep[];
  readonly state: SequenceState;
  /** The review of the current step, or null before a step exists. */
  readonly view: ConfirmView | null;
  readonly variant: "modal" | "sheet";
  readonly onClose: () => void;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
  readonly onRetry: () => void;
};

/**
 * What the confirm dialog draws for a state of the sequence, with no wallet or chain access: the headline, the steps,
 * the phase, the review of the current step, what was sent so far and the buttons.
 *
 * @param props The steps, the state, the review and the handlers.
 */
export const TransactionReview = ({ steps, state, view, variant, onClose, onCancel, onConfirm, onRetry }: TransactionReviewProps) => {
  const listed = state.steps.length === 0 ? steps : state.steps;
  const blockedMessage = state.phase === "review" && view !== null ? view.blockedReason : null;
  const position = listed.length > 1 ? `Step ${Math.min(state.stepIndex + 1, listed.length)} of ${listed.length}` : null;
  const reviewing = view !== null && state.prepared !== null && (state.phase === "review" || state.phase === "wallet" || state.phase === "confirming");
  return (
    <div className="zb-rv">
      {view === null || state.phase === "finished" ? null : <Headline view={view} />}

      {variant === "sheet" && listed.length > 1 ? (
        <div className="zb-rv-steps">
          <StepList
            steps={listed.map((planned, index) => ({
              label: planned.plan.title,
              ...(index < state.outcomes.length ? { at: state.outcomes[index]!.status } : index === state.stepIndex ? { at: state.phase === "wallet" ? "in your wallet" : state.phase === "confirming" ? "confirming" : "now" } : { estimate: "next" }),
            }))}
            current={state.phase === "finished" ? listed.length : state.stepIndex}
          />
        </div>
      ) : position === null ? null : (
        <p className="zb-rv-position">{position}</p>
      )}

      <div aria-live="polite" className="zb-rv-status">
        {state.phase === "preparing" ? <p className="zb-rv-p">Preparing the transaction: estimating gas and fees…</p> : null}
        {state.phase === "waiting" && state.gateWait != null ? (
          <Notice tone="info">
            The {state.gateWait.chainName} deposit gate needs a beacon header of epoch {state.gateWait.epoch.toString()} on chain before this epoch can be confirmed. Checking again in {state.gateWait.seconds} seconds.
          </Notice>
        ) : null}
        {state.phase === "wallet" ? <Notice tone="info">Confirm in your wallet. With a hardware wallet, read the screen of the device too.</Notice> : null}
        {state.phase === "confirming" ? <Notice tone="info">Submitted{state.submittedHash === null ? "" : ` as ${shortenHex(state.submittedHash, 8)}`}. Waiting for the chain to confirm it…</Notice> : null}
        {state.phase === "error" ? <Notice tone="error">{state.error}</Notice> : null}
        {state.phase === "finished" ? <Notice tone="info">Done. Every transaction is confirmed.</Notice> : null}
      </div>

      {reviewing ? <Review view={view} prepared={state.prepared!} outcomes={state.outcomes} /> : null}

      {reviewing || state.outcomes.length === 0 ? null : (
        <Disclosure summary="Sent so far" open={state.phase === "error"} testId="confirm-sent">
          <SentRows outcomes={state.outcomes} />
        </Disclosure>
      )}

      {blockedMessage === null ? null : <Notice tone="error">{blockedMessage}</Notice>}

      <div className="zb-rv-actions">
        {state.phase === "review" ? (
          <>
            <Button variant="outline" className="zb-rv-quiet" onClick={onCancel}>
              Cancel
            </Button>
            <Button colorPalette="blue" className="zb-rv-send" disabled={view === null || view.blockedReason !== null} onClick={onConfirm}>
              Send to wallet
            </Button>
          </>
        ) : null}
        {state.phase === "error" ? (
          <>
            <Button variant="outline" className="zb-rv-quiet" onClick={onClose}>
              Close
            </Button>
            {canRetry(state) ? <Button onClick={onRetry}>Try again</Button> : null}
          </>
        ) : null}
        {state.phase === "finished" || state.phase === "cancelled" ? <Button onClick={onClose}>Close</Button> : null}
        {state.phase === "preparing" || state.phase === "waiting" ? (
          <Button variant="outline" className="zb-rv-quiet" onClick={onCancel}>
            Cancel
          </Button>
        ) : null}
      </div>
    </div>
  );
};

/**
 * The confirm dialog. It prepares each transaction, shows it in full, and hands it to the wallet only when the user
 * presses the send button. With several steps (an allowance, then the relay) it shows each one in turn.
 *
 * @param props The planned transactions and the close handler.
 */
export const TransactionDialog = ({ steps, onClose, variant = "modal", onFinished }: TransactionDialogProps) => {
  const { state, sequence } = useTransactionSequence(steps);
  const step = state.steps[state.stepIndex];
  const finishedHash = state.phase === "finished" ? (state.outcomes.at(-1)?.transactionHash ?? null) : null;
  useEffect(() => {
    if (finishedHash !== null) onFinished?.(finishedHash);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [finishedHash]);
  const delivery = step?.disclosure.delivery ?? null;
  const routerAddresses = useRouterAddresses(step?.disclosure.destinationChainId ?? null, delivery?.router ?? null, { enabled: delivery !== null });
  const view = step === undefined ? null : buildConfirmView(step, routerAddresses.data);
  const cancel = (): void => {
    sequence.cancel();
    onClose();
  };
  return (
    <Frame variant={variant} onClose={onClose}>
      <TransactionReview steps={steps} state={state} view={view} variant={variant} onClose={onClose} onCancel={cancel} onConfirm={() => sequence.confirm()} onRetry={() => sequence.retry()} />
    </Frame>
  );
};

/** The container: the explorer's modal, or the bridge screen's sheet. */
export const Frame = ({ variant, onClose, children }: { readonly variant: "modal" | "sheet"; readonly onClose: () => void; readonly children: ReactNode }) =>
  variant === "sheet" ? (
    <Sheet label="Review before you sign" onClose={onClose}>
      <div className="zb-col zb-sign" style={{ paddingBottom: 18 }}>
        {children}
      </div>
    </Sheet>
  ) : (
    <Modal title="Review before you sign" width="46rem" onClose={onClose}>
      {children}
    </Modal>
  );
