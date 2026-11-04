"use client";
import { useEffect, useState } from "react";
import ConfirmAction from "./confirm-action";
type Version = {
  id: string;
  number: number;
  approved_at: string | null;
  definition: any;
};
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`,
      )
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
function matchesSaved(source: string, version: Version | undefined): boolean {
  if (!version) return false;
  try {
    return canonical(JSON.parse(source)) === canonical(version.definition);
  } catch {
    return false;
  }
}
async function api(path: string, data?: unknown) {
  const r = await fetch("/api" + path, {
    method: data === undefined ? "GET" : "POST",
    headers: { "Content-Type": "application/json" },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
  });
  const result = await r.json();
  if (!r.ok) throw new Error(result.error || "Request failed");
  return result;
}
export default function ScenarioEditor({
  boxId,
  sid,
  versionId,
  clock,
  operationIds,
  onChange,
}: {
  boxId: string;
  sid: string;
  versionId: string;
  clock: string;
  operationIds: string[];
  onChange: () => Promise<void>;
}) {
  const [versions, setVersions] = useState<Version[]>([]),
    [selected, setSelected] = useState(""),
    [source, setSource] = useState(""),
    [proposals, setProposals] = useState<any[]>([]),
    [prompt, setPrompt] = useState(""),
    [proposalNotice, setProposalNotice] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const version = versions.find((v) => v.id === selected);
  const savedDefinitionSelected = matchesSaved(source, version);
  async function load() {
    const rows = await api(`/sandboxes/${boxId}/versions`);
    setVersions(rows);
    return rows as Version[];
  }
  useEffect(() => {
    let active = true;
    setVersions([]);
    setProposals([]);
    setPrompt("");
    setProposalNotice("");
    setSource("");
    setError("");
    api(`/sandboxes/${boxId}/versions`)
      .then((rows) => {
        if (active) {
          setVersions(rows);
          const v = rows.find((v: Version) => v.id === versionId) || rows[0];
          setSelected(v?.id || "");
          setSource(JSON.stringify(v?.definition || {}, null, 2));
        }
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [boxId, versionId]);
  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  const loadExample = () => {
    const op =
      operationIds.find((id) => id.startsWith("POST ") && !id.includes("{")) ||
      operationIds[0];
    setSource(
      JSON.stringify(
        {
          version: 1,
          name: "Three failures then success",
          seed: "test-seed",
          clock: "2026-06-01T12:00:00.000Z",
          idempotency: "replay",
          rules: [
            {
              operation: op,
              times: 3,
              failure: { phase: "before", status: 429 },
            },
          ],
        },
        null,
        2,
      ),
    );
  };
  return (
    <section className="tab-panel" id="scenarios">
      <div className="section-head">
        <h2>Scenario versions</h2>
        <span className="chip chip-cool">
          Session pinned to v
          {versions.find((v) => v.id === versionId)?.number || "…"}
        </span>
      </div>
      <p className="muted">
        Saving creates a new draft. Review and approve it, then select it for
        this session. Switching versions resets this session&rsquo;s state.
      </p>
      <div className="scenario-grid">
        <div className="scenario-main">
          <div className="field">
            <label htmlFor="scenario-version">Version</label>
            <select
              id="scenario-version"
              aria-label="Scenario version to review"
              value={selected}
              onChange={(e) => {
                setSelected(e.target.value);
                setSource(
                  JSON.stringify(
                    versions.find((v) => v.id === e.target.value)?.definition,
                    null,
                    2,
                  ),
                );
              }}
            >
              {versions.map((v) => (
                <option key={v.id} value={v.id}>
                  {`v${v.number} ${v.definition.name}, ${v.approved_at ? "approved" : "draft"}`}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="definition">Typed scenario definition</label>
            <textarea
              id="definition"
              className="code-input code-input-tall"
              value={source}
              onChange={(e) => setSource(e.target.value)}
              spellCheck={false}
            />
          </div>
          {error && (
            <p role="alert" className="callout callout-bad">
              {error}
            </p>
          )}
          <div className="actions">
            <button
              disabled={busy || !source}
              className="btn btn-primary"
              onClick={() =>
                run(async () => {
                  const created = await api(
                    `/sandboxes/${boxId}/versions`,
                    JSON.parse(source),
                  );
                  await load();
                  setSelected(created.id);
                  setSource(JSON.stringify(created.definition, null, 2));
                })
              }
            >
              Save as new draft
            </button>
            <button
              disabled={
                busy ||
                !version ||
                !!version.approved_at ||
                !savedDefinitionSelected
              }
              className="btn"
              onClick={() =>
                run(async () => {
                  await api(
                    `/sandboxes/${boxId}/versions/${selected}/approve`,
                    {},
                  );
                  await load();
                })
              }
            >
              Approve saved definition
            </button>
            <ConfirmAction
              label="Use version & reset session"
              title={`Use v${version?.number ?? ""} for this session?`}
              body="This deletes resources, logs and retry history in the selected session."
              confirmLabel="Use version"
              danger
              disabled={
                busy ||
                !sid ||
                !version?.approved_at ||
                !savedDefinitionSelected
              }
              onConfirm={() =>
                run(async () => {
                  await api(`/sandboxes/${boxId}/sessions/${sid}/configure`, {
                    versionId: selected,
                  });
                  await onChange();
                })
              }
            />
          </div>
          <dl className="panels facts">
            <div>
              <dt>Idempotency policy</dt>
              <dd className="measured">
                {version?.definition.idempotency || "not set"}
              </dd>
            </div>
            <div>
              <dt>Session clock</dt>
              <dd className="measured cool">
                {clock ? new Date(clock).toISOString() : "not set"}
              </dd>
              <button
                className="btn"
                disabled={busy || !sid}
                onClick={() =>
                  run(async () => {
                    await api(`/sandboxes/${boxId}/sessions/${sid}/clock`, {
                      advanceMs: 1000,
                    });
                    await onChange();
                  })
                }
              >
                Advance 1 second
              </button>
            </div>
          </dl>
          <p className="hint">
            Send Idempotency-Key on mutation requests. Review the saved JSON
            before approval; edited text must be saved as a new draft.
          </p>
        </div>
        <aside className="panel scenario-aside">
          <h3>Start a draft</h3>
          <div className="actions">
            <button disabled={busy} className="btn" onClick={loadExample}>
              Load retry example
            </button>
            <button
              className="btn"
              disabled={busy}
              onClick={() =>
                run(async () => {
                  setProposals(await api(`/sandboxes/${boxId}/proposals`));
                })
              }
            >
              Suggest retry scenarios
            </button>
          </div>
          {proposals.length > 0 && (
            <>
              <select
                aria-label="Suggested scenario"
                defaultValue=""
                onChange={(event) => {
                  const proposal = proposals[Number(event.target.value)];
                  if (proposal)
                    setSource(JSON.stringify(proposal.definition, null, 2));
                }}
              >
                <option value="" disabled>
                  Choose a draft to review
                </option>
                {proposals.map((proposal, index) => (
                  <option key={index} value={index}>
                    {proposal.definition.name}
                  </option>
                ))}
              </select>
              <p className="hint">
                Template suggestions use declared operations. Review the rule,
                save a draft, and approve it before activation.
              </p>
            </>
          )}
          <form
            className="form-grid"
            onSubmit={(event) => {
              event.preventDefault();
              run(async () => {
                const proposal = await api(`/sandboxes/${boxId}/proposals`, {
                  prompt,
                });
                setSource(JSON.stringify(proposal.definition, null, 2));
                setProposalNotice(
                  `AI-inferred draft. Declared operations: ${proposal.evidence.join(", ") || "none"}. Review, save and approve before activation.`,
                );
              });
            }}
          >
            <div className="field">
              <label htmlFor="proposal-prompt">Describe a test scenario</label>
              <input
                id="proposal-prompt"
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
                maxLength={2000}
                required
              />
            </div>
            <div className="actions">
              <button className="btn" disabled={busy}>
                Generate AI draft
              </button>
            </div>
          </form>
          <p className="hint">
            AI generation sends the scenario request and imported contract to
            the configured model provider. Limited to 100 requests per workspace
            per month; failed attempts count.
          </p>
          {proposalNotice && (
            <p role="status" className="callout">
              {proposalNotice}
            </p>
          )}
        </aside>
      </div>
    </section>
  );
}
