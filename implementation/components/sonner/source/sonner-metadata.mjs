// Structural fields and prototype-sensitive names cannot be supplied by extensions.
const reserved = new Set([
  'path', 'name', 'type', 'text', 'children', 'counts', 'truncated', 'code', 'renameTo',
  '__proto__', 'prototype', 'constructor',
]);
export function validMetadataKey(key) {
  return key.trim().length > 0 && key.length <= 8192 && !reserved.has(key);
}
export function metadataEntries(file) {
  const priority = ['keyPoints', 'summary', 'description'];
  return Object.entries(file)
    .filter(([key, value]) => !reserved.has(key) && value != null)
    .sort(([left], [right]) => {
      const a = priority.indexOf(left), b = priority.indexOf(right);
      if (a !== b && (a >= 0 || b >= 0)) return (a < 0 ? priority.length : a) - (b < 0 ? priority.length : b);
      return left < right ? -1 : left > right ? 1 : 0;
    });
}
export function hasMetadata(file) {
  return file.type === 'file' && metadataEntries(file).length > 0;
}
