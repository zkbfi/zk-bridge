import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import DocsPage from "../src/DocsPage";
import { DocsSite, shortcutOf } from "../src/DocsSite";
import { collectPages, SITE_PAGES } from "../src/pages";

const pagesOf = (files: Record<string, string>) => collectPages({ userPages: files, operatorPages: {} });
const two = pagesOf({ "01-a.md": "# A\n\nFirst page here.\n\n## One\n\nx\n\n## Two\n\ny", "02-b.md": "# B\n\nSecond page." });

beforeEach(() => {
  window.location.hash = "";
});
afterEach(() => vi.restoreAllMocks());

describe("the search shortcut", () => {
  it("is Command K on Apple platforms, read from the platform and then the user agent, and Control K elsewhere", () => {
    expect(shortcutOf("MacIntel", "x")).toBe("⌘K");
    expect(shortcutOf("iPhone", "x")).toBe("⌘K");
    expect(shortcutOf("", "Mozilla (iPad; CPU OS)")).toBe("⌘K");
    expect(shortcutOf("Win32", "Mac")).toBe("Ctrl K");
    expect(shortcutOf("", "Linux")).toBe("Ctrl K");
  });
});

describe("DocsPage", () => {
  it("draws the site over the real pages: the front page, and a page by its slug", () => {
    const { unmount } = render(<DocsPage slug={null} heading={null} />);
    expect(screen.getByRole("heading", { level: 1, name: "Docs" })).toBeInTheDocument();
    expect(screen.getAllByRole("link").some((link) => link.getAttribute("href") === `#/docs/${SITE_PAGES[0]?.slug}`)).toBe(true);
    unmount();
    render(<DocsPage slug={SITE_PAGES[0]?.slug as string} heading={null} />);
    expect(screen.getByRole("heading", { level: 1, name: SITE_PAGES[0]?.title })).toBeInTheDocument();
  });
});

describe("the front page and a page", () => {
  it("counts the pages of a group, in the singular and the plural", () => {
    render(<DocsSite pages={two} slug={null} heading={null} />);
    expect(screen.getByText("2 pages")).toBeInTheDocument();
    cleanupAndShow(pagesOf({ "01-a.md": "# A\n\nx" }));
    expect(screen.getByText("1 page")).toBeInTheDocument();
  });

  const cleanupAndShow = (list: typeof two) => {
    document.body.innerHTML = "";
    render(<DocsSite pages={list} slug={null} heading={null} />);
  };

  it("says how many sections a page has, in the singular and the plural, and links the neighbours that exist", () => {
    render(<DocsSite pages={two} slug="a" heading={null} />);
    expect(screen.getByText("1 min read · 2 sections")).toBeInTheDocument();
    const pager = screen.getByRole("navigation", { name: "Previous and next page" });
    expect(within(pager).getAllByRole("link").map((link) => link.textContent)).toEqual(["NextB"]);
  });

  it("draws no pager for a page that has no neighbour", () => {
    render(<DocsSite pages={pagesOf({ "01-a.md": "# A\n\nx" })} slug="a" heading={null} />);
    expect(screen.queryByRole("navigation", { name: "Previous and next page" })).toBeNull();
    expect(screen.queryByRole("navigation", { name: "On this page" })).toBeNull();
  });

  it("draws only the previous link for the last page", () => {
    render(<DocsSite pages={two} slug="b" heading={null} />);
    const pager = screen.getByRole("navigation", { name: "Previous and next page" });
    expect(within(pager).getAllByRole("link").map((link) => link.textContent)).toEqual(["PreviousA"]);
  });
});

describe("the heading the address names", () => {
  it("takes focus on a heading, which gets a tabindex so it can", () => {
    render(<DocsSite pages={two} slug="a" heading="two" />);
    const heading = screen.getByRole("heading", { level: 2, name: "Two" });
    expect(heading).toHaveAttribute("tabindex", "-1");
    expect(document.activeElement).toBe(heading);
  });

  it("leaves a tabindex that is already there, and an element that takes focus by itself", () => {
    const { unmount } = render(<DocsSite pages={two} slug="a" heading="page-title" />);
    expect(screen.getByRole("heading", { level: 1 })).toHaveAttribute("tabindex", "-1");
    expect(document.activeElement).toBe(screen.getByRole("heading", { level: 1 }));
    unmount();
    const button = document.createElement("button");
    button.id = "native";
    document.body.append(button);
    render(<DocsSite pages={two} slug="a" heading="native" />);
    expect(button.hasAttribute("tabindex")).toBe(false);
    expect(document.activeElement).toBe(button);
    button.remove();
  });

  it("does nothing for a heading that is not on the page", () => {
    render(<DocsSite pages={two} slug="a" heading="nowhere" />);
    expect(screen.getByRole("heading", { level: 1, name: "A" })).toBeInTheDocument();
    expect(document.activeElement).toBe(document.body);
  });
});

