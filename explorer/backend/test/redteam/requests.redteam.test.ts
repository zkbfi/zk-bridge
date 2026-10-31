/**
 * Red team: the public request service (rate limits, caller keys, GPU spend, leaks in answers).
 * Each test is named "ATTACK <name>" when the attack is refused, "ATTACK SUCCEEDS <name>" when it works.
 */
import { describe, expect, it } from "vitest";
import { ProverCommandError } from "@zk-bridge/shared/prover";
import { UNKNOWN_CALLER, callerKey } from "../../src/requests/caller.ts";
import { start as startRequests } from "../../src/requests/module.ts";
import { SECRETS, fakeProofNeed, makeBackend, makeConfig, makeProofPackage, postFrom, requestBody } from "../support.ts";

type Backend = ReturnType<typeof makeBackend>;

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

const post = (backend: Backend, remoteAddress: string, headers: Record<string, string> = {}, overrides: Record<string, unknown> = {}) =>
  backend.app.request(
    "/requests",
    { method: "POST", headers: { "content-type": "application/json", ...headers }, body: requestBody(overrides) },
    { incoming: { socket: { remoteAddress } } },
  );

const callerRows = (backend: Backend) =>
  backend.storage.database.prepare("SELECT caller, count(*) AS n FROM requests GROUP BY caller ORDER BY caller").all() as Array<{ caller: string; n: number }>;

describe("caller keys and forwarded headers", () => {
  it("ATTACK X-Forwarded-For spoofing with the default configuration (header ignored)", async () => {
    const backend = makeBackend();
    for (let index = 0; index < 10; index += 1) expect((await post(backend, "203.0.113.5", { "x-forwarded-for": `198.51.100.${index}` })).status).toBe(202);
    expect((await post(backend, "203.0.113.5", { "x-forwarded-for": "198.51.100.77" })).status).toBe(429);
    expect(callerRows(backend)).toEqual([{ caller: "203.0.113.5", n: 10 }]);
  });

  it("ATTACK forged left-hand X-Forwarded-For entries behind one trusted proxy (only the rightmost entry counts)", async () => {
    const backend = makeBackend({ config: makeConfig({ trustForwardedHeader: true, trustedProxyHops: 1 }) });
    for (let index = 0; index < 10; index += 1) {
      // The client forges entries; the proxy appends the real client 203.0.113.5.
      expect((await post(backend, "10.0.0.1", { "x-forwarded-for": `198.51.100.${index}, 203.0.113.5` })).status).toBe(202);
    }
    expect((await post(backend, "10.0.0.1", { "x-forwarded-for": "1.1.1.1, 2.2.2.2, 203.0.113.5" })).status).toBe(429);
    expect(callerRows(backend)).toEqual([{ caller: "203.0.113.5", n: 10 }]);
  });

  it("ATTACK SUCCEEDS forged X-Forwarded-For when trustForwardedHeader is on and the backend is reached without the proxy (misconfiguration)", async () => {
    // Precondition: the operator turned the trust on and the port is reachable directly (listen.host not 127.0.0.1).
    const backend = makeBackend({ config: makeConfig({ trustForwardedHeader: true, trustedProxyHops: 1 }) });
    for (let index = 0; index < 30; index += 1) expect((await post(backend, "203.0.113.5", { "x-forwarded-for": `198.51.100.${index}` })).status).toBe(202);
    expect(callerRows(backend)).toHaveLength(30);
  });

  it("ATTACK an empty, junk or over-long caller text gives the unknown bucket, never raw text", () => {
    for (const text of ["", "junk", "<script>", "1.2.3.4.5", "999.1.1.1", "::g", "1:2:3:4:5:6:7:8:9", "a::b::c", "x".repeat(10_000)]) {
      expect(callerKey(text)).toBe(UNKNOWN_CALLER);
    }
  });

  it("ATTACK IPv4-mapped, bracketed, ported, zero-padded forms of one IPv4 address share one key", () => {
    const forms = ["1.2.3.4", "1.2.3.4:5555", "::ffff:1.2.3.4", "::FFFF:1.2.3.4", "[::ffff:1.2.3.4]:443", "::ffff:102:304", "0:0:0:0:0:ffff:0102:0304", "001.002.003.004", " 1.2.3.4 "];
    expect(new Set(forms.map(callerKey))).toEqual(new Set(["1.2.3.4"]));
  });

  it("ATTACK IPv6 addresses inside one /64 (interface id, zone, brackets, case) share one key", () => {
    const forms = ["2001:db8:1:2::1", "2001:db8:1:2:ffff:ffff:ffff:ffff", "[2001:DB8:1:2::abcd]:80", "2001:db8:1:2::1%eth0", "2001:0db8:0001:0002:0:0:0:9"];
    expect(new Set(forms.map(callerKey))).toEqual(new Set(["2001:db8:1:2::/64"]));
  });

  it("ATTACK SUCCEEDS one holder of an IPv6 /48 gets 65,536 caller keys and passes the per-caller limit (the global limit still holds)", async () => {
    const backend = makeBackend();
    let accepted = 0;
    for (let subnet = 0; subnet < 200; subnet += 1) {
      if ((await post(backend, `2001:db8:abcd:${subnet.toString(16)}::1`)).status === 202) accepted += 1;
    }
    // 200 /64 networks of one /48; the per-caller limit alone would allow 10. Only the global limit of 120 distinct
    // callers (K-2) stops it, and then it locks out new callers for a minute (K-7 stays open).
    expect(accepted).toBe(120);
    expect(callerRows(backend)).toHaveLength(120);
  });

  it("ATTACK SUCCEEDS IPv4-compatible (::a.b.c.d) and NAT64 (64:ff9b::a.b.c.d) callers collapse into one shared /64 bucket", () => {
    // Not a bypass: every caller behind such a gateway shares one bucket of 10 per minute (a denial of service for them).
    expect(callerKey("64:ff9b::1.2.3.4")).toBe(callerKey("64:ff9b::5.6.7.8"));
    expect(callerKey("::1.2.3.4")).toBe(callerKey("::9.9.9.9"));
  });
});

