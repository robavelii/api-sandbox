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

This PR supplies the engine foundation. A provider adapter, durable organization
budgets, authenticated proposal endpoints and dashboard review remain to be
implemented. Adapters must enforce token and cost limits and honor cancellation.
No live model provider has been configured or tested here. Returned drafts use
the existing version creation, owner approval and session configuration flow
when integrated; generation itself never persists or activates a scenario.
