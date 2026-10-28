import { ChakraProvider, defaultSystem } from "@chakra-ui/react";
import { act, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DocsSite } from "../src/DocsSite";
import { collectPages } from "../src/pages";

const pages = collectPages({
  userPages: { "01-first.md": "# First\n\nGo to [second](02-second.md#part).", "02-second.md": "# Second\n\n## Part\n\ntext" },
  operatorPages: { "tools.md": "# Tools\n\nbody" },
});
const show = () => render(<ChakraProvider value={defaultSystem}><DocsSite pages={pages} /></ChakraProvider>);
const goTo = (hash: string) => act(() => { window.location.hash = hash; window.dispatchEvent(new HashChangeEvent("hashchange")); });

describe("DocsSite", () => {
  it("shows the first page at the front, with both groups in the list", () => {
    window.location.hash = "";
    show();
    expect(screen.getByRole("article", { name: "First" })).toBeInTheDocument();
    expect(screen.getAllByRole("link").map((link) => link.getAttribute("href"))).toEqual(["#/help/first", "#/help/second", "#/tools", "#/help/second#part"]);
    expect(screen.getByRole("heading", { level: 2, name: "Operator guides" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "First" })).toHaveAttribute("aria-current", "page");
  });

  it("follows the hash, scrolls to a heading and sets the title", () => {
    window.location.hash = "";
    show();
    goTo("#/help/second#part");
    expect(screen.getByRole("article", { name: "Second" })).toBeInTheDocument();
    expect(document.title).toBe("Second - zk-bridge documentation");
  });

  it("says so when the page does not exist", () => {
    window.location.hash = "#/nowhere";
    show();
    expect(screen.getByText('There is no documentation page called "nowhere".')).toBeInTheDocument();
  });

  it("shows a notice and the plain title when there are no pages", () => {
    window.location.hash = "";
    render(<ChakraProvider value={defaultSystem}><DocsSite pages={[]} /></ChakraProvider>);
    expect(document.title).toBe("zk-bridge documentation");
  });
});
