import { createWorker } from "tesseract.js";
import { fileURLToPath } from "node:url";
import { findReceiptLocators } from "./receipt-locator.js";

const LANGUAGE_DIRECTORIES = Object.fromEntries(["eng", "amh"].map((language) => [
  language,
  fileURLToPath(new URL("./4.0.0/", import.meta.resolve(`@tesseract.js-data/${language}`)))
]));

export async function readReceiptLocators(imageBytes) {
  if (!(imageBytes instanceof Uint8Array) || imageBytes.byteLength === 0) {
    throw new TypeError("A non-empty image buffer is required.");
  }
  try {
    for (const language of ["eng", "amh"]) {
      let worker;
      let text = "";
      try {
        worker = await createWorker(language, 1, {
          langPath: LANGUAGE_DIRECTORIES[language],
          cacheMethod: "none",
          gzip: true
        });
        const result = await worker.recognize(imageBytes);
        text = String(result?.data?.text || "");
        const candidates = findReceiptLocators(text);
        if (candidates.length) return candidates;
      } finally {
        text = "";
        if (worker) await worker.terminate();
      }
    }
    return [];
  } finally {
    imageBytes.fill(0);
  }
}
