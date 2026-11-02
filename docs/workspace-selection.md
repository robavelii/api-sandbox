# Workspace selection

The dashboard lists the signed-in user's workspace memberships and roles.
Selecting a workspace stores a seven-day, HttpOnly, SameSite=Strict preference
cookie and reloads the dashboard to clear data from the previous workspace.
Production cookies require HTTPS. Login and password rotation clear the
preference so it cannot carry over to another signed-in account.

- `GET /api/workspaces` lists the authenticated user's memberships.
- `POST /api/workspaces/select` accepts `{ "workspaceId": "uuid" }` and checks
  membership before setting the preference.
- Every control-plane request validates the saved workspace against current
  database membership and obtains the role from that membership.

Without a selection, the first membership remains the backward-compatible
default. A removed membership invalidates the saved selection; workspace list
and selection endpoints ignore that preference to allow recovery. Selection is
shared across tabs in the same browser. Refresh other tabs after switching.

No migration is required. Workspace creation, invitations and membership
administration remain separate follow-up work.
