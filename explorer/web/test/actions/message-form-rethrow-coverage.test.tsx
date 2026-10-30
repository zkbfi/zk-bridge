import { StatefulMessageForm } from "../support/stateful";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Component, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { FIXTURE_PAIR } from "@terminal/data/fixtures";
import { renderPage } from "../render";

vi.mock("@terminal/app/actions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@terminal/app/actions")>()),
  buildMessageSteps: () => {
    throw new TypeError("a defect of the planner");
  },
}));

class Catcher extends Component<{ readonly children: ReactNode }, { readonly message: string | null }> {
  override state = { message: null as string | null };
  static getDerivedStateFromError(error: Error) {
    return { message: error.message };
  }
  override render() {
    return this.state.message === null ? this.props.children : <p role="alert">{this.state.message}</p>;
  }
}

describe("the message form with a planner that fails for a reason other than the input", () => {
  it("does not hide the defect as a form problem: the error reaches the boundary of the page", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    renderPage(
      <Catcher>
        <StatefulMessageForm pair={FIXTURE_PAIR} onReview={() => undefined} />
      </Catcher>,
    );
    await userEvent.click(screen.getByLabelText(/^Target contract on/));
    await userEvent.paste(`0x${"cd".repeat(20)}`);
    expect(await screen.findByRole("alert")).toHaveTextContent("a defect of the planner");
  });
});
