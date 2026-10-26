import { Box, Code, Heading, Table, Text } from "@chakra-ui/react";
import type { ReactNode } from "react";
import type { Block, Inline } from "./markdown";

const renderInline = (items: readonly Inline[], keyPrefix: string): ReactNode =>
  items.map((item, index) => {
    const key = `${keyPrefix}-${index}`;
    if (item.kind === "text") return item.text;
    if (item.kind === "code") return <Code key={key}>{item.text}</Code>;
    if (item.kind === "bold") return <strong key={key}>{renderInline(item.children, key)}</strong>;
    return <em key={key}>{renderInline(item.children, key)}</em>;
  });

const HEADING_SIZES = { 1: "xl", 2: "lg", 3: "md", 4: "sm" } as const;

const renderBlock = (block: Block, index: number): ReactNode => {
  const key = `block-${index}`;
  if (block.kind === "heading") {
    return (
      <Heading key={key} as={`h${block.level}`} id={block.id} size={HEADING_SIZES[block.level]} marginTop={block.level === 1 ? "0" : "5"} marginBottom="2" scrollMarginTop="4rem">
        {block.text}
      </Heading>
    );
  }
  if (block.kind === "paragraph") return <Text key={key} marginBottom="3" lineHeight="tall">{renderInline(block.children, key)}</Text>;
  if (block.kind === "quote") return <Box key={key} borderLeftWidth="3px" borderColor="border" paddingLeft="3" marginBottom="3" color="fg.muted">{renderInline(block.children, key)}</Box>;
  if (block.kind === "code") return <Box key={key} as="pre" overflowX="auto" padding="3" marginBottom="3" backgroundColor="bg.muted" borderRadius="md" fontSize="sm"><code>{block.text}</code></Box>;
  if (block.kind === "list") {
    return (
      <Box key={key} as={block.ordered ? "ol" : "ul"} paddingLeft="6" marginBottom="3" lineHeight="tall">
        {block.items.map((item, itemIndex) => (
          <li key={`${key}-${itemIndex}`}>{renderInline(item, `${key}-${itemIndex}`)}</li>
        ))}
      </Box>
    );
  }
  return (
    <Box key={key} overflowX="auto" marginBottom="3">
      <Table.Root size="sm">
        <Table.Header>
          <Table.Row>
            {block.header.map((cellItems, cellIndex) => (
              <Table.ColumnHeader key={`${key}-h-${cellIndex}`} scope="col">
                {renderInline(cellItems, `${key}-h-${cellIndex}`)}
              </Table.ColumnHeader>
            ))}
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {block.rows.map((row, rowIndex) => (
            <Table.Row key={`${key}-r-${rowIndex}`}>
              {row.map((cellItems, cellIndex) => (
                <Table.Cell key={`${key}-r-${rowIndex}-${cellIndex}`}>{renderInline(cellItems, `${key}-r-${rowIndex}-${cellIndex}`)}</Table.Cell>
              ))}
            </Table.Row>
          ))}
        </Table.Body>
      </Table.Root>
    </Box>
  );
};

/**
 * Renders the blocks of a documentation page as React elements.
 *
 * @param props The blocks.
 */
export const MarkdownView = ({ blocks }: { readonly blocks: readonly Block[] }) => <Box maxWidth="46rem">{blocks.map(renderBlock)}</Box>;
