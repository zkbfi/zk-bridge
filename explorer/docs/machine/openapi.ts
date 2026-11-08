/**
 * OpenAPI 3.1 descriptions of the public HTTP routes of the indexer and the backend, written to
 * `/data/openapi/indexer.json` and `/data/openapi/backend.json`.
 *
 * The route code binds to the Ponder runtime and to the storage of the backend, so it cannot be loaded here. The
 * documents are written out instead, and `test/machine-openapi.test.ts` reads the route code and fails when a route
 * exists in the code and not here (or the other way round). The routes that take no part in the public API are named in
 * {@link BACKEND_INTERNAL_ROUTES}.
 */
import { MESSAGE_STATUSES } from "../../data/src/status.ts";

type Json = Record<string, unknown>;

/** An OpenAPI document, as far as the tests and the build read it. */
export type OpenApiDocument = {
  readonly openapi: "3.1.0";
  readonly info: { readonly title: string; readonly version: string; readonly description: string };
  readonly servers: readonly { readonly url: string; readonly description: string }[];
  readonly paths: Record<string, Record<string, Json>>;
  readonly components?: { readonly schemas?: Record<string, Json> };
};

/** The routes of the backend code that the document leaves out, as `method path`. */
export const BACKEND_INTERNAL_ROUTES: readonly string[] = ["post /webhook/jobs/{jobId}"];

const DIRECTIONS = ["first-to-second", "second-to-first"] as const;
const HASH = { type: "string", pattern: "^0x[0-9a-fA-F]{64}$" };
const ADDRESS = { type: "string", pattern: "^0x[0-9a-fA-F]{40}$" };
const ref = (name: string): Json => ({ $ref: `#/components/schemas/${name}` });
const json = (schema: Json, description: string): Json => ({ description, content: { "application/json": { schema } } });
const errorResponse = (description: string): Json => json(ref("Error"), description);

const query = (name: string, description: string, schema: Json = { type: "string" }): Json => ({ name, in: "query", required: false, description, schema });
const path = (name: string, description: string, schema: Json = { type: "string" }): Json => ({ name, in: "path", required: true, description, schema });

const open = (description: string): Json => ({ type: "object", description, additionalProperties: true });
const list = (key: string, item: Json, extra: Json = {}): Json => ({ type: "object", required: [key], properties: { [key]: { type: "array", items: item }, ...extra }, additionalProperties: true });

const get = (summary: string, description: string, parameters: Json[], ok: Json, extra: Json = {}): Json => ({
  summary,
  description,
  parameters,
  responses: { "200": ok, ...extra },
});

const ERROR_SCHEMA: Json = { type: "object", required: ["error"], properties: { error: { type: "string" } }, additionalProperties: true };

