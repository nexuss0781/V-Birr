const VERIFY_ENDPOINT = "https://links.et/api/verify";
const MAX_IMAGE_BASE64_LENGTH = 5 * 1024 * 1024;
import { chooseReceiptLocator } from "./receipt-locator.js";
import { readReceiptLocators } from "./local-ocr.js";
export { VBirrApiError, VBirrClient } from "./client.js";

const ACCOUNT_FIELDS = Object.freeze({
  "telebirr-html": {
    sender: ["payerTelebirrNo"],
    receiver: ["creditedPartyAccountNo"]
  },
  "cbe-pdf": {
    sender: ["payerAccount"],
    receiver: ["receiverAccount"]
  },
  "mb-json": {
    sender: ["payerAccount"],
    receiver: ["receiverAccount"]
  },
  "zemen-pdf": {
    sender: ["payerAccount"],
    receiver: ["recipientAccount"]
  },
  "boa-json": {
    sender: [],
    receiver: ["receiverAccount"]
  },
  "awash-html": {
    sender: ["transaction", "senderAccount"],
    receiver: ["transaction", "beneficiaryAccount"]
  }
});

const SAFE_MESSAGES = Object.freeze({
  missing_key: "V-Birr is not configured for receipt verification.",
  invalid_key: "V-Birr could not authenticate the verification request.",
  revoked_key: "V-Birr could not authenticate the verification request.",
  invalid_json: "The receipt request could not be read.",
  invalid_request: "The receipt details were not accepted. Check the receipt URL or reference.",
  rate_limited: "Verification is temporarily rate limited. Try again later.",
  quota_exceeded: "The verification limit has been reached.",
  provider_down: "The receipt source is temporarily unavailable.",
  verification_failed: "The receipt could not be verified."
});

const SAFE_CODES = new Set(Object.keys(SAFE_MESSAGES));
const MASKED_VALUE = /[xX*•…]/u;

function result(status, message, extra = {}) {
  return {
    success: status === "verified",
    status,
    message,
    ...extra
  };
}

function normalizeAccount(value) {
  if (typeof value !== "string" || value.length > 64 || MASKED_VALUE.test(value)) {
    return null;
  }
  const digits = value.replace(/\D/g, "");
  return digits.length >= 4 && digits.length <= 32 ? digits : null;
}

function accountMatch(expectedDigits, actual) {
  if (actual === undefined || actual === null || actual === "") return "unavailable";
  if (typeof actual !== "string" && typeof actual !== "number") return "inconclusive";

  const value = String(actual);
  if (MASKED_VALUE.test(value)) return "inconclusive";
  const actualDigits = value.replace(/\D/g, "");
  if (actualDigits.length < 4) return "inconclusive";
  return actualDigits === expectedDigits ? "matched" : "mismatch";
}

function getPath(object, path) {
  let value = object;
  for (const key of path) {
    if (!value || typeof value !== "object") return undefined;
    value = value[key];
  }
  return value;
}

function validReceiptUrl(value) {
  if (typeof value !== "string" || value.length > 2048) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password;
  } catch {
    return false;
  }
}

function safeError(body, httpStatus) {
  const candidate = body && typeof body === "object" && body.error && typeof body.error === "object"
    ? body.error.code
    : null;
  const code = typeof candidate === "string" && SAFE_CODES.has(candidate)
    ? candidate
    : httpStatus === 429
      ? "rate_limited"
      : httpStatus === 503
        ? "provider_down"
        : "verification_failed";

  return { code: code.toUpperCase(), message: SAFE_MESSAGES[code] };
}

async function readJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

/**
 * V-Birr's server-side receipt verification client.
 * Keep the token in a server environment; never instantiate this class in browser code.
 */
export class VBirrVerificationClient {
  constructor({ token, fetchImpl = globalThis.fetch, timeoutMs = 130_000, ocrImpl = readReceiptLocators } = {}) {
    if (typeof token !== "string" || token.length === 0) {
      throw new TypeError("A V-Birr verification token is required.");
    }
    if (typeof fetchImpl !== "function") {
      throw new TypeError("This SDK requires a Fetch-compatible implementation.");
    }
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000) {
      throw new RangeError("timeoutMs must be an integer between 1 and 300000.");
    }

