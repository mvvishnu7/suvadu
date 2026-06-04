import type { ChangeContextOutput, ExplainWhyOutput, ReviewGuidanceOutput } from "../retrieval/contextBuilder.js";
import type { FileMemory } from "../domain/types.js";

type MissingFileMemory = { summary: string; repo: string; filePath: string; indexed: false; guidance: string[] };

export function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

export function printCompactOutput(value: unknown): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    printJson(value);
    return;
  }
  const output = value as Record<string, unknown>;
  if (typeof output.summary === "string") {
    console.log(`Summary: ${output.summary}`);
  }
  if (typeof output.confidence === "string") {
    console.log(`Confidence: ${output.confidence}`);
  }
  if (output.briefing && typeof output.briefing === "object" && !Array.isArray(output.briefing)) {
    for (const [key, items] of Object.entries(output.briefing as Record<string, unknown>)) {
      printList(compactTitle(key), stringArray(items));
    }
  }
  printList("Related files", stringArray(output.relatedFiles));
  printList("Unknowns", stringArray(output.unknowns));
}

export function printFileMemory(memory: FileMemory | MissingFileMemory): void {
  if (isMissingFileMemory(memory)) {
    console.log(memory.summary);
    for (const item of memory.guidance) {
      console.log(`- ${item}`);
    }
    return;
  }
  console.log(`File: ${memory.filePath}`);
  console.log(`Repo: ${memory.repoName}`);
  console.log(`Summary: ${memory.summary}`);
  console.log(`Risk: ${memory.riskLevel}`);
  printList("Why risky", memory.whyRisky);
  printList("Guidance", memory.guidance);
  printList("Warnings", memory.warnings);
  printList("Related Jira keys", memory.relatedJiraKeys);
  printList("Likely tests", memory.likelyTests);
  printList(
    "Co-changed files",
    memory.coChangedFiles.slice(0, 8).map((item) => `${item.path} (${item.count})`)
  );
  printList(
    "Recent commits",
    memory.recentCommits.slice(0, 8).map((commit) => `${commit.shortHash} ${commit.message}`)
  );
}

function isMissingFileMemory(memory: FileMemory | MissingFileMemory): memory is MissingFileMemory {
  return "indexed" in memory && memory.indexed === false;
}

export function printExplainWhy(output: ExplainWhyOutput): void {
  console.log(`Answer: ${output.answer}`);
  console.log(`Confidence: ${output.confidence}`);
  printList("Reasoning", output.reasoning);
  printList(
    "Evidence",
    output.evidence.map((item) => `${item.type} ${item.id}${item.title ? ` - ${item.title}` : ""}${item.url ? ` (${item.url})` : ""}`)
  );
  printList("Related Jira keys", output.relatedContext.jiraKeys);
  printList("Related files", output.relatedContext.relatedFiles);
  printList("Guidance", output.guidance);
  printList("Unknowns", output.unknowns);
}

export function printChangeContext(output: ChangeContextOutput): void {
  console.log(`Summary: ${output.summary}`);
  console.log(`Confidence: ${output.confidence}`);
  printList("Why this matters", output.briefing.why);
  printList("Risks", output.briefing.risks);
  printList("Guidance", output.briefing.guidance);
  printList("Tests", output.briefing.tests);
  printList(
    "Sources",
    output.briefing.sources.map((item) => `${item.type} ${item.id}${item.title ? ` - ${item.title}` : ""}${item.url ? ` (${item.url})` : ""}`)
  );
  printList(
    "Historical reasons",
    output.historicalReasons.map((item) => `${item.claim} (${item.confidence})`)
  );
  printList("Before editing", output.beforeEditing);
  printList("Related files", output.relatedFiles);
  printList("Questions to ask", output.questionsToAsk);
  printList("Unknowns", output.unknowns);
}

export function printReviewGuidance(output: ReviewGuidanceOutput): void {
  console.log(`Summary: ${output.summary}`);
  console.log(`Confidence: ${output.confidence}`);
  printList("Likely reviewer concerns", output.likelyReviewerConcerns);
  printList("Checklist", output.checklist);
  printList("Risky assumptions", output.riskyAssumptions);
  printList("Tests to add", output.testsToAdd);
  printList(
    "Evidence",
    output.evidence.map((item) => `${item.type} ${item.id}${item.title ? ` - ${item.title}` : ""}${item.url ? ` (${item.url})` : ""}`)
  );
  printList("Unknowns", output.unknowns);
}

function printList(title: string, items: string[]): void {
  if (items.length === 0) {
    return;
  }
  console.log(`${title}:`);
  for (const item of items) {
    console.log(`- ${item}`);
  }
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function compactTitle(key: string): string {
  const titles: Record<string, string> = {
    why: "Why this matters",
    risks: "Risks",
    guidance: "Guidance",
    tests: "Tests",
    sources: "Sources",
    likelyConcerns: "Likely concerns",
    riskyAssumptions: "Risky assumptions",
    checklist: "Checklist"
  };
  return titles[key] ?? key;
}
