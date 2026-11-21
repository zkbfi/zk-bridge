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

  it("draws ordered and unordered lists with inline code, bold, italic and links inside the items", () => {
    const { container } = show("- one `code`\n- **bold** and *italic*\n\n1. first\n2. [link](#/docs/safety)");
    const [bullets, steps] = [container.querySelector("ul.zd-list"), container.querySelector("ol.zd-list")];
    expect(bullets?.querySelectorAll("li")).toHaveLength(2);
    expect(bullets?.querySelector("code.zd-code")?.textContent).toBe("code");
    expect(bullets?.querySelector("strong")?.textContent).toBe("bold");
    expect(bullets?.querySelector("em")?.textContent).toBe("italic");
    expect(steps?.querySelectorAll("li")).toHaveLength(2);
    expect(steps?.querySelector("a")).toHaveAttribute("href", "#/docs/safety");
  });

  it("keeps text around a collapsed number in a table cell, and formats numbers inside bold and italic", () => {
    const { container } = show("| A | B |\n|---|---|\n| costs 0.0001234 now | **0.00005** and *0.0007* |");
    const cells = container.querySelectorAll("td");
    expect(cells[0]?.textContent).toContain("costs ");
    expect(cells[0]?.textContent).toContain(" now");
    expect(cells[0]?.querySelectorAll("sub")).toHaveLength(1);
    expect(cells[1]?.querySelectorAll("strong sub, em sub")).toHaveLength(2);
    expect(cells[1]?.textContent).toContain(" and ");
  });

  it("draws a table that has a header and no rows", () => {
    const { container } = show("| A | B |\n|---|---|\n");
    expect(container.querySelectorAll("th")).toHaveLength(2);
    expect(container.querySelectorAll("td")).toHaveLength(0);
  });

  it("an https link leaves without the referrer; a route stays a hash link; code blocks can take focus to scroll", () => {
    show("[out](https://example.org) and [in](#/docs/safety)\n\n```\ncode\n```");
    expect(screen.getByRole("link", { name: "out" })).toHaveAttribute("rel", "noopener noreferrer");
    expect(screen.getByRole("link", { name: "out" })).toHaveAttribute("target", "_blank");
    expect(screen.getByRole("link", { name: "in" })).not.toHaveAttribute("target");
    expect(screen.getByRole("link", { name: "in" })).toHaveAttribute("href", "#/docs/safety");
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
    expect(groups[0]?.results.map((result) => result.href)).toEqual(["#/docs/fees"]);
    expect(groups[1]?.results.map((result) => [result.title, result.href])).toEqual([
      ["Fees and you", "#/docs/safety/fees-and-you"],
      ["The tip for delivery", "#/docs/fees/the-tip-for-delivery"],
    ]);
    expect(searchDocs("tip delivery", pages).flatMap((group) => group.results.map((result) => result.title))).toEqual(["The tip for delivery"]);
    expect(searchDocs("nothing like this", pages)).toEqual([]);
  });

  it("ranks a title that holds the word inside another word below one where it starts a word, and keeps the page order on a tie", () => {
    const made = collectPages({ userPages: { "01-a.md": "# Cheese\n\nx", "02-b.md": "# Ees notes\n\nx", "03-c.md": "# Ees again\n\nx" }, operatorPages: {} });
    expect(searchDocs("ees", made)[0]?.results.map((result) => result.title)).toEqual(["Ees notes", "Ees again", "Cheese"]);
  });

  it("offers the themes", () => {
    expect(searchDocs("dark", pages).find((group) => group.id === "themes")?.results.map((result) => result.theme)).toEqual(["dark"]);
  });
});
