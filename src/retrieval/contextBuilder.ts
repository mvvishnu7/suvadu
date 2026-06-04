import fs from "node:fs/promises";
import path from "node:path";
import type { CommitSummary, ConfidenceLabel, FileMemory, Memory, MemoryNode, SourceReference } from "../domain/types.js";
import type { MemoryStore } from "../storage/MemoryStore.js";
import { fileNodeId, jiraNodeId } from "../utils/ids.js";
import { normalizeRepoFilePath } from "../utils/paths.js";
import { redactSecrets } from "../utils/secretRedactor.js";

export interface GetFileMemoryInput {
  repo: string;
  filePath: string;
}

export interface ChangeContextInput {
  repo: string;
  task: string;
  files: string[];
}

export interface ExplainWhyInput {
  repo: string;
  filePath: string;
  question: string;
  symbol?: string;
  line?: number;
}

export interface ReviewGuidanceInput {
  repo: string;
  diffSummary: string;
  files?: string[];
}

export interface ExplainWhyOutput {
  answer: string;
  confidence: ConfidenceLabel;
  reasoning: string[];
  evidence: SourceReference[];
  relatedContext: {
    jiraKeys: string[];
    relatedFiles: string[];
    relatedSymbols: string[];
  };
  guidance: string[];
  unknowns: string[];
}

export interface ReviewGuidanceOutput {
  summary: string;
  confidence: ConfidenceLabel;
  likelyReviewerConcerns: string[];
  checklist: string[];
  riskyAssumptions: string[];
  testsToAdd: string[];
  evidence: SourceReference[];
  unknowns: string[];
}

export interface ChangeContextBriefing {
  why: string[];
  risks: string[];
  guidance: string[];
  tests: string[];
  sources: SourceReference[];
}

export interface ChangeContextOutput {
  summary: string;
  confidence: ConfidenceLabel;
  briefing: ChangeContextBriefing;
  relevantFileMemories: FileMemory[];
  historicalReasons: Array<{
    claim: string;
    confidence: ConfidenceLabel;
    evidence: SourceReference[];
  }>;
  beforeEditing: string[];
  relatedFiles: string[];
  questionsToAsk: string[];
  unknowns: string[];
}

const REVIEW_CONCERNS = [
  {
    label: "Testing coverage",
    pattern: /\b(test|tests|coverage|it\b|unit|integration|e2e|assert|case)\b/i,
    checklist: "Add or update focused tests for the changed behavior.",
    riskyAssumption: "Existing tests may not cover the path this change affects."
  },
  {
    label: "Backward compatibility",
    pattern: /\b(backward|compat|compatibility|legacy|consumer|client|old|existing|breaking)\b/i,
    checklist: "Check older clients, persisted data, and public request/response compatibility.",
    riskyAssumption: "No downstream or older consumer still depends on the current behavior."
  },
  {
    label: "Public API behavior",
    pattern: /\b(api|endpoint|request|response|param|parameter|dto|contract|field)\b/i,
    checklist: "Avoid changing public API names or semantics unless the compatibility impact is explicit.",
    riskyAssumption: "The API surface is only used by the current code path."
  },
  {
    label: "Validation and edge cases",
    pattern: /\b(validate|validation|null|empty|zero|negative|boundary|edge|rounding|vat|tax|amount)\b/i,
    checklist: "Cover boundary values and domain edge cases before merging.",
    riskyAssumption: "Normal happy-path input is representative of production input."
  },
  {
    label: "Security or permissions",
    pattern: /\b(auth|security|permission|role|token|secret|access|csrf|cors)\b/i,
    checklist: "Check authorization, permissions, and sensitive data handling.",
    riskyAssumption: "The change cannot affect access control or sensitive data exposure."
  },
  {
    label: "Migration or persistence",
    pattern: /\b(migration|schema|database|db|postgres|sql|persist|entity|table|column)\b/i,
    checklist: "Check migration order, rollback behavior, and existing persisted records.",
    riskyAssumption: "Existing data already matches the new shape."
  },
  {
    label: "Rollout safety",
    pattern: /\b(rollout|feature flag|flag|fallback|gradual|disable|hotfix|rollback)\b/i,
    checklist: "Consider whether the behavior needs a flag, fallback, or rollback path.",
    riskyAssumption: "The change is safe to release everywhere at once."
  },
  {
    label: "Performance",
    pattern: /\b(performance|slow|latency|load|query|n\+1|cache|timeout)\b/i,
    checklist: "Check query count, latency, and repeated work in hot paths.",
    riskyAssumption: "The added work is not on a hot path."
  }
];

interface JiraTicketContext {
  key: string;
  title: string;
  body: string;
  url?: string;
  status?: string;
  issueType?: string;
  fetchedFromJiraCloud: boolean;
}

interface PullRequestContext {
  number: number;
  title: string;
  body: string;
  url?: string;
  author?: string;
  mergedAt?: string;
  jiraKeys: string[];
  changedFiles: string[];
}

interface ReviewCommentContext {
  id: string;
  pullRequestNumber: number;
  body: string;
  author?: string;
  path?: string;
  line?: number;
  url?: string;
  jiraKeys: string[];
}

export async function getFileMemoryOutput(
  store: MemoryStore,
  workspaceId: string,
  input: GetFileMemoryInput
): Promise<FileMemory | { summary: string; repo: string; filePath: string; indexed: false; guidance: string[] }> {
  const repo = await store.getRepositoryByName(workspaceId, input.repo);
  if (!repo) {
    return {
      summary: `Repository "${input.repo}" is not registered in this Suvadu workspace.`,
      repo: input.repo,
      filePath: normalizeRepoFilePath(input.filePath),
      indexed: false,
      guidance: ["Run `suvadu repo add <path> --name <name>` and `suvadu repo index <name>` first."]
    };
  }
  const filePath = normalizeRepoFilePath(input.filePath);
  const memory = await store.getFileMemory(repo.id, filePath);
  if (!memory) {
    return {
      summary: `No indexed memory exists for ${filePath} in ${repo.name}.`,
      repo: repo.name,
      filePath,
      indexed: false,
      guidance: [`Run \`suvadu repo index ${repo.name}\` if this file should be in local memory.`]
    };
  }
  return compactFileMemory(memory);
}

