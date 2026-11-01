import { describe, expect, it } from "vitest";
import { parseProveTiming } from "../src/prover/prove-timing.js";

describe("parseProveTiming", () => {
  it("reads the last prove_timing line: numbers for times and counters, text for the rest", () => {
    const stderr = [
      "ts=1 level=info event=prove_timing build_ms=1 total_ms=2",
      'ts=5 level=info event=prove_timing build_ms=10 native_ms=20 not_ready_count=3 worker_timings=reported worker_gpu="NVIDIA \\"L40S\\" 48GB" worker_cpu_model="AMD EPYC 9354" total_ms=abc',
      "ts=6 level=info event=proof_handed_off",
    ].join("\n");
    expect(parseProveTiming(stderr)).toEqual({
      build_ms: 10,
      native_ms: 20,
      not_ready_count: 3,
      worker_timings: "reported",
      worker_gpu: 'NVIDIA "L40S" 48GB',
      worker_cpu_model: "AMD EPYC 9354",
      total_ms: "abc",
    });
  });

  it("gives the marker of a worker without timings as text", () => {
    expect(parseProveTiming("ts=5 level=info event=prove_timing build_ms=1 worker_timings=none")).toEqual({ build_ms: 1, worker_timings: "none" });
  });

  it("gives null when the prover wrote no summary", () => {
    expect(parseProveTiming("")).toBeNull();
    expect(parseProveTiming("ts=1 level=info event=prove_step step=build elapsed_ms=5\nevent=prove_timings_not")).toBeNull();
  });
});
