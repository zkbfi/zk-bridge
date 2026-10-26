import { db } from "ponder:api";
import schema from "ponder:schema";
import { Hono } from "hono";
import { client, graphql } from "ponder";
import { registerDeliveryCostRoutes } from "./routes/delivery-cost";
import { registerFeedRoutes } from "./routes/feed";
import { registerStateRoutes } from "./routes/state";
import { registerSummaryRoutes } from "./routes/summary";

const app = new Hono();

// The generic read interfaces of Ponder: GraphQL, and SQL over HTTP for `@ponder/client`.
app.use("/graphql", graphql({ db, schema }));
app.use("/sql/*", client({ db, schema }));

// The routes of the explorer. See explorer/indexer/README.md for the contract.
registerDeliveryCostRoutes(app);
registerFeedRoutes(app);
registerStateRoutes(app);
registerSummaryRoutes(app);

export default app;
