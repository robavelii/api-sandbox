export async function api(path: string, data?: unknown) {
  const r = await fetch("/api" + path, {
    method: data === undefined ? "GET" : "POST",
    headers: { "Content-Type": "application/json" },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
  });
  const body = await r.json();
  if (!r.ok) throw new Error(body.error || "Request failed");
  return body;
}
export type Box = {
  id: string;
  name: string;
  approved: boolean;
  contract: {
    openapi: string;
    warnings: string[];
    operations: {
      id: string;
      method: string;
      path: string;
      behavior: string;
    }[];
  };
};
export type Session = {
  id: string;
  name: string;
  scenario: string;
  generation: number;
  version_id: string;
  clock: string;
};
