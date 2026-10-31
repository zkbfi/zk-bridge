import type { BridgeQuery, TipQuery } from "../app/route";
import { FeeControl, type FeeSlider } from "./FeeLine";

/** The tip modes the menu offers: the automatic fee, or a share, a fixed amount or a gas-based fee the user sets, or none. */
export type TipChoiceKey = "automatic" | "percentage" | "fixed" | "gas-multiplier" | "none";

const TIP_CHOICES: readonly { readonly value: TipChoiceKey; readonly label: string }[] = [
  { value: "automatic", label: "Automatic" },
  { value: "percentage", label: "Share" },
  { value: "fixed", label: "Fixed" },
  { value: "gas-multiplier", label: "Gas-based" },
  { value: "none", label: "None" },
];

/** The numbers the pill's sentence reads, worked out by the bridge screen from the draft. */
export type DeliveryFacts = {
  /** The destination chain's name. */
  readonly destination: string;
  /** The fee as a share of the amount, such as "0.39%", or null before it is known. */
  readonly feeShareText: string | null;
  /** A gas-based fee's worst case, the most the signed terms allow, such as "$0.60", or null. */
  readonly worstCaseText: string | null;
  /** A fixed fee in tokens, such as "0.50 USDC", or null. */
  readonly fixedText: string | null;
};

/** The pill's sentence: `text` for the pill (addresses shortened), `full` for its label and title. */
export type DeliverySummary = { readonly text: string; readonly full: string };

const shortAddress = (address: string): string => (/^0x[0-9a-fA-F]{40}$/.test(address) ? `${address.slice(0, 4)}…${address.slice(-2)}` : address);

const gasLimitText = (text: string): string => {
  const trimmed = text.trim();
  return /^\d+$/.test(trimmed) ? BigInt(trimmed).toLocaleString("en-US") : trimmed;
};

/**
 * What the delivery pill says (owner, quote 88): the arrangement in plain words, from the actual settings and numbers.
 * "A bot delivers it on PulseChain · fee 0.39%", "A bot delivers it · fee follows gas, up to $0.60", "A bot delivers it
 * for 0.50 USDC", "You deliver it yourself on PulseChain"; then a call, a router or a gas limit that is set.
 *
 * @param form The bridge form.
 * @param facts The destination and the fee's numbers.
 */
export const deliverySummary = (form: BridgeQuery, facts: DeliveryFacts): DeliverySummary => {
  const tip = form.tip ?? {};
  const mode = tip.mode ?? "percentage";
  const main =
    mode === "none"
      ? `You deliver it yourself on ${facts.destination}`
      : mode === "gas-multiplier"
        ? `A bot delivers it · fee follows gas${facts.worstCaseText === null ? "" : `, up to ${facts.worstCaseText}`}`
        : mode === "fixed"
          ? `A bot delivers it for ${facts.fixedText ?? "a fixed fee"}`
          : `A bot delivers it on ${facts.destination}${facts.feeShareText === null ? "" : ` · fee ${facts.feeShareText}`}`;
  const call = form.mode === "call" && form.callTarget !== undefined && form.callTarget !== "" ? form.callTarget : null;
  const router = tip.routerText !== undefined && tip.routerText.trim() !== "" ? tip.routerText.trim() : null;
  const gasLimit = form.gasLimit !== undefined && form.gasLimit.trim() !== "" ? form.gasLimit : null;
  const sentence = (address: (text: string) => string): string =>
    [
      `${main}${call === null ? "" : `, then calls ${address(call)}`}`,
      ...(router === null ? [] : [`via router ${address(router)}`]),
      ...(gasLimit === null ? [] : [`gas limit ${gasLimitText(gasLimit)}`]),
    ].join(" · ");
  return { text: sentence(shortAddress), full: sentence((text) => text) };
};

type Segment<T extends string> = { readonly value: T; readonly label: string };

const Segments = <T extends string>({ label, value, options, onChange, stacked = false }: { readonly label: string; readonly value: T; readonly options: readonly Segment<T>[]; readonly onChange: (next: T) => void; readonly stacked?: boolean }) => (
  <div className={stacked ? "zb-menu-row zb-menu-stack" : "zb-menu-row"}>
    <span>{label}</span>
    <span className="zb-seg" role="radiogroup" aria-label={label}>
      {options.map((option) => (
        <button key={option.value} type="button" role="radio" aria-checked={option.value === value} onClick={() => onChange(option.value)}>
          {option.label}
        </button>
      ))}
    </span>
  </div>
);

/** Props of {@link DeliveryMenu}. */
export type DeliveryMenuProps = {
  readonly form: BridgeQuery;
  readonly defaultRouter: string | null;
  readonly onChange: (next: BridgeQuery) => void;
  readonly onReceiver: () => void;
  /** The tip mode in force, and what choosing another does (the bridge screen keeps the fee where it is). */
  readonly tipChoice: TipChoiceKey;
  readonly onTipChoice: (next: TipChoiceKey) => void;
  /**
   * The values of the mode in force (the tip's value, the gas level, the gas limit), the same controls the tip drawer
   * draws, so typing here moves the drawer's slider and every number, and the other way round.
   */
  readonly controls: readonly FeeSlider[];
};

/**
 * The delivery settings behind the delivery pill: how the fee is set, the value of that mode, the gas level, the gas
 * limit, the relay router and sending to another address. Every value is a slider with a recommended tick, an exact
 * input and a reset (owner, quote 90); every choice writes the address.
 *
 * @param props The form, the default router, the controls and the handlers.
 */
export const DeliveryMenu = ({ form, defaultRouter, onChange, onReceiver, tipChoice, onTipChoice, controls }: DeliveryMenuProps) => {
  const tip: TipQuery = form.tip ?? {};
  return (
    <div className="zb-pop zb-delivery-menu" role="group" aria-label="Delivery settings">
      <Segments label="Fee" value={tipChoice} options={TIP_CHOICES} onChange={onTipChoice} stacked />
      {controls.map((control) => (
        <div key={control.label} className="zb-menu-control">
          <FeeControl slider={control} />
        </div>
      ))}
      <label className="zb-menu-row">
        <span>Relay router</span>
        <input className="zb-menu-field zb-mono" spellCheck={false} placeholder={defaultRouter ?? "default"} value={tip.routerText ?? ""} onChange={(event) => onChange({ ...form, tip: { ...tip, routerText: event.target.value === "" ? undefined : event.target.value } })} />
      </label>
      <div className="zb-menu-row">
        <span>Send to another address</span>
        <button type="button" className="zb-pill" onClick={onReceiver}>
          {form.receiver === undefined ? "Off" : "On"}
        </button>
      </div>
    </div>
  );
};
