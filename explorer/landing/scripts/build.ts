/**
 * Builds the landing page: type-stripped JavaScript, the page, and the settings baked into `main.js`.
 *
 * LANDING_CONFIG  the settings file, relative to explorer/landing (default landing.config.json, production;
 *                 landing.next.config.json is the staging site next.zkb.fi, which trusts only the staging key)
 * LANDING_SNAPSHOT_DIR  a directory with snapshot-light.webp, snapshot-dark.webp and snapshot.json ({"width","height"}),
 *                 made by script/release/snapshot.sh. When all three are there they are copied into the site and the
 *                 page shows them; otherwise the page has no snapshot block. A snapshot-og.jpg (1200x630) beside them,
 *                 with "siteUrl" in the settings, becomes the og:image and twitter:image of the page; without it the
 *                 page has no such tags.
 * LANDING_OUT     the output directory (default dist/)
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildLanding, optionsFromEnvironment } from "./build-landing.ts";

await buildLanding(optionsFromEnvironment(process.env, join(dirname(fileURLToPath(import.meta.url)), "..")));
