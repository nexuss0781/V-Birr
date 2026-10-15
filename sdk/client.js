import { randomUUID } from "node:crypto";

const DEFAULT_TIMEOUT_MS = 30_000;
const MASKED_VALUE = /[xX*•…]/u;

function accountDigits(value) {
  if (typeof value !== "string" || value.length > 64 || MASKED_VALUE.test(value)) return "";
  return value.replace(/\D/gu, "");
}

function validAccount(value) {
  const digits = accountDigits(value);
  return typeof value === "string" && digits.length >= 4 && digits.length <= 32;
}

function validateLocator({ receiptUrl, reference, transactionNumber } = {}) {
  const hasUrl = typeof receiptUrl === "string" && receiptUrl.trim() !== "";
  const hasReference = typeof reference === "string" && reference.trim() !== "";
  const hasTransactionNumber = typeof transactionNumber === "string" && transactionNumber.trim() !== "";
  if (Number(hasUrl) + Number(hasReference) + Number(hasTransactionNumber) !== 1) {
    return { error: "Provide exactly one receipt URL, reference, or transaction number." };
  }
  if (hasUrl) {
    let url;
    try { url = new URL(receiptUrl.trim()); }
    catch { return { error: "Provide a valid HTTPS receipt URL." }; }
    if (url.protocol !== "https:" || url.username || url.password || receiptUrl.trim().length > 2048) {
      return { error: "Provide a valid HTTPS receipt URL." };
    }
    return { input: { url: url.toString() } };
  }
  const value = (hasReference ? reference : transactionNumber).trim();
  if (value.length > 128 || /[\s\r\n]/u.test(value)) {
    return { error: "Provide a valid receipt transaction number or reference." };
  }
  return { input: { reference: value } };
}

function safeMessage(status) {
  if (status === "matched") return "Receipt verified: sender and receiving accounts matched.";
  if (status === "needs_review") return "The receipt matches the account details, but the sender is not registered; manual review is required.";
  if (status === "mismatch") return "The sender or receiving account does not match the receipt.";
  if (status === "inconclusive") return "The receipt does not expose enough detail to verify both accounts.";
  return "V-Birr could not verify the receipt.";
}

function errorCode(body, fallback = "REQUEST_FAILED") {
  const code = body?.error?.code;
  return typeof code === "string" && /^[a-z0-9_-]{1,64}$/iu.test(code)
    ? code.toUpperCase()
    : fallback;
}

export class VBirrApiError extends Error {
  constructor(message, { status = 0, code = "REQUEST_FAILED" } = {}) {
    super(message);
    this.name = "VBirrApiError";
    this.status = status;
    this.code = code;
  }
}

/**
 * Server-side client for the V-Birr API. Keep projectSecret on a trusted server.
 * It supports generic receipt validation, organization projects, payer registration,
 * and project-bound validation. It never initiates or authorizes a payment.
 */
export class VBirrClient {
  constructor({ baseUrl, projectSecret, fetchImpl = globalThis.fetch, timeoutMs = DEFAULT_TIMEOUT_MS, idFactory = randomUUID } = {}) {
    if (typeof baseUrl !== "string" || baseUrl.trim() === "") {
      throw new TypeError("A V-Birr API baseUrl is required.");
    }
    let parsedBase;
    try { parsedBase = new URL(baseUrl); }
    catch { throw new TypeError("baseUrl must be a valid URL."); }
    const localHttp = parsedBase.protocol === "http:" && ["localhost", "127.0.0.1", "::1"].includes(parsedBase.hostname);
    if ((parsedBase.protocol !== "https:" && !localHttp) || parsedBase.username || parsedBase.password || parsedBase.search || parsedBase.hash) {
      throw new TypeError("baseUrl must be an HTTPS URL (HTTP is allowed only for localhost).");
    }
    if (typeof projectSecret !== "string" || projectSecret.length === 0) {
      throw new TypeError("A V-Birr project secret is required.");
    }
    if (typeof fetchImpl !== "function") {
      throw new TypeError("This SDK requires a Fetch-compatible implementation.");
    }
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000) {
      throw new RangeError("timeoutMs must be an integer between 1 and 300000.");
    }
    if (typeof idFactory !== "function") {
      throw new TypeError("idFactory must be a function.");
    }

