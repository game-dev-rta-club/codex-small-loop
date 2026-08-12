export function normalizeLineEndings(source) {
  if (typeof source !== "string") {
    throw new TypeError("source must be a string");
  }
  return source.replace(/\r\n?/g, "\n");
}
