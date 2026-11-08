import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useServices } from "../app/services";
import { backendClientOf } from "../views/proof-panel-model";
import type { StrandingDeadline } from "./stranding";

type Direction = "first-to-second" | "second-to-first";

/** How often the backend is asked, and how often the clock of the lines ticks. */
export const STRANDING_REFRESH_MILLISECONDS = 60_000;

/** A clock in milliseconds that moves every minute. */
export const useMinuteClock = (): number => {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), STRANDING_REFRESH_MILLISECONDS);
    return () => clearInterval(timer);
  }, []);
  return now;
};

/**
 * The deadline of the light client that each direction delivers to, from the backend's pipeline. A direction whose
 * pipeline cannot be read, or whose backend gives no deadline, is null. Without a backend both are null.
 */
export const useStrandingDeadlines = (): Readonly<Record<Direction, StrandingDeadline | null>> => {
  const { endpoints, transport } = useServices();
  const query = useQuery({
    queryKey: ["stranding", endpoints().backendUrl?.value ?? null],
    queryFn: async (): Promise<Record<Direction, StrandingDeadline | null>> => {
      const client = backendClientOf(endpoints(), transport);
      const none = { "first-to-second": null, "second-to-first": null };
      if (client === null) return none;
      const [forward, back] = await Promise.allSettled([client.pipeline("first-to-second"), client.pipeline("second-to-first")]);
      const of = (answer: PromiseSettledResult<{ readonly deadline?: StrandingDeadline | null | undefined }>): StrandingDeadline | null => (answer.status === "fulfilled" ? (answer.value.deadline ?? null) : null);
      return { "first-to-second": of(forward), "second-to-first": of(back) };
    },
    refetchInterval: STRANDING_REFRESH_MILLISECONDS,
    staleTime: STRANDING_REFRESH_MILLISECONDS,
    retry: false,
  });
  return query.data ?? { "first-to-second": null, "second-to-first": null };
};

/** The direction that delivers to a chain: its light client is the one on that chain. */
export const directionInto = (pair: { readonly first: { readonly chainId: number } }, chainId: number): Direction => (pair.first.chainId === chainId ? "second-to-first" : "first-to-second");
