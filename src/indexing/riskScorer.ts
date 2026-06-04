import path from "node:path";
import type { CoChangedFile, FileMemory, RepoMemory, Repository, RiskLevel, SourceReference } from "../domain/types.js";
import type { IndexedFileRecord } from "./fileScanner.js";
import type { FileHistoryStats, GitHistoryResult } from "./gitHistoryIndexer.js";
import { nowIso } from "../utils/time.js";

const HIGH_RISK_TERMS = new Set([
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
]);

export function buildFileMemories(repository: Repository, files: IndexedFileRecord[], history: GitHistoryResult): FileMemory[] {
  const allPaths = files.map((file) => file.path);
  return files.map((file) => buildFileMemory(repository, file, history.fileStats.get(file.path), allPaths));
}

export function buildRepoMemory(repository: Repository, fileMemories: FileMemory[], indexedCommits: number, warnings: string[]): RepoMemory {
  const highRiskFiles = fileMemories
    .filter((memory) => memory.riskLevel === "high" || memory.riskLevel === "critical")
    .map((memory) => memory.filePath)
    .slice(0, 20);
  return {
    repoId: repository.id,
    repoName: repository.name,
    summary: `${repository.name} has ${fileMemories.length} indexed files and ${indexedCommits} indexed commits.`,
    indexedFiles: fileMemories.length,
    indexedCommits,
    highRiskFiles,
    warnings,
    updatedAt: nowIso()
  };
}

export function scoreFileRisk(file: Pick<IndexedFileRecord, "path" | "riskTerms">, stats?: FileHistoryStats): {
  riskLevel: RiskLevel;
  whyRisky: string[];
  score: number;
} {
  let score = 0;
  const whyRisky: string[] = [];
  const riskTerms = file.riskTerms.filter((term) => HIGH_RISK_TERMS.has(term));
  if (riskTerms.length > 0) {
    score += Math.min(3, riskTerms.length);
    whyRisky.push(`Path contains high-attention domain term${riskTerms.length > 1 ? "s" : ""}: ${riskTerms.join(", ")}`);
  }

  if (stats) {
    if (stats.commitCount >= 25) {
      score += 4;
      whyRisky.push(`Touched by ${stats.commitCount} indexed commits`);
    } else if (stats.commitCount >= 10) {
      score += 3;
      whyRisky.push(`Touched by ${stats.commitCount} indexed commits`);
    } else if (stats.commitCount >= 3) {
      score += 1;
      whyRisky.push(`Touched by ${stats.commitCount} indexed commits`);
    }

    if (stats.authors.size >= 6) {
      score += 2;
      whyRisky.push(`Changed by ${stats.authors.size} different authors`);
    } else if (stats.authors.size >= 3) {
      score += 1;
      whyRisky.push(`Changed by ${stats.authors.size} different authors`);
    }

    if (stats.coChanged.size >= 10) {
      score += 2;
      whyRisky.push(`Often changes with ${stats.coChanged.size} other indexed files`);
    } else if (stats.coChanged.size >= 3) {
      score += 1;
      whyRisky.push(`Changes with ${stats.coChanged.size} other indexed files`);
    }

    if (stats.jiraKeys.size > 0) {
      score += 1;
      whyRisky.push(`Commit history references Jira key${stats.jiraKeys.size > 1 ? "s" : ""}: ${[...stats.jiraKeys].join(", ")}`);
    }
  }

  if (whyRisky.length === 0) {
    whyRisky.push("No strong risk signals found in indexed local history yet");
  }

  return {
    score,
    whyRisky,
    riskLevel: score >= 8 ? "critical" : score >= 5 ? "high" : score >= 2 ? "medium" : "low"
  };
}

function buildFileMemory(
  repository: Repository,
  file: IndexedFileRecord,
  stats: FileHistoryStats | undefined,
  allPaths: string[]
): FileMemory {
  const risk = scoreFileRisk(file, stats);
  const coChangedFiles = topCoChangedFiles(stats);
  const likelyTests = findLikelyTests(file.path, allPaths, coChangedFiles);
  const relatedJiraKeys = stats ? [...stats.jiraKeys].sort() : [];
  const sourceReferences: SourceReference[] = [
    {
      type: "file",
      id: file.path,
      repo: repository.name,
      path: file.path,
      reason: "Indexed file summary"
    },
    ...(stats?.recentCommits.slice(0, 5).map((commit) => ({
      type: "commit" as const,
      id: commit.hash,
      repo: repository.name,
      title: commit.message,
      reason: `Touched ${file.path}`
    })) ?? [])
  ];

  return {
    repoId: repository.id,
    repoName: repository.name,
    filePath: file.path,
    summary: file.summary,
    riskLevel: risk.riskLevel,
    whyRisky: risk.whyRisky,
    recentCommits: stats?.recentCommits.slice(0, 8) ?? [],
    relatedJiraKeys,
    coChangedFiles,
    likelyTests,
    guidance: buildGuidance(file, risk.riskLevel, likelyTests, relatedJiraKeys, coChangedFiles),
    warnings: buildWarnings(file, risk.riskLevel),
    historicalSignals: buildHistoricalSignals(stats),
    sourceReferences,
    updatedAt: nowIso()
  };
}

