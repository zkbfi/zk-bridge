import type { ReactNode } from "react";
import { useServices } from "../app/services";
import { strandingLine } from "./stranding";
import { directionInto, useMinuteClock, useStrandingDeadlines } from "./use-stranding";

/**
 * "5.2 h until stranded (period 17)" for the light client on a chain, in the tone of the time left. It renders nothing
 * (not even `wrap`) while the backend gives no deadline: an older backend, no backend, or an unreachable one.
 *
 * @param props The chain that holds the light client, and the wrapper for the line (a row, say).
 */
export const StrandingLine = ({ chainId, wrap }: { readonly chainId: number; readonly wrap: (line: ReactNode) => ReactNode }) => {
  const { pair } = useServices();
  const deadlines = useStrandingDeadlines();
  const now = useMinuteClock();
  const line = strandingLine(deadlines[directionInto(pair, chainId)], now);
  if (line === null) return null;
  const tone = line.tone === "normal" ? undefined : line.tone === "warn" ? "zb-warn-text" : "zb-bad-text";
  const text = (
    <span className={tone} data-tone={line.tone} data-testid="stranding-line">
      {line.text}
    </span>
  );
  return <>{wrap(text)}</>;
};
