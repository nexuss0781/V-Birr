const LINKS_VERIFY_URL = "https://links.et/api/verify";
const LINKS_HEALTH_URL = LINKS_VERIFY_URL;
const MAX_WORKSPACE_BYTES = 4 * 1024 * 1024;
const RECEIPT_HOSTS = new Set([
  "transactioninfo.ethiotelecom.et",
  "apps.cbe.com.et",
  "mb.cbe.com.et",
  "mbreciept.cbe.com.et",
  "cbepay1.cbe.com.et",
  "cbepay2.cbe.com.et",
  "cs.bankofabyssinia.com",
  "share.zemenbank.com",
  "awashpay.awashbank.com",
  "receipts.dashenbanksc.com",
  "receipt.dashensuperapp.com",
  "api.dashensuperapp.com",
  "m-pesabusiness.safaricom.et",
  "receipt.ebirr.com",
  "receipt.amharabank.com.et",
  "transaction.amharabank.com.et",
  "abaymobile.com.et",
  "transactioninfo.berhanonline.et",
  "obinfo.oromiabank.com",
  "receipt.ahadubank.com",
  "receipts.siinqeebank.com",
  "receipt.zamzambank.com.et",
  "et.hulubeje.com"
]);
const NONSTANDARD_PORTS = {
  "awashpay.awashbank.com": "8225",
  "receipts.siinqeebank.com": "871"
};
const SOURCE_FIELDS = {
  "telebirr-html": {
    sender: ["payerTelebirrNo"], recipient: ["creditedPartyAccountNo"], amount: ["settledAmount"], currency: null
  },
  "cbe-pdf": {
    sender: ["payerAccount"], recipient: ["receiverAccount"], amount: ["transferredAmount"], currency: ["currency"]
  },
  "mb-json": {
    sender: ["payerAccount"], recipient: ["receiverAccount"], amount: ["transferredAmount"], currency: ["currency"]
  },
  "zemen-pdf": {
    sender: ["payerAccount"], recipient: ["recipientAccount"], amount: ["settledAmount"], currency: ["currency"]
  },
  "boa-json": {
    sender: [], recipient: ["receiverAccount"], amount: ["transferredAmount"], currency: ["currency"]
  },
  "awash-html": {
    sender: ["transaction", "senderAccount"], recipient: ["transaction", "beneficiaryAccount"], amount: ["transaction", "amount"], currency: null
  }
};
const SAFE_ERRORS = {
  missing_key: "The verification service is not configured.",
  invalid_key: "The project secret was not accepted.",
  revoked_key: "The project secret was not accepted.",
  invalid_json: "The request body is invalid.",
  invalid_request: "Provide a valid receipt input, sender account, and receiving account.",
  rate_limited: "Verification is rate limited. Wait before trying again.",
  quota_exceeded: "The verification quota has been reached.",
  provider_down: "The receipt source is temporarily unavailable.",
  verification_failed: "The receipt could not be verified at the source."
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store, private",
      "x-content-type-options": "nosniff"
    }
  });
}
function constantTimeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
function accountDigits(value) {
  if (typeof value !== "string" || value.length > 64) return "";
  if (/[xX*•…]/u.test(value)) return "";
  return value.replace(/\D/g, "");
}
function validExpectedAccount(value) {
  const digits = accountDigits(value);
  return typeof value === "string" && digits.length >= 4 && digits.length <= 32;
}
function getPath(object, path) {
  let current = object;
  for (const key of path) {
    if (!current || typeof current !== "object") return undefined;
    current = current[key];
  }
  return current;
}
function firstReceiptValue(receipt, path) {
  if (!Array.isArray(path) || path.length === 0) return undefined;
  const value = getPath(receipt, path);
  return value === null || value === undefined || value === "" ? undefined : value;
}
function compareAccount(expected, returned) {
  if (returned === undefined) return "unavailable";
  if (typeof returned !== "string" && typeof returned !== "number") return "inconclusive";
  const actual = String(returned);
  if (/[xX*•…]/u.test(actual)) return "inconclusive";
  const a = accountDigits(actual);
  const e = accountDigits(expected);
  if (!a || !e) return "inconclusive";
  return a === e ? "matched" : "mismatch";
}
function resolveReceiptUrl(value) {
  if (typeof value !== "string" || value.length > 2048) return null;
  let parsed;
  try { parsed = new URL(value); } catch { return null; }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) return null;
  const host = parsed.hostname.toLowerCase();
  if (!RECEIPT_HOSTS.has(host)) return null;
  if (parsed.port && parsed.port !== (NONSTANDARD_PORTS[host] || "")) return null;
  return parsed.toString();
}
function safeUpstreamError(body, status) {
  let code = body && typeof body === "object" && body.error && typeof body.error === "object" ? body.error.code : null;
  if (typeof code !== "string" || !Object.hasOwn(SAFE_ERRORS, code)) {
    code = status === 401 ? "verification_failed" : status === 429 ? "rate_limited" : status === 503 ? "provider_down" : "verification_failed";
  }
  const http = status === 429 ? 429 : status === 503 ? 503 : status === 502 ? 502 : status === 400 ? 400 : 502;
  return { code, message: SAFE_ERRORS[code], http };
}
async function readJsonBody(request, maxBytes = 8192) {
  const length = Number(request.headers.get("content-length") || 0);
  if (length > maxBytes) return null;
  const text = await request.text();
  if (text.length > maxBytes) return null;
  try { return JSON.parse(text); } catch { return null; }
}
async function readProviderResponse(response) {
  const text = await response.text();
  try {
    return { body: JSON.parse(text), text };
  } catch {
    return { body: null, text };
  }
}
function providerApiKey(env) {
  return env.VBIRR_RECEIPT_PROVIDER_KEY || env.LINKS_ET_API_KEY || "";
}
function requestAuthError(request, env) {
  if (!env.VBIRR_PROJECT_SECRET || !providerApiKey(env)) {
    return json({ ok: false, error: { code: "service_not_configured", message: SAFE_ERRORS.missing_key }, vbirr: { status: "failed", code: "SERVICE_NOT_CONFIGURED" } }, 503);
  }
  const suppliedSecret = request.headers.get("x-vbirr-project-secret") || "";
  if (!constantTimeEqual(suppliedSecret, env.VBIRR_PROJECT_SECRET)) {
    return json({ ok: false, error: { code: "invalid_project_secret", message: SAFE_ERRORS.invalid_key }, vbirr: { status: "failed", code: "INVALID_PROJECT_SECRET" } }, 401);
  }
  return null;
}
function workspaceAuthError(request, env) {
  if (!env.VBIRR_PROJECT_SECRET) {
    return json({ ok: false, error: { code: "workspace_not_configured", message: "The V-Birr workspace is not configured." } }, 503);
  }
  const suppliedSecret = request.headers.get("x-vbirr-project-secret") || "";
  if (!constantTimeEqual(suppliedSecret, env.VBIRR_PROJECT_SECRET)) {
    return json({ ok: false, error: { code: "invalid_project_secret", message: SAFE_ERRORS.invalid_key } }, 401);
  }
  return null;
}
function emptyWorkspace() {
  return { projects: [], reviews: [], activity: [] };
}
function validWorkspace(value) {
  return value && typeof value === "object" && !Array.isArray(value) &&
    Array.isArray(value.projects) && value.projects.length <= 500 &&
    Array.isArray(value.reviews) && value.reviews.length <= 5000 &&
    Array.isArray(value.activity) && value.activity.length <= 5000;
}
function workspaceStub(env) {
  if (!env.VBIRR_WORKSPACE) return null;
  const id = env.VBIRR_WORKSPACE.idFromName("vbirr-organization-workspace");
  return env.VBIRR_WORKSPACE.get(id);
}
async function loadWorkspace(env) {
  const stub = workspaceStub(env);
  if (!stub) return null;
  const response = await stub.fetch("https://vbirr-workspace/state", { method: "GET" });
  if (!response.ok) return null;
  const data = await response.json();
  return validWorkspace(data.workspace) ? data.workspace : emptyWorkspace();
}
async function manageWorkspace(request, env) {
  const authError = workspaceAuthError(request, env);
  if (authError) return authError;
  const stub = workspaceStub(env);
  if (!stub) return json({ ok: false, error: { code: "workspace_not_configured", message: "Server-side workspace storage is not configured." } }, 503);
  if (request.method === "GET") {
    try {
      const response = await stub.fetch("https://vbirr-workspace/state", { method: "GET" });
      const data = await response.json();
      return response.ok && validWorkspace(data.workspace)
        ? json({ ok: true, workspace: data.workspace, storage: "server" })
        : json({ ok: false, error: { code: "workspace_unavailable", message: "The V-Birr workspace could not be loaded." } }, 503);
    } catch {
      return json({ ok: false, error: { code: "workspace_unavailable", message: "The V-Birr workspace could not be loaded." } }, 503);
    }
  }
  if (request.method !== "PUT") return json({ ok: false, error: { code: "method_not_allowed", message: "Method not allowed." } }, 405);
  const body = await readJsonBody(request, MAX_WORKSPACE_BYTES);
  if (!body || !validWorkspace(body.workspace) || JSON.stringify(body).includes("imageBase64")) {
    return json({ ok: false, error: { code: "invalid_workspace", message: "The workspace update was not accepted." } }, 400);
  }
  try {
    const response = await stub.fetch("https://vbirr-workspace/state", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspace: body.workspace })
    });
    return response.ok ? json({ ok: true, storage: "server" }) : json({ ok: false, error: { code: "workspace_unavailable", message: "The V-Birr workspace could not be saved." } }, 503);
  } catch {
    return json({ ok: false, error: { code: "workspace_unavailable", message: "The V-Birr workspace could not be saved." } }, 503);
  }
}
function idempotencyHeader(request) {
  const idempotency = request.headers.get("Idempotency-Key");
  return idempotency && idempotency.length <= 128 && !/[\r\n]/.test(idempotency) ? idempotency : null;
}
function invalidIdempotency(request) {
  const idempotency = request.headers.get("Idempotency-Key");
  return Boolean(idempotency && (idempotency.length > 128 || /[\r\n]/.test(idempotency)));
}
async function postProvider(url, env, request, body) {
  const headers = {
    "x-api-key": providerApiKey(env),
    "content-type": "application/json",
    accept: "application/json"
  };
  const idempotency = idempotencyHeader(request);
  if (idempotency) headers["Idempotency-Key"] = idempotency;
  return fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    redirect: "manual"
  });
}
function makeDecision(receipt, expectedSender, expectedReceiver) {
  const source = typeof receipt?.source === "string" ? receipt.source : "unknown";
  const schema = SOURCE_FIELDS[source];
  const recipientPath = schema?.recipient || [];
  const senderPath = schema?.sender || [];
  const recipientStatus = compareAccount(expectedReceiver, firstReceiptValue(receipt, recipientPath));
  const senderStatus = compareAccount(expectedSender, firstReceiptValue(receipt, senderPath));
  const statuses = [recipientStatus, senderStatus];
  let status = "inconclusive";
  if (statuses.includes("mismatch")) status = "mismatch";
  else if (statuses.every((value) => value === "matched")) status = "matched";
  const amount = schema ? firstReceiptValue(receipt, schema.amount) : undefined;
  const currency = schema ? firstReceiptValue(receipt, schema.currency) : undefined;
  return {
    source,
    amount: typeof amount === "string" || typeof amount === "number" ? amount : null,
    currency: typeof currency === "string" ? currency : null,
    accountChecks: {
      recipient: { status: recipientStatus, field: recipientPath.length ? recipientPath.join(".") : null },
      sender: { status: senderStatus, field: senderPath.length ? senderPath.join(".") : null }
    },
    decision: { status, grant: status === "matched" }
  };
}
function responseFromProviderError(providerResponse, status) {
  const error = safeUpstreamError(providerResponse, status);
  return json({
    ok: false,
    error: { code: error.code, message: error.message },
    vbirr: { status: "failed", code: error.code.toUpperCase(), message: error.message },
    providerResponse: providerResponse ?? null
  }, error.http);
}
async function healthCheck() {
  try {
    const response = await fetch(LINKS_HEALTH_URL, { headers: { accept: "application/json" }, cf: { cacheTtl: 0, cacheEverything: false } });
    const data = await response.json();
    return response.ok && data?.ok === true
      ? json({ ok: true, service: "V-Birr", status: "online" })
      : json({ ok: false, service: "V-Birr", status: "unavailable" }, 503);
  } catch {
    return json({ ok: false, service: "V-Birr", status: "unavailable" }, 503);
  }
}
async function verify(request, env) {
  const authError = requestAuthError(request, env);
  if (authError) return authError;
  const body = await readJsonBody(request);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return json({ ok: false, error: { code: "invalid_json", message: SAFE_ERRORS.invalid_json }, vbirr: { status: "failed", code: "INVALID_JSON" } }, 400);
  }
  const hasUrl = typeof body.url === "string" && body.url.trim() !== "";
  const hasReference = typeof body.reference === "string" && body.reference.trim() !== "";
  if (hasUrl === hasReference || !validExpectedAccount(body.clientAccount) || invalidIdempotency(request)) {
    return json({ ok: false, error: { code: "invalid_request", message: SAFE_ERRORS.invalid_request }, vbirr: { status: "failed", code: "INVALID_REQUEST" } }, 400);
  }
  let project = null;
  let expectedBaseAccount = body.baseAccount;
  if (body.projectId !== undefined) {
    if (typeof body.projectId !== "string" || body.projectId.length < 1 || body.projectId.length > 128 || body.paymentBaseAccountOverride !== undefined) {
      return json({ ok: false, error: { code: "invalid_request", message: SAFE_ERRORS.invalid_request }, vbirr: { status: "failed", code: "INVALID_REQUEST" } }, 400);
    }
    let workspace;
    try { workspace = await loadWorkspace(env); } catch { workspace = null; }
    if (!workspace) {
      return json({ ok: false, error: { code: "workspace_not_configured", message: "Server-side workspace storage is unavailable." }, vbirr: { status: "failed", code: "WORKSPACE_UNAVAILABLE" } }, 503);
    }
    project = workspace.projects.find((item) => item && item.id === body.projectId) || null;
    if (!project) return json({ ok: false, error: { code: "project_not_found", message: "The organization project could not be found." }, vbirr: { status: "failed", code: "PROJECT_NOT_FOUND" } }, 404);
    expectedBaseAccount = project.baseAccount;
  }
  if (!validExpectedAccount(expectedBaseAccount)) {
    return json({ ok: false, error: { code: "invalid_request", message: SAFE_ERRORS.invalid_request }, vbirr: { status: "failed", code: "INVALID_REQUEST" } }, 400);
  }
  const receiptInput = hasUrl ? { url: resolveReceiptUrl(body.url.trim()) } : { reference: body.reference.trim() };
  if ((hasUrl && !receiptInput.url) || (hasReference && (receiptInput.reference.length > 128 || /[\r\n\t\s]/.test(receiptInput.reference)))) {
    return json({ ok: false, error: { code: "invalid_request", message: SAFE_ERRORS.invalid_request }, vbirr: { status: "failed", code: "INVALID_REQUEST" } }, 400);
  }
  const override = body.paymentBaseAccountOverride === undefined || body.paymentBaseAccountOverride === "" ? null : body.paymentBaseAccountOverride;
  if (override !== null && !validExpectedAccount(override)) {
    return json({ ok: false, error: { code: "invalid_request", message: SAFE_ERRORS.invalid_request }, vbirr: { status: "failed", code: "INVALID_REQUEST" } }, 400);
  }
  let upstream;
  try {
    upstream = await postProvider(LINKS_VERIFY_URL, env, request, receiptInput);
  } catch {
    const message = SAFE_ERRORS.verification_failed;
    return json({ ok: false, error: { code: "upstream_unavailable", message }, vbirr: { status: "failed", code: "UPSTREAM_UNAVAILABLE", message }, providerResponse: null }, 502);
  }
  const parsed = await readProviderResponse(upstream);
  const result = parsed.body;
  if (!upstream.ok || result?.ok !== true || !result?.receipt || typeof result.receipt !== "object") {
    return responseFromProviderError(result ?? parsed.text, upstream.status);
  }
  const registeredPayer = project ? (Array.isArray(project.payers) && project.payers.some((payer) => accountDigits(payer?.accountNumber) === accountDigits(body.clientAccount))) : null;
  const evaluated = makeDecision(result.receipt, body.clientAccount, override || expectedBaseAccount);
  if (project && !registeredPayer && evaluated.decision.grant) {
    evaluated.decision.status = "needs_review";
    evaluated.decision.grant = false;
  }
  return json({
    ok: true,
    providerKey: typeof result.providerKey === "string" ? result.providerKey : null,
    fetchedAt: typeof result.fetchedAt === "string" ? result.fetchedAt : null,
    receipt: { source: evaluated.source, amount: evaluated.amount, currency: evaluated.currency },
    accountChecks: evaluated.accountChecks,
    decision: evaluated.decision,
    vbirr: { status: evaluated.decision.status, code: project && evaluated.decision.status === "needs_review" ? "UNREGISTERED_PAYER" : evaluated.decision.status.toUpperCase() },
    project: project ? { id: project.id, registeredPayer } : null,
    providerResponse: result
  });
}
function screenshotUploadDisabled() {
  return json({
    ok: false,
    error: { code: "screenshot_upload_disabled", message: "Screenshot upload is disabled. Read the receipt locally and verify its URL or reference instead." },
    vbirr: { status: "failed", code: "SCREENSHOT_UPLOAD_DISABLED" }
  }, 410);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/health" && request.method === "GET") return healthCheck();
    if (url.pathname === "/api/workspace" && (request.method === "GET" || request.method === "PUT")) return manageWorkspace(request, env);
    if (url.pathname === "/api/verify" && request.method === "POST") return verify(request, env);
    if (url.pathname === "/api/verify-image" && request.method === "POST") return screenshotUploadDisabled();
    if (url.pathname.startsWith("/api/")) return json({ ok: false, error: { code: "not_found", message: "API route not found." } }, 404);
    return env.ASSETS.fetch(request);
  }
};

export class VBirrWorkspace {
  constructor(state) {
    this.state = state;
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname !== "/state") return json({ ok: false, error: { code: "not_found" } }, 404);
    if (request.method === "GET") {
      const workspace = await this.state.storage.get("workspace") || emptyWorkspace();
      return json({ ok: true, workspace });
    }
    if (request.method !== "PUT") return json({ ok: false, error: { code: "method_not_allowed" } }, 405);
    const body = await readJsonBody(request, MAX_WORKSPACE_BYTES);
    if (!body || !validWorkspace(body.workspace) || JSON.stringify(body).includes("imageBase64")) {
      return json({ ok: false, error: { code: "invalid_workspace" } }, 400);
    }
    await this.state.storage.put("workspace", body.workspace);
    return json({ ok: true });
  }
}
