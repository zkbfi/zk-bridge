import type { ReactElement } from "react";
import { vi } from "vitest";
import type { ResolvedSetting, RouteStep, StepJob } from "@zk-bridge/shared";
import type { RenderWithWalletOptions } from "../app/support";
import { renderWithWallet } from "../app/support";
import type { PanelEndpoints, PanelTransport } from "../../src/views/proof-panel-model";
import type { ForkPort } from "../../src/fork/fork-port";
import type { Services } from "../../src/app/services";
import { NOW_MS } from "./fixtures";

export const BACKEND = "https://backend.example.test";
const setting = (value: string): ResolvedSetting => ({ value, source: "user" });
export const withBackend = (): PanelEndpoints => ({ backendUrl: setting(BACKEND), msgboardIndexerUrl: null, archiveUrl: null, msgboardUrl: null });

/** What the fake backend answers; a test changes it. */
export type World = {
  steps: RouteStep[];
  unread: string[];
  stepsStatus: number;
  request: { status: number; body: unknown };
  job: unknown;
  proof: unknown;
  proofStatus: number;
  requests: unknown[];
  reads: string[];
};

export const newWorld = (): World => ({ steps: [], unread: [], stepsStatus: 200, request: { status: 202, body: { jobId: "job-1" } }, job: null, proof: null, proofStatus: 200, requests: [], reads: [] });

export const jobOf = (over: Partial<StepJob> = {}): StepJob => ({ jobId: "job-1", kind: "light-client-update", subject: "first-to-second", status: "running", startedAt: NOW_MS - 30_000, updatedAt: NOW_MS, etaAt: NOW_MS + 90_000, error: null, ...over });

export const transportOf = (world: World): PanelTransport => ({
  fetchJson: async (url) => {
    const path = url.slice(BACKEND.length);
    world.reads.push(path);
    if (path === "/route/steps") return world.stepsStatus === 200 ? { status: 200, body: { now: NOW_MS, steps: world.steps, unread: world.unread } } : { status: world.stepsStatus, body: {} };
    if (path.startsWith("/steps/jobs/")) return world.job === null ? { status: 404, body: {} } : { status: 200, body: world.job };
    if (path.startsWith("/steps/proofs/")) if (world.proofStatus !== 200) return { status: world.proofStatus, body: {} };
    return world.proof === null ? { status: 404, body: {} } : { status: 200, body: world.proof };
    throw new Error(`unexpected read ${path}`);
  },
  postJson: async (_url, init) => {
    world.requests.push(JSON.parse(init?.body ?? "null"));
    return world.request;
  },
});

export const quietForks: ForkPort = {
  facts: async () => null,
  chainState: async () => ({ gate: null, observation: null }),
  sealOffer: async () => ({ kind: "unavailable", reason: "none" }),
  observeOffer: async () => ({ kind: "unavailable", reason: "none" }),
  registryOf: async () => null,
};

/** Renders with the fake backend of a world. */
export const renderWorld = (ui: ReactElement, world: World, options: Omit<RenderWithWalletOptions, "services"> & { services?: Partial<Services> }) =>
  renderWithWallet(ui, { ...options, services: { endpoints: withBackend, transport: transportOf(world), forks: quietForks, readLightClientHead: vi.fn(async () => 0n), ...options.services } });