describe("global limit and GPU spend", () => {
  it("ATTACK twelve IPv4 addresses at their own limit do not lock honest callers out (BLOCKED, was K-2)", async () => {
    // The global limit counts distinct callers, not requests: twelve addresses use 12 of its 120 places.
    const backend = makeBackend();
    for (let host = 1; host <= 12; host += 1) {
      for (let index = 0; index < 10; index += 1) expect((await post(backend, `198.51.100.${host}`)).status).toBe(202);
    }
    expect((await post(backend, `198.51.100.1`)).status).toBe(429);
    expect((await post(backend, "203.0.113.200")).status).toBe(202);
    // The operator's keep-alive request passes as well.
    expect((await post(backend, "203.0.113.201", {}, { reason: "keep-alive" })).status).toBe(202);
  });

  it("ATTACK many callers cannot start more than one active job per direction", async () => {
    const backend = makeBackend();
    for (let host = 1; host <= 50; host += 1) await post(backend, `198.51.100.${host}`);
    expect(backend.prover.calls).toHaveLength(1);
    expect((backend.storage.database.prepare("SELECT count(*) AS n FROM jobs").get() as { n: number }).n).toBe(1);
  });

  it("ATTACK a new job right after a finished one is refused until secondsBetweenJobsPerDirection passed", async () => {
    const backend = makeBackend();
    expect((await post(backend, "198.51.100.1")).status).toBe(202);
    backend.prover.settleAll({ kind: "up-to-date" } as never);
    await tick();
    backend.clock.advance(119_000);
    expect((await post(backend, "198.51.100.2")).status).toBe(429);
    expect(backend.prover.calls).toHaveLength(1);
  });

  it("ATTACK an anonymous caller who asks for a proving run every secondsBetweenJobsPerDirection while no message waits starts nothing (BLOCKED, was K-1)", async () => {
    // A request only asks. The backend starts a paid run only when the chain indexer shows a waiting message or an old head.
    const need = fakeProofNeed({ needed: false });
    const backend = makeBackend({ proofNeed: need });
    for (let round = 0; round < 50; round += 1) {
      for (const direction of ["first-to-second", "second-to-first"]) {
        expect((await post(backend, `198.51.100.${round + 1}`, {}, { direction, reason: "keep-alive" })).status).toBe(409);
      }
      backend.clock.advance(120_000);
    }
    expect(backend.prover.calls).toHaveLength(0);
    expect((backend.storage.database.prepare("SELECT count(*) AS n FROM jobs").get() as { n: number }).n).toBe(0);
    // The indexer is asked at most once per direction in each reuse window, however many requests arrive.
    expect(need.reads).toHaveLength(100);
  });

  it("ATTACK when the indexer says a proof is needed every time (wrong facts), the daily job budget still stops the spend (backstop)", async () => {
    // Each run that finds a newer finalized head costs one remote GPU proof. The daily budget bounds that spend.
    const backend = makeBackend({ config: makeConfig({ limits: { jobsPerDirectionPerDay: 3 } }) });
    const answers: number[] = [];
    for (let round = 0; round < 5; round += 1) {
      for (const direction of ["first-to-second", "second-to-first"]) {
        answers.push((await post(backend, `198.51.100.${round + 1}`, {}, { direction, reason: "user" })).status);
      }
      backend.prover.settleAll({ kind: "proved", proofPackage: makeProofPackage(100 + round, 200 + round) } as never);
      await tick();
      // The webhook stores the proof and the publisher posts it: the job leaves the active states.
      backend.storage.database.prepare("UPDATE jobs SET status = 'published' WHERE status = 'proving'").run();
      backend.clock.advance(120_000);
    }
    expect(answers).toEqual([202, 202, 202, 202, 202, 202, 429, 429, 429, 429]);
    expect(backend.prover.calls).toHaveLength(6);
    // The oldest run leaves the day: one more run may start, and the answer said when.
    const refused = await post(backend, "198.51.100.50", {}, { direction: "first-to-second", reason: "user" });
    expect(Number(refused.headers.get("retry-after"))).toBe(86_400 - 5 * 120);
    backend.clock.advance((86_400 - 5 * 120) * 1000);
    expect((await post(backend, "198.51.100.51", {}, { direction: "first-to-second", reason: "user" })).status).toBe(202);
  });

  it("ATTACK a run that finds the chain up to date costs no proof and does not use the daily budget", async () => {
    const backend = makeBackend({ config: makeConfig({ limits: { jobsPerDirectionPerDay: 1 } }) });
    for (let round = 0; round < 3; round += 1) {
      expect((await post(backend, `198.51.100.${round + 1}`)).status).toBe(202);
      backend.prover.settleAll({ kind: "up-to-date" } as never);
      await tick();
      backend.clock.advance(120_000);
    }
    expect(backend.prover.calls).toHaveLength(3);
  });

  it("ATTACK a failed job is retried only after secondsBeforeRetryAfterFailure, not in a loop", async () => {
    const backend = makeBackend();
    await post(backend, "198.51.100.1");
    backend.prover.failAll(new ProverCommandError("boom", 1, ""));
    await tick();
    for (let host = 2; host < 40; host += 1) await post(backend, `198.51.100.${host}`);
    expect(backend.prover.calls).toHaveLength(1);
    backend.clock.advance(60_000);
    await post(backend, "198.51.100.99");
    expect(backend.prover.calls).toHaveLength(2);
  });
});

