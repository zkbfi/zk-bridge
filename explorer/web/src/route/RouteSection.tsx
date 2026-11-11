/**
 * The Route section of Explore: every pending step of both directions, each as a card with its situation, its
 * constraints and its guided flow (`StepCard`). A step that was listed and is gone stays on the page as "someone else
 * posted it" (or "Done" with the visitor's own transaction), so a card never vanishes under a click. The section has the
 * id `route`, so `#/explore?section=route` opens on it.
 */
import { useEffect, useState } from "react";
import type { RouteStep } from "@zk-bridge/shared";
import { XGroup } from "../explore/parts";
import { useWallet } from "../wallet/wallet-port";
import { StepCard } from "./StepCard";
import { useRouteBoard } from "./route-board";

/** The id of the section, for a link. */
export const ROUTE_SECTION_ID = "route";

/**
 * Keeps the steps seen so far, so a step that leaves the list is still shown (as posted). A read that left some reads
 * unread does not count a missing step as posted: the step stays pending then.
 *
 * A seal step comes from the seal offer of the visitor's account: without an account it is not offered, so a seal step that
 * left the list is dropped while no account is connected (it says nothing of the gate then).
 *
 * @param listed The steps of the newest list.
 * @param unread The reads of the newest list that failed.
 * @param account Whether a wallet account is connected.
 */
export const useSeen = (listed: readonly RouteStep[], unread: readonly string[], account = true): readonly { readonly step: RouteStep; readonly pending: RouteStep | null }[] => {
  const [seen, setSeen] = useState<readonly RouteStep[]>([]);
  useEffect(() => {
    setSeen((before) => {
      const known = new Set(before.map((step) => step.id));
      const added = listed.filter((step) => !known.has(step.id));
      return added.length === 0 ? before : [...before, ...added];
    });
  }, [listed]);
  const all = [...seen, ...listed.filter((step) => !seen.some((entry) => entry.id === step.id))].filter((step) => account || step.kind !== "seal" || listed.some((entry) => entry.id === step.id));
  return all.map((step) => {
    const current = listed.find((entry) => entry.id === step.id) ?? null;
    return { step: current ?? step, pending: current ?? (unread.length > 0 ? step : null) };
  });
};

/**
 * The Route section. Nothing while no backend is set (the sample page).
 *
 * @param props `focus`: scroll the section into view once it shows (a link to `#/explore?section=route`).
 */
export const RouteSection = ({ focus = false }: { readonly focus?: boolean }) => {
  const { reading, steps } = useRouteBoard();
  const unread = reading.kind === "ready" ? reading.unread : [];
  const wallet = useWallet();
  const cards = useSeen(steps, unread, wallet.account !== null);
  const shown = reading.kind !== "no-backend";
  useEffect(() => {
    if (focus && shown) document.getElementById(ROUTE_SECTION_ID)?.scrollIntoView?.({ block: "start" });
  }, [focus, shown]);
  if (!shown) return null;
  return (
    <div className="zb-col" id={ROUTE_SECTION_ID} data-testid="route-section">
      <XGroup title="Route" right={<a href="#/docs/how-the-bridge-works">How the route moves</a>} />
      {reading.kind === "loading" ? <p className="zb-small">Reading the pending steps…</p> : null}
      {reading.kind === "failed" ? <p className="zb-small" data-testid="route-failed">The backend did not give the pending steps ({reading.reason}). The page asks again every 30 s.</p> : null}
      {reading.kind === "ready" && cards.length === 0 ? <p className="zb-small" data-testid="route-empty">Nothing is pending: every step of both directions is posted.</p> : null}
      {reading.kind === "ready" && unread.length > 0 ? <p className="zb-small" data-testid="route-unread">{unread.length} read{unread.length === 1 ? "" : "s"} of the backend failed ({unread.join(", ")}); steps from them may be missing.</p> : null}
      {cards.map(({ step, pending }) => (
        <StepCard key={step.id} step={step} pending={pending} steps={steps} />
      ))}
    </div>
  );
};
