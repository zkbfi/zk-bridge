import { ChakraProvider, defaultSystem } from "@chakra-ui/react";
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MarkdownView } from "../../src/docs/MarkdownView";
import { parseMarkdown } from "../../src/docs/markdown";

const show = (source: string) => render(<ChakraProvider value={defaultSystem}><MarkdownView blocks={parseMarkdown(source)} /></ChakraProvider>);

describe("MarkdownView", () => {
  it("renders each heading level as its own element with the identifier for links", () => {
    show("# One\n## Two words\n### Three\n#### Four");
    expect(screen.getByRole("heading", { level: 1, name: "One" })).toHaveAttribute("id", "one");
    expect(screen.getByRole("heading", { level: 2, name: "Two words" })).toHaveAttribute("id", "two-words");
    expect(screen.getByRole("heading", { level: 3, name: "Three" })).toHaveAttribute("id", "three");
    expect(screen.getByRole("heading", { level: 4, name: "Four" })).toHaveAttribute("id", "four");
  });

  it("renders bold, italic and code inline marks as strong, em and code elements", () => {
    const { container } = show("a **b** *c* `d` e");
    expect(container.querySelector("strong")).toHaveTextContent("b");
    expect(container.querySelector("em")).toHaveTextContent("c");
    expect(container.querySelector("p code")).toHaveTextContent("d");
    expect(container.querySelector("p")).toHaveTextContent("a b c d e");
  });

  it("renders a quote, a code block, and lists in the right element", () => {
    const { container } = show("> quoted\n\n```\nlet x = 1;\n```\n\n- a\n- b\n\n1. c");
    expect(screen.getByText("quoted")).toBeInTheDocument();
    expect(container.querySelector("pre code")).toHaveTextContent("let x = 1;");
    expect(within(container.querySelector("ul")!).getAllByRole("listitem").map((item) => item.textContent)).toEqual(["a", "b"]);
    expect(within(container.querySelector("ol")!).getAllByRole("listitem").map((item) => item.textContent)).toEqual(["c"]);
  });

  it("renders a table with column headers and body cells", () => {
    show("| Name | **Value** |\n|---|---|\n| x | `1` |\n| y | 2 |");
    expect(screen.getAllByRole("columnheader").map((cell) => cell.textContent)).toEqual(["Name", "Value"]);
    expect(screen.getAllByRole("row")).toHaveLength(3);
    expect(screen.getAllByRole("cell").map((cell) => cell.textContent)).toEqual(["x", "1", "y", "2"]);
  });

  it("never turns text into markup", () => {
    const { container } = show("<img src=x onerror=alert(1)>");
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toContain("<img src=x onerror=alert(1)>");
  });
});

describe("MarkdownView links", () => {
  it("renders a link as an anchor with its address, and opens an https address safely", () => {
    show("[inside](#part) and [outside](https://example.org/x)");
    expect(screen.getByRole("link", { name: "inside" })).toHaveAttribute("href", "#part");
    expect(screen.getByRole("link", { name: "inside" })).not.toHaveAttribute("target");
    expect(screen.getByRole("link", { name: "outside" })).toHaveAttribute("href", "https://example.org/x");
    expect(screen.getByRole("link", { name: "outside" })).toHaveAttribute("rel", "noopener noreferrer");
  });

  it("renders a javascript: link as plain text", () => {
    const { container } = show("[x](javascript:alert(1))");
    expect(screen.queryByRole("link")).toBeNull();
    expect(container.textContent).toContain("javascript:alert(1");
  });
});
