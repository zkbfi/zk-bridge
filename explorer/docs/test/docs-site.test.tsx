import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { DocsSite } from "../src/DocsSite";
import { collectPages } from "../src/pages";

const pages = collectPages({
  userPages: {
    "01-first.md": "# First\n\nThis page starts here. More.\n\nGo to [second](02-how-the-bridge-works.md#part).",
    "02-how-the-bridge-works.md": "# Second\n\nHow it works.\n\n## Part\n\ntext\n\n### Detail\n\nmore",
    "03-running-a-bot.md": "# Bots\n\nFor operators.",
  },
  operatorPages: {},
});
const show = () => render(<DocsSite pages={pages} />);
const goTo = (hash: string) =>
  act(() => {
    window.location.hash = hash;
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  });

beforeEach(() => {
  window.location.hash = "";
  document.documentElement.className = "";
});

describe("DocsSite", () => {
  it("has the app's landmarks: a skip link, the header with the mark home and the search, the main text and the footer", () => {
    show();
    expect(screen.getByRole("link", { name: "Skip to the text" })).toBeInTheDocument();
    expect(screen.getByRole("banner")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "zkb.fi docs, home" })).toHaveAttribute("href", "#/");
    expect(screen.getByRole("button", { name: /Search the docs/ })).toBeInTheDocument();
    expect(screen.getByRole("main")).toBeInTheDocument();
    expect(screen.getByRole("contentinfo")).toBeInTheDocument();
  });

  it("the skip link moves focus to the text without changing the route", () => {
    show();
    fireEvent.click(screen.getByRole("link", { name: "Skip to the text" }));
    expect(document.activeElement).toBe(screen.getByRole("main"));
    expect(window.location.hash).toBe("");
  });

  it("the front page shows the title on the band and the pages in groups, as rows with a description", () => {
    show();
    expect(screen.getByRole("heading", { level: 1, name: "Docs" })).toBeInTheDocument();
    expect(screen.getByTestId("page-name")).toHaveTextContent("Docs");
    expect(screen.getAllByRole("heading", { level: 2 }).map((heading) => heading.textContent)).toEqual(["Using the bridge1 page", "How it works and what you trust1 page", "Running it1 page"]);
    const row = screen.getByRole("link", { name: /First/ });
    expect(row).toHaveAttribute("href", "#/help/first");
    expect(row).toHaveTextContent("Starts here.");
    expect(document.title).toBe("zkb.fi docs");
  });

  it("leaves out a group with no pages", () => {
    render(<DocsSite pages={pages.filter((page) => page.section !== "run")} />);
    expect(screen.queryByRole("heading", { name: /Running it/ })).toBeNull();
  });

  it("a page shows its title on the band, a meta line, the contents, the text and the next and previous pages", () => {
    show();
    goTo("#/help/how-the-bridge-works");
    const article = screen.getByRole("article", { name: "Second" });
    expect(screen.getByRole("heading", { level: 1, name: "Second" })).toBeInTheDocument();
    expect(screen.getByText("1 min read · 1 section")).toBeInTheDocument();
    expect(screen.getByTestId("page-name")).toHaveTextContent("How it works");
    expect(within(article).getByRole("heading", { level: 2, name: "Part" })).toHaveAttribute("id", "part");
    const contents = screen.getAllByRole("navigation", { name: "On this page" });
    expect(contents).toHaveLength(2);
    expect(within(contents[0] as HTMLElement).getAllByRole("link").map((link) => link.getAttribute("href"))).toEqual(["#/help/how-the-bridge-works#part", "#/help/how-the-bridge-works#detail"]);
    const pager = screen.getByRole("navigation", { name: "Previous and next page" });
    expect(within(pager).getAllByRole("link").map((link) => [link.textContent, link.getAttribute("href")])).toEqual([
      ["PreviousFirst", "#/help/first"],
      ["NextBots", "#/help/running-a-bot"],
    ]);
    expect(document.title).toBe("Second · zkb.fi docs");
  });

  it("links between pages stay hash links", () => {
    show();
    goTo("#/help/first");
    expect(within(screen.getByRole("article")).getByRole("link", { name: "second" })).toHaveAttribute("href", "#/help/how-the-bridge-works#part");
  });

  it("moves focus to the title after a move to another page", () => {
    show();
    goTo("#/help/first");
    expect(document.activeElement).toBe(screen.getByRole("heading", { level: 1, name: "First" }));
  });

  it("says so when the page does not exist", () => {
    window.location.hash = "#/nowhere";
    show();
    expect(screen.getByText('There is no documentation page called "nowhere".')).toBeInTheDocument();
    expect(document.title).toBe("Not found · zkb.fi docs");
  });

  it("shows a notice when there are no pages", () => {
    render(<DocsSite pages={[]} />);
    expect(screen.getByText("No pages are published yet.")).toBeInTheDocument();
  });

  it("the theme switch sets the app's theme classes", () => {
    show();
    fireEvent.click(screen.getByRole("radio", { name: "Dark" }));
    expect(document.documentElement).toHaveClass("theme-ember-dark");
    fireEvent.click(screen.getByRole("radio", { name: "Mono" }));
    expect(document.documentElement).toHaveClass("theme-mono");
    expect(screen.getByRole("radio", { name: "Mono" })).toHaveAttribute("aria-checked", "true");
  });
});

