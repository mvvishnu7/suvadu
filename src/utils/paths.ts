import path from "node:path";

export function toPosixPath(value: string): string {
  return value.replace(/\\/g, "/");
}

export function normalizeRepoFilePath(value: string): string {
  return toPosixPath(value).replace(/^\.?\//, "").replace(/^\/+/, "");
}

export function relativePath(fromDir: string, targetPath: string): string {
  return normalizeRepoFilePath(path.relative(fromDir, targetPath));
}

export function resolveFrom(baseDir: string, maybeRelative: string): string {
  return path.isAbsolute(maybeRelative) ? maybeRelative : path.resolve(baseDir, maybeRelative);
}

export function displayPath(baseDir: string, absolutePath: string): string {
  const relative = path.relative(baseDir, absolutePath);
  return relative.startsWith("..") ? absolutePath : `./${toPosixPath(relative)}`;
}
