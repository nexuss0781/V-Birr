import { cp, mkdir, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "dist");
const publicDir = path.join(root, "public");
await rm(publicDir, { recursive: true, force: true });
await mkdir(publicDir, { recursive: true });
for (const entry of await readdir(dist)) {
  await cp(path.join(dist, entry), path.join(publicDir, entry), { recursive: true });
}
console.log("Synchronized Cloudflare static assets from dist/ to public/.");
