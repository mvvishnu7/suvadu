import fs from "node:fs/promises";
import path from "node:path";
import type { MemoryNode, Repository } from "../domain/types.js";
import type { MemoryStore } from "../storage/MemoryStore.js";
import { runGit } from "../utils/git.js";
import { fileNodeId } from "../utils/ids.js";
import { inferLanguage, isLikelySourceOrDoc, isLockFile } from "../utils/language.js";
import { normalizeRepoFilePath } from "../utils/paths.js";
import { looksLikeSensitivePath, redactSecrets } from "../utils/secretRedactor.js";
import { nowIso } from "../utils/time.js";
import { createHash } from "node:crypto";

const SKIP_DIRS = new Set(["node_modules", "target", "build", "dist", "vendor", ".git", "coverage", ".idea", ".vscode"]);
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_SUMMARY_BYTES = 64 * 1024;

export interface IndexedFileRecord {
  path: string;
  absolutePath: string;
  language: string;
  size: number;
  hash: string;
  mtime: string;
  summary: string;
  riskTerms: string[];
  symbols: string[];
}

export interface FileScanResult {
  files: IndexedFileRecord[];
  warnings: string[];
}

export async function indexRepositoryFiles(store: MemoryStore, repository: Repository): Promise<FileScanResult> {
  const trackedFiles = (await runGit(repository.absolutePath, ["ls-files"], { maxBuffer: 50 * 1024 * 1024 }))
    .split(/\r?\n/)
    .map(normalizeRepoFilePath)
    .filter(Boolean);

  const warnings: string[] = [];
  const files: IndexedFileRecord[] = [];
  const now = nowIso();

  for (const filePath of trackedFiles) {
    if (!shouldIndexPath(filePath)) {
      continue;
    }
    const absolutePath = path.join(repository.absolutePath, filePath);
    let buffer: Buffer;
    let stat;
    try {
      stat = await fs.stat(absolutePath);
      if (stat.size > MAX_FILE_BYTES) {
        continue;
      }
      buffer = await fs.readFile(absolutePath);
    } catch {
      continue;
    }
    if (isBinary(buffer)) {
      continue;
    }
    if (looksLikeSensitivePath(filePath)) {
      warnings.push(`Sensitive-looking file was noticed and summarized carefully: ${filePath}`);
    }

    const text = redactSecrets(buffer.toString("utf8", 0, Math.min(buffer.length, MAX_SUMMARY_BYTES)));
    const language = inferLanguage(filePath);
    const symbols = extractSymbols(text, language);
    const summary = summarizeFile(filePath, language, text, symbols);
    const record: IndexedFileRecord = {
      path: filePath,
      absolutePath,
      language,
      size: stat.size,
      hash: createHash("sha256").update(buffer).digest("hex"),
      mtime: stat.mtime.toISOString(),
      summary,
      riskTerms: highRiskTerms(filePath),
      symbols
    };
    files.push(record);

    const node: MemoryNode = {
      id: fileNodeId(repository.name, filePath),
      type: "file",
      workspaceId: repository.workspaceId,
      repoId: repository.id,
      key: filePath,
      title: filePath,
      body: summary,
      properties: {
        language,
        size: stat.size,
        hash: record.hash,
        mtime: record.mtime,
        riskTerms: record.riskTerms,
        symbols
      },
      source: {
        type: "file",
        id: filePath,
        repo: repository.name,
        path: filePath,
        reason: "Indexed local repository file"
      },
      createdAt: now,
      updatedAt: now
    };
    await store.upsertNode(node);
  }

  return { files, warnings };
}

function shouldIndexPath(filePath: string): boolean {
  const parts = filePath.split("/");
  if (parts.some((part) => SKIP_DIRS.has(part))) {
    return false;
  }
  if (isLockFile(filePath)) {
    return false;
  }
  return isLikelySourceOrDoc(filePath);
}

function isBinary(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, Math.min(buffer.length, 8000));
  return sample.includes(0);
}

function summarizeFile(filePath: string, language: string, text: string, symbols: string[]): string {
  const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
  const title = markdownTitle(lines);
  if (title) {
    return `${language} document "${title}" at ${filePath}.`;
  }
  const firstMeaningful = lines.find((line) => !line.trim().startsWith("//") && !line.trim().startsWith("*"))?.trim();
  const symbolText = symbols.length ? ` Declares or mentions ${symbols.slice(0, 8).join(", ")}.` : "";
  const firstLineText = firstMeaningful ? ` First meaningful line: ${firstMeaningful.slice(0, 160)}` : "";
  return `${language} file at ${filePath}.${symbolText}${firstLineText}`.trim();
}

function markdownTitle(lines: string[]): string | null {
  const heading = lines.find((line) => /^#\s+/.test(line.trim()));
  return heading ? heading.replace(/^#\s+/, "").trim() : null;
}

function extractSymbols(text: string, language: string): string[] {
  const symbols = new Set<string>();
  const patterns =
    language.includes("Java") || language === "Kotlin"
      ? [
          /\bclass\s+([A-Z][A-Za-z0-9_]*)/g,
          /\binterface\s+([A-Z][A-Za-z0-9_]*)/g,
          /\bfun\s+([a-zA-Z_][A-Za-z0-9_]*)/g,
          /\b(public|private|protected)?\s*(static\s+)?[A-Za-z0-9_<>, ?]+\s+([a-z][A-Za-z0-9_]*)\s*\(/g
        ]
      : [
          /\bexport\s+(?:async\s+)?function\s+([a-zA-Z_][A-Za-z0-9_]*)/g,
          /\bfunction\s+([a-zA-Z_][A-Za-z0-9_]*)/g,
          /\bclass\s+([A-Z][A-Za-z0-9_]*)/g,
          /\bconst\s+([a-zA-Z_][A-Za-z0-9_]*)\s*=/g
        ];

  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const value = match[3] ?? match[1];
      if (value && value.length < 80) {
        symbols.add(value);
      }
    }
  }
  return [...symbols].slice(0, 20);
}

function highRiskTerms(filePath: string): string[] {
  const lower = filePath.toLowerCase();
  return [
    "payment",
    "tax",
    "pricing",
    "auth",
    "security",
    "migration",
    "config",
    "infra",
    "public-api",
    "api",
    "shared",
    "library",
    "gateway",
    "permissions",
    "checkout",
    "invoice",
    "billing"
  ].filter((term) => lower.includes(term));
}