export async function getChangeContext(
  store: MemoryStore,
  workspaceId: string,
  input: ChangeContextInput
): Promise<ChangeContextOutput> {
  const repo = await store.getRepositoryByName(workspaceId, input.repo);
  if (!repo) {
    return {
      summary: `Repository "${input.repo}" is not registered.`,
      confidence: "low",
      briefing: {
        why: [],
        risks: ["No repository memory is available."],
        guidance: ["Register and index the repo before asking Suvadu for change context."],
        tests: [],
        sources: []
      },
      relevantFileMemories: [],
      historicalReasons: [],
      beforeEditing: ["Register and index the repo before asking Suvadu for change context."],
      relatedFiles: [],
      questionsToAsk: [],
      unknowns: ["No repository memory is available."]
    };
  }

  const fileMemories = (
    await Promise.all(input.files.map((file) => store.getFileMemory(repo.id, normalizeRepoFilePath(file))))
  ).filter((memory): memory is FileMemory => memory !== null);
  const terms = tokenize(input.task);
  const historicalReasons = (
    await Promise.all(fileMemories.map((memory) => historicalClaimsForMemory(store, memory, terms)))
  )
    .flat()
    .slice(0, 5);
  const relatedFiles = unique(
    fileMemories.flatMap((memory) => [
      ...memory.coChangedFiles.slice(0, 3).map((item) => item.path),
      ...memory.likelyTests.slice(0, 3)
    ])
  ).slice(0, 10);
  const jiraContexts = (
    await Promise.all(fileMemories.map((memory) => getJiraTicketContexts(store, memory.relatedJiraKeys)))
  ).flat();
  const pullRequests = await getPullRequestContextsForFiles(store, repo, input.files, terms);
  const reviewComments = await getReviewCommentContextsForFiles(store, repo, input.files, terms);
  const rankedJiraTickets = rankJiraTickets(jiraContexts, terms);
  const prHistoricalReasons = pullRequests.slice(0, 2).map((pullRequest) => ({
    claim: `PR #${pullRequest.number} (${pullRequest.title}) may explain this change context.`,
    confidence: "medium" as ConfidenceLabel,
    evidence: [
      {
        type: "pull_request" as const,
        id: `#${pullRequest.number}`,
        repo: repo.name,
        url: pullRequest.url,
        title: pullRequest.title,
        reason: "PR title/body or changed files overlap with the task"
      }
    ]
  }));
  const reviewHistoricalReasons = reviewComments.slice(0, 3).map((comment) => ({
    claim: `PR #${comment.pullRequestNumber} review comment flags ${reviewCommentSignal(comment)}${comment.path ? ` for ${comment.path}` : ""}.`,
    confidence: "medium" as ConfidenceLabel,
    evidence: [
      {
        type: "review_comment" as const,
        id: comment.id,
        repo: repo.name,
        path: comment.path,
        url: comment.url,
        title: `PR #${comment.pullRequestNumber} review comment`,
        reason: "Review comment text overlaps with the task"
      }
    ]
  }));
  const beforeEditing = unique([
    ...reviewComments
      .slice(0, 2)
      .map((comment) => `${reviewChecklistFromComment(comment)} Source: PR #${comment.pullRequestNumber}.`),
    ...rankedJiraTickets
      .slice(0, 3)
      .map((ticket) => `Preserve linked business context from ${ticket.key}${ticket.title ? ` (${ticket.title})` : ""}.`),
    ...pullRequests.slice(0, 2).map((pullRequest) => `Compare behavior against PR #${pullRequest.number}${pullRequest.title ? ` (${pullRequest.title})` : ""}.`),
    ...fileMemories.flatMap((memory) => memory.guidance)
  ]).slice(0, 8);
  const questionsToAsk = buildQuestions(input.task, fileMemories);
  const unknowns = jiraContexts.some((ticket) => ticket.fetchedFromJiraCloud)
    ? reviewComments.length > 0
      ? ["ADRs and incidents are not indexed yet."]
      : ["PR review comments may exist but did not match this task; ADRs and incidents are not indexed yet."]
    : ["No Jira ticket bodies are indexed yet for these files; Jira comments, ADRs, and incidents are not indexed yet."];

  const combinedHistoricalReasons = [...reviewHistoricalReasons, ...prHistoricalReasons, ...historicalReasons].slice(0, 5);
  const briefing = buildChangeBriefing({
    repoName: repo.name,
    task: input.task,
    fileMemories,
    historicalReasons: combinedHistoricalReasons,
    reviewComments,
    pullRequests,
    jiraTickets: rankedJiraTickets
  });
  return {
    summary:
      fileMemories.length > 0
        ? `Suvadu found indexed memory for ${fileMemories.length} file${fileMemories.length === 1 ? "" : "s"} related to this task.`
        : "No indexed file memory matched the provided files.",
    confidence: combinedHistoricalReasons.length > 0 ? "medium" : fileMemories.length > 0 ? "low" : "low",
    briefing,
    relevantFileMemories: fileMemories.map(compactFileMemory),
    historicalReasons: combinedHistoricalReasons,
    beforeEditing,
    relatedFiles,
    questionsToAsk,
    unknowns
  };
}

export async function getReviewGuidance(
  store: MemoryStore,
  workspaceId: string,
  input: ReviewGuidanceInput
): Promise<ReviewGuidanceOutput> {
  const repo = await store.getRepositoryByName(workspaceId, input.repo);
  if (!repo) {
    return {
      summary: `Repository "${input.repo}" is not registered.`,
      confidence: "low",
      likelyReviewerConcerns: [],
      checklist: ["Register and index the repo before asking Suvadu for review guidance."],
      riskyAssumptions: [],
      testsToAdd: [],
      evidence: [],
      unknowns: ["No repository memory is available."]
    };
  }

  return buildReviewGuidanceForRepo(store, repo, {
    diffSummary: input.diffSummary,
    files: input.files ?? []
  });
}

