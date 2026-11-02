# Scenario proposal engine

The portable proposal engine provides `suggestedFailures(contract)` for repeatable
offline retry scenarios and `proposeScenario(contract, prompt, provider)` for model
adapters. Both return drafts with operation evidence, provenance and
`requiresApproval: true`. Evidence identifies declared operations; it does not
prove inferred business behavior.

Model output passes the existing scenario DSL validator against the original
contract. Invalid output gets one repair attempt; provider errors propagate.
The entire operation has a bounded deadline and abort signal. Providers receive
a cloned contract and cannot alter the source used for validation. Imported
descriptions and prompts must be treated as untrusted data by adapters.

The authenticated `GET /api/sandboxes/:id/proposals` endpoint returns template
suggestions scoped to the current organization. In the scenario editor, choose
**Suggest retry scenarios** and select a draft to review. This only changes the
editor contents; saving, owner approval and activation remain explicit actions.

Set `OPENAI_API_KEY` and optionally `PROPOSAL_MODEL` (default `gpt-4.1-mini`)
to enable owner-only `POST /api/sandboxes/:id/proposals` with `{ "prompt": "..." }`.
The editor's AI form sends the prompt and normalized contract to OpenAI. Contracts
are limited to 64 KB, prompts to 2,000 characters, responses to 64 KB and model
outputs to 2,048 tokens per call. Generation has a shared 20-second deadline and
at most one repair call. No live provider credentials were used in validation;
transport and provider behavior are tested with injected implementations.

Migration 004 persists usage per organization and UTC calendar month. An atomic
reservation enforces 100 requests per month, including failed attempts; each
request can make up to two model calls. This is a request budget, not a currency
spend cap. Operators must also configure provider-side spending controls.
Offline templates remain available without provider configuration.

Returned drafts use
the existing version creation, owner approval and session configuration flow
when integrated; generation itself never persists or activates a scenario.