    this.baseUrl = parsedBase.toString().replace(/\/+$/u, "");
    this.projectSecret = projectSecret;
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.idFactory = idFactory;
  }

  async #request(path, { method = "GET", body, idempotencyKey, signal } = {}) {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.timeoutMs);
    timer.unref?.();
    const abortFromCaller = () => controller.abort();
    if (signal?.aborted) abortFromCaller();
    else signal?.addEventListener?.("abort", abortFromCaller, { once: true });

    try {
      const headers = {
        accept: "application/json",
        "x-vbirr-project-secret": this.projectSecret
      };
      const options = { method, headers, signal: controller.signal, redirect: "error" };
      if (body !== undefined) {
        headers["content-type"] = "application/json";
        options.body = JSON.stringify(body);
      }
      if (idempotencyKey !== undefined) {
        if (typeof idempotencyKey !== "string" || idempotencyKey.length < 1 || idempotencyKey.length > 128 || /[\r\n]/u.test(idempotencyKey)) {
          throw new VBirrApiError("The idempotency key is invalid.", { code: "INVALID_IDEMPOTENCY_KEY" });
        }
        headers["Idempotency-Key"] = idempotencyKey;
      }

      const response = await this.fetchImpl(new URL(path, `${this.baseUrl}/`), options);
      let data;
      try { data = await response.json(); }
      catch { data = null; }
      if (!response.ok || data?.ok === false) {
        const message = typeof data?.error?.message === "string"
          ? data.error.message
          : "The V-Birr API request was not accepted.";
        throw new VBirrApiError(message, { status: response.status, code: errorCode(data) });
      }
      if (!data || typeof data !== "object" || Array.isArray(data)) {
        throw new VBirrApiError("The V-Birr API returned an invalid response.", { status: response.status, code: "INVALID_RESPONSE" });
      }
      return data;
    } catch (error) {
      if (error instanceof VBirrApiError) throw error;
      if (timedOut) throw new VBirrApiError("The V-Birr API request timed out.", { code: "TIMEOUT" });
      if (signal?.aborted) throw new VBirrApiError("The V-Birr API request was cancelled.", { code: "CANCELLED" });
      throw new VBirrApiError("The V-Birr API could not be reached.", { code: "NETWORK_ERROR" });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener?.("abort", abortFromCaller);
    }
  }

  /** Load the server-side project, payer, activity, and review workspace. */
  async getWorkspace({ signal } = {}) {
    const data = await this.#request("/api/workspace", { signal });
    if (!data.workspace || !Array.isArray(data.workspace.projects) ||
        !Array.isArray(data.workspace.reviews) || !Array.isArray(data.workspace.activity)) {
      throw new VBirrApiError("The V-Birr workspace response is invalid.", { code: "INVALID_WORKSPACE" });
    }
    return data.workspace;
  }

  async #saveWorkspace(workspace, { signal } = {}) {
    await this.#request("/api/workspace", { method: "PUT", body: { workspace }, signal });
    return workspace;
  }

  /**
   * Create a project in the server workspace. Its baseAccount becomes the
   * fixed receiving account used by verifyProject and cannot be overridden there.
   */
  async createProject({ organization, name, accountType, baseAccount, id, createdAt, signal } = {}) {
    const normalized = {
      organization: typeof organization === "string" ? organization.trim() : "",
      name: typeof name === "string" ? name.trim() : "",
      accountType: typeof accountType === "string" ? accountType.trim() : "",
      baseAccount: typeof baseAccount === "string" ? baseAccount.trim() : ""
    };
    if (!normalized.organization || normalized.organization.length > 100) {
      throw new TypeError("organization is required and must be at most 100 characters.");
    }
    if (!normalized.name || normalized.name.length > 80) {
      throw new TypeError("name is required and must be at most 80 characters.");
    }
    if (!normalized.accountType || normalized.accountType.length > 80) {
      throw new TypeError("accountType is required and must be at most 80 characters.");
    }
    if (!validAccount(normalized.baseAccount)) {
      throw new TypeError("baseAccount must be a full, unmasked account number.");
    }
    const projectId = id === undefined ? this.idFactory() : id;
    if (typeof projectId !== "string" || projectId.length < 1 || projectId.length > 128) {
      throw new TypeError("id must be a non-empty string of at most 128 characters.");
    }
    const timestamp = createdAt === undefined ? new Date().toISOString() : createdAt;
    if (typeof timestamp !== "string" || !Number.isFinite(Date.parse(timestamp))) {
      throw new TypeError("createdAt must be a valid date string.");
    }

    const workspace = await this.getWorkspace({ signal });
    if (workspace.projects.some((project) => project?.id === projectId)) {
      throw new VBirrApiError("A project with this id already exists.", { code: "PROJECT_ALREADY_EXISTS" });
    }
    const project = {
      id: projectId,
      ...normalized,
      payers: [],
      createdAt: timestamp
    };
    workspace.projects.unshift(project);
    await this.#saveWorkspace(workspace, { signal });
    return project;
  }

  /** Register a full payer account for project-based automatic validation. */
  async addPayer({ projectId, name, accountNumber, id, createdAt, signal } = {}) {
    if (typeof projectId !== "string" || projectId.length < 1 || projectId.length > 128) {
      throw new TypeError("projectId must be a non-empty string of at most 128 characters.");
    }
    const payerName = typeof name === "string" ? name.trim() : "";
    const normalizedAccount = typeof accountNumber === "string" ? accountNumber.trim() : "";
    if (!payerName || payerName.length > 90) throw new TypeError("name is required and must be at most 90 characters.");
    if (!validAccount(normalizedAccount)) throw new TypeError("accountNumber must be a full, unmasked account number.");

    const workspace = await this.getWorkspace({ signal });
    const project = workspace.projects.find((item) => item?.id === projectId);
    if (!project) throw new VBirrApiError("The project could not be found.", { status: 404, code: "PROJECT_NOT_FOUND" });
    project.payers = Array.isArray(project.payers) ? project.payers : [];
    const digits = accountDigits(normalizedAccount);
    if (project.payers.some((payer) => accountDigits(payer?.accountNumber) === digits)) {
      throw new VBirrApiError("This payer account is already registered to the project.", { code: "PAYER_ALREADY_EXISTS" });
    }
    const payerId = id === undefined ? this.idFactory() : id;
    if (typeof payerId !== "string" || payerId.length < 1 || payerId.length > 128) {
      throw new TypeError("id must be a non-empty string of at most 128 characters.");
    }
    const timestamp = createdAt === undefined ? new Date().toISOString() : createdAt;
    if (typeof timestamp !== "string" || !Number.isFinite(Date.parse(timestamp))) {
      throw new TypeError("createdAt must be a valid date string.");
    }
    const payer = { id: payerId, name: payerName, accountNumber: normalizedAccount, createdAt: timestamp };
    project.payers.push(payer);
    await this.#saveWorkspace(workspace, { signal });
    return payer;
  }

  /**
   * Generic receipt validation using the caller-supplied receiving/base account.
   * transactionNumber is an alias for reference. Receipt/account details returned
   * by the service are included for trusted server-side review.
   */
  async verify({ baseAccount, clientAccount, receiptUrl, reference, transactionNumber, idempotencyKey, signal } = {}) {
    if (!validAccount(baseAccount) || !validAccount(clientAccount)) {
      return this.#failed("Enter valid, full base and client account numbers.", "INVALID_ACCOUNTS");
    }
    const locator = validateLocator({ receiptUrl, reference, transactionNumber });
    if (locator.error) return this.#failed(locator.error, "INVALID_RECEIPT_INPUT");
    return this.#verifyRequest({ ...locator.input, baseAccount, clientAccount }, { idempotencyKey, signal });
  }

  /**
   * Validate a transaction against a stored project. The project’s baseAccount
   * is loaded by V-Birr and caller-supplied receiving-account overrides are not used.
   * Unregistered client accounts produce needs_review rather than an automatic grant.
   */
  async verifyProject({ projectId, clientAccount, receiptUrl, reference, transactionNumber, idempotencyKey, signal } = {}) {
    if (typeof projectId !== "string" || projectId.length < 1 || projectId.length > 128) {
      return this.#failed("Provide a valid project id.", "INVALID_PROJECT_ID");
    }
    if (!validAccount(clientAccount)) {
      return this.#failed("Enter a valid, full client account number.", "INVALID_ACCOUNTS");
    }
    const locator = validateLocator({ receiptUrl, reference, transactionNumber });
    if (locator.error) return this.#failed(locator.error, "INVALID_RECEIPT_INPUT");
    return this.#verifyRequest({ ...locator.input, projectId, clientAccount }, { idempotencyKey, signal });
  }

  async #verifyRequest(body, { idempotencyKey, signal } = {}) {
    try {
      const data = await this.#request("/api/verify", {
        method: "POST",
        body,
        idempotencyKey,
        signal
      });
      const status = typeof data.decision?.status === "string" ? data.decision.status : "failed";
      return {
        success: data.decision?.grant === true && status === "matched",
        status,
        message: safeMessage(status),
        receipt: data.receipt ?? null,
        fetchedAt: data.fetchedAt ?? null,
        providerKey: data.providerKey ?? null,
        accountChecks: data.accountChecks ?? null,
        decision: data.decision ?? { status: "failed", grant: false },
        project: data.project ?? null,
        providerResponse: data.providerResponse ?? null,
        error: data.ok === true ? null : { code: errorCode(data) }
      };
    } catch (error) {
      return this.#failed(error instanceof VBirrApiError ? error.message : "V-Birr could not verify the receipt.",
        error instanceof VBirrApiError ? error.code : "REQUEST_FAILED");
    }
  }

  #failed(message, code) {
    return {
      success: false,
      status: "failed",
      message,
      receipt: null,
      fetchedAt: null,
      providerKey: null,
      accountChecks: null,
      decision: { status: "failed", grant: false },
      project: null,
      providerResponse: null,
      error: { code }
    };
  }
}
