import { Box, Flex, Table, Text, chakra } from "@chakra-ui/react";
import { getAddress, isAddress } from "viem";
import { DEFAULT_GAS_MARGIN, GAS_MODE_HELP, SUGGESTED_TIP_RANGE, TIP_RANGE_HELP, TIP_RANGE_NAMES, type TipRangeOption } from "@zk-bridge/shared";
import { GAS_MODE_LABEL, TIP_NOTES, WRAP_NO_FEE_NOTICE, routerWarningOf } from "../tx/tip-copy";
import { formatUnits } from "../ui/format";
import type { BridgeDraft, DeliveryOptions, TipChoice, TipStatus } from "../tx/bridge-draft";
import { Field, Notice, TextInput } from "../ui/primitives";
import { TipCostCharts } from "./TipCostCharts";

/** Props of {@link DeliveryFeeSection}. */
export type DeliveryFeeSectionProps = {
  /** The native coin of the chain that the tokens arrive on. It prices the cost lines. */
  readonly destinationNativeSymbol: string;
  readonly destinationName: string;
  readonly options: DeliveryOptions;
  readonly onChange: (next: DeliveryOptions) => void;
  readonly draft: BridgeDraft;
  /**
   * True when the native coin is sent: it goes through the delivery router of this chain either way (with a tip as
   * `relayTokensAndCall`, without as `wrapAndRelayTokens`), so No tip does not mean "no router".
   */
  readonly native?: boolean;
};

const MODES: readonly { readonly value: TipChoice; readonly label: string; readonly note: string }[] = [
  { value: "gas-multiplier", label: GAS_MODE_LABEL, note: "estimate; the limit is the price ceiling" },
  { value: "percentage", label: "Percentage of the amount", note: "exact amount" },
  { value: "fixed", label: "Fixed amount", note: "exact amount" },
  { value: "none", label: "No tip: deliver directly, no router", note: "anyone can deliver; may take longer" },
];

/** The modes for the native coin: No tip still goes through the router of this chain, which wraps the coin. */
const NATIVE_MODES: typeof MODES = MODES.map((mode) => (mode.value === "none" ? { ...mode, label: "No tip", note: "anyone can deliver it, for free; it may take longer" } : mode));

/**
 * The "Tip for delivery" part of the bridge form. The tip is on by default as a gas based tip at the base fee, equal to the
 * measured cost, with a limit that is the price ceiling. The panel shows a low range (low, suggested and high) that the
 * user can pick from or edit. The user can edit it, change the mode, or remove it. The panel shows what the user pays: the amount, whether it is exact or an
 * estimate, the most that the tip can take, the cost lines and the data behind them. When no tip can travel, the
 * panel says why and the page sends a plain relay.
 *
 * @param props The options, the draft and the destination chain.
 */
export const DeliveryFeeSection = ({ destinationNativeSymbol, destinationName, options, onChange, draft, native = false }: DeliveryFeeSectionProps) => {
  const { tip } = draft;
  if (tip === null) return null;
  return (
    <Box as="fieldset" borderWidth="1px" borderColor="border" borderRadius="md" padding="3">
      <chakra.legend paddingX="1" fontWeight="medium" fontSize="sm">
        Tip for delivery
      </chakra.legend>
      <TipPanel tip={tip} draft={draft} options={options} onChange={onChange} destinationNativeSymbol={destinationNativeSymbol} destinationName={destinationName} native={native} />
    </Box>
  );
};

type TipPanelProps = {
  /** The tip of the draft. The caller has checked that the draft has one. */
  readonly tip: TipStatus;
  readonly draft: BridgeDraft;
  readonly options: DeliveryOptions;
  readonly onChange: (next: DeliveryOptions) => void;
  readonly destinationNativeSymbol: string;
  readonly destinationName: string;
  readonly native: boolean;
};

