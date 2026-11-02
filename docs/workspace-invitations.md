# Workspace invitations

Apply migration 006. Verified workspace owners can create member invitations
from the dashboard's **Workspace invitations** panel. Copy the one-time code
and share it securely with the invited person. Invitation emails are not sent
automatically in this release. The recipient registers or signs in, verifies
the invited email address, then pastes the code into **Accept invitation**.
The dashboard selects the accepted workspace and reloads.

- `GET /api/workspaces/invitations`: owners list active invitation metadata.
- `POST /api/workspaces/invitations`: owners submit `{ "email": "..." }`;
  returns the code once. Reissuing for an email invalidates the previous code.
- `POST /api/workspaces/invitations/:id/revoke`: owners revoke within their workspace.
- `POST /api/workspaces/invitations/accept`: verified recipients submit `{ "code": "..." }`.

Codes have 256 bits of randomness, are stored as SHA-256 hashes, expire after
seven days and are consumed atomically with membership creation. Acceptance
requires the account's verified email to match. New memberships receive the
member role; existing roles are preserved. Creation, revocation and acceptance
serialize on the workspace row alongside role administration. Each workspace
can hold at most 100 pending invitations. Expired entries are removed when an
owner creates another invitation. Acceptance shares the authentication attempt
limit; secret codes never appear in list responses.

Owners can promote an accepted member through member administration. Email
verification still requires configured mail delivery as described in
[email-verification.md](email-verification.md).