async function buildReviewGuidanceForRepo(
  store: MemoryStore,
  repo: { id: string; name: string },
  input: { diffSummary: string; files?: string[]; terms?: string[]; fileMemories?: FileMemory[] }
): Promise<ReviewGuidanceOutput> {
  const normalizedFiles = (input.files ?? []).map(normalizeRepoFilePath);
  const terms = input.terms ?? unique([...tokenize(input.diffSummary), ...normalizedFiles.flatMap(tokenize)]);
  const fileMemories =
    input.fileMemories ??
    (
      await Promise.all(normalizedFiles.map((file) => store.getFileMemory(repo.id, file)))
    ).filter((memory): memory is FileMemory => memory !== null);
  const reviewComments =
    normalizedFiles.length > 0
      ? await getReviewCommentContextsForFiles(store, repo, normalizedFiles, terms)
      : await getReviewCommentContextsForRepo(store, repo, terms);
  const reviewPatternMemories = rankReviewPatternMemories(
    await store.findMemories({
      repoId: repo.id,
      type: "review-pattern",
      limit: 200
    }),
    terms,
    normalizedFiles
  );
  const topReviewPatternMemories = reviewPatternMemories.slice(0, 4);
  const pullRequests =
    normalizedFiles.length > 0
      ? await getPullRequestContextsForFiles(store, repo, normalizedFiles, terms)
      : await getPullRequestContextsForRepo(store, repo, terms);
  const jiraKeys = unique([
    ...fileMemories.flatMap((memory) => memory.relatedJiraKeys),
    ...reviewComments.flatMap((comment) => comment.jiraKeys),
    ...pullRequests.flatMap((pullRequest) => pullRequest.jiraKeys)
  ]);
  const jiraTickets = rankJiraTickets(await getJiraTicketContexts(store, jiraKeys), terms, jiraKeys).slice(0, 3);
  const concernFullText = [
    input.diffSummary,
    ...reviewComments.slice(0, 8).map((comment) => comment.body),
    ...pullRequests.slice(0, 5).map((pullRequest) => `${pullRequest.title}\n${pullRequest.body}`),
    ...fileMemories.flatMap((memory) => [...memory.guidance, ...memory.whyRisky])
  ].join("\n");
  const concernEvidenceText = [
    ...reviewComments.slice(0, 8).map((comment) => comment.body),
    ...pullRequests.slice(0, 5).map((pullRequest) => `${pullRequest.title}\n${pullRequest.body}`),
    ...fileMemories.flatMap((memory) => [...memory.guidance, ...memory.whyRisky])
  ].join("\n");
  const concernMatches = detectReviewConcerns(concernFullText);
  const evidenceConcernMatches = detectReviewConcerns(concernEvidenceText);
  const likelyReviewerConcerns = unique([
    ...concernMatches.map((concern) => concern.label),
    ...topReviewPatternMemories.map((memory) => memory.summary)
  ]).slice(0, 8);
  const checklist = unique([
    ...topReviewPatternMemories.flatMap((memory) => memory.guidance),
    ...concernMatches.map((concern) => concern.checklist),
    ...reviewComments
      .filter((comment) => /\b(please|should|need|needs|missing|add|check|cover)\b/i.test(comment.body))
      .slice(0, topReviewPatternMemories.length > 0 ? 1 : 3)
      .map(reviewChecklistFromComment),
    ...pullRequests.slice(0, 2).map((pullRequest) => `Compare against PR #${pullRequest.number}${pullRequest.title ? ` (${pullRequest.title})` : ""}.`)
  ]).slice(0, 8);
  const riskyAssumptions = unique([
    ...evidenceConcernMatches.map((concern) => concern.riskyAssumption),
    ...fileMemories.flatMap((memory) => memory.whyRisky).slice(0, 3)
  ]).slice(0, 8);
  const testsToAdd = unique([
    ...topReviewPatternMemories
      .filter((memory) => memory.properties.category === "testing" || memory.properties.category === "validation-edge-case")
      .flatMap((memory) => memory.guidance)
      .filter((item) => /\b(test|coverage)\b/i.test(item)),
    ...reviewComments
      .filter((comment) => /\b(test|coverage|case|assert)\b/i.test(comment.body))
      .slice(0, topReviewPatternMemories.length > 0 ? 1 : 4)
      .map(testGuidanceFromReviewComment),
    ...testsFromConcerns(concernMatches),
    ...fileMemories.flatMap((memory) => memory.likelyTests.slice(0, 4).map((file) => `Update or inspect likely related test: ${file}`))
  ]).slice(0, 8);
  const evidence: SourceReference[] = compactSourceReferences([
    ...topReviewPatternMemories.flatMap((memory) => memory.sourceReferences.map((source) => ({
      ...source,
      reason: `Supports review pattern: ${memory.title}`
    }))),
    ...(topReviewPatternMemories.length > 0 ? [] : reviewComments.slice(0, 4).map((comment) => ({
      type: "review_comment" as const,
      id: comment.id,
      repo: repo.name,
      path: comment.path,
      url: comment.url,
      title: `PR #${comment.pullRequestNumber} review comment`,
      reason: "Review comment overlaps with the diff summary"
    }))),
    ...pullRequests.slice(0, 3).map((pullRequest) => ({
      type: "pull_request" as const,
      id: `#${pullRequest.number}`,
      repo: repo.name,
      url: pullRequest.url,
      title: pullRequest.title,
      reason: "PR title/body or changed files overlap with the diff summary"
    })),
    ...jiraTickets.map((ticket) => ({
      type: "jira" as const,
      id: ticket.key,
      repo: repo.name,
      url: ticket.url,
      title: ticket.title,
      reason: ticket.fetchedFromJiraCloud ? "Linked Jira ticket overlaps with the diff summary" : "Jira key was detected in indexed history"
    }))
  ], 8);
  const confidence: ConfidenceLabel =
    reviewComments.length >= 2 || (reviewComments.length > 0 && pullRequests.length > 0)
      ? "high"
      : evidence.length > 0 || concernMatches.length > 0
        ? "medium"
        : "low";

  return {
    summary:
      evidence.length > 0
        ? `Suvadu found ${topReviewPatternMemories.length} top review pattern${topReviewPatternMemories.length === 1 ? "" : "s"}, ${reviewComments.length} matching review comment${reviewComments.length === 1 ? "" : "s"}, and ${pullRequests.length} related PR${pullRequests.length === 1 ? "" : "s"} for this review.`
        : "Suvadu did not find strong historical review evidence for this diff summary.",
    confidence,
    likelyReviewerConcerns:
      likelyReviewerConcerns.length > 0
        ? likelyReviewerConcerns
        : ["No historical reviewer concern matched strongly; use standard repo tests and compatibility checks."],
    checklist: checklist.length > 0 ? checklist : ["Review the changed behavior against existing tests and public contracts."],
    riskyAssumptions: riskyAssumptions.length > 0 ? riskyAssumptions : ["No specific risky assumption was found in indexed memory."],
    testsToAdd: testsToAdd.length > 0 ? testsToAdd : ["Add focused tests for the changed behavior if coverage is not already present."],
    evidence,
    unknowns: [
      "ADRs and incidents are not indexed yet.",
      ...(normalizedFiles.length === 0 ? ["Pass changed files for more precise file-level review guidance."] : [])
    ]
  };
}

