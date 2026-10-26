import { screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseDocPages } from "../../src/docs/docs-index";
import { DocsView } from "../../src/views/DocsView";
import { renderPage } from "../render";

const pages = parseDocPages({ "/d/01-one.md": "# Page one\n\nText.\n\n## First heading\n\nMore.\n" });

afterEach(() => vi.restoreAllMocks());

describe("the docs view, edge cases", () => {
  it("says that there are no pages, and names no page, when the list is empty and no slug is asked for", () => {
    renderPage(<DocsView slug={null} heading={null} pages={[]} />);
    expect(screen.getByRole("status")).toHaveTextContent("There are no documentation pages yet.");
    expect(screen.getByRole("status")).not.toHaveTextContent("called");
  });

  it("scrolls to the top when the route names no heading", () => {
    const scrollTo = vi.spyOn(window, "scrollTo").mockImplementation(() => undefined);
    renderPage(<DocsView slug="one" heading={null} pages={pages} />);
    expect(scrollTo).toHaveBeenCalledWith({ top: 0 });
  });

  it("does not fail when the heading of the route is not on the page", () => {
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    renderPage(<DocsView slug="one" heading="no-such-heading" pages={pages} />);
    expect(scrollIntoView).not.toHaveBeenCalled();
    expect(screen.getByRole("article", { name: "Page one" })).toBeInTheDocument();
  });
});
