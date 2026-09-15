// Project code runs only in this disposable process after explicit opt-in.
import { pathToFileURL } from "node:url";
const chunks = [];
let size = 0;
for await (const chunk of process.stdin) {
  size += chunk.length;
  if (size > 64 * 1024 * 1024) throw new Error("Extension input is too large");
  chunks.push(chunk);
}
const { modules, files } = JSON.parse(Buffer.concat(chunks).toString("utf8"));
// Keep module logging separate from the machine-readable result.
console.log = (...args) => console.error(...args);
const extractors = new Map();
for (const filename of modules) {
  const module = await import(pathToFileURL(filename).href);
  if (module.apiVersion !== 1 || typeof module.extract !== "function") throw new Error("Unsupported extension API");
  extractors.set(filename, module.extract);
}
const output = [];
for (const file of files) {
  const value = await extractors.get(file.module)(Object.freeze({ path: file.path, text: file.text }));
  if (!value || typeof value !== "object" || Array.isArray(value)
      || Object.keys(value).some((key) => !["keyPoints", "summary"].includes(key))) throw new Error("Invalid extension result");
  const metadata = {};
  for (const key of ["keyPoints", "summary"]) {
    if (value[key] == null) continue;
    if (typeof value[key] !== "string" || value[key].length > 8192) throw new Error("Invalid extension metadata");
    if (value[key].trim()) metadata[key] = value[key].trim();
  }
  output.push({ path: file.path, ...metadata });
}
process.stdout.write(JSON.stringify(output), () => process.exit(0));
