export function classifyPortablePathMetadata(metadata) {
  if (metadata?.isSymbolicLink?.()) return "symlink";
  if (metadata?.isFile?.()) return "regular-file";
  return "other";
}
