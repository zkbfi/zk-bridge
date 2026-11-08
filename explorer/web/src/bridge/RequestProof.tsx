import { useEffect, useState } from "react";
import type { Hex } from "viem";
import type { ProofDirection } from "@zk-bridge/shared";
import { useServices } from "../app/services";
import { backendClientOf } from "../views/proof-panel-model";
import { proofRequestView, type ProofRequestView } from "./proof-request";

/**
 * "Request a proof" on a transfer that is final on its source chain and not yet covered: one POST to the prover's
 * `/requests`, no sign-in, and a line that says what happens. Hidden when no prover backend is set.
 *
 * @param props The transfer, its direction and the destination chain's name.
 */
export const RequestProof = ({ messageId, direction, destinationName }: { readonly messageId: string; readonly direction: ProofDirection; readonly destinationName: string }) => {
  const services = useServices();
  const client = backendClientOf(services.endpoints(), services.transport);
  const [view, setView] = useState<ProofRequestView | null>(null);
  const [sending, setSending] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const retryAt = view?.retryAt ?? null;

  // The button comes back on when the wait the backend named is over.
  useEffect(() => {
    if (retryAt === null) return undefined;
    const timer = setTimeout(() => setNow(Date.now()), Math.max(0, retryAt - Date.now()));
    return () => clearTimeout(timer);
  }, [retryAt]);

  if (client === null) return null;
  const waiting = retryAt !== null && now < retryAt;
  const started = view !== null && view.tone === "ok" && view.retryAt === null;

  const request = async (): Promise<void> => {
    setSending(true);
    const answer = await client.requestProof({ pair: services.pair.id, direction, reason: "message", messageId: messageId as Hex }).catch(() => null);
    const at = Date.now();
    setNow(at);
    setView(proofRequestView(answer, { destinationName, now: at }));
    setSending(false);
  };

  return (
    <div className="zb-request-proof">
      <button type="button" className="zb-pill" disabled={sending || waiting || started} onClick={() => void request()}>
        {sending ? "Asking the prover…" : "Request a proof"}
      </button>
      {view === null ? null : (
        <p className="zb-small" role="status" data-tone={view.tone} style={{ margin: "6px 0 0" }}>
          {view.text}
        </p>
      )}
    </div>
  );
};
