import test from "node:test";
import assert from "node:assert/strict";
import worker from "../../worker.js";

const env = {
  VBIRR_PROJECT_SECRET: "project-secret",
  VBIRR_RECEIPT_PROVIDER_KEY: "provider-secret",
  ASSETS: { fetch: async () => new Response("asset") }
};
const headers = { "content-type": "application/json", "x-vbirr-project-secret": "project-secret" };
const matchedProvider = {
  ok: true,
  providerKey: "cbe",
  fetchedAt: "2026-10-15T00:00:00Z",
  receipt: {
    source: "cbe-pdf",
    payerAccount: "0912792308",
    receiverAccount: "0987652314",
    transferredAmount: 50,
    currency: "ETB"
  }
};

function workspaceBinding(initial) {
  let workspace = structuredClone(initial || { projects: [], reviews: [], activity: [] });
  return {
    idFromName: () => "workspace",
    get: () => ({
      fetch: async (url, options = {}) => {
        if (new URL(url).pathname !== "/state") return new Response("Not found", { status: 404 });
        if (options.method === "PUT") workspace = structuredClone(JSON.parse(options.body).workspace);
        return new Response(JSON.stringify({ ok: true, workspace }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
    }),
    current: () => workspace
  };
}

async function withFetch(fetchImpl, callback) {
  const oldFetch = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  try { return await callback(); }
  finally { globalThis.fetch = oldFetch; }
}

function makeRequest(body, path = "/api/verify", requestHeaders = headers) {
  return new Request(`https://vbirr.test${path}`, {
    method: "POST",
    headers: requestHeaders,
    body: JSON.stringify(body)
  });
}

test("receipt URL/reference verification queries Links.et and preserves its response", async () => {
  let sent;
  const response = await withFetch(async (url, options) => {
    sent = { url, options };
    return new Response(JSON.stringify(matchedProvider), { status: 200 });
  }, () => worker.fetch(makeRequest({
    reference: "TX-001234",
    baseAccount: "0987652314",
    clientAccount: "0912792308"
  }), env));
  const data = await response.json();

  assert.equal(response.status, 200);
  assert.equal(sent.url, "https://links.et/api/verify");
  assert.equal(sent.options.headers["x-api-key"], "provider-secret");
  assert.deepEqual(JSON.parse(sent.options.body), { reference: "TX-001234" });
  assert.equal(data.decision.status, "matched");
  assert.equal(data.decision.grant, true);
  assert.deepEqual(data.providerResponse, matchedProvider);
  assert.equal(JSON.stringify(data).includes("provider-secret"), false);
});

test("project-bound checks ignore caller-supplied receiving accounts and require registered payers", async () => {
  const binding = workspaceBinding({
    projects: [{ id: "project-1", baseAccount: "0987652314", payers: [{ accountNumber: "0912792308" }] }],
    reviews: [],
    activity: []
  });
  const configuredEnv = { ...env, VBIRR_WORKSPACE: binding };
  const registered = await withFetch(async () => new Response(JSON.stringify(matchedProvider), { status: 200 }), () =>
    worker.fetch(makeRequest({
      reference: "TX-001234",
      projectId: "project-1",
      clientAccount: "0912792308",
      baseAccount: "1111111111"
    }), configuredEnv));
  const registeredData = await registered.json();
  assert.equal(registeredData.decision.grant, true);
  assert.equal(registeredData.project.registeredPayer, true);
  assert.equal(registeredData.accountChecks.recipient.status, "matched");

  const unregisteredProvider = structuredClone(matchedProvider);
  unregisteredProvider.receipt.payerAccount = "0911111111";
  const unregistered = await withFetch(async () => new Response(JSON.stringify(unregisteredProvider), { status: 200 }), () =>
    worker.fetch(makeRequest({ reference: "TX-001234", projectId: "project-1", clientAccount: "0911111111" }), configuredEnv));
  const review = await unregistered.json();
  assert.equal(review.decision.status, "needs_review");
  assert.equal(review.decision.grant, false);
  assert.equal(review.vbirr.code, "UNREGISTERED_PAYER");
});

test("project-bound checks reject caller account overrides and unknown projects", async () => {
  let calls = 0;
  const binding = workspaceBinding({ projects: [], reviews: [], activity: [] });
  const configuredEnv = { ...env, VBIRR_WORKSPACE: binding };
  const fetchImpl = async () => { calls += 1; return new Response(JSON.stringify(matchedProvider)); };
  const override = await withFetch(fetchImpl, () => worker.fetch(makeRequest({
    reference: "TX-001234", projectId: "project-1", clientAccount: "0912792308", paymentBaseAccountOverride: "0987652314"
  }), configuredEnv));
  const unknown = await withFetch(fetchImpl, () => worker.fetch(makeRequest({
    reference: "TX-001234", projectId: "missing", clientAccount: "0912792308"
  }), configuredEnv));
  assert.equal(override.status, 400);
  assert.equal(unknown.status, 404);
  assert.equal(calls, 0);
});

test("invalid locator/accounts and missing authorization are rejected before contacting Links.et", async () => {
  let calls = 0;
  const fetchImpl = async () => { calls += 1; return new Response(JSON.stringify(matchedProvider)); };
  const invalidAccounts = await withFetch(fetchImpl, () => worker.fetch(makeRequest({ reference: "TX-001234", baseAccount: "12", clientAccount: "0912792308" }), env));
  const invalidLocator = await withFetch(fetchImpl, () => worker.fetch(makeRequest({ url: "https://example.org/receipt", baseAccount: "0987652314", clientAccount: "0912792308" }), env));
  const missingAuth = await withFetch(fetchImpl, () => worker.fetch(makeRequest({ reference: "TX-001234", baseAccount: "0987652314", clientAccount: "0912792308" }, "/api/verify", { ...headers, "x-vbirr-project-secret": "wrong" }), env));

  assert.equal(invalidAccounts.status, 400);
  assert.equal(invalidLocator.status, 400);
  assert.equal(missingAuth.status, 401);
  assert.equal(calls, 0);
});

test("legacy screenshot endpoint returns 410 and never forwards screenshot bytes", async () => {
  let calls = 0;
  const response = await withFetch(async () => { calls += 1; return new Response("unexpected"); }, () =>
    worker.fetch(makeRequest({ imageBase64: "aGVsbG8=" }, "/api/verify-image"), env));
  const data = await response.json();
  assert.equal(response.status, 410);
  assert.equal(data.vbirr.code, "SCREENSHOT_UPLOAD_DISABLED");
  assert.equal(calls, 0);
});

test("workspace reads and writes require the project secret and persist server state", async () => {
  const binding = workspaceBinding();
  const configuredEnv = { ...env, VBIRR_WORKSPACE: binding };
  const getResponse = await worker.fetch(new Request("https://vbirr.test/api/workspace", { method: "GET", headers }), configuredEnv);
  assert.equal(getResponse.status, 200);
  assert.equal((await getResponse.json()).storage, "server");

  const workspace = { projects: [{ id: "p1", baseAccount: "0987652314", payers: [] }], reviews: [], activity: [] };
  const putResponse = await worker.fetch(new Request("https://vbirr.test/api/workspace", {
    method: "PUT", headers, body: JSON.stringify({ workspace })
  }), configuredEnv);
  assert.equal(putResponse.status, 200);
  assert.deepEqual(binding.current(), workspace);

  const denied = await worker.fetch(new Request("https://vbirr.test/api/workspace", {
    method: "GET", headers: { "x-vbirr-project-secret": "wrong" }
  }), configuredEnv);
  assert.equal(denied.status, 401);
});
