import path from "node:path";

const EXTENSION_LANGUAGE: Record<string, string> = {
  ".ts": "TypeScript",
  ".tsx": "TypeScript React",
  ".js": "JavaScript",
  ".jsx": "JavaScript React",
  ".mjs": "JavaScript",
  ".cjs": "JavaScript",
  ".java": "Java",
  ".kt": "Kotlin",
  ".kts": "Kotlin",
  ".py": "Python",
  ".go": "Go",
  ".rs": "Rust",
  ".rb": "Ruby",
  ".php": "PHP",
  ".cs": "C#",
  ".swift": "Swift",
  ".scala": "Scala",
  ".sql": "SQL",
  ".md": "Markdown",
  ".mdx": "MDX",
  ".json": "JSON",
  ".yaml": "YAML",
  ".yml": "YAML",
  ".xml": "XML",
  ".html": "HTML",
  ".css": "CSS",
  ".scss": "SCSS",
  ".sh": "Shell",
  ".bash": "Shell",
  ".zsh": "Shell",
  ".toml": "TOML",
  ".properties": "Properties"
};

export function inferLanguage(filePath: string): string {
  return EXTENSION_LANGUAGE[path.extname(filePath).toLowerCase()] ?? "Text";
}

export function isLockFile(filePath: string): boolean {
  const base = path.basename(filePath).toLowerCase();
  return ["package-lock.json", "yarn.lock", "pnpm-lock.yaml", "composer.lock", "poetry.lock", "cargo.lock"].includes(base);
}

export function isLikelySourceOrDoc(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return Object.prototype.hasOwnProperty.call(EXTENSION_LANGUAGE, ext);
}
