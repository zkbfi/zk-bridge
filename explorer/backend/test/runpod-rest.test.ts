import { describe, expect, it } from "vitest";
import { RUNPOD_REST_URL, RunPodRequestError, problemText, reasonOf, runPodRequest } from "../src/runpod-rest.ts";

const KEY = "fake-runpod-key-for-tests-0009";

type Seen = { url: string; method: string | undefined; headers: Headers; body: unknown };

/** A fetch that records the request and answers with `answer`. */
function fakeFetch(answer: () => Response) {
  const seen: Seen[] = [];
  const fetchFunction = (async (input: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: String(input), method: init?.method, headers: new Headers(init?.headers), body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined });
    return answer();
  }) as typeof fetch;
  return { seen, fetchFunction };
}

const options = { apiKey: KEY, timeoutMilliseconds: 1000 };

describe("runPodRequest", () => {
  it("sends the key as a bearer header and returns the parsed body", async () => {
    const { seen, fetchFunction } = fakeFetch(() => Response.json({ ok: 1 }));
    expect(await runPodRequest(fetchFunction, `${RUNPOD_REST_URL}/serverless/x`, options)).toEqual({ ok: 1 });
    expect(seen[0]?.method).toBeUndefined();
    expect(seen[0]?.headers.get("authorization")).toBe(`Bearer ${KEY}`);
    expect(seen[0]?.headers.get("accept")).toBe("application/json");
    expect(seen[0]?.headers.get("content-type")).toBeNull();
  });

  it("sends a JSON body with its method", async () => {
    const { seen, fetchFunction } = fakeFetch(() => Response.json({}));
    await runPodRequest(fetchFunction, "https://example.invalid/x", { ...options, method: "PATCH", body: { workers: { max: 0 } } });
    expect(seen[0]).toMatchObject({ method: "PATCH", body: { workers: { max: 0 } } });
    expect(seen[0]?.headers.get("content-type")).toBe("application/json");
  });

  it("answers null for a 2xx body that is not JSON", async () => {
    expect(await runPodRequest(fakeFetch(() => new Response("<html>")).fetchFunction, "https://example.invalid/x", options)).toBeNull();
  });

  it("throws the status and RunPod's problem text, never the key", async () => {
    const problem = fakeFetch(() => Response.json({ title: "Unauthorized", detail: "bad key" }, { status: 401 }));
    const error = (await runPodRequest(problem.fetchFunction, "https://example.invalid/x", options).catch((caught: unknown) => caught)) as RunPodRequestError;
    expect(error).toBeInstanceOf(RunPodRequestError);
    expect(error).toMatchObject({ message: "RunPod answered 401: Unauthorized: bad key", status: 401, retryAfterSeconds: null });
    expect(reasonOf(error)).toBe("RunPod answered 401: Unauthorized: bad key");
    const plain = await runPodRequest(fakeFetch(() => new Response("<html>", { status: 502 })).fetchFunction, "https://example.invalid/x", options).catch((caught: unknown) => caught);
    expect((plain as Error).message).toBe("RunPod answered 502");
  });

  it("reads Retry-After in seconds from a 429, and ignores a value it cannot use", async () => {
    const retry = async (value: string | null) => {
      const { fetchFunction } = fakeFetch(() => new Response("{}", { status: 429, ...(value === null ? {} : { headers: { "retry-after": value } }) }));
      return ((await runPodRequest(fetchFunction, "https://example.invalid/x", options).catch((caught: unknown) => caught)) as RunPodRequestError).retryAfterSeconds;
    };
    expect(await retry("120")).toBe(120);
    expect(await retry(null)).toBeNull();
    expect(await retry("Wed, 21 Oct 2026 07:28:00 GMT")).toBeNull();
    expect(await retry("0")).toBeNull();
    expect(await retry("-5")).toBeNull();
  });

  it("lets a network failure through as it is, and reasonOf names it", async () => {
    const failing = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    const error = await runPodRequest(failing, "https://example.invalid/x", options).catch((caught: unknown) => caught);
    expect(reasonOf(error)).toBe("TypeError");
  });
});

describe("problemText", () => {
  it("joins title and detail, cut short, and is null for anything else", () => {
    expect(problemText({ title: "T", detail: "D" })).toBe("T: D");
    expect(problemText({ title: "T" })).toBe("T");
    expect(problemText({ detail: "x".repeat(500) })?.length).toBe(200);
    expect(problemText({})).toBeNull();
    expect(problemText(null)).toBeNull();
    expect(problemText("x")).toBeNull();
  });
});