/** The body of the panel: the reason when no tip can travel, or the choice of mode and what follows from it. */
const TipPanel = ({ tip, draft, options, onChange, destinationNativeSymbol, destinationName, native }: TipPanelProps) => {
  if (tip.kind === "unavailable") return <Notice tone="info">{tip.reason}</Notice>;
  return (
    <>
      <Text fontSize="sm" color="fg.muted">
        A tip is for the delivery of your transfer on {destinationName}. The router sends it to its reward address. It is voluntary and it buys no promise. It is on by default as a gas based tip: the limit is the most it can take, and the deliverer's gas choice decides how much of the limit it takes. You fix the terms now. Nothing at delivery changes them.
      </Text>
      <TipNotes />
      <Box role="radiogroup" aria-label="How to tip for delivery" marginTop="2">
        {(native ? NATIVE_MODES : MODES).map((mode) => (
          <Flex key={mode.value} alignItems="center" gap="2" paddingY="1">
            <chakra.input id={`delivery-mode-${mode.value}`} type="radio" name="delivery-mode" checked={options.mode === mode.value} onChange={() => onChange({ ...options, mode: mode.value })} />
            <chakra.label htmlFor={`delivery-mode-${mode.value}`} fontSize="sm">
              {mode.label}{" "}
              <Text as="span" color="fg.muted">
                ({mode.note})
              </Text>
            </chakra.label>
          </Flex>
        ))}
      </Box>
      <TipDetails tip={tip} draft={draft} options={options} onChange={onChange} destinationNativeSymbol={destinationNativeSymbol} destinationName={destinationName} native={native} />
    </>
  );
};

const TipDetails = ({ tip, draft, options, onChange, destinationNativeSymbol, destinationName, native }: TipPanelProps) => {
  if (tip.kind !== "on") {
    return (
      <Text fontSize="sm" marginTop="2" data-testid="no-tip-note">
        {native
          ? `No tip. ${WRAP_NO_FEE_NOTICE}`
          : "No tip: the page sends a plain relay. No router and no fee terms are involved, so no router can take a fee. Anyone can deliver your transfer directly on the bridge, for free, but nobody is paid to do it, so it may take longer."}
      </Text>
    );
  }
  return <TipFields tip={tip} draft={draft} options={options} onChange={onChange} destinationNativeSymbol={destinationNativeSymbol} destinationName={destinationName} />;
};

const TipNotes = () => (
  <Box fontSize="sm" color="fg.muted" marginTop="1" data-testid="tip-notes">
    {TIP_NOTES.map((note) => (
      <Text key={note}>{note}</Text>
    ))}
  </Box>
);

type TipFieldsProps = Omit<TipPanelProps, "tip" | "native"> & {
  /** The tip when it is on. The caller has checked the kind. */
  readonly tip: Extract<TipStatus, { readonly kind: "on" }>;
};

const ModeFields = ({ options, onChange }: Pick<TipFieldsProps, "options" | "onChange">) => {
  if (options.mode === "percentage") {
    return (
      <Box flex="1 1 8rem">
        <Field label="Percentage of the amount" hint="For example 0.1. The tip takes this share. The recipient gets the rest.">
          {(id) => <TextInput id={id} inputMode="decimal" value={options.percentText} onChange={(event) => onChange({ ...options, percentText: event.target.value })} />}
        </Field>
      </Box>
    );
  }
  if (options.mode === "fixed") {
    return (
      <>
        <Box flex="1 1 8rem">
          <Field label="Fixed amount" hint="In whole tokens. Empty takes the suggestion, which needs your coin price.">
            {(id) => <TextInput id={id} inputMode="decimal" value={options.fixedText} onChange={(event) => onChange({ ...options, fixedText: event.target.value })} />}
          </Field>
        </Box>
        <Box flex="1 1 8rem">
          <Field label="Margin (percent)" hint="Profit on top of the cost, for the suggestion.">
            {(id) => <TextInput id={id} inputMode="decimal" value={options.marginPercentText} onChange={(event) => onChange({ ...options, marginPercentText: event.target.value })} />}
          </Field>
        </Box>
      </>
    );
  }
  return (
    <>
      <Box flex="1 1 8rem">
        <Field label="Gas multiplier" hint="1 is the cost itself. 0.5 is half of it and 1.5 is one and a half. A tip below the cost is allowed. The lowest tip here is just above zero; for zero, choose No tip or a fixed amount of 0.">
          {(id) => <TextInput id={id} inputMode="decimal" value={options.gasMultiplierText} onChange={(event) => onChange({ ...options, gasMultiplierText: event.target.value })} />}
        </Field>
      </Box>
      <Box flex="1 1 10rem">
        <Field label="Ceiling base fee (gwei)" hint="Empty means three times the base fee now. It sets the limit, which is the price ceiling.">
          {(id) => <TextInput id={id} inputMode="decimal" value={options.ceilingGweiText} onChange={(event) => onChange({ ...options, ceilingGweiText: event.target.value })} />}
        </Field>
      </Box>
    </>
  );
};