export async function explainWhyCodeExists(
  store: MemoryStore,
  workspaceId: string,
  input: ExplainWhyInput
): Promise<ExplainWhyOutput> {
  const repo = await store.getRepositoryByName(workspaceId, input.repo);
  const filePath = normalizeRepoFilePath(input.filePath);
  if (!repo) {
    return noExplanation(`Repository "${input.repo}" is not registered.`, filePath);
  }

  const memory = await store.getFileMemory(repo.id, filePath);
  if (!memory) {
    return noExplanation(`No indexed memory exists for ${filePath}.`, filePath);
  }

  const currentSnippet = input.line ? await readSnippet(repo.absolutePath, filePath, input.line) : "";
  const terms = unique([...tokenize(input.question), ...tokenize(input.symbol ?? ""), ...tokenize(currentSnippet)]);
  const rankedCommits = rankCommits(memory.recentCommits, terms);
  const rankedPullRequests = await getPullRequestContextsForFiles(store, repo, [filePath], terms);
  const rankedReviewComments = await getReviewCommentContextsForFiles(store, repo, [filePath], terms);
  const strongCommits = selectStrongCommits(rankedCommits, terms);
  const strongPullRequests = selectStrongPullRequests(rankedPullRequests, terms);
  const strongReviewComments = selectStrongReviewComments(rankedReviewComments, terms);
  const jiraContexts = await getJiraTicketContexts(store, memory.relatedJiraKeys);
  const preferredPullRequestJiraKeys = (strongPullRequests.length > 0 ? strongPullRequests : rankedPullRequests.slice(0, 1)).flatMap(
    (pullRequest) => pullRequest.jiraKeys
  );
  const preferredReviewCommentJiraKeys = strongReviewComments.flatMap((comment) => comment.jiraKeys);
  const preferredJiraKeys = unique([
    ...preferredJiraKeysFromCommits(strongCommits.length > 0 ? strongCommits : rankedCommits),
    ...preferredPullRequestJiraKeys,
    ...preferredReviewCommentJiraKeys
  ]);
  const rankedJiraTickets = rankJiraTickets(jiraContexts, terms, preferredJiraKeys);
  const strongJiraTickets = selectStrongJiraTickets(rankedJiraTickets, terms, preferredJiraKeys);
  const explanationJiraTickets = strongJiraTickets.length > 0 ? strongJiraTickets : rankedJiraTickets.slice(0, 1);
  const explanationPullRequests = strongPullRequests.length > 0 ? strongPullRequests : rankedPullRequests.slice(0, 1);
  const explanationReviewComments = strongReviewComments.length > 0 ? strongReviewComments : rankedReviewComments.slice(0, 1);
  const explanationCommits = strongCommits.length > 0 ? strongCommits : rankedCommits.slice(0, 1);
  const jiraEvidence = explanationJiraTickets.slice(0, 2).map((ticket) => ({
    type: "jira" as const,
    id: ticket.key,
    repo: repo.name,
    url: ticket.url,
    title: ticket.title,
    reason: ticket.fetchedFromJiraCloud ? "Jira Cloud ticket content overlaps with the question" : "Jira key was detected in local git history"
  }));
  const pullRequestEvidence = explanationPullRequests.slice(0, 2).map((pullRequest) => ({
    type: "pull_request" as const,
    id: `#${pullRequest.number}`,
    repo: repo.name,
    url: pullRequest.url,
    title: pullRequest.title,
    reason: "PR title/body or changed files overlap with the question"
  }));
  const reviewCommentEvidence = explanationReviewComments.slice(0, 2).map((comment) => ({
    type: "review_comment" as const,
    id: comment.id,
    repo: repo.name,
    path: comment.path,
    url: comment.url,
    title: `PR #${comment.pullRequestNumber} review comment`,
    reason: "Review comment text overlaps with the question"
  }));
  const commitEvidence = explanationCommits.slice(0, 3).map((commit) => ({
    type: "commit" as const,
    id: commit.hash,
    repo: repo.name,
    title: commit.message,
    reason: overlapReason(commit, terms)
  }));
  const evidence = [...jiraEvidence, ...pullRequestEvidence, ...reviewCommentEvidence, ...commitEvidence].slice(0, 7);
  const relatedFiles = unique([
    ...memory.coChangedFiles.slice(0, 5).map((item) => item.path),
    ...memory.likelyTests.slice(0, 5)
  ]);
  const matchingSignals = memory.historicalSignals.filter((signal) => hasOverlap(signal, terms));
  const confidence: ConfidenceLabel =
    explanationJiraTickets.some((ticket) => ticket.fetchedFromJiraCloud) && (explanationCommits.length > 0 || explanationPullRequests.length > 0 || explanationReviewComments.length > 0)
      ? "high"
      : evidence.length >= 2 || matchingSignals.length > 0
        ? "medium"
        : evidence.length === 1
          ? "low"
          : "low";

  if (evidence.length === 0 && matchingSignals.length === 0) {
    return {
      answer: `Suvadu cannot yet explain why this code exists from indexed history. It found file-level context, but no commit message or cached signal clearly matches the question.`,
      confidence: "low",
      reasoning: [
        `Indexed summary: ${memory.summary}`,
        "No matching local commit message was strong enough to support a specific historical explanation."
      ],
      evidence: memory.sourceReferences.slice(0, 3),
      relatedContext: {
        jiraKeys: memory.relatedJiraKeys,
        relatedFiles,
        relatedSymbols: []
      },
      guidance: memory.guidance,
      unknowns: [
        jiraContexts.some((ticket) => ticket.fetchedFromJiraCloud)
          ? "Jira tickets are indexed, but none clearly matched this question."
          : "Jira ticket bodies are not indexed for this file.",
        "No matching PR review comments were found; Jira comments, ADRs, incidents, and non-review PR conversation comments are not indexed yet.",
        "The reason may exist in external systems or older history outside the indexed commit window."
      ]
    };
  }

  const best = explanationCommits[0];
  const bestPullRequest = explanationPullRequests[0];
  const bestReviewComment = explanationReviewComments[0];
  const bestJira =
    explanationJiraTickets.find((ticket) => best?.jiraKeys?.includes(ticket.key) && ticket.fetchedFromJiraCloud) ??
    explanationJiraTickets.find((ticket) => bestPullRequest?.jiraKeys.includes(ticket.key) && ticket.fetchedFromJiraCloud) ??
    explanationJiraTickets.find((ticket) => bestReviewComment?.jiraKeys.includes(ticket.key) && ticket.fetchedFromJiraCloud) ??
    explanationJiraTickets.find((ticket) => ticket.fetchedFromJiraCloud);
  const answer =
    bestJira && bestPullRequest && best
      ? `Best supported explanation: Jira ${bestJira.key} (${bestJira.title}), PR #${bestPullRequest.number} (${bestPullRequest.title}), and commit ${best.shortHash} (${best.message}) all point to this behavior.`
      : bestJira && bestReviewComment
        ? `Best supported explanation: Jira ${bestJira.key} (${bestJira.title}) and a review comment on PR #${bestReviewComment.pullRequestNumber} both point to this behavior.`
      : bestJira && best
        ? `Best supported explanation: Jira ${bestJira.key} (${bestJira.title}) and commit ${best.shortHash} (${best.message}) both point to this behavior.`
        : bestPullRequest && best
          ? `Best supported explanation: PR #${bestPullRequest.number} (${bestPullRequest.title}) and commit ${best.shortHash} (${best.message}) both point to this behavior.`
          : bestJira
            ? `Best supported explanation: Jira ${bestJira.key} (${bestJira.title}) describes the closest linked business context.`
            : bestPullRequest
              ? `Best supported explanation: PR #${bestPullRequest.number} (${bestPullRequest.title}) describes the closest linked engineering context.`
              : bestReviewComment
                ? `Best supported explanation: a review comment on PR #${bestReviewComment.pullRequestNumber} discusses this behavior: ${evidenceExcerpt(bestReviewComment.body, 180)}`
              : best
                ? `Best supported explanation: this code is connected to commit ${best.shortHash} (${best.message}). Suvadu is inferring from local git history, so treat this as historical context rather than proof of business intent.`
                : `Best supported explanation: ${matchingSignals[0]}. Suvadu is inferring from indexed local history.`;

  return {
    answer,
    confidence,
    reasoning: [
      ...explanationJiraTickets
        .filter((ticket) => ticket.fetchedFromJiraCloud)
        .slice(0, 2)
        .map((ticket) => `Jira ${ticket.key}: ${ticket.title}${ticket.body ? ` - ${evidenceExcerpt(ticket.body)}` : ""}`),
      ...explanationPullRequests
        .slice(0, 2)
        .map((pullRequest) => `PR #${pullRequest.number}: ${pullRequest.title}${pullRequest.body ? ` - ${evidenceExcerpt(pullRequest.body)}` : ""}`),
      ...explanationReviewComments
        .slice(0, 2)
        .map((comment) => `Review comment on PR #${comment.pullRequestNumber}${comment.author ? ` by ${comment.author}` : ""}: ${evidenceExcerpt(comment.body)}`),
      ...matchingSignals.slice(0, 3),
      ...explanationCommits.slice(0, 2).map((commit) => `Commit ${commit.shortHash} touched this file: ${commit.message}`)
    ].slice(0, 6),
    evidence,
    relatedContext: {
      jiraKeys: memory.relatedJiraKeys,
      relatedFiles,
      relatedSymbols: input.symbol ? [input.symbol] : []
    },
    guidance: unique([
      ...explanationReviewComments
        .slice(0, 2)
        .map((comment) => `Review note from PR #${comment.pullRequestNumber}${comment.path ? ` on ${comment.path}` : ""}: ${evidenceExcerpt(comment.body, 140)}`),
      ...memory.guidance
    ]),
    unknowns: jiraContexts.some((ticket) => ticket.fetchedFromJiraCloud)
      ? rankedReviewComments.length > 0
        ? ["ADRs and incidents are not indexed yet."]
        : ["PR review comments may exist but did not match this question; Jira comments, ADRs, incidents, and non-review PR conversation comments are not indexed yet."]
      : ["Jira ticket bodies are not indexed for these keys; PR review comments, ADRs, and incidents are not indexed yet."]
  };
}

