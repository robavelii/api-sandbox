import type { Contract } from "./index.js";
import { defaultDefinition, definition, type Definition } from "./scenario.js";

export interface Proposal {
  definition: Definition;
  provenance: "template" | "ai-inferred";
  evidence: string[];
  requiresApproval: true;
}

/** Implementations must honor signal and enforce their own token/cost limits. */
export type ProposalProvider = (request: {
  prompt: string;
  contract: Contract;
  validationError?: string;
  signal: AbortSignal;
}) => Promise<unknown>;

/** Portable suggestions remain available when no model provider is configured. */
export function suggestedFailures(contract: Contract): Proposal[] {
  return contract.operations.slice(0, 50).map((operation) => ({
    definition: definition(
      {
        ...defaultDefinition(),
        name: `Retry ${operation.method} ${operation.path}`.slice(0, 100),
        rules: [
          {
            operation: operation.id,
            times: 3,
            failure: { phase: "before", status: 429 },
          },
        ],
      },
      contract,
    ),
    provenance: "template",
    evidence: [operation.id],
    requiresApproval: true,
  }));
}

/** Generates drafts only. Saving, approval and activation are separate actions. */
export async function proposeScenario(
  contract: Contract,
  prompt: string,
  provider: ProposalProvider,
  timeoutMs = 20_000,
): Promise<Proposal> {
  if (typeof prompt !== "string" || !prompt.trim() || prompt.length > 2000)
    throw new Error("Describe the scenario using 1–2000 characters.");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000)
    throw new Error("Proposal timeout must be between 1 and 30000 ms.");
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const task = async (): Promise<Proposal> => {
      let validationError: string | undefined;
      for (let attempt = 0; attempt < 2; attempt++) {
        controller.signal.throwIfAborted();
        // Clone the contract so a provider cannot mutate runtime configuration.
        const candidate = await provider({
          prompt: prompt.trim(),
          contract: structuredClone(contract),
          validationError,
          signal: controller.signal,
        });
        controller.signal.throwIfAborted();
        try {
          const value = definition(candidate, contract);
          return {
            definition: structuredClone(value),
            provenance: "ai-inferred",
            evidence: [...new Set(value.rules.map((rule) => rule.operation))],
            requiresApproval: true,
          };
        } catch (error) {
          validationError =
            error instanceof Error ? error.message : "Invalid definition.";
        }
      }
      throw new Error(
        "Provider returned an invalid scenario after one repair attempt.",
      );
    };
    return await Promise.race([
      task(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error("Scenario proposal timed out."));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    controller.abort();
  }
}