const customRouterWarning = (routerText: string | null, defaultRouter: string): string | null => {
  const text = (routerText ?? "").trim();
  if (!isAddress(text, { strict: false })) return null;
  return routerWarningOf({ router: getAddress(text), defaultRouter: getAddress(defaultRouter) });
};

const TipFields = ({ tip, draft, options, onChange, destinationNativeSymbol, destinationName }: TipFieldsProps) => {
  const { target } = tip;
  const warning = customRouterWarning(options.routerText, target.router);
  return (
    <Box marginTop="3">
      {options.mode === "gas-multiplier" ? (
        <Text fontSize="sm" color="fg.muted" marginBottom="2" data-testid="gas-mode-help">
          {GAS_MODE_HELP}
        </Text>
      ) : null}
      {draft.tipNotice === null ? null : (
        <Box marginBottom="2" data-testid="tip-notice">
          <Notice tone="info">{draft.tipNotice}</Notice>
        </Box>
      )}
      <Flex gap="2" flexWrap="wrap">
        <ModeFields options={options} onChange={onChange} />
        <Box flex="2 1 14rem">
          <Field
            label={`Your coin price (${target.token.symbol} for one ${destinationNativeSymbol})`}
            hint="Your own price. The page cannot verify it, and nothing at delivery reads it. The gas multiplier folds it into the multiplier now. It also prices the cost lines."
          >
            {(id) => (
              <TextInput id={id} inputMode="decimal" value={options.senderPriceText ?? draft.defaultSenderPriceText} onChange={(event) => onChange({ ...options, senderPriceText: event.target.value })} />
            )}
          </Field>
        </Box>
      </Flex>
      {target.isWrappedNative ? (
        <Flex alignItems="center" gap="2" marginTop="2">
          <chakra.input id="payout-native" type="checkbox" checked={options.payoutNative} onChange={(event) => onChange({ ...options, payoutNative: event.target.checked })} />
          <chakra.label htmlFor="payout-native" fontSize="sm">
            Pay out in {destinationNativeSymbol}, not in the wrapped token
          </chakra.label>
        </Flex>
      ) : null}
      <chakra.details marginTop="2" open={(options.routerText ?? "").trim() !== ""} data-testid="tip-advanced">
        <chakra.summary fontSize="sm" fontWeight="medium" cursor="pointer">
          Advanced: router
        </chakra.summary>
        <Field label={`Router on ${destinationName}`} hint="The router that receives the relay and pays the tip. The default is the default delivery router. Anyone can deliver through it, and it pays the tip to its own reward address.">
          {(id) => (
            <TextInput id={id} spellCheck={false} autoComplete="off" value={options.routerText ?? target.router} onChange={(event) => onChange({ ...options, routerText: event.target.value })} />
          )}
        </Field>
        {warning === null ? null : (
          <Box data-testid="tip-router-warning">
            <Notice tone="warning">{warning}</Notice>
          </Box>
        )}
      </chakra.details>
      <DeliveryQuote draft={draft} options={options} onChange={onChange} destinationNativeSymbol={destinationNativeSymbol} destinationName={destinationName} />
    </Box>
  );
};

const RANGE_ENDS = [
  { id: "low", name: TIP_RANGE_NAMES.low, factor: SUGGESTED_TIP_RANGE.low },
  { id: "default", name: TIP_RANGE_NAMES.default, factor: null },
  { id: "high", name: TIP_RANGE_NAMES.high, factor: SUGGESTED_TIP_RANGE.high },
] as const;

/** Props of {@link TipRange}. */
export type TipRangeProps = {
  readonly range: TipRangeOption;
  readonly token: { readonly symbol: string; readonly decimals: number };
  readonly options: DeliveryOptions;
  readonly onChange: (next: DeliveryOptions) => void;
};

/**
 * The suggested range as three choices: low, suggested and high. Each shows its tip in the token. A choice fills the gas
 * multiplier, which the user may then edit by hand to any value.
 */
