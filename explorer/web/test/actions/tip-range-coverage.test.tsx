import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DEFAULT_DELIVERY_OPTIONS } from "../../src/tx/bridge-draft";
import { TipRange } from "../../src/actions/DeliveryFeeSection";
import { renderPage } from "../render";

describe("the suggested tip range", () => {
  it("shows nothing when the range cannot be computed, because there is nothing honest to suggest", () => {
    renderPage(<TipRange range={{ kind: "unavailable", reason: "the margin must be above zero" }} token={{ symbol: "TKN", decimals: 18 }} options={DEFAULT_DELIVERY_OPTIONS} onChange={() => undefined} />);
    expect(screen.queryByTestId("tip-range")).toBeNull();
  });
});
