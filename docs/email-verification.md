# Email verification

Apply migration 005, then configure `RESEND_API_KEY` and `VERIFICATION_FROM`
with a verified sending domain. The account-security panel sends a code to the
signed-in account's stored email address. The user pastes that code back into
the confirmation form. Delivery uses Resend's fixed HTTPS endpoint with a
10-second timeout; provider response bodies and codes are never logged.

Authenticated endpoints:

- `GET /api/auth/email-status` returns `{ "verified": true|false }`.
- `POST /api/auth/email-verification` requests a code.
- `POST /api/auth/email-verification/confirm` consumes `{ "code": "..." }`.

Codes contain 256 random bits, are stored only as SHA-256 hashes, expire after
24 hours, and can be consumed once by the account that requested them. Issuance
serializes per user, imposes a one-minute resend cooldown, and invalidates older
codes. Failed delivery invalidates the pending code while retaining the cooldown.
Both request and confirmation share the database-backed authentication attempt
limit. Existing users remain unverified until they complete this flow.

Without mail credentials, requests return a configuration error; normal account
and simulation functions remain available. Verification is a prerequisite for
future invitations, not a new login requirement. No live mail credentials were
used during validation; delivery is tested with an injected sender and transport.
