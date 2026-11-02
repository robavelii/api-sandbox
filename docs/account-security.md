# Account password and sessions

The dashboard's **Account security** panel supports password changes, signing
out other devices, and signing out everywhere. Password changes require the
current password and a new password of 12–128 characters. They revoke all prior
sessions and create a new seven-day session for the current browser.

Authenticated endpoints:

- `POST /api/auth/password`: `{ "currentPassword": "...", "newPassword": "..." }`
- `POST /api/auth/logout-others`: revoke all sessions except the caller's.
- `POST /api/auth/logout-all`: revoke all sessions and clear the browser cookie.

All mutations scope session deletion to the authenticated user. Password changes
share the database-backed authentication attempt limit. Login and password/session
mutations lock the user row; password changes recheck the caller's session after
locking, so a waiting stale request cannot change the password again. Transactions
commit password changes and session replacement atomically. No migration is needed.

This adds self-service security for signed-in accounts. Forgotten-password
recovery, verified email, invitations and workspace switching remain subsequent
organization-access work.
