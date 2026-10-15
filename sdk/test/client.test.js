import test from "node:test";
import assert from "node:assert/strict";
import { VBirrClient } from "../index.js";

const baseUrl = "https://vbirr.example";
const secret = "project-secret-never-return-this";
const info = {
  ok: true,
  providerKey: "cbe",
  fetchedAt: "2026-10-15T00:00:00Z",
  receipt: { source: "cbe-pdf", amount: 50, currency: "ETB" },
  accountChecks: {
    sender: { status: "matched", field: "payerAccount" },
    recipient: { status: "matched", field: "receiverAccount" }
  },
  decision: { status: "matched", grant: true },
  project: null,
  providerResponse: { receipt: { reference: "TX-001234", transferredAmount: 50 } }
};

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

test("generic verify accepts transactionNumber and returns the transaction result info", async () => {
  let request;
  const client = new VBirrClient({
    baseUrl,
    projectSecret: secret,
    fetchImpl: async (url, options) => {
      request = { url: String(url), options };
      return jsonResponse(info);
    }
  });
  const result = await client.verify({
    baseAccount: "0987652314",
    clientAccount: "0912792308",
    transactionNumber: "TX-001234",
    idempotencyKey: "payment-123"
  });

  assert.equal(request.url, `${baseUrl}/api/verify`);
  assert.equal(request.options.method, "POST");
  assert.equal(request.options.headers["x-vbirr-project-secret"], secret);
  assert.equal(request.options.headers["Idempotency-Key"], "payment-123");
  assert.deepEqual(JSON.parse(request.options.body), {
    reference: "TX-001234",
    baseAccount: "0987652314",
    clientAccount: "0912792308"
  });
  assert.equal(result.success, true);
  assert.equal(result.status, "matched");
  assert.deepEqual(result.receipt, info.receipt);
  assert.deepEqual(result.accountChecks, info.accountChecks);
  assert.deepEqual(result.providerResponse, info.providerResponse);
  assert.equal(JSON.stringify(result).includes(secret), false);
});

test("generic and project verification reject missing, duplicate, or incomplete inputs without a request", async () => {
  let calls = 0;
  const client = new VBirrClient({
    baseUrl,
    projectSecret: secret,
    fetchImpl: async () => { calls += 1; return jsonResponse(info); }
  });
  const missing = await client.verify({ baseAccount: "0987652314", clientAccount: "0912792308" });
  const duplicate = await client.verify({ baseAccount: "0987652314", clientAccount: "0912792308", reference: "TX-001234", transactionNumber: "TX-001234" });
  const invalidProject = await client.verifyProject({ projectId: "p1", clientAccount: "***", transactionNumber: "TX-001234" });

  assert.equal(missing.error.code, "INVALID_RECEIPT_INPUT");
  assert.equal(duplicate.error.code, "INVALID_RECEIPT_INPUT");
  assert.equal(invalidProject.error.code, "INVALID_ACCOUNTS");
  assert.equal(calls, 0);
});

test("createProject persists a fixed base account through the workspace API", async () => {
  const calls = [];
  let workspace = { projects: [], reviews: [], activity: [] };
  const client = new VBirrClient({
    baseUrl,
    projectSecret: secret,
    idFactory: () => "project-123",
    fetchImpl: async (url, options) => {
      calls.push({ path: new URL(url).pathname, method: options.method, body: options.body ? JSON.parse(options.body) : null });
      if (options.method === "GET") return jsonResponse({ ok: true, workspace, storage: "server" });
      workspace = JSON.parse(options.body).workspace;
      return jsonResponse({ ok: true, storage: "server" });
    }
  });
  const project = await client.createProject({
    organization: "Example Trading PLC",
    name: "Monthly collections",
    accountType: "CBE",
    baseAccount: "0987652314",
    createdAt: "2026-10-16T00:00:00.000Z"
  });

  assert.deepEqual(project, {
    id: "project-123",
    organization: "Example Trading PLC",
    name: "Monthly collections",
    accountType: "CBE",
    baseAccount: "0987652314",
    payers: [],
    createdAt: "2026-10-16T00:00:00.000Z"
  });
  assert.equal(calls[0].path, "/api/workspace");
  assert.equal(calls[0].method, "GET");
  assert.equal(calls[1].method, "PUT");
  assert.deepEqual(workspace.projects[0], project);
});