function buildChangeBriefing(input: {
  repoName: string;
  task: string;
  fileMemories: FileMemory[];
  historicalReasons: ChangeContextOutput["historicalReasons"];
  reviewComments: ReviewCommentContext[];
  pullRequests: PullRequestContext[];
  jiraTickets: JiraTicketContext[];
}): ChangeContextBriefing {
  const concernText = [
    input.task,
    ...input.reviewComments.slice(0, 8).map((comment) => comment.body),
    ...input.fileMemories.flatMap((memory) => [...memory.whyRisky, ...memory.guidance, ...memory.warnings])
  ].join("\n");
  const concerns = detectReviewConcerns(concernText);
  const jiraWhy = input.jiraTickets.slice(0, 3).map((ticket) => jiraBriefingLine(ticket, input.task));
  const prWhy = input.pullRequests.slice(0, jiraWhy.length > 0 ? 1 : 2).map(prBriefingLine);
  const fallbackWhy = input.historicalReasons
    .filter((reason) => reason.evidence.some((source) => source.type === "commit" || source.type === "jira"))
    .slice(0, 2)
    .map((reason) => reason.claim);
  const why = unique([
    ...jiraWhy,
    ...prWhy,
    ...fallbackWhy,
    ...(jiraWhy.length === 0 && prWhy.length === 0 && fallbackWhy.length === 0
      ? input.fileMemories.slice(0, 2).map((memory) => `Indexed file context: ${memory.summary}`)
      : [])
  ]).slice(0, 5);

  const risks = unique([
    ...input.fileMemories
      .filter((memory) => memory.riskLevel === "high" || memory.riskLevel === "critical")
      .map((memory) => `${memory.filePath} is ${memory.riskLevel} risk in indexed history.`),
    ...input.fileMemories.flatMap((memory) => memory.whyRisky),
    ...input.fileMemories.flatMap((memory) => memory.warnings),
    ...input.reviewComments.slice(0, 4).map(reviewRiskFromComment)
  ]).slice(0, 7);

  const guidance = unique([
    ...input.reviewComments
      .filter((comment) => /\b(please|should|need|needs|missing|add|check|cover|avoid|must)\b/i.test(comment.body))
      .slice(0, 3)
      .map(reviewChecklistFromComment),
    ...input.pullRequests
      .slice(0, 2)
      .map((pullRequest) => `Keep behavior compatible with the flow touched by PR #${pullRequest.number}${pullRequest.title ? ` (${pullRequest.title})` : ""}.`),
    ...input.jiraTickets
      .slice(0, 2)
      .map((ticket) => jiraGuidanceLine(ticket, input.task)),
    ...concerns.slice(0, 3).map((concern) => concern.checklist),
    ...input.fileMemories
      .flatMap((memory) => memory.guidance)
      .filter((item) => !/^Start by reading/i.test(item) && !/^Use Jira keys/i.test(item))
  ]).slice(0, 7);

  const tests = unique([
    ...testsFromTask(input.task),
    ...input.reviewComments
      .filter((comment) => /\b(test|coverage|case|assert|it\b|integration|unit)\b/i.test(comment.body))
      .slice(0, 4)
      .map(testGuidanceFromReviewComment),
    ...input.fileMemories.flatMap((memory) => memory.likelyTests.slice(0, 5).map((file) => `Update or inspect likely related test: ${file}`))
  ]).slice(0, 8);

  const sources = compactSourceReferences([
    ...input.jiraTickets.slice(0, 3).map((ticket) => ({
      type: "jira" as const,
      id: ticket.key,
      repo: input.repoName,
      url: ticket.url,
      title: ticket.title,
      reason: ticket.fetchedFromJiraCloud ? "Linked Jira ticket content matched the task" : "Jira key was detected in indexed history"
    })),
    ...input.pullRequests.slice(0, 2).map((pullRequest) => ({
      type: "pull_request" as const,
      id: `#${pullRequest.number}`,
      repo: input.repoName,
      url: pullRequest.url,
      title: pullRequest.title,
      reason: "PR title/body or changed files matched the task"
    })),
    ...input.reviewComments.slice(0, 3).map((comment) => ({
      type: "review_comment" as const,
      id: comment.id,
      repo: input.repoName,
      path: comment.path,
      url: comment.url,
      title: `PR #${comment.pullRequestNumber} review comment`,
      reason: "Review comment matched the task"
    })),
    ...input.historicalReasons.flatMap((reason) => reason.evidence),
    ...input.fileMemories.flatMap((memory) => memory.sourceReferences.slice(0, 2))
  ], 8);

  return {
    why: why.length > 0 ? why : ["No strong historical reason matched this task yet; Suvadu is falling back to file-level memory."],
    risks: risks.length > 0 ? risks : ["No specific risk was found in indexed history for this task."],
    guidance: guidance.length > 0 ? guidance : ["Make the smallest behavior change and preserve existing public contracts unless the task explicitly changes them."],
    tests: tests.length > 0 ? tests : ["Inspect existing related tests and add focused coverage for the changed behavior."],
    sources
  };
}

async function historicalClaimsForMemory(
  store: MemoryStore,
  memory: FileMemory,
  terms: string[]
): Promise<ChangeContextOutput["historicalReasons"]> {
  const matchingCommits = rankCommits(memory.recentCommits, terms).slice(0, 2);
  const claims: ChangeContextOutput["historicalReasons"] = matchingCommits.map((commit) => ({
    claim: `Commit ${commit.shortHash} suggests relevant history for ${memory.filePath}: ${commit.message}`,
    confidence: "low" as ConfidenceLabel,
    evidence: [
      {
        type: "commit" as const,
        id: commit.hash,
        repo: memory.repoName,
        title: commit.message,
        reason: "Commit message overlaps with the task"
      }
    ]
  }));
  const jiraContexts = await getJiraTicketContexts(store, memory.relatedJiraKeys);
  const matchingCommitsForJira = rankCommits(memory.recentCommits, terms);
  const rankedJira = rankJiraTickets(jiraContexts, terms, preferredJiraKeysFromCommits(matchingCommitsForJira)).slice(0, 3);
  if (rankedJira.length > 0 && rankedJira.some((ticket) => ticket.fetchedFromJiraCloud)) {
    for (const ticket of rankedJira) {
      claims.push({
        claim: `Jira ${ticket.key}${ticket.title ? ` (${ticket.title})` : ""} may explain behavior in ${memory.filePath}.`,
        confidence: ticket.fetchedFromJiraCloud ? "medium" : "low",
        evidence: [
          {
            type: "jira" as const,
            id: ticket.key,
            repo: memory.repoName,
            url: ticket.url,
            title: ticket.title,
            reason: ticket.fetchedFromJiraCloud
              ? "Fetched Jira Cloud ticket linked through commit history"
              : "Detected in local commit messages"
          }
        ]
      });
    }
  } else if (memory.relatedJiraKeys.length > 0) {
    claims.push({
      claim: `${memory.filePath} is linked to Jira key${memory.relatedJiraKeys.length === 1 ? "" : "s"} ${memory.relatedJiraKeys.join(", ")} through commit messages.`,
      confidence: "low" as ConfidenceLabel,
      evidence: memory.relatedJiraKeys.map((key) => ({
        type: "jira" as const,
        id: key,
        repo: memory.repoName,
        reason: "Detected in local commit messages"
      }))
    });
  }
  return claims;
}

