import { expect, test } from "@playwright/test";

test("a team can configure and replay an isolated integration journey", async ({
  page,
  request,
  browser,
}) => {
  await page.goto("/");
  await page.getByText("Forgot password?", { exact: true }).click();
  await page.getByLabel("Recovery email").fill("missing@example.com");
  await page
    .getByRole("button", { name: "Send recovery code", exact: true })
    .click();
  await expect(
    page.locator("#password-recovery").getByRole("status"),
  ).toContainText("If this email belongs to a verified account");
  await page.getByText("Forgot password?", { exact: true }).click();
  await page.getByRole("button", { name: "Create an account" }).click();
  await page.getByLabel("Email").fill("journey@example.com");
  await page.getByLabel("Password").fill("integration-password");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(
    page.getByRole("heading", { name: "Make integrations feel real." }),
  ).toBeVisible();
  const corsSession = await page.evaluate(async () => {
    const response = await fetch("http://127.0.0.1:4100/api/me", {
      credentials: "include",
    });
    return { status: response.status, email: (await response.json()).email };
  });
  expect(corsSession).toEqual({ status: 200, email: "journey@example.com" });
  const rejectedOrigin = await request.post(
    "http://127.0.0.1:4100/api/auth/login",
    {
      headers: { Origin: "https://attacker.invalid" },
      data: { email: "journey@example.com", password: "integration-password" },
    },
  );
  expect(rejectedOrigin.status()).toBe(403);

  await page.getByRole("button", { name: "Explore example" }).click();
  await expect(
    page.getByRole("heading", { name: "Import your API" }),
  ).toBeVisible();
  await expect(page.getByLabel("Specification source")).toContainText(
    '"openapi": "3.0.3"',
  );
  await page.getByRole("button", { name: "Import contract →" }).click();

  await expect(page.getByText("Review needed")).toBeVisible();
  await page
    .getByLabel("Describe a test scenario")
    .fill("Retry payment requests");
  await page.getByRole("button", { name: "Generate AI draft" }).click();
  await expect(page.locator("#scenarios").getByRole("alert")).toContainText(
    "not configured",
  );
  await page.getByRole("button", { name: "Suggest retry scenarios" }).click();
  await page.getByLabel("Suggested scenario").selectOption("0");
  await expect(page.getByLabel("Typed scenario definition")).toHaveValue(
    /Retry/,
  );
  const endpoint = await page
    .getByRole("heading", { name: "Your sandbox endpoint" })
    .locator("..")
    .locator(".code-row code")
    .textContent();
  const key = await page
    .getByText("Save this key securely:")
    .locator("..")
    .locator("code")
    .textContent();
  expect(endpoint).toMatch(/^http:\/\/127\.0\.0\.1:4100\/sandbox\//);
  expect(key).toMatch(/^[a-f0-9]{64}$/);

  await page
    .getByRole("button", { name: "Approve inferred CRUD mappings" })
    .click();
  await expect(page.getByText("Ready", { exact: true })).toBeVisible();

  const created = await request.post(`${endpoint}/payments`, {
    headers: { Authorization: `Bearer ${key}` },
    data: { amount: 2500, currency: "USD" },
  });
  expect(created.status()).toBe(201);
  const payment = await created.json();
  expect(payment).toMatchObject({
    id: "pay_000001",
    amount: 2500,
    currency: "USD",
  });

  await page.getByRole("button", { name: "Refresh" }).click();
  await expect(page.getByText("POST /payments", { exact: true })).toBeVisible();
  await expect(
    page
      .getByText("STORED RESOURCES", { exact: true })
      .locator("..")
      .getByText("1", { exact: true }),
  ).toBeVisible();

  await page.getByRole("button", { name: "Load retry example" }).click();
  await page.getByRole("button", { name: "Save as new draft" }).click();
  await expect(
    page.getByRole("option", { name: /v2 .* draft/ }),
  ).toBeAttached();
  await page.getByRole("button", { name: "Approve saved definition" }).click();
  await expect(
    page.getByRole("option", { name: /v2 .* approved/ }),
  ).toBeAttached();
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Use version" }).click();
  await expect(page.getByText("Session pinned to v2")).toBeVisible();

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const failure = await request.post(`${endpoint}/payments`, {
      headers: {
        Authorization: `Bearer ${key}`,
        "Idempotency-Key": "checkout-42",
      },
      data: { amount: 4200, currency: "USD" },
    });
    expect(failure.status()).toBe(429);
  }
  const success = await request.post(`${endpoint}/payments`, {
    headers: {
      Authorization: `Bearer ${key}`,
      "Idempotency-Key": "checkout-42",
    },
    data: { amount: 4200, currency: "USD" },
  });
  expect(success.status()).toBe(201);
  const replay = await request.post(`${endpoint}/payments`, {
    headers: {
      Authorization: `Bearer ${key}`,
      "Idempotency-Key": "checkout-42",
    },
    data: { amount: 4200, currency: "USD" },
  });
  expect(await replay.json()).toEqual(await success.json());

  await page.getByRole("button", { name: "Refresh" }).click();
  await expect(page.getByText("Replayed saved result")).toBeVisible();
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Reset state" }).click();
  await expect(page.getByText("No requests yet.")).toBeVisible();
  const afterReset = await request.get(`${endpoint}/payments`, {
    headers: { Authorization: `Bearer ${key}` },
  });
  expect(await afterReset.json()).toEqual([]);

  page.once("dialog", (dialog) => dialog.accept("ci"));
  await page.getByRole("button", { name: "New session" }).click();
  await expect(page.getByLabel("Session")).toHaveValue(/.+/);
  await expect(page.getByLabel("Session").locator("option:checked")).toHaveText(
    "ci",
  );
  const isolated = await request.get(`${endpoint}/payments`, {
    headers: {
      Authorization: `Bearer ${key}`,
      "X-SpecTwin-Session": "ci",
    },
  });
  expect(await isolated.json()).toEqual([]);

  const sandboxId = endpoint!.split("/").at(-1)!;
  const outsider = await browser.newContext();
  const outsiderPage = await outsider.newPage();
  await outsiderPage.goto("/");
  await outsiderPage.getByRole("button", { name: "Create an account" }).click();
  await outsiderPage.getByLabel("Email").fill("outsider@example.com");
  await outsiderPage.getByLabel("Password").fill("integration-password");
  await outsiderPage.getByRole("button", { name: "Create account" }).click();
  await expect(
    outsiderPage.getByRole("heading", { name: "Make integrations feel real." }),
  ).toBeVisible();
  const forbidden = await outsiderPage.evaluate(async (id) => {
    const response = await fetch(`/api/sandboxes/${id}/sessions`);
    return { status: response.status, body: await response.json() };
  }, sandboxId);
  expect(forbidden).toEqual({
    status: 404,
    body: { error: "Sandbox not found." },
  });
  await outsider.close();
  await page.getByText("Workspace audit history", { exact: true }).click();
  await page
    .getByRole("button", { name: "Load audit history", exact: true })
    .click();
  await expect(
    page
      .locator("#workspace-audit")
      .getByText("scenario.version_created", { exact: true })
      .first(),
  ).toBeVisible();
  await page.getByText("Workspace invitations", { exact: true }).click();
  await page.getByLabel("Invite email").fill("teammate@example.com");
  await page
    .getByRole("button", { name: "Create invitation", exact: true })
    .click();
  await expect(
    page.locator("#workspace-invitations").getByRole("alert"),
  ).toContainText("Verify your email");
  await page.getByText("Workspace members", { exact: true }).click();
  await page.getByRole("button", { name: "Load members", exact: true }).click();
  const ownRole = page.locator("#workspace-members select");
  await expect(ownRole).toHaveValue("owner");
  await ownRole.selectOption("member");
  await expect(
    page.locator("#workspace-members").getByRole("alert"),
  ).toContainText("at least one owner");
  await expect(ownRole).toHaveValue("owner");
  await expect(
    page.getByLabel("Active workspace").locator("option"),
  ).toContainText("My workspace");
  await page.getByText("Account security", { exact: true }).click();
  await page.getByRole("button", { name: "Send verification code" }).click();
  await expect(
    page.getByText("Verification email delivery is not configured.", {
      exact: true,
    }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Sign out other devices" }).click();
  await expect(
    page.getByText("Other devices have been signed out.", { exact: true }),
  ).toBeVisible();
  await page.getByLabel("Current password").fill("integration-password");
  await page.getByLabel("New password").fill("updated-integration-password");
  await page
    .getByRole("button", { name: "Change password", exact: true })
    .click();
  await expect(
    page.getByText("Password updated. Other devices have been signed out."),
  ).toBeVisible();
  await page.getByRole("button", { name: "Sign out everywhere" }).click();
  await expect(
    page.getByRole("button", { name: "Sign in", exact: true }),
  ).toBeVisible();
});
