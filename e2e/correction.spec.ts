import { expect, test } from "@playwright/test";

test.describe("landing and demo", () => {
  test("landing explains the product and starts the demo", async ({ page }) => {
    // #given
    await page.goto("/");
    // #then
    await expect(page.getByRole("heading", { level: 1 })).toContainText("When financial facts change");
    const text = await page.locator("body").innerText();
    expect(text).not.toContain("—");
    await expect(page.getByRole("link", { name: /Run the Nocera correction/ })).toHaveAttribute("href", "/demo");
  });

  test("the demo page says when the hosted model's daily budget is used up", async ({ page }) => {
    // #given
    const until = new Date(Date.now() + 30 * 60_000).toISOString();
    await page.route("**/api/v1/ready", (route) => route.fulfill({ json: { data: { model: { provider: "groq", id: "openai/gpt-oss-120b", configured: true, limit: { window: "day", until } } } } }));
    // #when
    await page.goto("/demo");
    // #then
    await expect(page.getByRole("status").filter({ hasText: "daily token budget is used up" })).toBeVisible();
  });

  test("a demo workspace opens with three synthetic notes and live updates", async ({ page }) => {
    // #given
    await page.goto("/demo");
    // #when
    await page.getByRole("button", { name: "Start this workspace" }).click();
    await page.waitForURL(/\/w\//);
    // #then
    await expect(page.getByText("Live", { exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: /Nocera Q1 2025/ }).first()).toBeVisible();
    await expect(page.getByRole("link", { name: /The Joint Corp/ }).first()).toBeVisible();
  });

  test("the agent runtime page shows the Mozaik participants and shared state", async ({ page }) => {
    // #given
    await page.goto("/demo");
    await page.getByRole("button", { name: "Start this workspace" }).click();
    await page.waitForURL(/\/w\//);
    // #when
    await page.goto(`${new URL(page.url()).pathname}/runtime`);
    // #then
    await expect(page.getByRole("heading", { name: "Shared state" })).toBeVisible();
    await expect(page.getByText(/Active loops:/)).toBeVisible();
    await expect(page.getByRole("listitem").filter({ hasText: "Financial Verifier" })).toBeVisible();
  });

  test("a figure in a note opens its filing evidence", async ({ page }) => {
    // #given
    await page.goto("/demo");
    await page.getByRole("button", { name: "Start this workspace" }).click();
    await page.waitForURL(/\/w\//);
    await page.getByRole("link", { name: /Nocera Q1 2025/ }).first().click();
    // #when
    await page.getByRole("button", { name: /\$1,275,416: Total current assets/ }).click();
    // #then
    await expect(page.getByText(/Re-read from the stored filing bytes/)).toBeVisible();
    await expect(page.getByText("0001683168-25-003734").first()).toBeVisible();
  });
});

test.describe("editorial review and reissue", () => {
  test("an editor approves and reissues a verified correction; history and notice stay public", async ({ page, request }) => {
    // #given a case prepared to a ready draft through the domain guards (test harness, not agents)
    const prepared = await page.request.post("/api/v1/test/harness/nocera-ready", { headers: { "x-errata-client": "web" } });
    expect(prepared.ok()).toBeTruthy();
    const { slug, caseId, candidateId } = (await prepared.json()).data as { slug: string; caseId: string; candidateId: string };

    // #when the editor opens the case
    await page.goto(`/w/${slug}/cases/${caseId}`);
    await expect(page.getByRole("heading", { name: "A verified correction is ready for an editor" })).toBeVisible();
    await page.getByRole("link", { name: "Review correction" }).click();
    await page.waitForURL(new RegExp(`/review/${candidateId}`));
    await expect(page.getByText("$670,496").first()).toBeVisible();
    await expect(page.getByText("-$123,653").first()).toBeVisible();

    // #and approves, then reissues as separate confirmed steps
    await page.getByRole("button", { name: "Approve this draft" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Approve" }).click();
    await expect(page.getByRole("button", { name: /Reissue version 2/ })).toBeEnabled();
    await page.getByRole("button", { name: /Reissue version 2/ }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Reissue now" }).click();
    await page.waitForURL(/\/research\//);

    // #then the public page shows the corrected version and keeps version 1 with its warning
    const publicLink = page.getByRole("link", { name: /Public page/ });
    const href = await publicLink.getAttribute("href");
    await page.goto(href!);
    await expect(page.getByRole("heading", { level: 1 })).toContainText("working capital deficit");
    await expect(page.getByText(/Corrected on/)).toBeVisible();
    await page.getByRole("link", { name: "version 1" }).click();
    await expect(page.getByText("Superseded by version 2")).toBeVisible();
    await expect(page.getByText(/should no longer be relied upon/).first()).toBeVisible();
    await expect(page.getByText("$1,275,416").first()).toBeVisible();

    // #and the correction notice lists each change with its source
    await page.getByRole("link", { name: "the correction notice" }).click();
    await expect(page.getByRole("heading", { level: 1 })).toContainText("Correction:");
    await expect(page.getByRole("cell", { name: "-$123,653" }).or(page.getByText("-$123,653")).first()).toBeVisible();

    // #and exports carry the corrected figures
    const reportApi = new URL(page.url()).pathname.replace(/\/notices\/.*/, "").replace("/p/", "/api/v1/public/reports/");
    const pdf = await request.get(`${reportApi}/versions/2/export/pdf`);
    expect(pdf.headers()["content-type"]).toContain("application/pdf");
    expect((await pdf.body()).subarray(0, 5).toString()).toBe("%PDF-");
  });

  test("an analyst cannot approve", async ({ page }) => {
    // #given
    const prepared = await page.request.post("/api/v1/test/harness/nocera-ready", { headers: { "x-errata-client": "web" } });
    expect(prepared.ok(), await prepared.text()).toBeTruthy();
    const { slug, caseId, candidateId } = (await prepared.json()).data as { slug: string; caseId: string; candidateId: string };
    await page.goto(`/w/${slug}`);
    // #when
    await page.getByLabel("Demo role").selectOption("analyst");
    await page.waitForLoadState("networkidle");
    await page.goto(`/w/${slug}/cases/${caseId}/review/${candidateId}`);
    // #then
    await expect(page.getByRole("button", { name: "Approve this draft" })).toBeDisabled();
    await expect(page.getByText(/Switch to the editor role/)).toBeVisible();
  });

  test("another browser session cannot open someone else's workspace", async ({ page, browser }) => {
    // #given
    const prepared = await page.request.post("/api/v1/test/harness/nocera-ready", { headers: { "x-errata-client": "web" } });
    expect(prepared.ok(), await prepared.text()).toBeTruthy();
    const { slug } = (await prepared.json()).data as { slug: string };
    const stranger = await browser.newContext();
    const strangerPage = await stranger.newPage();
    // #when
    await strangerPage.goto(`/w/${slug}`);
    // #then
    await expect(strangerPage.getByRole("heading", { name: /not open in this browser/ })).toBeVisible();
    await stranger.close();
  });

  test("an unknown public report is a 404", async ({ page }) => {
    const response = await page.goto("/p/zzzzzzzzzz");
    expect(response?.status()).toBe(404);
  });
});
