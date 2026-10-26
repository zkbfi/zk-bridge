import { expect, test, type Page } from "@playwright/test";

const SHOT_DIRECTORY = "docs/screenshots";
const takeScreenshots = process.env.SCREENSHOTS === "1";

const shoot = async (page: Page, name: string): Promise<void> => {
  if (takeScreenshots) await page.screenshot({ path: `${SHOT_DIRECTORY}/${name}.png` });
};

test.beforeEach(async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" });
});

test("search jumps to a view, the bridge form tips by default, and the confirm dialog shows the maximum", async ({ page }) => {
  await page.goto("/#/pair/eth-pls");
  await expect(page.getByRole("heading", { name: "Summary" })).toBeVisible();
  await expect(page.getByRole("table", { name: "Transfers and messages" })).toBeVisible();
  await shoot(page, "pair-view");

  await page.keyboard.press("Control+K");
  await page.getByRole("combobox", { name: /^Search views/ }).fill("audit");
  await shoot(page, "palette-search");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "Audit" })).toBeVisible();
  await shoot(page, "audit-view");

  await page.goto("/#/pair/eth-pls");
  await page.getByRole("button", { name: "Connect wallet" }).click();
  await page.getByRole("button", { name: "Bridge tokens" }).click();
  const form = page.getByRole("form", { name: "Bridge tokens" });
  await form.getByLabel(/^Amount to send/).fill("250");
  await expect(form.getByTestId("bridge-fee")).toContainText("0.1% = 0.25 USDC");
  // The tip is on by default at 0.1 percent. Nothing to turn on.
  await expect(form.getByRole("radio", { name: /Percentage of the amount/ })).toBeChecked();
  await expect(form.getByTestId("delivery-summary")).toContainText("(exact)");
  await expect(form.getByTestId("tip-runner-notes")).toContainText("Only one whitelisted runner");
  await form.getByLabel(/^Your coin price/).fill("3000");
  await expect(form.getByTestId("delivery-data-source")).toContainText("measured from 40 recent deliveries, p90");
  await shoot(page, "bridge-form-delivery-fee");

  await form.getByRole("button", { name: "Review transaction" }).click();
  const dialog = page.getByRole("dialog", { name: "Review before you sign" });
  // The first step is the allowance. It already shows the fees of the relay that follows.
  await expect(dialog.getByText("Step 1 of 2")).toBeVisible();
  await expect(dialog.getByTestId("confirm-runner-maximum")).toContainText("The runner can take at most");
  await expect(dialog.getByTestId("confirm-tip-now")).toContainText("(exact)");
  await dialog.getByRole("button", { name: "Send to wallet" }).click();
  await expect(dialog.getByText("Step 2 of 2")).toBeVisible();
  await expect(dialog.getByTestId("confirm-runner-maximum")).toContainText("The runner can take at most");
  await shoot(page, "confirm-dialog");
  await dialog.getByRole("button", { name: "Send to wallet" }).click();
  await expect(dialog.getByText(/Done\./)).toBeVisible();
});

test("the docs open from the search and the page fits a narrow laptop", async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 800 });
  await page.goto("/#/");
  await expect(page.getByRole("heading", { name: "Global view" })).toBeVisible();
  await page.keyboard.press("/");
  await page.getByRole("combobox", { name: /^Search views/ }).fill("data source line");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("article", { name: "Fees explained" })).toBeVisible();
  const overflows = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
  expect(overflows).toBe(false);
  await shoot(page, "docs-view");

  await page.goto("/#/pair/eth-pls");
  await expect(page.getByRole("table", { name: "Transfers and messages" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)).toBe(false);
  await shoot(page, "pair-view-narrow");
});
