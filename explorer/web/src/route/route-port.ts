/**
 * The reads of the route steps as react-query hooks, through the backend client of Settings: the pending steps (every
 * 30 s), a step job while it runs (every 5 s) and the finished proof of a step. A request is one call. Without a backend
 * nothing is read. A rate limit of 60 reads a minute per caller sits behind these intervals.
 */
import { useQuery } from "@tanstack/react-query";
import type { RouteStep, RouteStepKind, RouteSteps, StepJob, StepProof, StepRequestAnswer, RequestableStepKind } from "@zk-bridge/shared";
import { useServices } from "../app/services";
import { backendClientOf } from "../views/proof-panel-model";

/** How often the pending steps are read. */
export const ROUTE_STEPS_REFRESH_MILLISECONDS = 30_000;
/** How often a running job is read. */
export const STEP_JOB_REFRESH_MILLISECONDS = 5_000;

/** What the pending steps read gave: no backend is set, nothing yet, the steps, or a failure. */
export type RouteStepsReading =
  | { readonly kind: "no-backend" }
  | { readonly kind: "loading" }
  | { readonly kind: "failed"; readonly reason: string }
  | { readonly kind: "ready"; readonly now: number; readonly steps: readonly RouteStep[]; readonly unread: readonly string[] };

/** The pending steps of both directions. */
export const useRouteSteps = (): RouteStepsReading => {
  const { endpoints, transport } = useServices();
  const backend = endpoints().backendUrl?.value ?? null;
  const query = useQuery({
    queryKey: ["route-steps", backend],
    enabled: backend !== null,
    queryFn: (): Promise<RouteSteps> => (backendClientOf(endpoints(), transport) as NonNullable<ReturnType<typeof backendClientOf>>).routeSteps(),
    refetchInterval: ROUTE_STEPS_REFRESH_MILLISECONDS,
    staleTime: ROUTE_STEPS_REFRESH_MILLISECONDS,
    retry: false,
  });
  if (backend === null) return { kind: "no-backend" };
  if (query.data !== undefined) return { kind: "ready", now: query.data.now, steps: query.data.steps, unread: query.data.unread };
  if (query.error !== null) return { kind: "failed", reason: query.error.message };
  return { kind: "loading" };
};

/**
 * The backend's calls for one step: ask for its proof, and read its finished proof.
 */
export type StepBackend = {
  request(input: { readonly pair: string; readonly kind: RequestableStepKind; readonly subject: string }): Promise<StepRequestAnswer | null>;
  proof(kind: RouteStepKind, subject: string): Promise<StepProof | null>;
};

/** The calls that need no hook: a request, and the finished proof read when the visitor posts. */
export const useStepBackend = (): StepBackend => {
  const { endpoints, transport } = useServices();
  return {
    request: async (input) => {
      const client = backendClientOf(endpoints(), transport);
      if (client === null) return null;
      return client.requestStep(input).catch(() => null);
    },
    proof: async (kind, subject) => {
      const client = backendClientOf(endpoints(), transport);
      return client === null ? null : client.stepProof(kind, subject).catch(() => null);
    },
  };
};

/**
 * A step job, read every 5 s while it is queued or running. Null for no job, an unknown job and a failed read.
 *
 * @param jobId The job, or null.
 */
export const useStepJob = (jobId: string | null): StepJob | null => {
  const { endpoints, transport } = useServices();
  const query = useQuery({
    queryKey: ["step-job", jobId],
    enabled: jobId !== null,
    queryFn: async (): Promise<StepJob | null> => (await backendClientOf(endpoints(), transport)?.stepJob(jobId as string)) ?? null,
    refetchInterval: (state) => (state.state.data?.status === "done" || state.state.data?.status === "failed" ? false : STEP_JOB_REFRESH_MILLISECONDS),
    retry: false,
  });
  return query.data ?? null;
};
