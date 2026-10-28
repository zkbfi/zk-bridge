import { Box, Flex, Heading, Stack, Text } from "@chakra-ui/react";
import { useEffect, useState } from "react";
import { MarkdownView } from "@web/docs/MarkdownView";
import { routeOf, type DocsSiteGroup, type DocsSitePage } from "./pages";
import { parseRoute } from "./route";

/** Props of {@link DocsSite}. */
export type DocsSiteProps = {
  readonly pages: readonly DocsSitePage[];
};

const GROUP_TITLES: Readonly<Record<DocsSiteGroup, string>> = { help: "Help", operator: "Operator guides" };
const GROUPS: readonly DocsSiteGroup[] = ["help", "operator"];

/** Follows the hash of the address, so the back button and a shared link both work. */
const useHash = (): string => {
  const [hash, setHash] = useState(() => window.location.hash);
  useEffect(() => {
    const update = () => setHash(window.location.hash);
    window.addEventListener("hashchange", update);
    return () => window.removeEventListener("hashchange", update);
  }, []);
  return hash;
};

/**
 * The documentation site: a list of pages beside the text of the chosen page. The page comes from the hash of the
 * address, so the site needs no server and loads from any path prefix.
 *
 * @param props The pages.
 */
export const DocsSite = ({ pages }: DocsSiteProps) => {
  const route = parseRoute(useHash());
  const page = route.id === "" ? (pages[0] ?? null) : (pages.find((candidate) => candidate.id === route.id) ?? null);

  useEffect(() => {
    document.title = page === null ? "zk-bridge documentation" : `${page.title} - zk-bridge documentation`;
    if (route.anchor === "") {
      window.scrollTo({ top: 0 });
      return;
    }
    document.getElementById(route.anchor)?.scrollIntoView({ block: "start" });
  }, [page, route.anchor]);

  return (
    <Flex gap="6" direction={{ base: "column", md: "row" }} alignItems="flex-start" padding="4" maxWidth="72rem" marginX="auto">
      <Box as="nav" aria-label="Documentation pages" flexShrink="0" width={{ base: "100%", md: "16rem" }} position={{ base: "static", md: "sticky" }} top="4">
        {GROUPS.map((group) => (
          <Box key={group} marginBottom="4">
            <Heading as="h2" size="sm" marginBottom="2">
              {GROUP_TITLES[group]}
            </Heading>
            <Stack as="ol" gap="1" listStyleType="none" margin="0" padding="0">
              {pages
                .filter((entry) => entry.group === group)
                .map((entry) => (
                  <li key={entry.id}>
                    <a href={routeOf(entry.id, "")} aria-current={entry.id === page?.id ? "page" : undefined}>
                      <Text as="span" fontWeight={entry.id === page?.id ? "semibold" : "normal"} textDecoration={entry.id === page?.id ? "none" : "underline"}>
                        {entry.title}
                      </Text>
                    </a>
                  </li>
                ))}
            </Stack>
          </Box>
        ))}
      </Box>
      <Box as="article" flex="1" minWidth="0" aria-label={page?.title ?? "Not found"}>
        {page === null ? <Text>{`There is no documentation page called "${route.id}".`}</Text> : <MarkdownView blocks={page.blocks} />}
      </Box>
    </Flex>
  );
};
