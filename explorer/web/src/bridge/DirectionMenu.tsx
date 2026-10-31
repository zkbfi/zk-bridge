import { useEffect, useRef, type KeyboardEvent } from "react";
import type { Direction } from "@terminal/model/types";
import { usePairHealth } from "../app/queries";
import { useServices } from "../app/services";
import { Chevron } from "./icons";
import { TokenIcon } from "./TokenIcon";

/** A route: a pair and a direction. */
export type RouteChoice = { readonly pairId: string; readonly dir: Direction };

type Chain = { readonly chainId: number; readonly name: string };

/** The chains of the pairs the dapp knows, first then second. */
const PAIR_CHAINS: Readonly<Record<string, readonly [Chain, Chain]>> = {
  "eth-pls": [{ chainId: 1, name: "Ethereum" }, { chainId: 369, name: "PulseChain" }],
  "sepolia-pls943": [{ chainId: 11155111, name: "Sepolia" }, { chainId: 943, name: "PulseChain v4" }],
};

const TESTNETS = new Set([11155111, 943]);

/** Props of {@link DirectionMenu}. */
export type DirectionMenuProps = {
  readonly current: RouteChoice;
  readonly onPick: (next: RouteChoice) => void;
  readonly onClose: () => void;
};

/**
 * The route menu that drops from the From pill (owner: "dropdown works for the from network for sure"): every
 * direction of every pair, grouped by pair, testnets under their own heading; two chain icons with a chevron between.
 * The current route is lit with an accent bar on its left edge, which never shifts content (no check mark). Routes the
 * release has no deployment for are greyed with the reason. Arrow keys move, Enter picks, Escape closes.
 *
 * @param props The current route and the handlers.
 */
export const DirectionMenu = ({ current, onPick, onClose }: DirectionMenuProps) => {
  const { knownPairs } = useServices();
  const health = usePairHealth().data ?? [];
  /** Why a route cannot be used now, or null: no deployment, or the gate on its source chain is closed. */
  const blockedReason = (pairId: string, configured: boolean, from: Chain, side: "first" | "second"): string | null => {
    if (!configured) return "not deployed yet";
    const gate = health.find((entry) => entry.pairId === pairId)?.gates[side];
    return gate === "stop" || gate === "sealed" ? `paused: the gate on ${from.name} is closed` : null;
  };
  const list = useRef<HTMLDivElement>(null);
  const items = (): HTMLElement[] => [...(list.current?.querySelectorAll<HTMLElement>('[role="menuitemradio"]:not([aria-disabled="true"])') ?? [])];

  useEffect(() => {
    (items().find((item) => item.getAttribute("aria-checked") === "true") ?? items()[0])?.focus();
  }, []);

  const onKey = (event: KeyboardEvent): void => {
    const all = items();
    const at = all.indexOf(document.activeElement as HTMLElement);
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const next = (at + (event.key === "ArrowDown" ? 1 : -1) + all.length) % all.length;
      all[next]?.focus();
    }
  };

  const groups = knownPairs.flatMap((pair) => {
    const chains = PAIR_CHAINS[pair.id];
    if (chains === undefined) return [];
    return [{ pair, chains, testnet: TESTNETS.has(chains[0].chainId) }];
  });
  const sorted = [...groups.filter((group) => !group.testnet), ...groups.filter((group) => group.testnet)];

  return (
    <div ref={list} className="zb-pop zb-dir-menu" role="menu" aria-label="Route" onKeyDown={onKey}>
      {sorted.map(({ pair, chains, testnet }, index) => (
        <div key={pair.id} role="group" aria-label={testnet ? `Testnet: ${chains[0].name} ⇄ ${chains[1].name}` : `${chains[0].name} ⇄ ${chains[1].name}`}>
          {testnet && (index === 0 || !sorted[index - 1]!.testnet) ? <div className="zb-pop-group">Testnet</div> : null}
          {!testnet ? <div className="zb-pop-group">{chains[0].name} ⇄ {chains[1].name}</div> : null}
          {(["first-to-second", "second-to-first"] as const).map((dir) => {
            const [from, to] = dir === "first-to-second" ? chains : [chains[1], chains[0]];
            const checked = pair.id === current.pairId && dir === current.dir;
            const reason = blockedReason(pair.id, pair.configured, from, dir === "first-to-second" ? "first" : "second");
            const disabled = reason !== null;
            return (
              <button
                key={dir}
                type="button"
                role="menuitemradio"
                aria-checked={checked}
                aria-disabled={disabled}
                tabIndex={-1}
                onClick={() => (disabled ? undefined : onPick({ pairId: pair.id, dir }))}
              >
                <TokenIcon subject={{ chainId: from.chainId }} symbol={from.name} size={20} />
                <Chevron dir="right" />
                <TokenIcon subject={{ chainId: to.chainId }} symbol={to.name} size={20} />
                <span>
                  {from.name} → {to.name}
                </span>
                <span style={{ marginLeft: "auto", fontSize: "var(--zb-step--1)", color: "var(--zb-muted)" }}>{reason}</span>
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
};
