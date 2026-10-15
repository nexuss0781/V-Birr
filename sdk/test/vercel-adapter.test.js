import test from "node:test";
import assert from "node:assert/strict";
import { handleVercelRequest } from "../../lib/vercel-handler.js";

function setEnvironment(values) {
  const original = {};
  for (const [key, value] of Object.entries(values)) {
    original[key] = process.env[key];
    process.env[key] = value;
  }
  return () => {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

async function withFetch(fetchImpl, callback) {
  const original = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  try { return await callback(); }
  finally { globalThis.fetch = original; }
}

test("Vercel API verify sends only locator data to Links.et with the server credential", async () => {
  const restoreEnv = setEnvironment({
    VBIRR_PROJECT_SECRET: "project-secret",
    VBIRR_RECEIPT_PROVIDER_KEY: "provider-secret",
    UPSTASH_REDIS_REST_URL: "",
    UPSTASH_REDIS_REST_TOKEN: ""
  });
  let upstreamRequest;
  try {
    const response = await withFetch(async (url, options) => {
      upstreamRequest = { url, options };
      return new Response(JSON.stringify({
        ok: true,
        receipt: { source: "cbe-pdf", payerAccount: "0912792308", receiverAccount: "0987652314" }
      }), { status: 200 });
    }, () => handleVercelRequest(new Request("https://vbirr.test/api/verify", {
      method: "POST",
      headers: { "content-type": "application/json", "x-vbirr-project-secret": "project-secret" },
      body: JSON.stringify({ reference: "TX-001234", baseAccount: "0987652314", clientAccount: "0912792308" })
    })));
    const data = await response.json();
    assert.equal(data.decision.grant, true);
    assert.equal(upstreamRequest.url, "https://links.et/api/verify");
    assert.equal(upstreamRequest.options.headers["x-api-key"], "provider-secret");
    assert.deepEqual(JSON.parse(upstreamRequest.options.body), { reference: "TX-001234" });
    assert.equal(JSON.stringify(upstreamRequest.options.body).includes("imageBase64"), false);
  } finally {
    restoreEnv();
  }
});

test("Vercel workspace routes read and save the server-side Redis workspace", async () => {
  const restoreEnv = setEnvironment({
    VBIRR_PROJECT_SECRET: "project-secret",
    VBIRR_RECEIPT_PROVIDER_KEY: "provider-secret",
    UPSTASH_REDIS_REST_URL: "https://redis.example.test",
    UPSTASH_REDIS_REST_TOKEN: "redis-secret"
  });
  const commands = [];
  try {
    const fetchImpl = async (url, options) => {
      commands.push({ url, options, command: JSON.parse(options.body) });
      const command = JSON.parse(options.body);
      if (command[0] === "GET") return new Response(JSON.stringify({ result: null }), { status: 200 });
      return new Response(JSON.stringify({ result: "OK" }), { status: 200 });
    };
    const getResponse = await withFetch(fetchImpl, () => handleVercelRequest(new Request("https://vbirr.test/api/workspace", {
      method: "GET", headers: { "x-vbirr-project-secret": "project-secret" }
    })));
    const getBody = await getResponse.json();
    assert.equal(getBody.ok, true);
    assert.equal(getBody.storage, "server");
    assert.deepEqual(commands[0].command, ["GET", "vbirr:organization-workspace:v1"]);

    const workspace = { projects: [{ id: "p1", baseAccount: "0987652314", payers: [] }], reviews: [], activity: [] };
    const putResponse = await withFetch(fetchImpl, () => handleVercelRequest(new Request("https://vbirr.test/api/workspace", {
      method: "PUT",
      headers: { "content-type": "application/json", "x-vbirr-project-secret": "project-secret" },
      body: JSON.stringify({ workspace })
    })));
    const putBody = await putResponse.json();
    assert.equal(putBody.ok, true);
    assert.deepEqual(commands[1].command, ["SET", "vbirr:organization-workspace:v1", JSON.stringify(workspace)]);
  } finally {
    restoreEnv();
  }
});

test("Vercel legacy screenshot endpoint rejects image bodies without any outbound request", async () => {
  const restoreEnv = setEnvironment({ VBIRR_PROJECT_SECRET: "project-secret", VBIRR_RECEIPT_PROVIDER_KEY: "provider-secret" });
  let outboundCalls = 0;
  try {
    const response = await withFetch(async () => { outboundCalls += 1; return new Response("unexpected"); }, () =>
      handleVercelRequest(new Request("https://vbirr.test/api/verify-image", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ imageBase64: "aGVsbG8=" })
      })));
    assert.equal(response.status, 410);
    assert.equal(outboundCalls, 0);
  } finally {
    restoreEnv();
  }
});
