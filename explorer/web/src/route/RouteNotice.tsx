/**
 * The one-line notice of the Bridge screen when a route step holds up new sends or deliveries (deposits closed, a gate to
 * seal, a light client near stranding), with a link to the Route section of Explore. Nothing when none does.
 */
import { routeBlockersOf } from "@zk-bridge/shared";
import { useServices } from "../app/services";
import { formatRoute } from "../app/route";
import { useClockSeconds } from "../fork/use-fork";
import { blockerNotice } from "./route-model";
import { useRouteBoard } from "./route-board";

/** The notice. */
export const RouteNotice = () => {
  const { pair } = useServices();
  const { steps } = useRouteBoard();
  const nowMs = useClockSeconds(15_000) * 1_000;
  const text = blockerNotice(routeBlockersOf(steps, nowMs), { pair, nowMs });
  if (text === null) return null;
  return (
    <span className="zb-rs-notice" data-testid="route-notice">
      {text} <a href={formatRoute({ name: "explore", section: "route" })}>Open the route steps</a>
    </span>
  );
};
