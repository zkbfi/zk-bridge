import type { BridgeQuery, TipQuery } from "../app/route";

/** The speeds the menu offers: a share of the amount as the tip. Custom keeps whatever the tip drawer sets. */
export const SPEEDS = [
  { key: "standard", label: "Standard", percent: "0.1" },
  { key: "fast", label: "Fast", percent: "0.3" },
] as const;

/** The pill's summary: "Standard delivery", or what differs, such as "Fast · tip 0.3%". */
export const deliverySummary = (form: BridgeQuery): string => {
  const tip = form.tip ?? {};
  const speed = SPEEDS.find((candidate) => (tip.mode === undefined || tip.mode === "percentage") && (tip.percentText ?? "0.1") === candidate.percent);
  const parts: string[] = [];
  if (tip.mode === "fixed") parts.push("fixed tip");
  else if (tip.mode === "gas-multiplier") parts.push("gas-based tip");
  else if (tip.mode === "none") parts.push("no tip");
  // A share set in the tip drawer is the whole fee's (tip and cost together), shown short.
  else if (speed === undefined) parts.push(tip.percentText === undefined || !Number.isFinite(Number(tip.percentText)) ? "custom fee" : `fee ${Number(Number(tip.percentText).toPrecision(3))}%`);
  else if (speed.key !== "standard") parts.push(`${speed.label} · tip ${speed.percent}%`);
  if (form.gasLimit !== undefined) parts.push(`gas ${form.gasLimit}`);
  if (tip.routerText !== undefined) parts.push("custom router");
  return parts.length === 0 ? "Standard delivery" : parts.join(" · ");
};

type Segment<T extends string> = { readonly value: T; readonly label: string };

const Segments = <T extends string>({ label, value, options, onChange }: { readonly label: string; readonly value: T; readonly options: readonly Segment<T>[]; readonly onChange: (next: T) => void }) => (
  <div className="zb-menu-row">
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
};

/**
 * The delivery settings behind the "Standard delivery" pill: speed, how the tip is computed, the gas limit, the relay
 * router and sending to another address, each a row of pill segments or a field. Every choice writes the address.
 *
 * @param props The form, the default router and the handlers.
 */
export const DeliveryMenu = ({ form, defaultRouter, onChange, onReceiver }: DeliveryMenuProps) => {
  const tip: TipQuery = form.tip ?? {};
  const mode = tip.mode ?? "percentage";
  const speed = mode === "percentage" ? (SPEEDS.find((candidate) => (tip.percentText ?? "0.1") === candidate.percent)?.key ?? "custom") : "custom";
  const setTip = (next: TipQuery): void => onChange({ ...form, tip: { ...tip, ...next } });
  return (
    <div className="zb-pop zb-delivery-menu" role="group" aria-label="Delivery settings">
      <Segments
        label="Speed"
        value={speed}
        options={[...SPEEDS.map((candidate) => ({ value: candidate.key, label: candidate.label })), { value: "custom" as const, label: "Custom" }]}
        onChange={(next) => {
          const preset = SPEEDS.find((candidate) => candidate.key === next);
          if (preset !== undefined) setTip({ mode: "percentage", percentText: preset.percent });
        }}
      />
      <Segments
        label="Tip"
        value={mode}
        options={[
          { value: "percentage", label: "Share" },
          { value: "fixed", label: "Fixed" },
          { value: "gas-multiplier", label: "Gas-based" },
        ]}
        onChange={(next) => setTip({ mode: next })}
      />
      <label className="zb-menu-row">
        <span>Gas limit</span>
        <input className="zb-menu-field" inputMode="numeric" placeholder="auto" value={form.gasLimit ?? ""} onChange={(event) => onChange({ ...form, gasLimit: event.target.value === "" ? undefined : event.target.value })} />
      </label>
      <label className="zb-menu-row">
        <span>Relay router</span>
        <input className="zb-menu-field zb-mono" spellCheck={false} placeholder={defaultRouter ?? "default"} value={tip.routerText ?? ""} onChange={(event) => setTip({ routerText: event.target.value === "" ? undefined : event.target.value })} />
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
