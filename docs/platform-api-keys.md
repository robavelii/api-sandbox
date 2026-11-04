# Platform API keys

Apply migration 009. Owners can create, list and revoke keys from **Platform API
keys** in the dashboard. Each key is permanently bound to its workspace and has
the `read` scope. The creator must retain owner membership: demotion or removal
immediately blocks subsequent key requests. Expired or revoked keys are rejected.
Keys are shown once; only SHA-256 hashes are stored. List responses never expose
secret values or hashes. Up to 20 active keys can exist per workspace, with an
expiry of 1–365 days (90 by default).

Use `Authorization: Bearer stp_...` on GET requests to `/api/sandboxes` and its
read endpoints, `/api/usage`, or `/api/me`. Platform keys cannot mutate resources,
manage keys or membership, invoke account operations, or create AI proposals.
Browser workspace cookies cannot change a key's workspace. Supplying both a key
and a browser cookie does not bypass key restrictions. The imported API's sandbox
keys remain separate and are used only on `/sandbox/...` routes.

Management endpoints require an owner browser session:

- `GET /api/platform-keys`: metadata for up to 100 recent keys in the workspace.
- `POST /api/platform-keys`: `{ "name": "CI reader", "expiresInDays": 90 }`.
- `POST /api/platform-keys/:id/revoke`: revoke a key in the selected workspace.

Owner membership is checked from the database on every key request. An in-flight
request can finish after a key is revoked; new requests are rejected. Restoring
the creator's owner role allows an otherwise unexpired, unrevoked key to work
again. Revoke keys explicitly when retiring access permanently.