/** The OpenAPI document of the indexer (`explorer/indexer`, routes under `/api`). */
export const buildIndexerSpec = (): OpenApiDocument => {
  const direction = query("direction", 'A direction written source chain id, then ">" or "-", then destination chain id, such as 1>369 or 1-369.');
  const feedFilters = [
    direction,
    query("kind", "token transfers or plain messages.", { type: "string", enum: ["token", "message"] }),
    query("status", "A comma list of message statuses.", { type: "string", description: `Statuses: ${MESSAGE_STATUSES.join(", ")}.` }),
    query("token", "A token address on either chain.", ADDRESS),
    query("address", "A sender or recipient address.", ADDRESS),
    query("from", "Earliest send time, Unix seconds.", { type: "string", pattern: "^\\d+$" }),
    query("to", "Latest send time, Unix seconds.", { type: "string", pattern: "^\\d+$" }),
  ];
  const limit = (maximum: number, fallback: number): Json => query("limit", `Rows per page, 1 to ${maximum} (default ${fallback}).`, { type: "integer", minimum: 1, maximum, default: fallback });
  const cursor = query("cursor", "The nextCursor of the previous page.");
  const offset = query("offset", "Rows to skip, for paging.", { type: "integer", minimum: 0, default: 0 });
  const asOf = query("asOf", "Only rows sent or posted at or before this Unix second. Pass the asOf of the first page so new rows do not shift the pages.", { type: "integer", minimum: 0 });
  const notFound = { "404": errorResponse("Nothing stored under that identifier.") };
  const badRequest = { "400": errorResponse("A parameter is invalid; error names it.") };
  const archiveOff = { "503": errorResponse("The proof archive is off or its database cannot be reached.") };
  const chainId = query("chainId", "Only this chain.", { type: "integer" });
  const now = query("now", "Replaces the clock with this Unix time in seconds. For tests.", { type: "integer" });

  return {
    openapi: "3.1.0",
    info: {
      title: "zkb.fi indexer API",
      version: "1",
      description:
        "Read-only chain data of one bridge pair: messages, transfers, light client heads, gate events, tokens, costs and the proof archive. Everything here is public chain data and none of it is a trusted answer: verify what matters against the chains.",
    },
    servers: [{ url: "/", description: "The origin of the indexer you use. Each pair has its own indexer; GET /api/pair names the pair." }],
    paths: {
      "/api/pair": { get: get("The pair this indexer serves", "Names the pair, its two chains and their contracts.", [], json(open("The pair."), "The pair.")) },
      "/api/summary": { get: get("Dashboard summary", "Heads, gates, in-flight counts, the last day's volume and the newest head updates.", [now], json(open("The summary."), "The summary.")) },
      "/api/heads": { get: get("Light client heads", "The stored head of each light client.", [], json(list("heads", open("One head.")), "The heads.")) },
      "/api/head-updates": {
        get: get("Light client head updates", "Stored head updates, newest first.", [chainId, query("before", "Only slots below this slot.", { type: "string", pattern: "^\\d+$" }), limit(500, 50)], json(open("The updates."), "The updates.")),
      },
      "/api/light-client-costs": { get: get("Light client update costs", "What head updates cost per chain and per poster.", [], json(open("Costs per chain and per poster."), "The costs.")) },
      "/api/gate": { get: get("Gate events", "Events of the gate contracts, newest first.", [limit(500, 50)], json(open("The gate events."), "The events.")) },
      "/api/registry": { get: get("Fork registry observations", "What the fork registry on PulseChain recorded.", [], json(open("The observations."), "The observations.")) },
      "/api/tokens": { get: get("Tokens", "Every token the bridge has seen, with its bridged copy.", [], json(list("tokens", open("One token.")), "The tokens.")) },
      "/api/audit": { get: get("Escrow and supply audit", "For each token, what the mediator holds against what the bridged copy has in supply.", [], json(open("The audit."), "The audit.")) },
      "/api/escrow": { get: get("Escrow and bridged supply", "The amounts locked in the mediators and the supply of bridged copies.", [], json(open("Escrow and bridgedSupply."), "The amounts.")) },
      "/api/release-events": {
        get: get("Release events", "Unlocks and mints for an address.", [query("address", "Recipient address.", ADDRESS), limit(500, 50)], json(open("The release events."), "The events."), badRequest),
      },
      "/api/feed": {
        get: get("Transfer and message feed", "Sent messages and their transfers, newest first.", [...feedFilters, limit(200, 50), cursor], json(ref("MessagePage"), "A page of items."), badRequest),
      },
      "/api/counts": { get: get("All-time counts", "Totals over the whole tables: messages per status, direction and kind, in flight, light client updates and tokens per chain, unique addresses, contracts, gates and escrow entries. Cached for ten seconds.", [], json(open("The counts."), "The counts.")) },
      "/api/browse/messages": {
        get: get(
          "Browse messages and transfers",
          "A page of messages and transfers with the total that match, filtered and sorted by the indexer. Items are as in the feed.",
          [
            ...feedFilters,
            query("sender", "The account that sent the tokens, or the sender of a plain message.", ADDRESS),
            query("recipient", "The account that receives the tokens, or is paid.", ADDRESS),
            query("sort", "Order. Amounts are in base units, so sort by amount with a token filter.", { type: "string", enum: ["newest", "oldest", "amount-high", "amount-low"], default: "newest" }),
            limit(200, 50),
            offset,
            asOf,
          ],
          json(list("items", ref("Message"), { total: { type: "integer" }, limit: { type: "integer" }, offset: { type: "integer" }, asOf: { type: "integer" } }), "A page of items."),
          badRequest,
        ),
      },
      "/api/browse/proofs": {
        get: get(
          "Browse light client updates",
          "A page of light client updates, each with its number on its chain, and the total that match.",
          [chainId, query("poster", "Who posted the update.", ADDRESS), query("from", "Earliest time, Unix seconds.", { type: "string", pattern: "^\\d+$" }), query("to", "Latest time, Unix seconds.", { type: "string", pattern: "^\\d+$" }), query("sort", "Order.", { type: "string", enum: ["newest", "oldest", "slot-high", "slot-low"], default: "newest" }), limit(200, 50), offset, asOf],
          json(open("items, total, limit, offset and asOf."), "A page of updates."),
          badRequest,
        ),
      },
      "/api/browse/tokens": {
        get: get(
          "Browse tokens",
          "A page of tokens, each with the transfers that name it, and the total that match.",
          [chainId, query("kind", "Native tokens or bridged copies.", { type: "string", enum: ["native", "copy"] }), query("sort", "Order.", { type: "string", enum: ["symbol", "transfers"], default: "symbol" }), limit(200, 50), offset],
          json(open("items, total, limit, offset and asOf."), "A page of tokens."),
          badRequest,
        ),
      },
      "/api/browse/addresses": {
        get: get(
          "Browse addresses",
          "A page of the accounts that sent, received or posted, with what each did, and the total that match.",
          [query("role", "Only accounts with this role.", { type: "string", enum: ["sender", "recipient", "poster"] }), query("q", "The start of an address, in hex."), query("sort", "Order.", { type: "string", enum: ["activity", "recent"], default: "activity" }), limit(200, 50), offset],
          json(open("items, total, limit, offset and asOf."), "A page of addresses."),
          badRequest,
        ),
      },
      "/api/messages/{messageId}": {
        get: get("One message", "A message with its transfer, data and the step costs.", [path("messageId", "32 byte message identifier.", HASH)], json(ref("Message"), "The message, with its data and step costs."), { ...badRequest, ...notFound }),
      },
      "/api/history": {
        get: get(
          "History of sends, deliveries and head updates",
          "Sends, deliveries and stored heads of both chains in one list, newest first. A filter on kind, status, token or address leaves head updates out.",
          [...feedFilters, query("chain", "Events that happened on this chain.", { type: "integer" }), query("eventKind", "One kind of event.", { type: "string", enum: ["sent", "delivered", "head-update"] }), limit(200, 50), cursor],
          json(ref("Page"), "A page of events."),
          badRequest,
        ),
      },
      "/api/search": {
        get: get(
          "Cross-referenced search",
          "What a text is (address, transaction hash, message identifier, token), with typed results and links. Reads only the indexer's own tables.",
          [{ ...query("q", "The text to look up (at most 200 characters)."), required: true }, query("limit", "Results per type.", { type: "integer", minimum: 1 })],
          json(open("candidates, results and problems."), "The answer."),
          badRequest,
        ),
      },
      "/api/delivered": { get: get("Delivered messages and timing", "Per direction: deliveries in the last 24 hours and 7 days, the value delivered and how long deliveries took.", [now], json(open("Directions and timing."), "The figures.")) },
      "/api/undelivered": {
        get: get(
          "Messages waiting for delivery",
          "Messages a stored head covers that nobody has delivered, oldest first. The work list of the evidence archive.",
          [direction, query("after", "The nextCursor of the previous page."), limit(500, 100)],
          json(list("items", open("One message."), { nextCursor: { type: ["string", "null"] } }), "A page of items."),
          badRequest,
        ),
      },
      "/api/tx/{chainId}/{hash}": {
        get: get("Cost of one transaction", "What a stored send, delivery or light client update cost, in wei and in dollars.", [path("chainId", "Chain id.", { type: "integer" }), path("hash", "Transaction hash.", HASH)], json(open("The cost."), "The cost."), { ...badRequest, ...notFound }),
      },
      "/api/delivery-cost": {
        get: get("Measured delivery gas", "Gas used by recent deliveries by kind, and the latest base fee. It holds no proof cost.", [{ ...chainId, required: true }], json(open("The report."), "The report."), badRequest),
      },
      "/api/proofs/storage/{chainId}/{address}/{block}": {
        get: get("Archived storage proofs", "Archived eth_getProof answers of one account in one block. A reader verifies each against a header it trusts.", [path("chainId", "Chain id.", { type: "integer" }), path("address", "Account address.", ADDRESS), path("block", "Block number.", { type: "integer" })], json(list("entries", open("One proof.")), "The proofs."), { ...badRequest, ...notFound, ...archiveOff }),
      },
      "/api/proofs/light-client/{direction}": {
        get: get(
          "Archived light client proofs",
          "Light client update proofs, newest start first.",
          [path("direction", "Proof direction.", { type: "string", enum: [...DIRECTIONS] }), query("startSlot", "Only proofs that start at this slot.", { type: "string", pattern: "^\\d+$" }), limit(500, 50)],
          json(list("proofs", open("One proof.")), "The proofs."),
          { ...badRequest, ...archiveOff },
        ),
      },
      "/api/proofs/evidence/{messageId}": {
        get: get("Archived delivery evidence", "The delivery evidence archived for a message.", [path("messageId", "32 byte message identifier.", HASH)], json(list("evidence", open("One piece of evidence.")), "The evidence."), { ...badRequest, ...notFound, ...archiveOff }),
      },
      "/api/proofs/summary": { get: get("Proof archive row counts", "How many rows the archive holds.", [], json(open("Counts."), "The counts."), archiveOff) },
    },
    components: {
      schemas: {
        Error: ERROR_SCHEMA,
        Page: list("items", open("One item."), { nextCursor: { type: ["string", "null"], description: "Pass as cursor for the next page; null on the last page." } }),
        MessagePage: list("items", ref("Message"), { nextCursor: { type: ["string", "null"], description: "Pass as cursor for the next page; null on the last page." } }),
        Message: {
          type: "object",
          description: "A message with its direction, steps and, for a token message, its transfer.",
          properties: { messageId: HASH, kind: { type: "string", enum: ["token", "message"] }, status: { type: "string", enum: [...MESSAGE_STATUSES] }, transfer: { oneOf: [ref("Transfer"), { type: "null" }] } },
          additionalProperties: true,
        },
        Transfer: {
          type: "object",
          description:
            "The token side of a message. Amounts are decimal strings of base units. When the mediator paid a delivery router, the delivery fee fields say what the router received, what went to the deliverer and what the recipient received; they are null for a transfer that no router delivered, and until the delivery.",
          properties: {
            value: { type: ["string", "null"], description: "Locked or burned on the source chain." },
            deliveredValue: { type: ["string", "null"], description: "Paid by the mediator on the destination chain (to the router, for a router delivery)." },
            paidTo: { oneOf: [ADDRESS, { type: "null" }], description: "The account that the mediator paid." },
            deliveryRouter: { oneOf: [ADDRESS, { type: "null" }], description: "The delivery router that the mediator paid." },
            routerAmount: { type: ["string", "null"], description: "What the router received and could deliver." },
            fee: { type: ["string", "null"], description: "The delivery fee to the deliverer, in the destination token; null when it cannot be known (a gas based fee of an older router paid in the native coin)." },
            received: { type: ["string", "null"], description: "What the recipient received after the fee; 0 when the router handed the amount off." },
            deliverer: { oneOf: [ADDRESS, { type: "null" }], description: "The account that received the fee (the router's reward address); null when no fee was paid." },
            finalRecipient: { oneOf: [ADDRESS, { type: "null" }], description: "The account that the router paid." },
            feeSource: {
              type: ["string", "null"],
              enum: ["event", "logs", "terms", null],
              description: "event: the router's Delivered event. logs: the token transfers from the router in the delivery transaction (routers without the event). terms: an older router's native payout, with the fee from the sender's terms.",
            },
          },
          additionalProperties: true,
        },
      },
    },
  };
};