test("SDK supports the full create project, register payer, then validate transaction flow", async () => {
  let workspace = { projects: [], reviews: [], activity: [] };
  let nextId = 0;
  let verificationBody;
  const client = new VBirrClient({
    baseUrl,
    projectSecret: secret,
    idFactory: () => `generated-${++nextId}`,
    fetchImpl: async (url, options) => {
      const path = new URL(url).pathname;
      if (path === "/api/workspace" && options.method === "GET") {
        return jsonResponse({ ok: true, workspace });
      }
      if (path === "/api/workspace" && options.method === "PUT") {
        workspace = JSON.parse(options.body).workspace;
        return jsonResponse({ ok: true });
      }
      if (path === "/api/verify") {
        verificationBody = JSON.parse(options.body);
        return jsonResponse({
          ...info,
          project: { id: verificationBody.projectId, registeredPayer: true }
        });
      }
      return jsonResponse({ ok: false, error: { code: "not_found" } }, 404);
    }
  });

  const project = await client.createProject({
    organization: "Example Trading PLC",
    name: "Monthly collections",
    accountType: "CBE",
    baseAccount: "0987652314"
  });
  await client.addPayer({ projectId: project.id, name: "Payer One", accountNumber: "0912792308" });
  const result = await client.verifyProject({
    projectId: project.id,
    clientAccount: "0912792308",
    transactionNumber: "TX-001234"
  });

  assert.deepEqual(verificationBody, {
    reference: "TX-001234",
    projectId: project.id,
    clientAccount: "0912792308"
  });
  assert.equal(workspace.projects[0].baseAccount, "0987652314");
  assert.equal(workspace.projects[0].payers[0].accountNumber, "0912792308");
  assert.equal(result.success, true);
  assert.equal(result.project.registeredPayer, true);
});

test("addPayer registers a full account and prevents duplicate normalized accounts", async () => {
  let workspace = {
    projects: [{ id: "p1", baseAccount: "0987652314", payers: [] }],
    reviews: [], activity: []
  };
  const client = new VBirrClient({
    baseUrl,
    projectSecret: secret,
    idFactory: () => "payer-1",
    fetchImpl: async (_url, options) => {
      if (options.method === "GET") return jsonResponse({ ok: true, workspace });
      workspace = JSON.parse(options.body).workspace;
      return jsonResponse({ ok: true });
    }
  });
  const payer = await client.addPayer({ projectId: "p1", name: "Payer One", accountNumber: "0912-792-308" });
  assert.deepEqual(payer, {
    id: "payer-1", name: "Payer One", accountNumber: "0912-792-308", createdAt: payer.createdAt
  });
  assert.equal(workspace.projects[0].payers.length, 1);
  await assert.rejects(
    () => client.addPayer({ projectId: "p1", name: "Duplicate", accountNumber: "0912792308" }),
    { code: "PAYER_ALREADY_EXISTS" }
  );
});

test("verifyProject sends only project id, client account, and transaction locator; needs_review is not success", async () => {
  let sent;
  const response = {
    ...info,
    decision: { status: "needs_review", grant: false },
    project: { id: "project-123", registeredPayer: false }
  };
  const client = new VBirrClient({
    baseUrl,
    projectSecret: secret,
    fetchImpl: async (_url, options) => {
      sent = JSON.parse(options.body);
      return jsonResponse(response);
    }
  });
  const result = await client.verifyProject({
    projectId: "project-123",
    clientAccount: "0912792308",
    transactionNumber: "TX-001234"
  });

  assert.deepEqual(sent, { reference: "TX-001234", projectId: "project-123", clientAccount: "0912792308" });
  assert.equal(result.status, "needs_review");
  assert.equal(result.success, false);
  assert.equal(result.project.registeredPayer, false);
  assert.match(result.message, /manual review/i);
});

test("createProject rejects invalid accounts before contacting the workspace", async () => {
  let calls = 0;
  const client = new VBirrClient({ baseUrl, projectSecret: secret, fetchImpl: async () => { calls += 1; return jsonResponse({}); } });
  await assert.rejects(
    () => client.createProject({ organization: "Org", name: "Project", accountType: "CBE", baseAccount: "251-***-333" }),
    /full, unmasked account number/
  );
  assert.equal(calls, 0);
});