function buildQuestions(task: string, fileMemories: FileMemory[]): string[] {
  const questions: string[] = [];
  if (/\b(remove|delete|rename|drop)\b/i.test(task)) {
    questions.push("Is the behavior or identifier still consumed by older clients or downstream services?");
  }
  if (fileMemories.some((memory) => memory.relatedJiraKeys.length > 0)) {
    questions.push("Do the linked Jira tickets describe a business rule that is not obvious in code?");
  }
  if (fileMemories.some((memory) => memory.likelyTests.length > 0)) {
    questions.push("Do the likely related tests encode the behavior you are about to change?");
  }
  if (questions.length === 0) {
    questions.push("What historical behavior should stay stable after this change?");
  }
  return questions;
}

function detectReviewConcerns(text: string): typeof REVIEW_CONCERNS {
  return REVIEW_CONCERNS.filter((concern) => concern.pattern.test(text));
}

function testsFromTask(task: string): string[] {
  const tests: string[] = [];
  if (/\bvalidation|validate\b/i.test(task)) {
    tests.push("Add validation edge-case tests for the changed behavior.");
  }
  if (/\bjira\b/i.test(task) && /\bcomment\b/i.test(task)) {
    tests.push("Add or update Jira comment tests for the changed submission paths.");
  }
  return tests;
}

function testsFromConcerns(concerns: typeof REVIEW_CONCERNS): string[] {
  const labels = new Set(concerns.map((concern) => concern.label));
  const tests: string[] = [];
  if (labels.has("Validation and edge cases")) {
    tests.push("Add boundary and edge-case tests for the changed validation/calculation behavior.");
  }
  if (labels.has("Backward compatibility") || labels.has("Public API behavior")) {
    tests.push("Add compatibility tests around existing request/response behavior or older clients.");
  }
  if (labels.has("Security or permissions")) {
    tests.push("Add authorization/permission tests for the affected path.");
  }
  if (labels.has("Migration or persistence")) {
    tests.push("Add persistence or migration coverage for existing records.");
  }
  if (labels.has("Rollout safety")) {
    tests.push("Add tests for flag/fallback behavior where rollout safety depends on it.");
  }
  if (labels.has("Performance")) {
    tests.push("Add or run performance-sensitive coverage for the changed hot path.");
  }
  if (labels.has("Testing coverage")) {
    tests.push("Add the missing unit or integration tests requested by similar historical reviews.");
  }
  return tests;
}

function compactFileMemory(memory: FileMemory): FileMemory {
  return {
    ...memory,
    whyRisky: memory.whyRisky.slice(0, 4),
    recentCommits: memory.recentCommits.slice(0, 3).map(compactCommitSummary),
    relatedJiraKeys: unique([
      ...memory.recentCommits.flatMap((commit) => commit.jiraKeys ?? []),
      ...memory.relatedJiraKeys
    ]).slice(0, 8),
    coChangedFiles: memory.coChangedFiles.slice(0, 5),
    likelyTests: memory.likelyTests.slice(0, 5),
    guidance: memory.guidance.slice(0, 5),
    warnings: memory.warnings.slice(0, 3),
    historicalSignals: memory.historicalSignals.slice(0, 3),
    sourceReferences: compactSourceReferences(memory.sourceReferences, 5)
  };
}

function compactCommitSummary(commit: CommitSummary): CommitSummary {
  const { changedFiles: _changedFiles, ...compactCommit } = commit;
  return compactCommit;
}

function reviewCommentSignal(comment: ReviewCommentContext): string {
  const concerns = detectReviewConcerns(comment.body).map((concern) => concern.label.toLowerCase());
  if (concerns.length > 0) {
    return concerns.slice(0, 2).join(" and ");
  }
  return "a related implementation concern";
}

function jiraBriefingLine(ticket: JiraTicketContext, task: string): string {
  const sentence = firstRelevantSentence(ticket.body, tokenize(task));
  return sentence ? `Jira ${ticket.key}: ${sentence}` : `Jira ${ticket.key}: ${ticket.title}.`;
}

function jiraGuidanceLine(ticket: JiraTicketContext, _task: string): string {
  return `Preserve the behavior described by ${ticket.key}${ticket.title ? ` (${ticket.title})` : ""}.`;
}

function prBriefingLine(pullRequest: PullRequestContext): string {
  return `PR #${pullRequest.number}: ${pullRequest.title}.`;
}

function reviewRiskFromComment(comment: ReviewCommentContext): string {
  const body = comment.body.toLowerCase();
  if (/\bflow separation\b/.test(body) || /\bseparate the flow\b/.test(body) || /\bfields are required\b/.test(body)) {
    return `PR #${comment.pullRequestNumber} review note: separate flows may need distinct request contracts.`;
  }
  if (/\bvalidation\b/.test(body) || /\bedge\b/.test(body)) {
    return `PR #${comment.pullRequestNumber} review note: validation edge cases were called out for this area.`;
  }
  if (/\btest|coverage\b/.test(body)) {
    return `PR #${comment.pullRequestNumber} review note: reviewers expected focused test coverage for this path.`;
  }
  return `PR #${comment.pullRequestNumber} review note: ${firstCompleteClause(comment.body)}`;
}

function reviewChecklistFromComment(comment: ReviewCommentContext): string {
  const body = comment.body.toLowerCase();
  if (/\bflow separation\b/.test(body) || /\bseparate the flow\b/.test(body) || /\bfields are required\b/.test(body)) {
    return "Keep separate flows explicit, with required fields that match each path.";
  }
  if (/\btwo buttons\b/.test(body) || /\bdifferent endpoints\b/.test(body)) {
    return "If endpoint behavior changes, keep distinct actions distinguishable in the public API.";
  }
  if (/\bvalidation\b/.test(body) || /\bedge\b/.test(body)) {
    if (/\bvat|tax|rounding|calculation\b/.test(body)) {
      return "Add calculation edge-case coverage for the rounding or tax behavior.";
    }
    return "Add validation edge-case coverage for the changed behavior.";
  }
  if (/\btest|coverage\b/.test(body)) {
    return "Add or update focused tests for the changed path.";
  }
  return `Account for PR #${comment.pullRequestNumber} review note: ${firstCompleteClause(comment.body)}`;
}

