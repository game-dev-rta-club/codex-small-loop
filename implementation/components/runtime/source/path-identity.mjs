import path from "node:path";

export function pathsEqual(left, right, platform = process.platform) {
  if (typeof left !== "string" || typeof right !== "string") return false;

  const implementation = platform === "win32" ? path.win32 : path.posix;
  if (!implementation.isAbsolute(left) || !implementation.isAbsolute(right)) {
    return false;
  }
  const normalizedLeft = implementation.resolve(left);
  const normalizedRight = implementation.resolve(right);

  return platform === "win32"
    ? normalizedLeft.toLocaleLowerCase("en-US")
      === normalizedRight.toLocaleLowerCase("en-US")
    : normalizedLeft === normalizedRight;
}
