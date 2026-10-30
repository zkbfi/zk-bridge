import { Button, Flex, Stack, Text } from "@chakra-ui/react";
import { useMemo } from "react";
import { buildMessageSteps } from "@terminal/app/actions";
import type { PairConfig } from "@terminal/model/types";
import { PlanInputError } from "@terminal/tx/plan";
import type { MessageQuery } from "../app/route";
import type { WebStep } from "../tx/bridge-steps";
import { Field, SelectInput, TextAreaInput, TextInput } from "../ui/primitives";

/** Props of {@link MessageForm}. */
export type MessageFormProps = {
  readonly pair: PairConfig;
  /** The fields that differ from the defaults, as the address holds them. */
  readonly query: MessageQuery;
  /** Called with the fields that differ from the defaults after every edit. */
  readonly onQuery: (next: MessageQuery) => void;
  readonly onReview: (steps: readonly WebStep[]) => void;
};

type Values = { readonly chain: "first" | "second"; readonly target: string; readonly data: string; readonly gas: string };

/** The defaults: the message goes from the first chain (Ethereum, or Sepolia) to the second. */
const DEFAULT_VALUES: Values = { chain: "first", target: "", data: "", gas: "200000" };

const valuesOf = (query: MessageQuery): Values => ({ ...DEFAULT_VALUES, ...query });

/** The fields that differ from the defaults; only they go in the address. */
const queryOf = (values: Values): MessageQuery => ({
  ...(values.chain === DEFAULT_VALUES.chain ? {} : { chain: values.chain }),
  ...(values.target === DEFAULT_VALUES.target ? {} : { target: values.target }),
  ...(values.data === DEFAULT_VALUES.data ? {} : { data: values.data }),
  ...(values.gas === DEFAULT_VALUES.gas ? {} : { gas: values.gas }),
});

const NO_DISCLOSURE = { feesApplyTo: "this-transaction", amountToken: null, destinationNativeSymbol: null, destinationChainId: null, delivery: null } as const;

type Planned = { readonly steps: readonly WebStep[]; readonly problem: string | null };

const plan = (values: Values, pair: PairConfig): Planned => {
  if (values.target.trim() === "") return { steps: [], problem: "Enter the target contract on the other chain." };
  try {
    const steps = buildMessageSteps(values, pair).map((step): WebStep => ({ plan: step.plan, disclosure: NO_DISCLOSURE }));
    return { steps, problem: null };
  } catch (error) {
    if (error instanceof PlanInputError) return { steps: [], problem: error.message };
    throw error;
  }
};

/**
 * The form of "Send a message": a call to a contract on the other chain through the message bridge.
 *
 * @param props The pair, the fields from the address, their change handler and the review handler.
 */
export const MessageForm = ({ pair, query, onQuery, onReview }: MessageFormProps) => {
  const values = useMemo(() => valuesOf(query), [query]);
  const setValues = (next: Values): void => onQuery(queryOf(next));
  const planned = useMemo(() => plan(values, pair), [values, pair]);
  const source = values.chain === "first" ? pair.first : pair.second;
  const destination = values.chain === "first" ? pair.second : pair.first;
  return (
    <form
      aria-label="Send a message"
      onSubmit={(event) => {
        event.preventDefault();
        if (planned.problem === null) onReview(planned.steps);
      }}
    >
      <Stack gap="3">
        <Field label="Send from">
          {(id) => (
            <SelectInput id={id} value={values.chain} onChange={(event) => setValues({ ...values, chain: event.target.value as Values["chain"] })}>
              <option value="first">{pair.first.name}</option>
              <option value="second">{pair.second.name}</option>
            </SelectInput>
          )}
        </Field>
        <Field label={`Target contract on ${destination.name}`}>
          {(id) => <TextInput id={id} spellCheck={false} autoComplete="off" placeholder="0x…" value={values.target} onChange={(event) => setValues({ ...values, target: event.target.value })} />}
        </Field>
        <Field label="Call data" hint="Hex, such as 0xabcd. Empty is allowed.">
          {(id) => <TextAreaInput id={id} spellCheck={false} value={values.data} onChange={(event) => setValues({ ...values, data: event.target.value })} />}
        </Field>
        <Field label={`Gas for the call on ${destination.name}`} hint="A whole number. The call runs once, even if it fails.">
          {(id) => <TextInput id={id} inputMode="numeric" value={values.gas} onChange={(event) => setValues({ ...values, gas: event.target.value })} />}
        </Field>
        <Flex alignItems="center" gap="3" flexWrap="wrap">
          <Button type="submit" colorPalette="blue" disabled={planned.problem !== null} aria-describedby="message-form-reason">
            Review transaction
          </Button>
          <Text id="message-form-reason" fontSize="sm" color="fg.muted" aria-live="polite">
            {planned.problem ?? `Sends from ${source.name}. You see every detail before your wallet opens.`}
          </Text>
        </Flex>
      </Stack>
    </form>
  );
};
