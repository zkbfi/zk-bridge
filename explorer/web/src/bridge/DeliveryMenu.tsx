import type { BridgeQuery, TipQuery } from "../app/route";
import { useState } from "react";
import { FeeControl, type FeeSlider } from "./FeeLine";
import { Chevron } from "./icons";

/** The tip modes the menu offers: the automatic fee, or a share, a fixed amount or a gas-based fee the user sets, or none. */
export type TipChoiceKey = "automatic" | "percentage" | "fixed" | "gas-multiplier" | "none";

const TIP_CHOICES: readonly { readonly value: TipChoiceKey; readonly label: string }[] = [
  { value: "automatic", label: "Automatic" },
  { value: "percentage", label: "Share" },
  { value: "fixed", label: "Fixed" },
  { value: "gas-multiplier", label: "Gas-based" },
  { value: "none", label: "Yourself" },
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
  /** The fee itself, in dollars when the token has a price, else in the token ("$0.39", "0.0039 ETH"), or null. */
  readonly feeAmountText?: string | null;
  /** A gas-based fee's worst case as a share of the amount ("0.6%"), or null. */
  readonly worstCaseShareText?: string | null;
  /** The share the form asks for in percentage mode ("1%"), known before an amount is typed, or null. */
  readonly percentText?: string | null;
  /** The gas level's name ("Normal"), the one numberless fact left when nothing else is known. */
  readonly gasLevelName?: string;
};

/**
 * The arrangement in words: `short` for the control (a few words, one line on a phone), `text` with addresses shortened,
 * `full` for its label and tooltip.
 */
export type DeliverySummary = { readonly short: string; readonly text: string; readonly full: string };

const shortAddress = (address: string): string => (/^0x[0-9a-fA-F]{40}$/.test(address) ? `${address.slice(0, 4)}…${address.slice(-2)}` : address);

const callGasText = (text: string): string => {
  const trimmed = text.trim();
  return /^\d+$/.test(trimmed) ? BigInt(trimmed).toLocaleString("en-US") : trimmed;
};

/**
 * What the delivery pill says (owner, quote 88): the arrangement in plain words, from the actual settings and numbers.
 * "Deliver for 0.39%, max $0.39", "Deliver for ~0.39%, max $0.60" (the fee follows gas), "Deliver for 0.50 USDC",
 * "You deliver it yourself on PulseChain"; then a call (with its call gas), or a router that is set.
 *
 * @param form The bridge form.
 * @param facts The destination and the fee's numbers.
 */
export const deliverySummary = (form: BridgeQuery, facts: DeliveryFacts): DeliverySummary => {
  const tip = form.tip ?? {};
  const mode = tip.mode ?? "percentage";
  // Owner: "we need to say something like: \"deliver for x%, max 0.01\"": the price of the delivery, not who does it.
  // And "show cost details relative to what the user is bridging, per mode": every mode says its share of the amount.
  const share = facts.feeShareText;
  const amount = facts.feeAmountText ?? null;
  const worst = facts.worstCaseText === null ? "" : `, max ${facts.worstCaseText}${facts.worstCaseShareText ? ` (${facts.worstCaseShareText})` : ""}`;
  const fixed = `${facts.fixedText ?? "a fixed fee"}${facts.fixedText !== null && share !== null ? ` (${share})` : ""}`;
  const main =
    mode === "none"
      ? `You deliver it yourself on ${facts.destination}`
      : mode === "gas-multiplier"
        ? `Deliver for ${share === null ? "the gas cost" : `~${share}`}${worst}`
        : mode === "fixed"
          ? `Deliver for ${fixed}`
          : `Deliver for ${share ?? "a share of the amount"}${amount === null ? "" : `, max ${amount}`}`;
  const call = form.callTarget !== undefined && form.callTarget !== "" ? form.callTarget : null;
  const router = tip.routerText !== undefined && tip.routerText.trim() !== "" ? tip.routerText.trim() : null;
  const callGas = call !== null && form.callGas !== undefined && form.callGas.trim() !== "" ? form.callGas : null;
  const sentence = (address: (text: string) => string): string =>
    [
      `${main}${call === null ? "" : `, then calls ${address(call)}${callGas === null ? "" : ` with ${callGasText(callGas)} gas`}`}`,
      ...(router === null ? [] : [`via router ${address(router)}`]),
    ].join(" · ");
  // Owner: "this shit in the ui is still too wordy. just tell the user what is happening: \"Deliver for a share ~16 min + light
  // client 14 h behind\" they do not need to know why. give them hard numbers. clicking in helps them figure out why".
  // So the short text is numbers only: the percent from the form before an amount is known, the max once it is, the fixed
  // amount, the gas level's name when nothing numeric is known; the reasons live in the menu and in `full`.
  const atGas = `Deliver at ${facts.gasLevelName === undefined ? "the current" : facts.gasLevelName} gas`;
  const percent = share ?? facts.percentText ?? null;
  const short =
    mode === "none"
      ? "You deliver it"
      : mode === "gas-multiplier"
        ? `${share === null ? atGas : `Deliver for ~${share}`}${worst}`
        : mode === "fixed"
          ? facts.fixedText === null ? "Set the fixed fee" : `Deliver for ${fixed}`
          : percent === null ? "Set the share" : `Deliver for ${percent}${amount === null ? "" : `, max ${amount}`}`;
  return { short, text: sentence(shortAddress), full: sentence((text) => text) };
};

type Segment<T extends string> = { readonly value: T; readonly label: string };

