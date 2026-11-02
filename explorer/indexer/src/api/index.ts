import { db } from "ponder:api";
import schema from "ponder:schema";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { client, graphql } from "ponder";
import { registerDeliveredRoute } from "./routes/delivered";
import { registerDeliveryCostRoutes } from "./routes/delivery-cost";
import { registerFeedRoutes } from "./routes/feed";
import { registerHistoryRoute } from "./routes/history";
import { registerProofRoutes } from "./routes/proofs";
import { registerSearchRoute } from "./routes/search";
import { registerStateRoutes } from "./routes/state";
import { registerSummaryRoutes } from "./routes/summary";
import { registerTransactionRoutes } from "./routes/transactions";
import { registerUndeliveredRoute } from "./routes/undelivered";
import { pair } from "../lib/pair";
import { startArchiverFromEnvironment } from "../proof-archive/archiver";

const app = new Hono();

// A dapp page loaded from an IPFS gateway reads this indexer from another origin, so every route answers with
// `Access-Control-Allow-Origin: *`. Every route only reads and nothing reads a login from the browser, so a wildcard
// origin gives away nothing. GraphQL clients post their queries, hence POST.
app.use(
  "*",
  cors({
    origin: "*",
    allowMethods: ["GET", "POST", "OPTIONS"],
    allowHeaders: ["Content-Type"],
    maxAge: 86_400,
  }),
);

// The generic read interfaces of Ponder: GraphQL, and SQL over HTTP for `@ponder/client`.
app.use("/graphql", graphql({ db, schema }));
app.use("/sql/*", client({ db, schema }));

// The routes of the explorer. See explorer/indexer/README.md for the contract.
registerDeliveredRoute(app);
registerDeliveryCostRoutes(app);
registerFeedRoutes(app);
registerHistoryRoute(app);
registerProofRoutes(app);
registerSearchRoute(app);
registerStateRoutes(app);
registerSummaryRoutes(app);
registerTransactionRoutes(app);
registerUndeliveredRoute(app);

// The proof archive (src/proof-archive): it fetches storage proofs at epoch boundaries and takes the backend's held
// proofs, beside the indexing. Off without DATABASE_URL or with PROOF_ARCHIVE=off. It never stops the API.
void startArchiverFromEnvironment(pair);

export default app;
