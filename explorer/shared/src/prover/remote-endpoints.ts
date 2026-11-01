import { z } from "zod";

/** The most endpoints that the prover accepts in `prover.remote_endpoints` (`MAX_REMOTE_ENDPOINTS` in the prover). */
export const MAX_REMOTE_ENDPOINTS = 8;

/** The label rule of the prover: 1 to 32 lower case letters, digits, `-` or `_`, starting with a letter or a digit. */
const LABEL = /^[a-z0-9][a-z0-9_-]{0,31}$/;

/** The rule of the prover for the name of an environment variable: capitals, digits and `_`, starting with a capital. */
const VARIABLE = /^[A-Z][A-Z0-9_]{0,63}$/;

function isLoopback(url: URL): boolean {
  return url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
}

/**
 * One proving endpoint of the remote backend, in the JSON of the backend and the bots. The prover tries the endpoints in
 * the order of the list: a dedicated worker first, a serverless endpoint as the fallback (`docs/gpu-prover.md`,
 * "Endpoint list"). The entry holds the NAME of the variable with the key, never the key.
 */
export const remoteEndpointSchema = z
  .object({
    /** The name of the endpoint in the logs, such as `dedicated` or `serverless`. The logs never show the URL. */
    label: z.string().regex(LABEL, "must be 1 to 32 lower case letters, digits, '-' or '_'"),
    /** The base URL of the worker. A plain http address is allowed only without a key, or on the local machine. */
    url: z.url({ protocol: /^https?$/ }),
    /** The NAME of the variable that holds the API key. Leave it out for a worker that checks no key. */
    apiKeyVariable: z.string().regex(VARIABLE, "must be the NAME of an environment variable in capitals").optional(),
    /** The longest wait for a worker that is not ready yet. Short for a dedicated worker. Default: the prover's 900 s. */
    readyWaitSeconds: z.number().int().nonnegative().optional(),
    /** The time one request may take. Default: the time of the generated file. */
    timeoutSeconds: z.number().int().positive().optional(),
    /** How often the job is sent to this endpoint before the prover moves on. Default: the attempts of the generated file. */
    attempts: z.number().int().positive().optional(),
  })
  .strict()
  .refine((endpoint) => endpoint.apiKeyVariable === undefined || new URL(endpoint.url).protocol === "https:" || isLoopback(new URL(endpoint.url)), {
    message: "must use https when the endpoint has an API key (http only on the local machine): the key travels in the request",
    path: ["url"],
  });

/** One proving endpoint. */
export type RemoteEndpoint = z.infer<typeof remoteEndpointSchema>;

/** A list of proving endpoints in priority order, with unique labels. */
export const remoteEndpointListSchema = z
  .array(remoteEndpointSchema)
  .min(1)
  .max(MAX_REMOTE_ENDPOINTS)
  .refine((endpoints) => new Set(endpoints.map((endpoint) => endpoint.label)).size === endpoints.length, { message: "every endpoint needs its own label" });

/** The label that the prover gives the single endpoint of `remote_url`. */
export const SINGLE_ENDPOINT_LABEL = "remote";

/** The distinct names of the variables that the endpoints read their keys from, in list order. */
export function endpointKeyVariables(endpoints: readonly RemoteEndpoint[]): string[] {
  return [...new Set(endpoints.flatMap((endpoint) => (endpoint.apiKeyVariable === undefined ? [] : [endpoint.apiKeyVariable])))];
}