function topCoChangedFiles(stats?: FileHistoryStats): CoChangedFile[] {
  if (!stats) {
    return [];
  }
  return [...stats.coChanged.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([filePath, count]) => ({
      path: filePath,
      count,
      reason: `Changed together in ${count} indexed commit${count === 1 ? "" : "s"}`
    }));
}

function findLikelyTests(filePath: string, allPaths: string[], coChangedFiles: CoChangedFile[]): string[] {
  const base = path.basename(filePath, path.extname(filePath)).toLowerCase();
  const candidates = new Set<string>();
  for (const coChanged of coChangedFiles) {
    if (isTestPath(coChanged.path)) {
      candidates.add(coChanged.path);
    }
  }
  for (const candidate of allPaths) {
    const lower = candidate.toLowerCase();
    if (!isTestPath(lower)) {
      continue;
    }
    if (lower.includes(base) || lower.includes(base.replace(/controller|service|handler|resource/g, ""))) {
      candidates.add(candidate);
    }
  }
  return [...candidates].slice(0, 8);
}

function isTestPath(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  return lower.includes("/test/") || lower.includes("/tests/") || lower.includes(".test.") || lower.includes(".spec.");
}

function buildGuidance(
  file: IndexedFileRecord,
  riskLevel: RiskLevel,
  likelyTests: string[],
  jiraKeys: string[],
  coChangedFiles: CoChangedFile[]
): string[] {
  const guidance: string[] = [];
  if (likelyTests.length > 0) {
    guidance.push(`Start by reading likely related test${likelyTests.length === 1 ? "" : "s"}: ${likelyTests.slice(0, 3).join(", ")}`);
  }
  if (jiraKeys.length > 0) {
    guidance.push(`Use Jira key${jiraKeys.length === 1 ? "" : "s"} ${jiraKeys.join(", ")} as historical breadcrumbs; ticket details are available when Jira Cloud enrichment is configured.`);
  }
  if (coChangedFiles.length > 0) {
    guidance.push(`Check commonly co-changed file${coChangedFiles.length === 1 ? "" : "s"} before editing: ${coChangedFiles.slice(0, 3).map((item) => item.path).join(", ")}`);
  }
  if (file.riskTerms.some((term) => ["api", "public-api", "payment", "tax", "auth", "security", "billing", "invoice"].includes(term))) {
    guidance.push("Treat behavior changes here as compatibility-sensitive until consumers or tests say otherwise.");
  }
  if (riskLevel === "high" || riskLevel === "critical") {
    guidance.push("Make the smallest behavior change you can and keep source references handy for review.");
  }
  if (guidance.length === 0) {
    guidance.push("No strong historical guidance yet; rely on current code and tests, and re-index after meaningful history accumulates.");
  }
  return guidance;
}

function buildWarnings(file: IndexedFileRecord, riskLevel: RiskLevel): string[] {
  const warnings: string[] = [];
  if (riskLevel === "critical") {
    warnings.push("Critical risk score from local history; verify assumptions before broad edits.");
  }
  if (riskLevel === "high") {
    warnings.push("High risk score from local history; inspect related commits and tests.");
  }
  if (file.riskTerms.includes("config") || file.riskTerms.includes("security")) {
    warnings.push("Configuration/security-looking path; avoid assuming behavior is local to this file.");
  }
  return warnings;
}

function buildHistoricalSignals(stats?: FileHistoryStats): string[] {
  if (!stats) {
    return ["No git history was indexed for this file yet."];
  }
  const signals: string[] = [];
  const commitWithJira = stats.recentCommits.find((commit) => (commit.jiraKeys?.length ?? 0) > 0);
  if (commitWithJira) {
    signals.push(`Recent history links this file to ${commitWithJira.jiraKeys?.join(", ")} via commit ${commitWithJira.shortHash}: ${commitWithJira.message}`);
  }
  const firstRecent = stats.recentCommits[0];
  if (firstRecent) {
    signals.push(`Most recent indexed touch is ${firstRecent.shortHash} by ${firstRecent.author}: ${firstRecent.message}`);
  }
  if (signals.length === 0) {
    signals.push("No strong historical explanation signal found in indexed commits.");
  }
  return signals;
}
