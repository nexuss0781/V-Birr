import { cp, mkdir, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const destination = path.join(root, "dist", "tesseract");
const coreOutput = path.join(destination, "core");
const langOutput = path.join(destination, "lang");
const workerSource = path.join(root, "node_modules", "tesseract.js", "dist", "worker.min.js");
const coreSource = path.join(root, "node_modules", "tesseract.js-core");
const languages = ["eng", "amh"];

await Promise.all([mkdir(destination, { recursive: true }), mkdir(coreOutput, { recursive: true }), mkdir(langOutput, { recursive: true })]);
await cp(workerSource, path.join(destination, "worker.min.js"));
for (const name of await readdir(coreSource)) {
  if (/^tesseract-core.*\.wasm(?:\.js)?$/u.test(name)) {
    await cp(path.join(coreSource, name), path.join(coreOutput, name));
  }
}
for (const language of languages) {
  const langSource = path.join(root, "node_modules", "@tesseract.js-data", language, "4.0.0");
  await cp(path.join(langSource, `${language}.traineddata.gz`), path.join(langOutput, `${language}.traineddata.gz`));
}
console.log("Packaged first-party Tesseract worker, WASM core, and English/Amharic language models.");
