# Workspace membership management

Owners can open **Workspace members** to list existing members, change roles
between owner and member, or remove access. The member list is owner-only and
scoped to the selected workspace. Invitations and email verification are not
part of this release; no arbitrary account can be added through these endpoints.

- `GET /api/workspaces/members`
- `POST /api/workspaces/members/:userId/role` with `{ "role": "member" }` or owner
- `POST /api/workspaces/members/:userId/remove`

Every mutation locks the workspace row and rechecks the caller's ownership
inside the transaction. Last-owner checks run under that same lock, so competing
demotions/removals cannot leave a workspace without an owner. Removing membership
immediately blocks subsequent requests scoped to that workspace; other workspace
memberships and account sessions remain intact. A user who removes themselves
can select a remaining workspace through the selection API or sign in again.

No migration is required. The dashboard reloads after changes to the caller's
own membership, and refreshes the list after other member changes.
