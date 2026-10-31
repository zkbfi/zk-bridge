import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { parseMarkdown } from "@web/docs/markdown";
import { DocsMarkdown, isWarning } from "../src/DocsMarkdown";
import { searchDocs } from "../src/docs-search";
import { collectPages } from "../src/pages";

const show = (source: string) => render(<DocsMarkdown blocks={parseMarkdown(source)} />);

describe("DocsMarkdown", () => {
  it("leaves the title to the band and draws the headings with their ids", () => {
    show("# Title\n\n## Part one\n\n### Small");
    expect(screen.queryByRole("heading", { level: 1 })).toBeNull();
    expect(screen.getByRole("heading", { level: 2, name: "Part one" })).toHaveAttribute("id", "part-one");
    expect(screen.getByRole("heading", { level: 3, name: "Small" })).toHaveAttribute("id", "small");
  });

  it("draws a quote as a note, and as a warning when it opens with a warning word", () => {
    show("> A plain note.\n\n> **Warning:** keys stay in the wallet.");
    const [note, warning] = screen.getAllByRole("note");
    expect(note).not.toHaveClass("zd-warn");
    expect(warning).toHaveClass("zd-callout", "zd-warn");
    const quote = parseMarkdown("> Never share the key.")[0];
    expect(quote?.kind === "quote" && isWarning(quote.children)).toBe(true);
  });

  it("collapses three or more leading zeros in table numbers, right-aligns numeric cells, and keeps the full value for screen readers", () => {
    const { container } = show("| Cost | Note |\n|---|---|\n| 0.0001234 | about 0.0042 |");
    expect(container.querySelector("td.zd-num")).not.toBeNull();
    expect(screen.getByLabelText("0.0001234")).toHaveTextContent("0.031234");
    expect(container.querySelector("sub")?.textContent).toBe("3");
    expect(screen.getByText("about 0.0042")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Table" })).toHaveAttribute("tabindex", "0");
  });

  it("an https link leaves without the referrer; a route stays a hash link; code blocks can take focus to scroll", () => {
    show("[out](https://example.org) and [in](#/help/safety)\n\n```\ncode\n```");
    expect(screen.getByRole("link", { name: "out" })).toHaveAttribute("rel", "noopener noreferrer");
    expect(screen.getByRole("link", { name: "in" })).toHaveAttribute("href", "#/help/safety");
    expect(screen.getByText("code").closest("pre")).toHaveAttribute("tabindex", "0");
  });
});

describe("searchDocs", () => {
  const pages = collectPages({
    userPages: { "01-fees.md": "# Fees explained\n\nAbout the tip.\n\n## The tip for delivery\n\nx", "02-safety.md": "# Safety\n\nWhat you trust.\n\n## Fees and you\n\ny" },
    operatorPages: {},
  });

  it("with no query lists the pages by group", () => {
    expect(searchDocs("", pages).map((group) => [group.title, group.results.map((result) => result.title)])).toEqual([
      ["Using the bridge", ["Fees explained"]],
      ["How it works and what you trust", ["Safety"]],
    ]);
  });

  it("finds pages and headings by every word, title matches first", () => {
    const groups = searchDocs("fee", pages);
    expect(groups.map((group) => group.id)).toEqual(["pages", "headings"]);
    expect(groups[0]?.results.map((result) => result.href)).toEqual(["#/help/fees"]);
    expect(groups[1]?.results.map((result) => [result.title, result.href])).toEqual([
      ["Fees and you", "#/help/safety#fees-and-you"],
      ["The tip for delivery", "#/help/fees#the-tip-for-delivery"],
    ]);
    expect(searchDocs("tip delivery", pages).flatMap((group) => group.results.map((result) => result.title))).toEqual(["The tip for delivery"]);
    expect(searchDocs("nothing like this", pages)).toEqual([]);
  });

  it("offers the themes", () => {
    expect(searchDocs("dark", pages).find((group) => group.id === "themes")?.results.map((result) => result.theme)).toEqual(["dark"]);
  });
});
