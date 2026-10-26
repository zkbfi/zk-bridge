import { Box, Flex, Heading, Stack, Text } from "@chakra-ui/react";
import { useEffect } from "react";
import { DOC_PAGES, findDocPage, type DocPage } from "../docs/docs-index";
import { MarkdownView } from "../docs/MarkdownView";
import { Notice } from "../ui/primitives";

/** Props of {@link DocsView}. */
export type DocsViewProps = {
  /** The slug of the page to show, or null for the first page. */
  readonly slug: string | null;
  /** The identifier of a heading to scroll to, or null. */
  readonly heading: string | null;
  /** Replaces the pages. Tests use it. */
  readonly pages?: readonly DocPage[];
};

/**
 * The Docs view: the user documentation, written as Markdown files in `explorer/web/docs/pages`. A list of the pages
 * sits beside the text. The palette searches the titles and the headings.
 *
 * @param props The page and the heading to show.
 */
export const DocsView = ({ slug, heading, pages = DOC_PAGES }: DocsViewProps) => {
  const page = slug === null ? (pages[0] ?? null) : findDocPage(slug, pages);

  useEffect(() => {
    if (heading === null) {
      window.scrollTo({ top: 0 });
      return;
    }
    document.getElementById(heading)?.scrollIntoView({ block: "start" });
  }, [page, heading]);

  if (page === null && slug === null) return <Notice tone="info">There are no documentation pages yet.</Notice>;
  if (page === null) return <Notice tone="warning">There is no documentation page called "{slug}".</Notice>;
  return (
    <Flex gap="6" direction={{ base: "column", md: "row" }} alignItems="flex-start">
      <Box as="nav" aria-label="Documentation pages" flexShrink="0" width={{ base: "100%", md: "14rem" }} position={{ base: "static", md: "sticky" }} top="4.5rem">
        <Heading as="h2" size="sm" marginBottom="2">
          Docs
        </Heading>
        <Stack as="ol" gap="1" listStyleType="none" margin="0" padding="0">
          {pages.map((entry) => (
            <li key={entry.slug}>
              <a href={`#/docs/${entry.slug}`} aria-current={entry.slug === page.slug ? "page" : undefined}>
                <Text as="span" fontWeight={entry.slug === page.slug ? "semibold" : "normal"} textDecoration={entry.slug === page.slug ? "none" : "underline"}>
                  {entry.title}
                </Text>
              </a>
            </li>
          ))}
        </Stack>
      </Box>
      <Box as="article" flex="1" minWidth="0" aria-label={page.title}>
        <MarkdownView blocks={page.blocks} />
      </Box>
    </Flex>
  );
};