/** The OpenAPI document of the backend (proof requests, progress, evidence). */
export const buildBackendSpec = (): OpenApiDocument => {
  const directionPath = path("direction", "Proof direction.", { type: "string", enum: [...DIRECTIONS] });
  const messageId = path("messageId", "32 byte message identifier.", HASH);
  const tooMany = { "429": json(ref("RateLimited"), "Too many requests; Retry-After says when to ask again.") };
  return {
    openapi: "3.1.0",
    info: {
      title: "zkb.fi backend API",
      version: "1",
      description:
        "Proof requests and the progress of a transfer: ask for a light client proof, watch a message or a direction move through the proving pipeline, and fetch archived delivery evidence. The proof webhook the prover calls is authenticated and not part of this description. Times are milliseconds since 1970; slots are decimal text.",
    },
    servers: [{ url: "/", description: "The origin of the backend you use. Every route answers Access-Control-Allow-Origin: *." }],
    paths: {
      "/health": { get: get("Health", "Module states, the queue length and the newest job of each direction.", [], json(ref("Health"), "The report.")) },
      "/requests": {
        post: {
          summary: "Ask for a proof",
          description: "Asks the backend to prove the next light client head for a direction. The backend may refuse because nothing needs proving or because the asker is rate limited.",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["pair", "direction", "reason"],
                  properties: {
                    pair: { type: "string", description: "The pair this backend serves, such as sepolia-pls943." },
                    direction: { type: "string", enum: [...DIRECTIONS] },
                    reason: { type: "string", enum: ["message", "keep-alive", "user"] },
                    messageId: { ...HASH, description: "The message that waits for the proof, when there is one." },
                  },
                  additionalProperties: true,
                },
              },
            },
          },
          responses: {
            "202": json(open("requestId and jobId."), "Accepted."),
            "400": errorResponse("The body is not valid, or names another pair."),
            "409": errorResponse("Nothing to prove now; asking again changes nothing."),
            "413": errorResponse("The body is too large."),
            ...tooMany,
            "503": json(ref("RateLimited"), "The chains cannot be checked now; retryAfterSeconds says when to ask again."),
          },
        },
      },
      "/requests/{id}": { get: get("State of a request", "The request and the job behind it.", [path("id", "The requestId from POST /requests.")], json(open("The request with its job."), "The request."), { "404": errorResponse("No such request.") }) },
      "/directions/{direction}": { get: get("Newest proof job of a direction", "The active job, or the latest one.", [directionPath], json(open("direction and job (null when none)."), "The job."), { "404": errorResponse("Unknown direction.") }) },
      "/directions/{direction}/pipeline": { get: get("Proving pipeline of a direction", "The stages of the next proof: head, decision, job, latest proof, and the rule that starts a proof (rule: minIntervalSeconds, lookaheadSeconds, profitMargin, proofCostUsd, priced).", [directionPath], json(open("The pipeline."), "The pipeline."), { "404": errorResponse("Unknown direction."), ...tooMany }) },
      "/progress/{messageId}": {
        get: get("Progress of one transfer", "Which stage a message is in, what it waits on and an estimate.", [messageId], json(open("The stages with status done, current or pending."), "The progress."), { "400": errorResponse("Not a message identifier."), "404": errorResponse("Unknown message."), ...tooMany, "503": errorResponse("The chain indexer is not configured or cannot be read.") }),
      },
      "/benchmarks": {
        get: get("Proving timings", "Median and 90th percentile of each pipeline step over a window.", [query("window", "A number and m, h or d, from 1h to 30d.", { type: "string", default: "24h" })], json(open("Steps per direction."), "The timings."), { "400": errorResponse("Invalid window."), ...tooMany }),
      },
      "/billing": {
        get: get(
          "GPU billing",
          "What RunPod billed for GPU time, per UTC day (`byDay`) and in total (`total`): `billedUsd`, `billedSeconds` and `effectiveUsdPerHour`, null for a day RunPod has no figure for. `last24h` holds the last 24 hours. The price of a GPU hour is measured from RunPod's billing (amount divided by billed hours over the last 7 days): `rateSource` is `runpod`, and `usdPerHour` is that rate. Only when RunPod's billing cannot be read is `rateSource` `assumed`, and `usdPerHour` the configured price (`assumptions.gpuUsdPerHour`, a fallback). `assumptions.idleTimeoutSeconds` is the idle timeout the backend is configured to set on the RunPod endpoint, and `assumptions.endpointIdleTimeoutSeconds` is what RunPod reported for the endpoint when the backend started (null if unknown). `ageSeconds` says how old the reading is (RunPod is read at most every 10 minutes, and the last good reading is kept when a read fails). `account` (`balanceUsd`, `balanceAgeSeconds`, `spendNowUsdPerHour`, `spendLimitUsd`, `daysLeft` at the 7-day average `averageDailyUsd7d`) is filled only for requests that reach the backend directly; through the public host its fields are null. `earlyStarts`, on each day and in the total, is the part of the bill that workers started before a proof account for: `sessions`, `used`, `unused`, `unusedSeconds`, `unusedUsd` (at `usdPerHour`) and `waitingSeconds` (seconds a worker sat ready before the due time in used sessions). `breakdown`, on each day, in the total and in `last24h`, puts every billed second in one bucket, each `{ seconds, usd }` (USD at `usdPerHour`): `proving` (GPU time of proof jobs, from the start of the request on the worker to the proof returned), `startingUp` (cold start before a worker can take work: early-start sessions from start to ready, and the wait of jobs that met no ready worker), `waitingForProof` (a started worker ready and idle until its proof began), `unusedEarlyStarts` (the billed seconds of sessions with no proof), `idleAfterJob` (the idle timeout after each job, not counted again where a later job or session overlaps) and `unaccounted` (RunPod's billed seconds and USD minus the five others; negative when our records claim more than was billed; null for a period RunPod has no figure for). An instant counts in one bucket only, so the six add up to the RunPod figures of the period (`billedSeconds`, `billedUsd`). In the total, the buckets cover every day of the answer, and `unaccounted` adds the days that have RunPod figures. Records of early-start sessions are kept 7 days, so earlier days show none.",
          [query("days", "Days to report, 1 to 30.", { type: "integer", default: 7 })],
          json(open("Billing per day, the total and the early starts."), "The billing."),
          { "400": errorResponse("Invalid days."), ...tooMany },
        ),
      },
      "/warmup/summary": {
        get: {
          ...get("Early-start spending (deprecated)", "Deprecated: the old name of `/billing`, kept with its old body (worker sessions per day with `wasted` fields, and RunPod's `billing` beside them). Use `/billing`.", [query("days", "Days to report, 1 to 30.", { type: "integer", default: 7 })], json(open("Daily totals and the sum."), "The summary."), { "400": errorResponse("Invalid days."), ...tooMany }),
          deprecated: true,
        },
      },
      "/archive/proofs": { get: get("Archived proof rows", "The proofs the backend archived.", [], json(open("The rows."), "The rows.")) },
      "/evidence/{messageId}": { get: get("Delivery evidence", "The archived evidence of a delivery, as JSON.", [messageId], json(open("The evidence."), "The evidence."), { "400": errorResponse("Not a message identifier."), "404": errorResponse("No evidence for this message.") }) },
      "/proofs/latest/{direction}": {
        get: get(
          "Latest valid proof of a direction",
          "The newest proof that starts at the light client's current head. The head may move after the read, so read it again before posting.",
          [directionPath],
          json(ref("LatestProof"), "The proof."),
          { "404": errorResponse("Unknown direction, or nothing usable is kept."), "503": errorResponse("The module cannot tell; try again later. This does not mean there is no proof.") },
        ),
      },
    },
    components: {
      schemas: {
        Error: ERROR_SCHEMA,
        RateLimited: { type: "object", required: ["error"], properties: { error: { type: "string" }, retryAfterSeconds: { type: "number" } }, additionalProperties: true },
        Health: {
          type: "object",
          required: ["status", "time", "modules", "queue", "lastJobs"],
          properties: {
            status: { const: "ok" },
            time: { type: "number" },
            modules: { type: "object", additionalProperties: { type: "object", required: ["state"], properties: { state: { type: "string", enum: ["running", "not built", "degraded"] }, detail: { type: "string" } } } },
            queue: { type: "object", required: ["length"], properties: { length: { type: "number" } } },
            lastJobs: { type: "object", additionalProperties: true },
          },
          additionalProperties: true,
        },
        LatestProof: {
          type: "object",
          required: ["pair", "direction", "programKey", "startSlot", "startRoot", "newSlot", "newRoot", "publicValues", "proof"],
          properties: {
            pair: { type: "string" },
            direction: { type: "string", enum: [...DIRECTIONS] },
            programKey: HASH,
            startSlot: { type: "string", pattern: "^\\d+$" },
            startRoot: HASH,
            newSlot: { type: "string", pattern: "^\\d+$" },
            newRoot: HASH,
            publicValues: { type: "string", pattern: "^0x[0-9a-fA-F]*$" },
            proof: { type: "string", pattern: "^0x[0-9a-fA-F]*$" },
          },
          additionalProperties: true,
        },
      },
    },
  };
};