    this.token = token;
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.ocrImpl = ocrImpl;
  }

  /**
   * Verify that a receipt's sender and receiver accounts match the supplied accounts.
   * Provide exactly one of receiptUrl or reference. This method never initiates a payment.
   */
  async verify({ sender, receiver, receiptUrl, reference, idempotencyKey, signal } = {}) {
    const senderDigits = normalizeAccount(sender);
    const receiverDigits = normalizeAccount(receiver);
    if (!senderDigits || !receiverDigits) {
      return result("failed", "Enter valid sender and receiver account identifiers.", {
        error: { code: "INVALID_ACCOUNTS" }
      });
    }

    const hasUrl = typeof receiptUrl === "string" && receiptUrl.trim().length > 0;
    const hasReference = typeof reference === "string" && reference.trim().length > 0;
    if (hasUrl === hasReference) {
      return result("failed", "Provide exactly one receipt URL or reference.", {
        error: { code: "INVALID_RECEIPT_INPUT" }
      });
    }
    if (hasUrl && !validReceiptUrl(receiptUrl.trim())) {
      return result("failed", "Provide a valid HTTPS receipt URL.", {
        error: { code: "INVALID_RECEIPT_URL" }
      });
    }
    if (hasReference && (reference.trim().length > 128 || /[\s\r\n]/u.test(reference.trim()))) {
      return result("failed", "Provide a valid receipt reference.", {
        error: { code: "INVALID_REFERENCE" }
      });
    }
    if (idempotencyKey !== undefined && (
      typeof idempotencyKey !== "string" ||
      idempotencyKey.length < 1 ||
      idempotencyKey.length > 128 ||
      /[\r\n]/u.test(idempotencyKey)
    )) {
      return result("failed", "The idempotency key is invalid.", {
        error: { code: "INVALID_IDEMPOTENCY_KEY" }
      });
    }

    const requestBody = hasUrl
      ? { url: receiptUrl.trim() }
      : { reference: reference.trim() };
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.timeoutMs);
    timer.unref?.();

    const abortFromCaller = () => controller.abort();
    if (signal?.aborted) {
      abortFromCaller();
    } else {
      signal?.addEventListener?.("abort", abortFromCaller, { once: true });
    }

    try {
      const headers = {
        "content-type": "application/json",
        accept: "application/json",
        "x-api-key": this.token
      };
      if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;

      const response = await this.fetchImpl(VERIFY_ENDPOINT, {
        method: "POST",
        headers,
        body: JSON.stringify(requestBody),
        signal: controller.signal,
        redirect: "error"
      });
      const body = await readJson(response);

      if (response.status === 202) {
        return result("inconclusive", "The receipt is still processing; check it again shortly.", {
          error: { code: "PROCESSING" }
        });
      }
      if (!response.ok || body?.ok !== true || !body.receipt || typeof body.receipt !== "object") {
        const error = safeError(body, response.status);
        return result("failed", error.message, { error });
      }

      const receipt = body.receipt;
      const schema = ACCOUNT_FIELDS[receipt.source];
      const senderStatus = schema?.sender.length
        ? accountMatch(senderDigits, getPath(receipt, schema.sender))
        : "unavailable";
      const receiverStatus = schema?.receiver.length
        ? accountMatch(receiverDigits, getPath(receipt, schema.receiver))
        : "unavailable";
      const checks = { sender: senderStatus, receiver: receiverStatus };

      if (senderStatus === "matched" && receiverStatus === "matched") {
        return result("verified", "V-Birr verified that both accounts match the receipt.", { checks });
      }
      if (senderStatus === "mismatch" || receiverStatus === "mismatch") {
        return result("failed", "The sender or receiver account does not match the receipt.", { checks });
      }
      return result("inconclusive", "The receipt does not expose enough account detail to verify both parties.", { checks });
    } catch {
      if (timedOut) {
        return result("failed", "Receipt verification timed out. Try again later.", {
          error: { code: "TIMEOUT" }
        });
      }
      if (signal?.aborted) {
        return result("failed", "Receipt verification was cancelled.", {
          error: { code: "CANCELLED" }
        });
      }
      return result("failed", "V-Birr could not reach the receipt verification service.", {
        error: { code: "NETWORK_ERROR" }
      });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener?.("abort", abortFromCaller);
    }
  }

  /**
   * OCR a screenshot locally in memory, then verify only its receipt URL/reference.
   * Screenshot bytes are never sent to the verification provider.
   */
  async verifyImage({ sender, receiver, imageBase64, idempotencyKey, signal } = {}) {
    const senderDigits = normalizeAccount(sender);
    const receiverDigits = normalizeAccount(receiver);
    if (!senderDigits || !receiverDigits) {
      return result("failed", "Enter valid sender and receiver account identifiers.", {
        error: { code: "INVALID_ACCOUNTS" }
      });
    }
    if (typeof imageBase64 !== "string" || imageBase64.trim() === "") {
      return result("failed", "Provide a receipt screenshot as base64.", { error: { code: "INVALID_IMAGE" } });
    }
    const trimmedImage = imageBase64.trim();
    const prefix = trimmedImage.match(/^data:image\/[a-zA-Z0-9.+-]+;base64,/);
    const normalizedImage = prefix ? trimmedImage.slice(prefix[0].length) : trimmedImage;
    if (
      normalizedImage.length > MAX_IMAGE_BASE64_LENGTH ||
      normalizedImage.length % 4 === 1 ||
      !/^[A-Za-z0-9+/]*={0,2}$/u.test(normalizedImage)
    ) {
      return result("failed", "Provide a valid screenshot no larger than 5 MB encoded.", { error: { code: "INVALID_IMAGE" } });
    }
    if (idempotencyKey !== undefined && (
      typeof idempotencyKey !== "string" || idempotencyKey.length < 1 ||
      idempotencyKey.length > 128 || /[\r\n]/u.test(idempotencyKey)
    )) {
      return result("failed", "The idempotency key is invalid.", { error: { code: "INVALID_IDEMPOTENCY_KEY" } });
    }

    if (signal?.aborted) return result("failed", "Receipt verification was cancelled.", { error: { code: "CANCELLED" } });
    const imageBytes = Buffer.from(normalizedImage, "base64");
    let candidates;
    try {
      candidates = await this.ocrImpl(imageBytes);
    } catch {
      return result("inconclusive", "The screenshot could not be read locally. Enter its receipt URL or reference manually.", {
        error: { code: "LOCAL_OCR_FAILED" }
      });
    } finally {
      imageBytes.fill(0);
    }
    if (signal?.aborted) return result("failed", "Receipt verification was cancelled.", { error: { code: "CANCELLED" } });
    const locator = chooseReceiptLocator(candidates);
    if (!locator) {
      const referenceCandidates = Array.isArray(candidates)
        ? candidates.filter((item) => item && (item.type === "url" || item.type === "reference")).map(({ type, value }) => ({ type, value }))
        : [];
      return result("inconclusive", referenceCandidates.length
        ? "More than one receipt URL or reference was found. Select the correct one and verify it manually."
        : "The screenshot did not contain a supported receipt URL or reference. Enter one manually.", {
        error: { code: referenceCandidates.length ? "AMBIGUOUS_RECEIPT_LOCATOR" : "RECEIPT_LOCATOR_NOT_FOUND" },
        referenceCandidates
      });
    }
    const verified = await this.verify({
      sender,
      receiver,
      ...(locator.type === "url" ? { receiptUrl: locator.value } : { reference: locator.value }),
      idempotencyKey,
      signal
    });
    return { ...verified, parsedFromScreenshot: true };
  }
}

export default VBirrVerificationClient;
