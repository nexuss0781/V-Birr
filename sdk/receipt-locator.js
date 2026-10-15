const URL_PATTERN = /\bhttps:\/\/[a-z0-9.-]+(?::\d+)?(?:\/[^\s<>"']*)?/giu;
const REFERENCE_PATTERN = /(?:transaction(?:\s*(?:id|no\.?|number|ref(?:erence)?))?|txn(?:\s*(?:id|no\.?|ref(?:erence)?))?|receipt(?:\s*(?:id|no\.?|number|ref(?:erence)?))?|reference(?:\s*(?:no\.?|number))?|ref(?:erence)?(?:\s*(?:no\.?|number))?|rrn|trace(?:\s*(?:id|no\.?|number))?)\s*(?:[:#=-]\s*|\s+)([A-Z0-9][A-Z0-9/_-]{5,63})/giu;
const TRAILING_PUNCTUATION = /[.,;:!?)}\]]+$/u;
const NON_REFERENCE_WORDS = new Set(["SUCCESS", "SUCCESSFUL", "COMPLETED", "TRANSFER", "PAYMENT", "RECEIPT", "REFERENCE"]);

function cleanLocator(value) {
  return String(value || "").trim().replace(TRAILING_PUNCTUATION, "");
}

export function findReceiptLocators(ocrText) {
  if (typeof ocrText !== "string" || !ocrText) return [];
  const found = new Map();
  for (const match of ocrText.matchAll(URL_PATTERN)) {
    const value = cleanLocator(match[0]);
    try {
      const url = new URL(value);
      if (url.protocol === "https:" && !url.username && !url.password) {
        found.set(`url:${url.toString().toLowerCase()}`, { type: "url", value: url.toString() });
      }
    } catch {}
  }
  for (const match of ocrText.matchAll(REFERENCE_PATTERN)) {
    const value = cleanLocator(match[1]);
    const compact = value.replace(/[^A-Z0-9]/giu, "");
    const digitCount = (compact.match(/\d/gu) || []).length;
    if (compact.length < 6 || digitCount < 3 || NON_REFERENCE_WORDS.has(compact.toUpperCase())) continue;
    found.set(`reference:${value.toUpperCase()}`, { type: "reference", value });
  }
  return [...found.values()];
}

export function chooseReceiptLocator(candidates) {
  if (!Array.isArray(candidates)) return null;
  const unique = new Map(candidates.map((item) => [`${item?.type}:${String(item?.value || "").toUpperCase()}`, item]));
  const values = [...unique.values()];
  const urls = values.filter((item) => item?.type === "url");
  if (urls.length === 1) return urls[0];
  if (urls.length > 1) return null;
  const references = values.filter((item) => item?.type === "reference");
  return references.length === 1 ? references[0] : null;
}
