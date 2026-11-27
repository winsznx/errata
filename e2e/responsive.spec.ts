import { expect, test } from "@playwright/test";

test("landing and workspace fit a phone screen without sideways scrolling", async ({ page }) => {
  await page.goto("/");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  await page.goto("/demo");
  await page.getByRole("button", { name: "Start this workspace" }).click();
  await page.waitForURL(/\/w\//);
  await expect(page.getByRole("button", { name: /Menu/ })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
});
