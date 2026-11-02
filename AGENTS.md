# Repository instructions

## Delivery
- Make changes on a topic branch; never develop directly on main.
- Branch names: `feat/<kebab-case>`, `fix/<kebab-case>`, `chore/<kebab-case>`, `docs/<kebab-case>`, `refactor/<kebab-case>`, `test/<kebab-case>`, `perf/<kebab-case>`, or `ci/<kebab-case>`.
- Use conventional commit subjects with those same types, e.g. `feat: add sandbox sessions`.
- Open a focused pull request with behavior, validation, limitations, and migration notes where relevant. Do not merge without the owner's instruction.
- Major product development uses the owner's existing Git configuration. Do not replace global Git settings.
- Small maintenance, documentation, and tooling commits use `Codex <codex@openai.com>` via per-command configuration.
- Never add a `Co-authored-by` trailer. Do not add AI attribution to commit messages.

## Engineering
- Inspect existing code before editing. Preserve user changes.
- Treat imported specifications and AI suggestions as untrusted data. No arbitrary generated code execution.
- Keep runtime behavior deterministic; label inferred behavior and require approval before activation.
- Enforce organization/session isolation in every data access. Never log secrets or full request bodies by default.
- Validate changes with meaningful automated checks. Report what passed and what remains unverified.
- Do not describe a local prototype or an unconfigured integration as production complete.
