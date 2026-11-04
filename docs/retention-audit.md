# Audit history and retention

Apply migration 008 before starting the updated API and worker. Owners can read
the selected workspace's audit history in the dashboard or through
`GET /api/workspaces/audit`. Each page has at most 100 events, ordered newest first;
pass the last event ID as `?before=` to fetch the next page. Members cannot read
audit history and every page is scoped to the selected organization.

Database triggers record committed membership changes, sandbox key rotation and
approval changes, scenario-version creation/approval, session resets, and active
version changes. Events are written in the same transaction as each mutation, so
rolled-back changes leave no events. Metadata is an explicit allowlist of roles,
approval flags and version identifiers; keys, passwords, imported contracts and
resource bodies are never copied. Records identify the affected resource but do
not yet identify the human actor. This is application history, not a tamper-proof
compliance ledger; privileged database users can alter records.

The worker runs a bounded retention pass once per minute. Concurrent workers use
a PostgreSQL advisory lock so only one executes the pass. Each table deletes at
most 500 rows per pass (the reusable function accepts 1–1000). Row locks use
`SKIP LOCKED`, lock waits are limited to two seconds, and each statement has a
ten-second deadline. Failures roll back the complete pass and are retried by the
worker. Tables belonging to optional migrations are skipped until installed.

| Data                                         | Retention                                                       |
| -------------------------------------------- | --------------------------------------------------------------- |
| Request logs                                 | 30 days                                                         |
| Audit history                                | 90 days                                                         |
| Delivered/failed webhook deliveries          | 30 days after last update                                       |
| Webhook events                               | 30 days, only after fanout and after all deliveries are removed |
| Auth sessions                                | Until expiration                                                |
| Auth rate-limit buckets                      | 24 hours after the window started                               |
| Verification, invitation and recovery tokens | 24 hours after expiration                                       |
| Recovery request buckets                     | 24 hours after the last request                                 |

Pending or leased webhook work and events that have not been fanned out are
preserved. Active sessions, current resource state, immutable scenario versions,
specifications and account records are preserved. Data export and account deletion
policies remain separate work. Retention requires a running worker; deployments
must monitor worker health and database size rather than assuming minute-level
deletion completion under a backlog.