export const TipRange = ({ range, token, options, onChange }: TipRangeProps) => {
  if (range.kind === "unavailable") return null;
  return (
    <Box marginTop="2" data-testid="tip-range">
      <Text fontSize="sm" fontWeight="medium">
        Suggested range
      </Text>
      <Flex gap="2" flexWrap="wrap" marginTop="1" role="group" aria-label="Suggested tips">
        {RANGE_ENDS.map((end) => {
          const factorText = formatUnits(end.factor ?? DEFAULT_GAS_MARGIN, 18);
          return (
            <chakra.button
              key={end.id}
              type="button"
              data-testid={`tip-range-${end.id}`}
              aria-pressed={options.mode === "gas-multiplier" && options.gasMultiplierText === factorText}
              onClick={() => onChange({ ...options, mode: "gas-multiplier", gasMultiplierText: factorText })}
              borderWidth="1px"
              borderRadius="md"
              paddingX="3"
              paddingY="1"
              fontSize="sm"
            >
              {end.name}: {formatUnits(range[end.id].description.nowUnits, token.decimals)} {token.symbol}
            </chakra.button>
          );
        })}
      </Flex>
      <Text fontSize="xs" color="fg.muted" marginTop="1">
        {TIP_RANGE_HELP}
      </Text>
    </Box>
  );
};

const DeliveryQuote = ({ draft, options, onChange, destinationNativeSymbol, destinationName }: { readonly draft: BridgeDraft; readonly options: DeliveryOptions; readonly onChange: (next: DeliveryOptions) => void; readonly destinationNativeSymbol: string; readonly destinationName: string }) => {
  const { delivery, deliveryProblem } = draft;
  if (delivery === null) {
    return <Box marginTop="3">{deliveryProblem === null || deliveryProblem === draft.tipNotice ? <Text fontSize="sm" color="fg.muted">Enter an amount and a receiver to see the tip.</Text> : <Notice tone="warning">{deliveryProblem}</Notice>}</Box>;
  }
  const { description, suggestions, token } = delivery;
  const unit = `${destinationNativeSymbol} on ${destinationName}`;
  return (
    <Box marginTop="3" aria-live="polite" data-testid="delivery-quote">
      <Text fontWeight="medium" data-testid="delivery-summary">
        {description.summary}
      </Text>
      <Text fontSize="sm" color="fg.muted">
        How it is computed: {description.formula}.
      </Text>
      <TipRange range={suggestions.tipRange} token={token} options={options} onChange={onChange} />
      <TipCostCharts delivery={delivery} nativeSymbol={destinationNativeSymbol} chainName={destinationName} />
      <Text fontSize="sm" fontWeight="medium" marginTop="1" data-testid="tip-maximum">
        {description.mode === "gas"
          ? `Expected tip about ${formatUnits(description.expectedUnits, token.decimals)} ${token.symbol} at the gas estimate. The most it can take is ${formatUnits(delivery.maximumTip, token.decimals)} ${token.symbol}, the limit: a deliverer who supplies more gas can raise the tip up to it.`
          : `The tip can take at most ${formatUnits(delivery.maximumTip, token.decimals)} ${token.symbol}.`}
      </Text>
      {description.certainty === "estimate" ? (
        <Text fontSize="sm" color="orange.fg">
          This is an estimate: the real tip follows the gas that the delivery uses and the gas price at delivery. It can never pass the limit.
        </Text>
      ) : null}
      {description.breakdown.length === 0 ? (
        <Text fontSize="sm" color="fg.muted" marginTop="2" data-testid="no-cost-lines">
          Enter your coin price to see the cost lines of the delivery.
        </Text>
      ) : (
        <Table.Root size="sm" marginTop="2" aria-label="Cost breakdown of the delivery">
          <Table.Header>
            <Table.Row>
              <Table.ColumnHeader scope="col">Cost line</Table.ColumnHeader>
              <Table.ColumnHeader scope="col" textAlign="end">
                Amount (estimate)
              </Table.ColumnHeader>
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {description.breakdown.map((line) => (
              <Table.Row key={line.id}>
                <Table.Cell>
                  {line.label} <Text as="span" fontSize="xs" color="fg.muted">({line.note})</Text>
                </Table.Cell>
                <Table.Cell textAlign="end" whiteSpace="nowrap">
                  {formatUnits(line.amountWei, 18)} {unit}
                </Table.Cell>
              </Table.Row>
            ))}
          </Table.Body>
        </Table.Root>
      )}
      <Text fontSize="xs" color="fg.muted" marginTop="2" data-testid="delivery-data-source">
        Data: {suggestions.dataSource.description} ({suggestions.dataSource.gas.toString()} gas). {suggestions.dataSource.baseFeeDescription}.
      </Text>
      <Text fontSize="xs" color="fg.muted">
        The suggestion updates as the indexer records more deliveries.
      </Text>
    </Box>
  );
};