describe("the search", () => {
  it("opens with the pill, Command K, Control K and slash, and makes the page inert while open", () => {
    show();
    fireEvent.click(screen.getByRole("button", { name: /Search the docs/ }));
    expect(screen.getByRole("dialog", { name: "Search the docs" })).toBeInTheDocument();
    expect(document.querySelector(".zd-page")).toHaveAttribute("inert");
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    for (const key of [{ key: "k", metaKey: true }, { key: "k", ctrlKey: true }, { key: "/" }]) {
      fireEvent.keyDown(document.body, key);
      expect(screen.getByRole("dialog")).toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "Close" }));
      expect(screen.queryByRole("dialog")).toBeNull();
    }
  });

  it("returns focus to the search pill when it closes", () => {
    show();
    const pill = screen.getByRole("button", { name: /Search the docs/ });
    pill.focus();
    fireEvent.click(pill);
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Escape" });
    expect(document.activeElement).toBe(pill);
  });

  it("lists the pages by group with no query, finds headings, and opens the chosen row with Enter", () => {
    show();
    fireEvent.click(screen.getByRole("button", { name: /Search the docs/ }));
    expect(screen.getAllByRole("option").map((option) => option.querySelector(".zb-palette-title")?.textContent)).toEqual(["First", "Second", "Bots"]);
    const field = screen.getByRole("combobox");
    fireEvent.change(field, { target: { value: "detail" } });
    expect(screen.getByRole("option", { selected: true })).toHaveTextContent("DetailSecond");
    fireEvent.keyDown(field, { key: "Enter" });
    expect(window.location.hash).toBe("#/help/how-the-bridge-works#detail");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("moves the highlight with the arrow keys", () => {
    show();
    fireEvent.click(screen.getByRole("button", { name: /Search the docs/ }));
    const field = screen.getByRole("combobox");
    fireEvent.keyDown(field, { key: "ArrowDown" });
    expect(screen.getByRole("option", { selected: true })).toHaveTextContent("Second");
    fireEvent.keyDown(field, { key: "End" });
    expect(screen.getByRole("option", { selected: true })).toHaveTextContent("Bots");
    expect(field).toHaveAttribute("aria-activedescendant", screen.getByRole("option", { selected: true }).id);
  });

  it("keeps Tab inside the dialog", () => {
    show();
    fireEvent.click(screen.getByRole("button", { name: /Search the docs/ }));
    const field = screen.getByRole("combobox");
    const home = screen.getByRole("button", { name: "Docs home" });
    home.focus();
    fireEvent.keyDown(home, { key: "Tab" });
    expect(document.activeElement).toBe(field);
    fireEvent.keyDown(field, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(home);
  });

  it("sets the theme from a search row", () => {
    show();
    fireEvent.click(screen.getByRole("button", { name: /Search the docs/ }));
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "theme mono" } });
    fireEvent.click(screen.getByRole("option", { name: /Theme: Mono/ }));
    expect(document.documentElement).toHaveClass("theme-mono");
  });
});