describe("bodies and leaks", () => {
  it("ATTACK a 1 MB request body is refused with 413", async () => {
    const backend = makeBackend();
    const answer = await backend.app.request(
      "/requests",
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pad: "x".repeat(1_000_000) }) },
      { incoming: { socket: { remoteAddress: "1.2.3.4" } } },
    );
    expect(answer.status).toBe(413);
  });

  it("ATTACK extra fields, a wrong pair or a bad messageId are refused and store nothing", async () => {
    const backend = makeBackend();
    for (const overrides of [{ extra: 1 }, { pair: "sepolia-pls943" }, { reason: "message" }, { reason: "message", messageId: "0x12" }, { direction: "both" }]) {
      const { init, env } = postFrom("1.2.3.4", overrides);
      expect((await backend.app.request("/requests", init, env)).status).toBe(400);
    }
    expect(callerRows(backend)).toEqual([]);
  });

  it("ATTACK a prover error that carries the RunPod key, the bearer and an endpoint reaches no answer and no log line", async () => {
    const backend = makeBackend();
    const { requestId } = (await (await post(backend, "1.2.3.4")).json()) as { requestId: string };
    backend.prover.failAll(new Error(`POST https://api.runpod.ai/v2/endpoint?key=${SECRETS.runpodApiKey} Authorization: Bearer ${SECRETS.webhookBearer}`));
    await tick();
    const texts = await Promise.all([`/requests/${requestId}`, "/directions/first-to-second", "/health"].map(async (path) => (await backend.app.request(path)).text()));
    for (const text of texts) expect(text).not.toContain("api.runpod.ai");
    for (const text of [...texts, ...backend.log.lines]) {
      expect(text).not.toContain(SECRETS.runpodApiKey);
      expect(text).not.toContain(SECRETS.webhookBearer);
    }
  });

  it("ATTACK SUCCEEDS job rows are never pruned (only request rows are), so the jobs table grows for ever", async () => {
    const backend = makeBackend();
    for (let round = 0; round < 30; round += 1) {
      await post(backend, `198.51.100.${round + 1}`);
      backend.prover.settleAll({ kind: "up-to-date" } as never);
      await tick();
      backend.clock.advance(120_000);
    }
    backend.clock.advance(48 * 3_600_000);
    const stop = await startRequests(backend.context);
    await stop();
    const count = (table: string) => (backend.storage.database.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
    expect(count("requests")).toBe(0);
    expect(count("jobs")).toBe(30);
  });
});
