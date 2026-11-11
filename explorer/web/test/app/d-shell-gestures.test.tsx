import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { FIXTURE_PAIR } from "@terminal/data/fixtures";
import { Shell } from "../../src/app/Shell";
import { connectedWallet, disconnectedWallet, renderWithWallet } from "./support";

beforeEach(() => {
  window.localStorage.clear();
});

const renderAt = async (hash: string) => {
  window.history.replaceState(null, "", hash);
  const view = renderWithWallet(<Shell />, { wallet: connectedWallet() });
  await waitFor(() => expect(view.container.querySelector(".zb")).not.toBeNull());
  return view.container.querySelector(".zb") as HTMLElement;
};

const touch = (x: number, y: number) => ({ clientX: x, clientY: y });

describe("the sideways slide: arrow keys at the ends and away from the three screens", () => {
  it("stays on Activity when the left arrow has nowhere to go", async () => {
    await renderAt("#/activity");
    await userEvent.keyboard("{ArrowLeft}");
    expect(window.location.hash).toBe("#/activity");
  });

  it("stays on Explore when the right arrow has nowhere to go", async () => {
    await renderAt("#/explore");
    await userEvent.keyboard("{ArrowRight}");
    expect(window.location.hash).toBe("#/explore");
  });

  it("does nothing on a page that is not one of the three screens", async () => {
    await renderAt("#/audit");
    await userEvent.keyboard("{ArrowRight}");
    expect(window.location.hash).toBe("#/audit");
  });
});

describe("the sideways slide: swipes", () => {
  it("moves to Explore on a long swipe to the left, and back to Bridge on a long swipe to the right", async () => {
    const root = await renderAt(`#/bridge/${FIXTURE_PAIR.id}`);
    fireEvent.touchStart(root, { touches: [touch(300, 100)] });
    fireEvent.touchEnd(root, { changedTouches: [touch(150, 110)] });
    await waitFor(() => expect(window.location.hash).toBe("#/explore"));
    fireEvent.touchStart(root, { touches: [touch(100, 100)] });
    fireEvent.touchEnd(root, { changedTouches: [touch(250, 100)] });
    await waitFor(() => expect(window.location.hash).toBe(`#/bridge/${FIXTURE_PAIR.id}`));
  });

  it("ignores a short swipe and a mostly vertical one", async () => {
    const root = await renderAt(`#/bridge/${FIXTURE_PAIR.id}`);
    const before = window.location.hash;
    fireEvent.touchStart(root, { touches: [touch(300, 100)] });
    fireEvent.touchEnd(root, { changedTouches: [touch(260, 100)] });
    fireEvent.touchStart(root, { touches: [touch(300, 100)] });
    fireEvent.touchEnd(root, { changedTouches: [touch(180, 300)] });
    expect(window.location.hash).toBe(before);
  });

  it("ignores an end without a start, and a start without a finger", async () => {
    const root = await renderAt(`#/bridge/${FIXTURE_PAIR.id}`);
    const before = window.location.hash;
    fireEvent.touchEnd(root, { changedTouches: [touch(0, 0)] });
    fireEvent.touchStart(root, { touches: [] });
    fireEvent.touchEnd(root, { changedTouches: [touch(0, 0)] });
    fireEvent.touchStart(root, { touches: [touch(300, 100)] });
    fireEvent.touchEnd(root, { changedTouches: [] });
    expect(window.location.hash).toBe(before);
  });
});

describe("the search band of Explore", () => {
  it("writes the typed text into the address without adding a history entry", async () => {
    await renderAt("#/explore");
    const before = window.history.length;
    await userEvent.type(await screen.findByRole("combobox", { name: "Search Explore" }), "abc");
    await waitFor(() => expect(window.location.hash).toBe("#/explore?q=abc"));
    expect(window.history.length).toBe(before);
  });
});

describe("the links the shell repairs or refuses", () => {
  it("says so, and shows the default pair, when the address asks for a pair this build does not have", async () => {
    await renderAt("#/bridge/no-such-pair");
    expect(await screen.findByRole("status")).toHaveTextContent(`no-such-pair isn't available here; showing ${FIXTURE_PAIR.label}`);
    expect(window.location.hash).toContain(`#/bridge/${FIXTURE_PAIR.id}`);
  });

  it("moves a link that names the native coin as native to the zero-address form", async () => {
    await renderAt(`#/bridge/${FIXTURE_PAIR.id}?bridge.token=native`);
    await waitFor(() => expect(window.location.hash).not.toMatch(/bridge\.token=native(&|$)/));
    expect(window.location.hash).toMatch(/bridge\.token=first(:|%3A)0x0{40}/);
  });

  it("shows a page of Explore in its own frame, with no slide", async () => {
    const root = await renderAt("#/explore/slot/1");
    expect(root.querySelector(".zb-slide-left, .zb-slide-right")).toBeNull();
    expect(window.location.hash).toBe("#/explore/slot/1");
  });
});

describe("a bridge link opened without a wallet", () => {
  it("still opens the bridge with the amount of the link", async () => {
    window.history.replaceState(null, "", `#/bridge/${FIXTURE_PAIR.id}?bridge.amount=1.5`);
    renderWithWallet(<Shell />, { wallet: disconnectedWallet() });
    expect(await screen.findByRole("region", { name: /You send from/ })).toBeInTheDocument();
    expect(await screen.findByDisplayValue("1.5")).toBeInTheDocument();
  });
});