describe("the current heading while scrolling", () => {
  it("marks the last heading above a quarter of the window, measuring on the next frame and once per frame", () => {
    const frames: (() => void)[] = [];
    const request = vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => frames.push(() => callback(0)));
    render(<DocsSite pages={two} slug="a" heading={null} />);
    const marked = () => screen.getAllByRole("link", { current: "location" }).map((link) => link.textContent);
    expect(marked()).toEqual(["Two", "Two"]);
    fireEvent.scroll(window);
    fireEvent.scroll(window);
    expect(request).toHaveBeenCalledTimes(1);
    act(() => frames[0]?.());
    fireEvent.scroll(window);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("marks no heading before any has reached the top, and cancels a pending frame when it unmounts", () => {
    const cancel = vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);
    vi.spyOn(window, "requestAnimationFrame").mockReturnValue(42);
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({ top: 900 } as DOMRect);
    const { unmount } = render(<DocsSite pages={two} slug="a" heading={null} />);
    expect(screen.queryAllByRole("link", { current: "location" })).toEqual([]);
    fireEvent.scroll(window);
    unmount();
    expect(cancel).toHaveBeenCalledWith(42);
  });

  it("cancels nothing when no frame is pending", () => {
    const cancel = vi.spyOn(window, "cancelAnimationFrame");
    render(<DocsSite pages={two} slug="a" heading={null} />).unmount();
    expect(cancel).not.toHaveBeenCalled();
  });
});

describe("the search from the keyboard", () => {
  it("opens from an element that is not an HTML element, ignores a second press while open", () => {
    render(<DocsSite pages={two} slug={null} heading={null} />);
    const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    icon.setAttribute("tabindex", "0");
    document.body.append(icon);
    icon.focus();
    expect(document.activeElement).toBe(icon);
    fireEvent.keyDown(document.body, { key: "k", ctrlKey: true });
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    fireEvent.keyDown(document.body, { key: "k", ctrlKey: true });
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    icon.remove();
  });

  it("types a slash into a field without opening the search, and ignores other keys", () => {
    render(<DocsSite pages={two} slug={null} heading={null} />);
    const field = document.createElement("textarea");
    document.body.append(field);
    fireEvent.keyDown(field, { key: "/" });
    fireEvent.keyDown(document.body, { key: "x" });
    fireEvent.keyDown(document.body, { key: "/", altKey: true });
    expect(screen.queryByRole("dialog")).toBeNull();
    field.remove();
  });
});

describe("the search sheet", () => {
  const open = (list = two) => {
    render(<DocsSite pages={list} slug={null} heading={null} />);
    fireEvent.click(screen.getByRole("button", { name: /Search the docs/ }));
    return screen.getByRole("combobox");
  };

  it("says nothing matches, has no active row, and Enter opens nothing", () => {
    const field = open();
    fireEvent.change(field, { target: { value: "zzzzqq" } });
    expect(screen.getByText(/Nothing matches/)).toBeInTheDocument();
    expect(screen.queryAllByRole("option")).toEqual([]);
    expect(field).not.toHaveAttribute("aria-activedescendant");
    fireEvent.keyDown(field, { key: "Enter" });
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(window.location.hash).toBe("");
  });

  it("shows a row without a subtitle as its title alone", () => {
    const field = open(pagesOf({ "01-a.md": "# Bare\n\n## Part\n\n- x" }));
    fireEvent.change(field, { target: { value: "bare" } });
    const rows = screen.getAllByRole("option");
    expect(rows.map((row) => [row.querySelector(".zb-palette-title")?.textContent, row.querySelector(".zb-palette-sub")?.textContent ?? null])).toEqual([
      ["Bare", null],
      ["Part", "Bare"],
    ]);
  });

  it("moves the highlight with the mouse, and opens the docs home from the footer", () => {
    open();
    const rows = screen.getAllByRole("option");
    fireEvent.mouseMove(rows[1] as HTMLElement);
    expect(screen.getByRole("option", { selected: true })).toBe(rows[1]);
    fireEvent.click(screen.getByRole("button", { name: "Docs home" }));
    expect(window.location.hash).toBe("#/docs");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("leaves Tab alone away from the ends of the dialog", () => {
    const field = open();
    const close = screen.getByRole("button", { name: "Close" });
    field.focus();
    fireEvent.keyDown(field, { key: "Tab" });
    expect(document.activeElement).toBe(field);
    close.focus();
    fireEvent.keyDown(close, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(close);
    fireEvent.keyDown(field, { key: "a" });
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
});
