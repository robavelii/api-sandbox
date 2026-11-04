# Forgotten-password recovery

Apply migration 007 and configure `RESEND_API_KEY` and `VERIFICATION_FROM`
using the same verified sender as email verification. The sign-in page's
**Forgot password?** panel requests and consumes recovery codes.

- `POST /api/auth/recovery/request` accepts `{ "email": "..." }`.
- `POST /api/auth/recovery/confirm` accepts `{ "code": "...", "newPassword": "..." }`.

Only verified accounts receive mail. Unknown, unverified, cooldown, unavailable
mailer and delivery-failure outcomes return the same public success message.
This prevents response-based account enumeration; delivery timing is not padded.
Both endpoints use the distributed authentication attempt limit, and requests
also have a one-minute per-email cooldown stored as an email hash.

Codes have 256 bits of randomness, are stored only as hashes, expire after
30 minutes, and are single-use. Reissuing replaces the prior code; failed mail
delivery deletes the pending code while retaining the cooldown. Password reset
consumes the token, updates the password and revokes all account sessions in one
transaction, serialized on the user row with login and authenticated password
changes. Reset never creates a login or clears another signed-in account's cookie.
Authenticated password changes also invalidate outstanding recovery codes.

Existing unverified accounts cannot recover until they have verified their email.
No code or submitted password is logged. Provider transport is tested using
injected implementations; live credentialed mail delivery remains unverified.
