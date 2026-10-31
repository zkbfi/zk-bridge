import { useQuery } from "@tanstack/react-query";
import type { ProbeKind, ProbeResult } from "./service-probe";
import { useServices } from "./services";

/** A probe while it runs, then its result. */
export type ProbeState = { readonly ok: null } | ProbeResult;

/**
 * Probes a URL now and every minute. Null URL: nothing to probe (the state stays pending).
 *
 * @param url The URL, or null when the service is not set.
 * @param kind What to ask it.
 */
export const useServiceProbe = (url: string | null, kind: ProbeKind): ProbeState => {
  const { probe } = useServices();
  const query = useQuery({
    queryKey: ["probe", url, kind],
    enabled: url !== null,
    refetchInterval: 60_000,
    retry: false,
    queryFn: () => probe(url!, kind),
  });
  return query.data ?? { ok: null };
};
