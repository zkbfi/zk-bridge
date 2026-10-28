import { Button, Flex, Stack, Text } from "@chakra-ui/react";
import { useMemo, useState } from "react";
import type { Address } from "viem";
import type { BridgeContext } from "@terminal/app/actions";
import type { ChainSnapshot } from "@terminal/chain/live-reads";
import type { ChainSide, PairConfig, TokenInfo } from "@terminal/model/types";
import { useDeliveryCost, usePriorityFee } from "../app/queries";
import { computeBridgeDraft, DEFAULT_DELIVERY_OPTIONS, tipStatusOf, type DeliveryOptions } from "../tx/bridge-draft";
import type { BridgeFormValues, WebStep } from "../tx/bridge-steps";
import { formatAmountWithSymbol, formatUnits } from "../ui/format";
import { Field, Notice, SelectInput, TextAreaInput, TextInput } from "../ui/primitives";
import { DeliveryFeeSection } from "./DeliveryFeeSection";

/** Props of {@link BridgeForm}. */
export type BridgeFormProps = {
  /** `tokens` bridges any token. `wrap` wraps the native coin through the router. */
  readonly variant: "tokens" | "wrap";
  readonly pair: PairConfig;
  readonly tokens: readonly TokenInfo[];
  /** The live state of both chains for the account. */
  readonly context: BridgeContext;
  readonly account: Address;
  /** Called with the planned transactions when the user presses Review. */
  readonly onReview: (steps: readonly WebStep[]) => void;
};

type TokenChoice = { readonly value: string; readonly label: string; readonly side: ChainSide };

const snapshotOf = (context: BridgeContext, side: ChainSide): ChainSnapshot | null => {
  const found = (context.snapshots ?? []).find((result) => result.status === "ok" && result.snapshot.chain.side === side);
  return found === undefined || found.status !== "ok" ? null : found.snapshot;
};

const choicesOf = (variant: BridgeFormProps["variant"], pair: PairConfig, tokens: readonly TokenInfo[], context: BridgeContext): readonly TokenChoice[] => {
  if (variant === "wrap") {
    return ([pair.first, pair.second] as const).flatMap((chain): TokenChoice[] => {
      if (chain.contracts.deliveryRouter === null) return [];
      const balance = snapshotOf(context, chain.side)?.nativeBalance;
      const suffix = balance === undefined ? "" : `, you hold ${formatUnits(balance, 18, { maximumFractionDigits: 6 })}`;
      return [{ value: `${chain.side}:native`, side: chain.side, label: `Wrap ${chain.nativeSymbol} on ${chain.name}${suffix}` }];
    });
  }
  return tokens.map((token): TokenChoice => {
    const position = snapshotOf(context, token.side)?.positions.find((candidate) => candidate.token.address === token.address);
    const suffix = position === undefined ? "" : `, you hold ${formatUnits(position.balance, token.decimals, { maximumFractionDigits: 6 })}`;
    const chain = token.side === "first" ? pair.first : pair.second;
    return { value: `${token.side}:${token.address}`, side: token.side, label: `${token.symbol} on ${chain.name}${suffix}` };
  });
};

const sideOfChoice = (choice: string): ChainSide => (choice.startsWith("second:") ? "second" : "first");

/**
 * The form of "Bridge tokens" and "Wrap the native coin". It shows the tip for delivery, which is on by default.
 * Review is disabled until the transaction can be built.
 *
 * @param props The pair, the tokens, the live state and the review handler.
 */
