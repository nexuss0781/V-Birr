import { createWorker } from "tesseract.js";
import { findReceiptLocators } from "../sdk/receipt-locator.js";

const OCR_ASSETS = "/tesseract";

export async function readReceiptScreenshots(files, onProgress = () => {}) {
  if (!Array.isArray(files) || files.length < 1 || files.length > 5) {
    throw new TypeError("Choose between one and five receipt screenshots.");
  }
  const worker = await createWorker(["eng", "amh"], 1, {
    workerPath: `${OCR_ASSETS}/worker.min.js`,
    corePath: `${OCR_ASSETS}/core`,
    langPath: `${OCR_ASSETS}/lang`,
    cacheMethod: "none",
    workerBlobURL: false,
    gzip: true,
    logger: (message) => {
      if (message && typeof message.progress === "number") {
        onProgress({ status: String(message.status || "Reading screenshot"), progress: message.progress });
      }
    }
  });
  const locators = new Map();
  try {
    for (let index = 0; index < files.length; index += 1) {
      const result = await worker.recognize(files[index]);
      const extracted = findReceiptLocators(result?.data?.text || "");
      for (const locator of extracted) {
        locators.set(`${locator.type}:${locator.value.toUpperCase()}`, locator);
      }
      onProgress({ status: "Screenshot read locally", progress: (index + 1) / files.length });
    }
    return [...locators.values()];
  } finally {
    await worker.terminate();
  }
}
