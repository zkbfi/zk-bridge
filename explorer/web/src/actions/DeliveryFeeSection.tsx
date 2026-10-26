import { Box, Flex, Table, Text, chakra } from "@chakra-ui/react";
import { getAddress, isAddress } from "viem";
import { RUNNER_NOTES, routerWarningOf } from "../tx/tip-copy";
import { formatUnits } from "../ui/format";
import type { BridgeDraft, DeliveryOptions, TipChoice } from "../tx/bridge-draft";
import { Field, Notice, TextInput } from "../ui/primitives";

/** Props of {@link DeliveryFeeSection}. */
export type DeliveryFeeSectionProps = {
  /** The native coin of the chain that the tokens arrive on. It prices the cost lines. */
  readonly destinationNativeSymbol: string;
  readonly destinationName: string;
  readonly options: DeliveryOptions;
  readonly onChange: (next: DeliveryOptions) => void;
  readonly draft: BridgeDraft;
};

const MODES: readonly { readonly value: TipChoice; readonly label: string; readonly note: string }[] = [
  { value: "percentage", label: "Percentage of the amount", note: "exact amount" },
  { value: "gas-multiplier", label: "Gas multiplier with a ceiling", note: "estimate, with a guaranteed maximum" },
  { value: "fixed", label: "Fixed amount", note: "exact amount" },
  { value: "none", label: "No tip: deliver directly, no router", note: "anyone can deliver; may take longer" },
];

/**
 * The "Tip for delivery" part of the bridge form. The tip is on by default at 0.1 percent of the transfer. The user can
 * edit it, change the mode, or remove it. The panel shows what the user pays: the amount, whether it is exact or an
 * estimate, the most that the runner can take, the cost lines and the data behind them. When no tip can travel, the
 * panel says why and the page sends a plain relay.
 *
 * @param props The options, the draft and the destination chain.
 */
export const DeliveryFeeSection = ({ destinationNativeSymbol, destinationName, options, onChange, draft }: DeliveryFeeSectionProps) => {
  if (draft.tip === null) return null;
  return (
    <Box as="fieldset" borderWidth="1px" borderColor="border" borderRadius="md" padding="3">
      <chakra.legend paddingX="1" fontWeight="medium" fontSize="sm">
        Tip for delivery
      </chakra.legend>
      <TipPanel draft={draft} options={options} onChange={onChange} destinationNativeSymbol={destinationNativeSymbol} destinationName={destinationName} />
    </Box>
  );
};

type TipPanelProps = {
  readonly draft: BridgeDraft;
  readonly options: DeliveryOptions;
  readonly onChange: (next: DeliveryOptions) => void;
  readonly destinationNativeSymbol: string;
  readonly destinationName: string;
};

/** The body of the panel: the reason when no tip can travel, or the choice of mode and what follows from it. */
const TipPanel = ({ draft, options, onChange, destinationNativeSymbol, destinationName }: TipPanelProps) => {
  const { tip } = draft;
  if (tip === null) return null;
  if (tip.kind === "unavailable") return <Notice tone="info">{tip.reason}</Notice>;
  return (
    <>
      <Text fontSize="sm" color="fg.muted">
        A tip pays the runner that delivers your transfer on {destinationName}. It is on by default at 0.1 percent. You fix it now. Nothing at delivery changes it.
      </Text>
      <TipRunnerNotes />
      <Box role="radiogroup" aria-label="How to tip for delivery" marginTop="2">
        {MODES.map((mode) => (
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
      <TipDetails draft={draft} options={options} onChange={onChange} destinationNativeSymbol={destinationNativeSymbol} destinationName={destinationName} />
    </>
  );
};

const TipDetails = ({ draft, options, onChange, destinationNativeSymbol, destinationName }: TipPanelProps) => {
  if (draft.tip?.kind !== "on") {
    return (
      <Text fontSize="sm" marginTop="2" data-testid="no-tip-note">
        No tip: the page sends a plain relay. No router and no fee terms are involved, so no router and no runner can take a fee. Anyone can deliver your transfer directly on the bridge, for free, but nobody is paid to do it, so it may take longer.
      </Text>
    );
  }
  return <TipFields draft={draft} options={options} onChange={onChange} destinationNativeSymbol={destinationNativeSymbol} destinationName={destinationName} />;
};

const TipRunnerNotes = () => (
  <Box fontSize="sm" color="fg.muted" marginTop="1" data-testid="tip-runner-notes">
    {RUNNER_NOTES.map((note) => (
      <Text key={note}>{note}</Text>
    ))}
  </Box>
);

type TipFieldsProps = TipPanelProps;

const ModeFields = ({ options, onChange }: Pick<TipFieldsProps, "options" | "onChange">) => {
  if (options.mode === "percentage") {
    return (
      <Box flex="1 1 8rem">
        <Field label="Percentage of the amount" hint="For example 0.1. The runner takes this share. The recipient gets the rest.">
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
        <Field label="Gas multiplier" hint="1.2 pays 20 percent above the gas cost.">
          {(id) => <TextInput id={id} inputMode="decimal" value={options.gasMultiplierText} onChange={(event) => onChange({ ...options, gasMultiplierText: event.target.value })} />}
        </Field>
      </Box>
      <Box flex="1 1 10rem">
        <Field label="Ceiling base fee (gwei)" hint="Empty means twice the base fee now.">
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

const TipFields = ({ draft, options, onChange, destinationNativeSymbol, destinationName }: TipFieldsProps) => {
  const { tip } = draft;
  if (tip === null || tip.kind !== "on") return null;
  const { target } = tip;
  const warning = customRouterWarning(options.routerText, target.router);
  return (
    <Box marginTop="3">
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
        <Field label={`Router on ${destinationName}`} hint="The router that receives the relay and pays the tip. The default is the fee router of the deployment. Its one whitelisted runner delivers.">
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
      <DeliveryQuote draft={draft} destinationNativeSymbol={destinationNativeSymbol} destinationName={destinationName} />
    </Box>
  );
};

const DeliveryQuote = ({ draft, destinationNativeSymbol, destinationName }: { readonly draft: BridgeDraft; readonly destinationNativeSymbol: string; readonly destinationName: string }) => {
  const { delivery, deliveryProblem } = draft;
  if (delivery === null) {
    return <Box marginTop="3">{deliveryProblem === null ? <Text fontSize="sm" color="fg.muted">Enter an amount and a receiver to see the tip.</Text> : <Notice tone="warning">{deliveryProblem}</Notice>}</Box>;
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
      <Text fontSize="sm" fontWeight="medium" marginTop="1" data-testid="runner-maximum">
        The runner can take at most {formatUnits(delivery.maximumRunnerTake, token.decimals)} {token.symbol}.
      </Text>
      {description.certainty === "estimate" ? (
        <Text fontSize="sm" color="orange.fg">
          This is an estimate: the real tip follows the gas price when the transfer is delivered. It can never pass the maximum above.
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
      {suggestions.proofCostMissing ? <Notice tone="warning">The indexer has no price of the native coin, so the proof cost is left out of the cost.</Notice> : null}
      <Text fontSize="xs" color="fg.muted" marginTop="2" data-testid="delivery-data-source">
        Data: {suggestions.dataSource.description} ({suggestions.dataSource.gas.toString()} gas). {suggestions.dataSource.baseFeeDescription}.
      </Text>
      <Text fontSize="xs" color="fg.muted">
        The suggestion updates as the indexer records more deliveries.
      </Text>
    </Box>
  );
};