function testGuidanceFromReviewComment(comment: ReviewCommentContext): string {
  const body = comment.body.toLowerCase();
  if (/\b(vat|tax|rounding)\b/i.test(body)) {
    return `Add focused rounding/tax edge-case tests referenced by PR #${comment.pullRequestNumber} review.`;
  }
  if (/\b(validation|validate|null|empty|zero|negative|boundary|edge|case)\b/i.test(body)) {
    return `Add validation edge-case tests referenced by PR #${comment.pullRequestNumber} review.`;
  }
  if (/\b(integration|it\b|e2e)\b/i.test(body)) {
    return `Add or verify integration coverage requested by PR #${comment.pullRequestNumber} review.`;
  }
  if (/\b(unit)\b/i.test(body)) {
    return `Add or verify unit coverage requested by PR #${comment.pullRequestNumber} review.`;
  }
  return `Add or verify focused test coverage requested by PR #${comment.pullRequestNumber} review.`;
}

function rankReviewPatternMemories(memories: Memory[], terms: string[], files: string[]): Memory[] {
  return memories
    .map((memory) => ({
      memory,
      score:
        terms.reduce((score, term) => {
          const haystack = `${memory.title} ${memory.summary} ${memory.guidance.join(" ")} ${String(memory.properties.excerpt ?? "")}`.toLowerCase();
          if (!haystack.includes(term)) {
            return score;
          }
          return score + (isSpecificTerm(term) ? 2 : 1);
        }, 0) +
        (files.length > 0 && files.includes(String(memory.properties.filePath ?? "")) ? 3 : 0)
    }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((item) => item.memory);
}

function rankCommits(commits: CommitSummary[], terms: string[]): CommitSummary[] {
  return commits
    .map((commit) => ({
      commit,
      score: terms.filter((term) => commit.message.toLowerCase().includes(term)).length + (commit.jiraKeys?.length ?? 0) * 0.25
    }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((item) => item.commit);
}

function selectStrongCommits(commits: CommitSummary[], terms: string[]): CommitSummary[] {
  return commits.filter((commit) => hasSpecificOverlap(commit.message, terms));
}

async function getPullRequestContextsForRepo(
  store: MemoryStore,
  repo: { id: string },
  terms: string[]
): Promise<PullRequestContext[]> {
  const nodes = await store.findNodes({
    repoId: repo.id,
    type: "pull_request",
    limit: 1000
  });
  return rankPullRequests(nodes.map(pullRequestContextFromNode), terms);
}

async function getPullRequestContextsForFiles(
  store: MemoryStore,
  repo: { id: string; name: string },
  files: string[],
  terms: string[]
): Promise<PullRequestContext[]> {
  const nodes = new Map<string, MemoryNode>();
  for (const file of files.map(normalizeRepoFilePath)) {
    const relationships = await store.findRelationships({
      repoId: repo.id,
      type: "TOUCHED",
      toNodeId: fileNodeId(repo.name, file),
      limit: 100
    });
    for (const relationship of relationships) {
      const node = await store.getNode(relationship.fromNodeId);
      if (node?.type === "pull_request") {
        nodes.set(node.id, node);
      }
    }
  }
  return rankPullRequests([...nodes.values()].map(pullRequestContextFromNode), terms);
}

function pullRequestContextFromNode(node: MemoryNode): PullRequestContext {
  return {
    number: numberProperty(node, "number"),
    title: cleanupPullRequestTitle(node.title ?? node.key),
    body: node.body ?? "",
    url: node.source?.url,
    author: stringProperty(node, "author"),
    mergedAt: stringProperty(node, "mergedAt"),
    jiraKeys: stringArrayProperty(node, "jiraKeys"),
    changedFiles: stringArrayProperty(node, "changedFiles")
  };
}

function rankPullRequests(pullRequests: PullRequestContext[], terms: string[]): PullRequestContext[] {
  return pullRequests
    .map((pullRequest) => ({
      pullRequest,
      score:
        terms.reduce((score, term) => {
          const haystack = `${pullRequest.title} ${pullRequest.body} ${pullRequest.changedFiles.join(" ")}`.toLowerCase();
          if (!haystack.includes(term)) {
            return score;
          }
          return score + (isSpecificTerm(term) ? 2 : 1);
        }, 0) + pullRequest.jiraKeys.length * 0.25
    }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((item) => item.pullRequest);
}

function selectStrongPullRequests(pullRequests: PullRequestContext[], terms: string[]): PullRequestContext[] {
  return pullRequests.filter((pullRequest) =>
    hasSpecificOverlap(`${pullRequest.title} ${pullRequest.body}`, terms)
  );
}

async function getReviewCommentContextsForRepo(
  store: MemoryStore,
  repo: { id: string },
  terms: string[]
): Promise<ReviewCommentContext[]> {
  const nodes = await store.findNodes({
    repoId: repo.id,
    type: "review_comment",
    limit: 1000
  });
  return rankReviewComments(nodes.map(reviewCommentContextFromNode), terms);
}

async function getReviewCommentContextsForFiles(
  store: MemoryStore,
  repo: { id: string; name: string },
  files: string[],
  terms: string[]
): Promise<ReviewCommentContext[]> {
  const nodes = new Map<string, MemoryNode>();
  for (const file of files.map(normalizeRepoFilePath)) {
    const relationships = await store.findRelationships({
      repoId: repo.id,
      type: "APPLIES_TO",
      toNodeId: fileNodeId(repo.name, file),
      limit: 100
    });
    for (const relationship of relationships) {
      const node = await store.getNode(relationship.fromNodeId);
      if (node?.type === "review_comment") {
        nodes.set(node.id, node);
      }
    }
  }
  return rankReviewComments([...nodes.values()].map(reviewCommentContextFromNode), terms);
}

function reviewCommentContextFromNode(node: MemoryNode): ReviewCommentContext {
  return {
    id: node.source?.id ?? node.key,
    pullRequestNumber: numberProperty(node, "pullRequestNumber"),
    body: node.body ?? "",
    author: stringProperty(node, "author"),
    path: stringProperty(node, "path"),
    line: numberPropertyOrUndefined(node, "line"),
    url: node.source?.url,
    jiraKeys: stringArrayProperty(node, "jiraKeys")
  };
}

function rankReviewComments(comments: ReviewCommentContext[], terms: string[]): ReviewCommentContext[] {
  return comments
    .map((comment) => ({
      comment,
      score:
        terms.reduce((score, term) => {
          const haystack = `${comment.body} ${comment.path ?? ""}`.toLowerCase();
          if (!haystack.includes(term)) {
            return score;
          }
          return score + (isSpecificTerm(term) ? 2 : 1);
        }, 0) + comment.jiraKeys.length * 0.25
    }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((item) => item.comment);
}

function selectStrongReviewComments(comments: ReviewCommentContext[], terms: string[]): ReviewCommentContext[] {
  return comments.filter((comment) => hasSpecificOverlap(`${comment.body} ${comment.path ?? ""}`, terms));
}

async function getJiraTicketContexts(store: MemoryStore, keys: string[]): Promise<JiraTicketContext[]> {
  const uniqueKeys = unique(keys);
  const nodes = (
    await Promise.all(uniqueKeys.map((key) => store.getNode(jiraNodeId(key))))
  ).filter((node): node is MemoryNode => node !== null);
  return Promise.all(nodes.map(async (node) => {
    const commentRels = await store.findRelationships({
      repoId: node.repoId ?? "",
      type: "HAS_COMMENT",
      fromNodeId: node.id,
      limit: 20
    });
    const commentBodies: string[] = [];
    for (const rel of commentRels) {
      const commentNode = await store.getNode(rel.toNodeId);
      if (commentNode?.body) {
        commentBodies.push(commentNode.body);
      }
    }
    const bodyWithComments = commentBodies.length > 0
      ? `${node.body ?? ""}\n\nComments:\n${commentBodies.join("\n---\n")}`
      : (node.body ?? "");
    return {
      key: node.key,
      title: cleanupJiraTitle(node.title ?? node.key),
      body: bodyWithComments,
      url: node.source?.url,
      status: typeof node.properties.status === "string" ? node.properties.status : undefined,
      issueType: typeof node.properties.issueType === "string" ? node.properties.issueType : undefined,
      fetchedFromJiraCloud: node.properties.fetchedFromJiraCloud === true
    };
  }));
}

function rankJiraTickets(tickets: JiraTicketContext[], terms: string[], preferredKeys: string[] = []): JiraTicketContext[] {
  const preferred = new Set(preferredKeys);
  return tickets
    .map((ticket) => ({
      ticket,
      score:
        terms.reduce((score, term) => {
          const haystack = `${ticket.key} ${ticket.title} ${ticket.body}`.toLowerCase();
          if (!haystack.includes(term)) {
            return score;
          }
          return score + (isSpecificTerm(term) ? 2 : 1);
        }, 0) +
        (preferred.has(ticket.key) ? 4 : 0) +
        (ticket.fetchedFromJiraCloud ? 0.75 : 0)
    }))
    .filter((item) => item.score > 0 || item.ticket.fetchedFromJiraCloud)
    .sort((a, b) => b.score - a.score)
    .map((item) => item.ticket);
}

function selectStrongJiraTickets(tickets: JiraTicketContext[], terms: string[], preferredKeys: string[]): JiraTicketContext[] {
  const preferred = new Set(preferredKeys);
  return tickets.filter((ticket) => preferred.has(ticket.key) || hasSpecificOverlap(`${ticket.key} ${ticket.title} ${ticket.body}`, terms));
}

function preferredJiraKeysFromCommits(commits: CommitSummary[]): string[] {
  return unique(commits.slice(0, 3).flatMap((commit) => commit.jiraKeys ?? []));
}

function isSpecificTerm(term: string): boolean {
  return !["service", "behavior", "manager", "handler", "helper", "utils", "util"].includes(term);
}

function cleanupJiraTitle(title: string): string {
  return title.replace(/^[A-Z][A-Z0-9]+-[0-9]+:\s*/, "");
}

function cleanupPullRequestTitle(title: string): string {
  return title.replace(/^#[0-9]+:\s*/, "");
}

function stringProperty(node: MemoryNode, key: string): string | undefined {
  const value = node.properties[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberProperty(node: MemoryNode, key: string): number {
  const value = node.properties[key];
  return typeof value === "number" ? value : Number(node.key);
}

function numberPropertyOrUndefined(node: MemoryNode, key: string): number | undefined {
  const value = node.properties[key];
  return typeof value === "number" ? value : undefined;
}

function stringArrayProperty(node: MemoryNode, key: string): string[] {
  const value = node.properties[key];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function overlapReason(commit: CommitSummary, terms: string[]): string {
  const matched = terms.filter((term) => commit.message.toLowerCase().includes(term));
  if (matched.length > 0) {
    return `Message overlaps with: ${matched.slice(0, 5).join(", ")}`;
  }
  if ((commit.jiraKeys?.length ?? 0) > 0) {
    return `Mentions Jira key${commit.jiraKeys?.length === 1 ? "" : "s"} ${commit.jiraKeys?.join(", ")}`;
  }
  return "Recent indexed commit touching this file";
}

function hasOverlap(value: string, terms: string[]): boolean {
  const lower = value.toLowerCase();
  return terms.some((term) => lower.includes(term));
}

function hasSpecificOverlap(value: string, terms: string[]): boolean {
  const lower = value.toLowerCase();
  return terms.some((term) => isSpecificTerm(term) && lower.includes(term));
}

function evidenceExcerpt(value: string, maxLength = 220): string {
  const cleaned = value
    .replace(/!\[[^\]]*\]\([^)]+\)/g, "")
    .replace(/<img\b[^>]*>/gi, "")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.length > maxLength ? `${cleaned.slice(0, maxLength).trim()}...` : cleaned;
}

function firstRelevantSentence(value: string, terms: string[]): string {
  const sentences = completeSentences(value);
  const specificTerms = terms.filter(isSpecificTerm);
  return (
    sentences.find((sentence) => specificTerms.some((term) => sentence.toLowerCase().includes(term))) ??
    sentences.find((sentence) => terms.some((term) => sentence.toLowerCase().includes(term))) ??
    sentences[0] ??
    ""
  );
}

function firstCompleteClause(value: string): string {
  const sentence = completeSentences(value)[0] ?? "";
  if (sentence.length <= 220) {
    return sentence;
  }
  const clause = sentence.split(/[,;:]\s+/)[0]?.trim();
  if (clause && clause.length >= 20 && clause.length <= 220) {
    return clause;
  }
  const words = sentence.split(/\s+/);
  const output: string[] = [];
  for (const word of words) {
    if ([...output, word].join(" ").length > 220) {
      break;
    }
    output.push(word);
  }
  return output.join(" ");
}

function completeSentences(value: string): string[] {
  const cleaned = value
    .replace(/!\[[^\]]*\]\([^)]+\)/g, "")
    .replace(/<img\b[^>]*>/gi, "")
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned.length === 0) {
    return [];
  }
  return (cleaned.match(/[^.!?]+[.!?]+|[^.!?]+$/g) ?? [cleaned]).map((sentence) => sentence.trim()).filter(Boolean);
}

function tokenize(value: string): string[] {
  const withIdentifierBoundaries = value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ");
  return unique(
    withIdentifierBoundaries
      .toLowerCase()
      .split(/[^a-z0-9_-]+/)
      .map((term) => term.trim())
      .filter((term) => term.length >= 3 && !["the", "and", "for", "this", "that", "with", "from", "why", "does", "have"].includes(term))
  );
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function compactSourceReferences(references: SourceReference[], limit: number): SourceReference[] {
  const seen = new Set<string>();
  const output: SourceReference[] = [];
  for (const reference of references) {
    const key = `${reference.type}:${reference.id}:${reference.path ?? ""}:${reference.url ?? ""}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    output.push(reference);
    if (output.length >= limit) {
      break;
    }
  }
  return output;
}

async function readSnippet(repoPath: string, filePath: string, line: number): Promise<string> {
  try {
    const absolutePath = path.join(repoPath, filePath);
    const text = redactSecrets(await fs.readFile(absolutePath, "utf8"));
    const lines = text.split(/\r?\n/);
    const start = Math.max(0, line - 4);
    const end = Math.min(lines.length, line + 3);
    return lines.slice(start, end).join("\n");
  } catch {
    return "";
  }
}

function noExplanation(reason: string, filePath: string): ExplainWhyOutput {
  return {
    answer: reason,
    confidence: "low",
    reasoning: [],
    evidence: [],
    relatedContext: {
      jiraKeys: [],
      relatedFiles: [filePath],
      relatedSymbols: []
    },
    guidance: ["Index the repository before asking historical why-questions."],
    unknowns: ["No local indexed evidence is available."]
  };
}