const Segments = <T extends string>({ label, value, options, onChange, stacked = false }: { readonly label: string; readonly value: T; readonly options: readonly Segment<T>[]; readonly onChange: (next: T) => void; readonly stacked?: boolean }) => (
  <div className={stacked ? "zb-menu-row zb-menu-stack" : "zb-menu-row"}>
    <span className="zb-m-head">{label}</span>
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
  /** The tip mode in force, and what choosing another does (the bridge screen keeps the fee where it is). */
  readonly tipChoice: TipChoiceKey;
  readonly onTipChoice: (next: TipChoiceKey) => void;
  /** The value of the mode in force (share, fixed amount, gas multiple), or null when the mode has none. */
  readonly value: FeeSlider | null;
  /** The gas level as an anchor with its 15-minute range, or null before the base fee is known. */
  readonly gas: FeeSlider | null;
  /** The automatic and the hard fee cap, as ranges. */
  readonly caps: readonly FeeSlider[];
  /** What the fee covers (delivery gas, proof, the gas level, tip, the fee); empty without prices. */
  readonly breakdown: readonly { readonly label: string; readonly value: string; readonly total?: boolean }[];
  /** A line under the values, such as what happens left of the break-even tick. */
  readonly note: string | null;
  /**
   * The callback gas that the relay passes, worked out from the call gas, or null when there is no call or no call gas
   * yet. It is shown read only: the page sets it.
   */
  readonly callbackGas: bigint | null;
};

/**
 * The one delivery menu (owner, quote 98: one layer, "a tighter summary of actions"): who delivers, that mode's value,
 * the gas level, both caps, what the fee covers, then an Advanced fold with the relay router and a call
 * after delivery (with the exact gas the call gets). Every value is a slider with a recommended tick, an exact input, a reset and an undo (owner, quote
 * 90); every choice writes the address.
 *
 * @param props The form, the default router, the controls and the handlers.
 */
export const DeliveryMenu = ({ form, defaultRouter, onChange, tipChoice, onTipChoice, value, gas, caps, breakdown, note, callbackGas }: DeliveryMenuProps) => {
  const tip: TipQuery = form.tip ?? {};
  const [advanced, setAdvanced] = useState(form.callGas !== undefined || tip.routerText !== undefined || form.callTarget !== undefined);
  const control = (slider: FeeSlider) => (
    <div key={slider.label} className="zb-menu-control">
      <FeeControl slider={slider} />
    </div>
  );
  // The router calls this contract after it pays the recipient (the call after delivery); no target, no call.
  const writeCall = (target: string | undefined, data: string | undefined): void =>
    onChange({ ...form, callTarget: target, callData: target === undefined ? undefined : data, ...(target === undefined ? { callGas: undefined } : {}) });
  return (
    <div className="zb-delivery-menu" role="group" aria-label="Delivery settings">
      <Segments label="Who delivers" value={tipChoice} options={TIP_CHOICES} onChange={onTipChoice} stacked />
      {value === null ? null : control(value)}
      {gas === null ? null : control(gas)}
      {caps.map(control)}
      {breakdown.length === 0 ? null : (
        <ul className="zb-breakdown" aria-label="What the fee covers">
          {breakdown.map((line) => (
            <li key={line.label} data-total={line.total === true ? "" : undefined}>
              <span>{line.label}</span>
              <span>{line.value}</span>
            </li>
          ))}
        </ul>
      )}
      {note === null ? null : <p className="zb-slider-note">{note}</p>}
      <button type="button" className="zb-menu-fold" aria-expanded={advanced} onClick={() => setAdvanced(!advanced)}>
        Advanced
        <Chevron dir={advanced ? "up" : "down"} />
      </button>
      {advanced ? (
        <div className="zb-menu-advanced">
          <label className="zb-menu-row">
            <span>Relay router</span>
            <input className="zb-menu-field zb-mono" spellCheck={false} placeholder={defaultRouter ?? "default"} value={tip.routerText ?? ""} onChange={(event) => onChange({ ...form, tip: { ...tip, routerText: event.target.value === "" ? undefined : event.target.value } })} />
          </label>
          <label className="zb-menu-row">
            <span>Call after delivery</span>
            <input className="zb-menu-field zb-mono" spellCheck={false} placeholder="0x… contract (none)" value={form.callTarget ?? ""} onChange={(event) => writeCall(event.target.value === "" ? undefined : event.target.value, form.callData)} />
          </label>
          {form.callTarget === undefined ? null : (
            <label className="zb-menu-row">
              <span>Call data</span>
              <input className="zb-menu-field zb-mono" spellCheck={false} placeholder="0x" value={form.callData ?? ""} onChange={(event) => writeCall(form.callTarget, event.target.value === "" ? undefined : event.target.value)} />
            </label>
          )}
          {form.callTarget === undefined ? null : (
            <label className="zb-menu-row">
              <span>Call gas</span>
              <input
                className="zb-menu-field zb-mono"
                inputMode="numeric"
                autoComplete="off"
                placeholder="the exact gas the call gets"
                aria-label="Call gas"
                value={form.callGas ?? ""}
                onChange={(event) => onChange({ ...form, callGas: event.target.value === "" ? undefined : event.target.value })}
              />
            </label>
          )}
          {callbackGas === null ? null : (
            <div className="zb-menu-row" data-testid="callback-gas">
              <span>Callback gas</span>
              <span className="zb-mono">{callbackGas.toLocaleString("en-US")} (set for you: the call gas plus the router's own work)</span>
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
};
