import { Badge } from "@chakra-ui/react";
import { useSyncExternalStore } from "react";
import type { ConnectionRuntime } from "@terminal/data/connection-runtime";
import { useServices } from "./services";

const INDEXER_LABEL = "indexer";

/** Props of {@link SourceBadgeView}. */
export type SourceBadgeViewProps = { readonly runtime: ConnectionRuntime };

/**
 * The badge for a live page. It follows the source that answers now. Its text is `indexer`, or `RPC fallback:` and the
 * reason. A fallback has the warning tone, so the colour and the words both say that the data comes from the chains.
 *
 * @param props The connection runtime.
 */
export const SourceBadgeView = ({ runtime }: SourceBadgeViewProps) => {
  const label = useSyncExternalStore(runtime.subscribe, () => runtime.redact(runtime.source().label));
  const fallback = label !== INDEXER_LABEL;
  return (
    <Badge
      colorPalette={fallback ? "orange" : "gray"}
      variant="subtle"
      maxWidth={{ base: "9rem", md: "20rem" }}
      truncate
      aria-label={`Data source: ${label}`}
      title={label}
      flexShrink={0}
    >
      {label}
    </Badge>
  );
};

/** The badge of the top bar. A fixture page has no connection, so it shows nothing. */
export const SourceBadge = () => {
  const { connection } = useServices();
  return connection === null ? null : <SourceBadgeView runtime={connection} />;
};
