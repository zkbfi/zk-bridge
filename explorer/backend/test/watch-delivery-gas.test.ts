import { describe, expect, it } from "vitest";
import { BACKEND_START_DELIVERY_GAS } from "@zk-bridge/shared";
import { createLogger } from "../src/logger.ts";
import { MEASURED_SAMPLES_MINIMUM, chooseDeliveryGas, createDeliveryGasReader, deliveryGasFromReport } from "../src/watch/delivery-gas.ts";

const START = 500_000n;
const kind = (sampleCount: number, p90Gas: string | null) => ({ sampleCount, p90Gas, averageGas: p90Gas, defaultGas: "600000", isDefault: sampleCount === 0 });

describe("chooseDeliveryGas", () => {
  it("takes the start figure with no report or no samples", () => {
    expect(chooseDeliveryGas(null, START)).toEqual({ gas: START, source: "start", sampleCount: 0 });
    expect(chooseDeliveryGas(kind(0, null), START)).toEqual({ gas: START, source: "start", sampleCount: 0 });
  });

  it("takes the start figure while fewer than ten deliveries are measured", () => {
    expect(MEASURED_SAMPLES_MINIMUM).toBe(10);
    expect(chooseDeliveryGas(kind(9, "300000"), START)).toEqual({ gas: START, source: "start", sampleCount: 9 });
  });

  it("follows the measured 90th percentile from ten deliveries, above or below the start figure", () => {
    expect(chooseDeliveryGas(kind(10, "471234"), START)).toEqual({ gas: 471_234n, source: "measured", sampleCount: 10 });
    expect(chooseDeliveryGas(kind(200, "540000"), START)).toEqual({ gas: 540_000n, source: "measured", sampleCount: 200 });
  });

  it("takes the start figure when the report has enough samples but no percentile, or a zero one", () => {
    expect(chooseDeliveryGas(kind(12, null), START)).toEqual({ gas: START, source: "start", sampleCount: 12 });
    expect(chooseDeliveryGas(kind(12, "0"), START)).toEqual({ gas: START, source: "start", sampleCount: 12 });
  });
});

describe("deliveryGasFromReport", () => {
  const report = (callback: ReturnType<typeof kind>) => ({ chainId: 943, baseFee: { wei: null, blockNumber: null, timestamp: null }, kinds: { token_callback: callback, token: kind(0, null), message: kind(0, null) } });

  it("reads the deliveries through the router, the kind that pays a fee", () => {
    expect(deliveryGasFromReport(report(kind(30, "480000")), START).gas).toBe(480_000n);
  });
});

describe("createDeliveryGasReader", () => {
  const lines: string[] = [];
  const logger = createLogger({ write: (line) => lines.push(line), now: () => 0, knownSecrets: () => [] });
  const logged = () => lines.map((line) => JSON.parse(line) as Record<string, unknown>);
  const report = (callback: ReturnType<typeof kind>) => ({ chainId: 943, baseFee: { wei: null, blockNumber: null, timestamp: null }, kinds: { token_callback: callback, token: kind(0, null), message: kind(0, null) } });

  it("uses the indexer's measured figure, asks for the destination chain, and logs the source once per change", async () => {
    lines.length = 0;
    const urls: string[] = [];
    let answer: { status: number; body: unknown } = { status: 200, body: report(kind(20, "470000")) };
    const read = createDeliveryGasReader({ start: START, indexerUrl: "http://indexer.test/", chainId: 943, logger, get: async (url) => (urls.push(url), answer) });
    expect(await read()).toBe(470_000n);
    expect(await read()).toBe(470_000n);
    expect(urls).toEqual(["http://indexer.test/api/delivery-cost?chainId=943", "http://indexer.test/api/delivery-cost?chainId=943"]);
    expect(logged()).toEqual([{ time: "1970-01-01T00:00:00.000Z", level: "info", event: "watch_delivery_gas", chainId: 943, source: "measured", gas: "470000", sampleCount: 20 }]);
    answer = { status: 200, body: report(kind(3, "300000")) };
    expect(await read()).toBe(START);
    expect(logged().at(-1)).toMatchObject({ event: "watch_delivery_gas", source: "start", gas: "500000", sampleCount: 3 });
  });

  it("falls back to the start figure, and says why, when the indexer answers badly or not at all", async () => {
    lines.length = 0;
    let answer: () => Promise<{ status: number; body: unknown }> = async () => ({ status: 503, body: {} });
    const read = createDeliveryGasReader({ start: START, indexerUrl: "http://indexer.test", chainId: 943, logger, get: () => answer() });
    expect(await read()).toBe(START);
    answer = async () => ({ status: 200, body: { nope: true } });
    expect(await read()).toBe(START);
    answer = async () => Promise.reject(new Error("down"));
    expect(await read()).toBe(START);
    expect(logged().map((line) => [line.event, line.level])).toEqual(Array(3).fill(["watch_delivery_gas_unreadable", "warn"]));
    expect(logged()[0]).toMatchObject({ chainId: 943, why: "the chain indexer answered 503 for the delivery costs" });
    expect(logged()[1]).toMatchObject({ why: "the chain indexer sent the delivery costs in an unknown shape" });
    expect(logged()[2]).toMatchObject({ why: "down" });
    answer = async () => Promise.reject("refused");
    expect(await read()).toBe(START);
    expect(logged()[3]).toMatchObject({ why: "refused" });
  });

  it("the start figure of the code is the one of the shared constant", () => {
    expect(BACKEND_START_DELIVERY_GAS).toBe(START);
  });
});
