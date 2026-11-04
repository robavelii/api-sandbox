import { expect, test } from "@playwright/test";

test("an owner creates, uses and revokes a read-only platform key", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Create an account" }).click();
  await page
    .getByLabel("Email", { exact: true })
    .fill("platform-key-browser@example.com");
  await page
    .getByLabel("Password", { exact: true })
    .fill("integration-password");
  await page
    .getByRole("button", { name: "Create account", exact: true })
    .click();
  await page.getByRole("link", { name: "Settings" }).click();
  await page.getByRole("link", { name: "Platform keys" }).click();
  await page.getByLabel("Platform key name").fill("Browser CI reader");
  await page
    .getByRole("button", { name: "Create platform key", exact: true })
    .click();
  const token = await page
    .getByText("Save this platform key now:")
    .locator("code")
    .textContent();
  expect(token).toMatch(/^stp_[a-f0-9]{64}$/);
  const read = await page.evaluate(async (secret) => {
    const response = await fetch("/api/sandboxes", {
      headers: { authorization: `Bearer ${secret}` },
    });
    return { status: response.status, body: await response.json() };
  }, token);
  expect(read).toEqual({ status: 200, body: [] });
  await page
    .getByRole("button", { name: "Revoke Browser CI reader", exact: true })
    .click();
  await expect(
    page.getByRole("row", { name: /Browser CI reader read/ }),
  ).toContainText("revoked");
  const revoked = await page.evaluate(
    async (secret) =>
      (
        await fetch("/api/sandboxes", {
          headers: { authorization: `Bearer ${secret}` },
        })
      ).status,
    token,
  );
  expect(revoked).toBe(401);
});