export const BridgeForm = ({ variant, pair, tokens, context, account, onReview }: BridgeFormProps) => {
  const choices = useMemo(() => choicesOf(variant, pair, tokens, context), [variant, pair, tokens, context]);
  const [values, setValues] = useState<Required<BridgeFormValues>>({ token: choices[0]?.value ?? "", amount: "", receiver: account, mode: "plain", data: "", gasLimit: "", callTarget: "", callData: "" });
  const [options, setOptions] = useState<DeliveryOptions>(DEFAULT_DELIVERY_OPTIONS);
  const effectiveToken = choices.some((choice) => choice.value === values.token) ? values.token : (choices[0]?.value ?? "");
  const side = sideOfChoice(effectiveToken);
  const sourceChain = side === "first" ? pair.first : pair.second;
  const destinationChain = side === "first" ? pair.second : pair.first;
  const effectiveValues = useMemo(() => ({ ...values, token: effectiveToken }), [values, effectiveToken]);
  const tipOn = useMemo(
    () => tipStatusOf({ values: effectiveValues, options, pair, tokens, valuations: context.tokenValuationsWei ?? {} }).kind === "on",
    [effectiveValues, options, pair, tokens, context.tokenValuationsWei],
  );
  const report = useDeliveryCost(destinationChain.chainId, { enabled: tipOn });
  const priority = usePriorityFee(destinationChain.chainId, { enabled: tipOn });

  const draft = useMemo(
    () => computeBridgeDraft(effectiveValues, options, { pair, tokens, context, report: report.data ?? null, priorityFeeWei: priority.data ?? null }),
    [effectiveValues, options, pair, tokens, context, report.data, priority.data],
  );
  const reasonId = "bridge-form-reason";
  const showCall = values.mode !== "plain" && !tipOn && variant === "tokens";

  return (
    <form
      aria-label={variant === "wrap" ? "Wrap the native coin" : "Bridge tokens"}
      onSubmit={(event) => {
        event.preventDefault();
        if (draft.status === "ready") onReview(draft.steps);
      }}
    >
      <Stack gap="3">
        <Field label={variant === "wrap" ? "Coin to wrap" : "Token"}>
          {(id) => (
            <SelectInput
              id={id}
              value={effectiveToken}
              onChange={(event) => {
                setValues({ ...values, token: event.target.value });
                // The price and the router belong to one token and one destination chain.
                setOptions({ ...options, senderPriceText: null, routerText: null });
              }}
            >
              {choices.map((choice) => (
                <option key={choice.value} value={choice.value}>
                  {choice.label}
                </option>
              ))}
            </SelectInput>
          )}
        </Field>
        <Field label={`Amount to send from ${sourceChain.name}`}>
          {(id) => <TextInput id={id} inputMode="decimal" autoComplete="off" placeholder="0.0" value={values.amount} onChange={(event) => setValues({ ...values, amount: event.target.value })} />}
        </Field>
        <Field label={`Receiver on ${destinationChain.name}`} hint="The address that gets the tokens. It defaults to your account.">
          {(id) => <TextInput id={id} spellCheck={false} autoComplete="off" value={values.receiver} onChange={(event) => setValues({ ...values, receiver: event.target.value })} />}
        </Field>
        {variant === "tokens" && !tipOn ? (
          <Field label="How the receiver gets it">
            {(id) => (
              <SelectInput id={id} value={values.mode} onChange={(event) => setValues({ ...values, mode: event.target.value as BridgeFormValues["mode"] })}>
                <option value="plain">Plain transfer (relayTokens)</option>
                <option value="call">Transfer and call the receiver (relayTokensAndCall)</option>
              </SelectInput>
            )}
          </Field>
        ) : null}
        {showCall ? (
          <>
            <Field label="Data for the receiver" hint="Hex, such as 0xabcd. Empty is allowed.">
              {(id) => <TextAreaInput id={id} spellCheck={false} value={values.data} onChange={(event) => setValues({ ...values, data: event.target.value })} />}
            </Field>
          </>
        ) : null}
        {variant === "tokens" ? (
          <Field label="Gas limit" hint="Optional. The gas for the delivery on the other chain. Empty uses the default. The number must be at least the default for this kind of message and at most the bridge maximum.">
            {(id) => <TextInput id={id} inputMode="numeric" autoComplete="off" placeholder="Default" value={values.gasLimit} onChange={(event) => setValues({ ...values, gasLimit: event.target.value })} />}
          </Field>
        ) : null}
        {variant === "tokens" ? (
          <>
            <Field label="Call target" hint="Optional. A contract that the delivery router calls after it pays the recipient. It works with a tip. Empty makes no call.">
              {(id) => <TextInput id={id} spellCheck={false} autoComplete="off" placeholder="0x…" value={values.callTarget} onChange={(event) => setValues({ ...values, callTarget: event.target.value })} />}
            </Field>
            <Field label="Call data" hint="Optional. Hex, such as 0xabcd, for the call target. The call sends no native coin. Empty calls the target with no data.">
              {(id) => <TextAreaInput id={id} spellCheck={false} value={values.callData} onChange={(event) => setValues({ ...values, callData: event.target.value })} />}
            </Field>
          </>
        ) : null}

        <DeliveryFeeSection destinationNativeSymbol={destinationChain.nativeSymbol} destinationName={destinationChain.name} options={options} onChange={setOptions} draft={draft} />
        {report.error === null || !tipOn ? null : <Notice tone="error">The delivery cost did not load: {report.error.message}</Notice>}

        <Flex alignItems="center" gap="3" flexWrap="wrap">
          <Button type="submit" colorPalette="blue" disabled={draft.status !== "ready"} aria-describedby={reasonId}>
            Review transaction
          </Button>
          <Text id={reasonId} fontSize="sm" color={draft.status === "blocked" ? "red.fg" : "fg.muted"} aria-live="polite">
            {draft.reason ?? "You see every detail before your wallet opens."}
          </Text>
        </Flex>
      </Stack>
    </form>
  );
};
