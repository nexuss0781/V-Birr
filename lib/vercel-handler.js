import worker from "../worker.js";

const WORKSPACE_KEY = "vbirr:organization-workspace:v1";

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store, private" }
  });
}

function makeRedisBinding(env) {
  if (!env.UPSTASH_REDIS_REST_URL || !env.UPSTASH_REDIS_REST_TOKEN) return undefined;
  const endpoint = env.UPSTASH_REDIS_REST_URL.replace(/\/+$/u, "");
  const request = async (command) => {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.UPSTASH_REDIS_REST_TOKEN}`,
        "content-type": "application/json",
        accept: "application/json"
      },
      body: JSON.stringify(command),
      cache: "no-store"
    });
    const payload = await response.json();
    if (!response.ok || payload?.error) throw new Error("Workspace storage request failed.");
    return payload?.result;
  };
  return {
    idFromName: () => "vbirr-organization-workspace",
    get: () => ({
      async fetch(input, init = {}) {
        const requestObject = input instanceof Request ? input : new Request(input, init);
        const url = new URL(requestObject.url);
        if (url.pathname !== "/state") return json({ ok: false, error: { code: "not_found" } }, 404);
        if (requestObject.method === "GET") {
          const result = await request(["GET", WORKSPACE_KEY]);
          const workspace = result ? JSON.parse(result) : { projects: [], reviews: [], activity: [] };
          return json({ ok: true, workspace });
        }
        if (requestObject.method !== "PUT") return json({ ok: false, error: { code: "method_not_allowed" } }, 405);
        const body = await requestObject.json();
        if (!body?.workspace || JSON.stringify(body).includes("imageBase64")) {
          return json({ ok: false, error: { code: "invalid_workspace" } }, 400);
        }
        await request(["SET", WORKSPACE_KEY, JSON.stringify(body.workspace)]);
        return json({ ok: true });
      }
    })
  };
}

export async function handleVercelRequest(request) {
  const env = {
    VBIRR_PROJECT_SECRET: process.env.VBIRR_PROJECT_SECRET || "",
    VBIRR_RECEIPT_PROVIDER_KEY: process.env.VBIRR_RECEIPT_PROVIDER_KEY || process.env.LINKS_ET_API_KEY || "",
    VBIRR_WORKSPACE: undefined,
    ASSETS: { fetch: async () => json({ ok: false, error: { code: "not_found" } }, 404) }
  };
  env.VBIRR_WORKSPACE = makeRedisBinding(process.env);
  return worker.fetch(request, env);
}

export default { fetch: handleVercelRequest };
