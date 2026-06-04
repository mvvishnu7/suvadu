import readline from "node:readline";
import { performance } from "node:perf_hooks";
import type { LoadedConfig } from "../config/configLoader.js";
import { getChangeContext, getFileMemoryOutput, explainWhyCodeExists, getReviewGuidance } from "../retrieval/contextBuilder.js";
import type { ChangeContextOutput, ReviewGuidanceOutput } from "../retrieval/contextBuilder.js";
import type { SourceReference } from "../domain/types.js";
import type { MemoryStore } from "../storage/MemoryStore.js";

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: unknown;
}

interface ToolCallParams {
  name: string;
  arguments?: Record<string, unknown>;
}

interface PromptGetParams {
  name: string;
  arguments?: Record<string, unknown>;
}

const protocolVersion = "2024-11-05";

export interface McpStartupTiming {
  configLoadMs: number;
  storeOpenMs: number;
  totalMs: number;
}

interface McpToolTiming {
  tool: string;
  retrievalMs: number;
  storageMs: number;
  storageCalls: number;
  serializationMs: number;
  totalMs: number;
  storeMethods: Record<string, { calls: number; ms: number }>;
}

export async function serveMcp(store: MemoryStore, loaded: LoadedConfig, options: { startupTiming?: McpStartupTiming } = {}): Promise<void> {
  process.stderr.write("Suvadu MCP server running on stdio.\n");
  if (isTimingLogEnabled() && options.startupTiming) {
    process.stderr.write(`Suvadu MCP startup timing ${JSON.stringify(roundStartupTiming(options.startupTiming))}\n`);
  }
  const rl = readline.createInterface({
    input: process.stdin,
    crlfDelay: Number.POSITIVE_INFINITY
  });

  rl.on("line", async (line) => {
    if (!line.trim()) {
      return;
    }
    let request: JsonRpcRequest;
    try {
      request = JSON.parse(line) as JsonRpcRequest;
    } catch {
      return;
    }
    if (request.id === undefined || request.id === null) {
      return;
    }
    try {
      const result = await handleRequest(store, loaded, request);
      send({ jsonrpc: "2.0", id: request.id, result });
    } catch (error) {
      send({
        jsonrpc: "2.0",
        id: request.id,
        error: {
          code: -32000,
          message: error instanceof Error ? error.message : String(error)
        }
      });
    }
  });
}

async function handleRequest(store: MemoryStore, loaded: LoadedConfig, request: JsonRpcRequest): Promise<unknown> {
  switch (request.method) {
    case "initialize":
      return {
        protocolVersion,
        capabilities: {
          tools: {},
          prompts: {}
        },
        serverInfo: {
          name: "suvadu",
          version: "0.1.0"
        }
      };
    case "tools/list":
      return { tools: toolDefinitions() };
    case "tools/call":
      return callTool(store, loaded, request.params);
    case "prompts/list":
      return { prompts: promptDefinitions() };
    case "prompts/get":
      return getPrompt(request.params);
    default:
      throw new Error(`Unsupported MCP method: ${request.method}`);
  }
}

async function callTool(store: MemoryStore, loaded: LoadedConfig, params: unknown): Promise<unknown> {
  const tool = params as ToolCallParams;
  if (!tool?.name) {
    throw new Error("Missing tool name");
  }
  const args = tool.arguments ?? {};
  const startedAt = performance.now();
  const timing = newToolTiming(tool.name);
  const timedStore = createTimedStore(store, timing);
  let payload: unknown;
  const retrievalStartedAt = performance.now();
  if (tool.name === "get_file_memory") {
    payload = await getFileMemoryOutput(timedStore, loaded.workspace.id, {
      repo: stringArg(args, "repo"),
      filePath: stringArg(args, "filePath")
    });
  } else if (tool.name === "get_change_context") {
    const changeContext = await getChangeContext(timedStore, loaded.workspace.id, {
      repo: stringArg(args, "repo"),
      task: stringArg(args, "task"),
      files: arrayArg(args, "files")
    });
    payload = booleanArg(args, "includeRaw") === true ? changeContext : compactChangeContextForMcp(changeContext);
  } else if (tool.name === "explain_why_code_exists") {
    payload = await explainWhyCodeExists(timedStore, loaded.workspace.id, {
      repo: stringArg(args, "repo"),
      filePath: stringArg(args, "filePath"),
      question: stringArg(args, "question"),
      symbol: optionalStringArg(args, "symbol"),
      line: optionalNumberArg(args, "line")
    });
  } else if (tool.name === "review_change") {
    const reviewGuidance = await getReviewGuidance(timedStore, loaded.workspace.id, {
      repo: stringArg(args, "repo"),
      diffSummary: stringArg(args, "diffSummary"),
      files: optionalArrayArg(args, "files")
    });
    payload =
      booleanArg(args, "includeRaw") === true
        ? reviewGuidance
        : compactReviewGuidanceForMcp(reviewGuidance, stringArg(args, "diffSummary"));
  } else {
    throw new Error(`Unknown tool: ${tool.name}`);
  }
  timing.retrievalMs = performance.now() - retrievalStartedAt;

  const includeTiming = booleanArg(args, "includeTiming") === true;
  const payloadWithTiming = includeTiming ? withTiming(payload, finalizeTiming(timing, startedAt)) : payload;
  const serializationStartedAt = performance.now();
  const text = JSON.stringify(payloadWithTiming, null, 2);
  timing.serializationMs = performance.now() - serializationStartedAt;
  const finalTiming = finalizeTiming(timing, startedAt);
  if (isTimingLogEnabled()) {
    process.stderr.write(`Suvadu MCP tool timing ${JSON.stringify(finalTiming)}\n`);
  }
  return {
    _meta: {
      suvaduTiming: finalTiming
    },
    content: [
      {
        type: "text",
        text
      }
    ]
  };
}

export function compactChangeContextForMcp(output: ChangeContextOutput): unknown {
  return {
    summary: output.summary,
    confidence: output.confidence,
    briefing: {
      why: output.briefing.why,
      risks: output.briefing.risks,
      guidance: output.briefing.guidance,
      tests: output.briefing.tests,
      sources: compactSourceLabels(output.briefing.sources)
    },
    relatedFiles: output.relatedFiles,
    unknowns: output.unknowns
  };
}

export function compactReviewGuidanceForMcp(output: ReviewGuidanceOutput, diffSummary = ""): unknown {
  return {
    summary: output.summary,
    confidence: output.confidence,
    briefing: {
      likelyConcerns: compactReviewConcerns(output, diffSummary),
      riskyAssumptions: compactReviewAssumptions(output, diffSummary),
      checklist: compactReviewChecklist(output, diffSummary),
      tests: compactReviewTests(output, diffSummary),
      sources: compactReviewSourceLabels(output.evidence, diffSummary)
    },
    unknowns: output.unknowns
  };
}

function compactReviewConcerns(output: ReviewGuidanceOutput, diffSummary: string): string[] {
  const context = reviewContext(diffSummary);
  const concerns: string[] = [];
  if (context.validation) {
    concerns.push("Validation and edge cases are reviewer-sensitive for this change.");
  }
  if (context.jiraComment) {
    concerns.push("Jira comment behavior may affect multiple submission paths.");
  }
  if (hasReviewSignal(output, /\b(public api|endpoint|request|response|contract|dto)\b/i)) {
    concerns.push("Endpoint and request-contract semantics are likely reviewer concerns for this change.");
  }
  if (hasReviewSignal(output, /\b(test|coverage)\b/i)) {
    concerns.push("Reviewers previously asked for focused tests around this path.");
  }
  return uniqueStrings([...concerns, ...specificReviewItems(output.likelyReviewerConcerns, diffSummary)]).slice(0, 5);
}

function compactReviewAssumptions(output: ReviewGuidanceOutput, diffSummary: string): string[] {
  const context = reviewContext(diffSummary);
  const assumptions: string[] = [];
  if (context.validation) {
    assumptions.push("Happy-path requests may not cover omitted, null, zero, or boundary values.");
  }
  if (context.jiraComment) {
    assumptions.push("Changing Jira comment behavior may affect multiple submission paths.");
  }
  const riskSummary = summarizeHistoricalRisk(output.riskyAssumptions);
  if (riskSummary) {
    assumptions.push(riskSummary);
  }
  return uniqueStrings([...assumptions, ...specificReviewItems(output.riskyAssumptions, diffSummary)]).slice(0, 6);
}

function compactReviewChecklist(output: ReviewGuidanceOutput, diffSummary: string): string[] {
  const context = reviewContext(diffSummary);
  const checklist: string[] = [];
  if (context.validation) {
    checklist.push("Cover boundary values and edge cases before merging.");
  }
  if (context.jiraComment) {
    checklist.push("Verify Jira comment output for all affected submission paths.");
  }
  if (hasReviewSignal(output, /\b(public api|endpoint|request|response|contract|dto)\b/i)) {
    checklist.push("Keep endpoint and DTO semantics stable unless the diff intentionally changes the public contract.");
  }
  return uniqueStrings([...checklist, ...specificReviewItems(output.checklist, diffSummary)]).slice(0, 6);
}

function compactReviewTests(output: ReviewGuidanceOutput, diffSummary: string): string[] {
  const context = reviewContext(diffSummary);
  const tests: string[] = [];
  if (context.validation) {
    tests.push("Add or verify validation edge-case tests for the changed behavior.");
  }
  if (context.jiraComment) {
    tests.push("Add or verify Jira comment tests for the affected submission paths.");
  }
  tests.push(...specificReviewItems(output.testsToAdd, diffSummary));
  return uniqueStrings(tests).slice(0, 6);
}

function compactReviewItems(items: string[], diffSummary: string): string[] {
  const lowerDiff = diffSummary.toLowerCase();
  const allowRollout = /\b(rollout|feature flag|flag|fallback|disable|hotfix|rollback)\b/i.test(lowerDiff);
  const allowPerformance = /\b(performance|latency|slow|load|query|cache|timeout)\b/i.test(lowerDiff);
  return items
    .filter((item) => {
      const lower = item.toLowerCase();
      if (!allowRollout && /\b(rollout|feature flag|flag|fallback|release everywhere at once)\b/.test(lower)) {
        return false;
      }
      if (!allowPerformance && /\b(performance|latency|hot path)\b/.test(lower)) {
        return false;
      }
      if (/missing unit or integration tests requested by similar historical reviews/.test(lower)) {
        return false;
      }
      return true;
    })
    .slice(0, 6);
}

function specificReviewItems(items: string[], diffSummary: string): string[] {
  return compactReviewItems(items, diffSummary)
    .filter((item) => !/^(Testing coverage|Public API behavior|Validation and edge cases|Rollout safety|Performance|Backward compatibility|Migration or persistence|Security or permissions)$/i.test(item))
    .filter((item) => !/^Past review comments/i.test(item))
    .filter((item) => !/^Skipped estimation does not mean duration is 0\.$/i.test(item))
    .filter((item) => !/^Add or update focused tests for the changed behavior\.$/i.test(item))
    .filter((item) => !/^Cover boundary values and domain edge cases before merging\.$/i.test(item))
    .filter((item) => !/^Inspect related integration tests before assuming coverage already exists\.$/i.test(item))
    .filter((item) => !/^Add validation edge-case tests referenced by PR #[0-9]+ review\.$/i.test(item))
    .filter((item) => !/^Existing tests may not cover the path this change affects\.$/i.test(item))
    .filter((item) => !/^The API surface is only used by the current code path\.$/i.test(item))
    .filter((item) => !/^Normal happy-path input is representative of production input\.$/i.test(item))
    .filter((item) => !/^Touched by \d+/i.test(item))
    .filter((item) => !/^Changed by \d+/i.test(item))
    .filter((item) => !/^Often changes with \d+/i.test(item));
}

function reviewContext(diffSummary: string): { validation: boolean; jiraComment: boolean } {
  return {
    validation: /\bvalidation|validate|required|required fields?|null|zero|boundary|edge\b/i.test(diffSummary),
    jiraComment: /\bjira\b/i.test(diffSummary) && /\bcomment|submission|submit\b/i.test(diffSummary)
  };
}

function hasReviewSignal(output: ReviewGuidanceOutput, pattern: RegExp): boolean {
  return [
    ...output.likelyReviewerConcerns,
    ...output.checklist,
    ...output.riskyAssumptions,
    ...output.testsToAdd,
    ...output.evidence.map((source) => `${source.id} ${source.title ?? ""} ${source.path ?? ""} ${source.reason ?? ""}`)
  ].some((item) => pattern.test(item));
}

function summarizeHistoricalRisk(items: string[]): string | undefined {
  const touched = firstMatching(items, /^Touched by /i);
  const authors = firstMatching(items, /^Changed by /i);
  const coChanged = firstMatching(items, /^Often changes with /i);
  const parts = [touched, authors, coChanged].filter((item): item is string => item !== undefined);
  return parts.length > 0 ? `This area is historically busy: ${parts.join("; ")}.` : undefined;
}

function firstMatching(items: string[], pattern: RegExp): string | undefined {
  return items.find((item) => pattern.test(item));
}

function uniqueStrings(items: string[]): string[] {
  return [...new Set(items.filter((item) => item.trim().length > 0))];
}

function compactReviewSourceLabels(sources: SourceReference[], diffSummary: string): string[] {
  const pullRequests = rankedSources(sources.filter((source) => source.type === "pull_request"), diffSummary).slice(0, 2);
  const jiraTickets = rankedSources(sources.filter((source) => source.type === "jira"), diffSummary).slice(0, 2);
  const reviewComments = rankedSources(
    sources.filter((source) => source.type === "review_comment"),
    diffSummary,
    pullRequests.map((source) => source.id)
  ).slice(0, 2);
  return compactSourceLabels([...pullRequests, ...jiraTickets, ...reviewComments], 6);
}

function rankedSources(sources: SourceReference[], text: string, preferredIds: string[] = []): SourceReference[] {
  const terms = sourceTerms(text);
  return sources
    .map((source, index) => ({
      source,
      index,
      score:
        terms.reduce((score, term) => {
          const haystack = `${source.id} ${source.title ?? ""} ${source.path ?? ""} ${source.reason ?? ""}`.toLowerCase();
          return sourceContainsTerm(haystack, term) ? score + sourceTermWeight(term) : score;
        }, 0) +
        (preferredIds.some((id) => source.id.startsWith(`${id} `)) ? 4 : 0) +
        (source.reason?.toLowerCase().includes("diff summary") ? 1 : 0)
    }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((item) => item.source);
}

function sourceContainsTerm(haystack: string, term: string): boolean {
  if (haystack.includes(term)) {
    return true;
  }
  return term === "validation" && /\bvalidator\b/.test(haystack);
}

function sourceTermWeight(term: string): number {
  if (term === "validation" || term === "auth" || term === "payment" || term === "skip") {
    return 4;
  }
  if (term === "jira" || term === "comment" || term === "migration") {
    return 3;
  }
  if (term === "controller" || term === "service" || term === "handler") {
    return 2;
  }
  return 1;
}

function sourceTerms(text: string): string[] {
  return [
    ...new Set(
      text
        .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((term) => term.length >= 4 && !["changed", "change", "behavior", "summary"].includes(term))
    )
  ];
}

function compactSourceLabels(sources: SourceReference[], limit = 8): string[] {
  const labels: string[] = [];
  const seen = new Set<string>();
  for (const source of sources) {
    const label = sourceLabel(source);
    if (seen.has(label)) {
      continue;
    }
    seen.add(label);
    labels.push(label);
    if (labels.length >= limit) {
      break;
    }
  }
  return labels;
}

function sourceLabel(source: SourceReference): string {
  if (source.type === "jira" || source.type === "pull_request") {
    return `${source.id}${source.title ? ` - ${source.title}` : ""}`;
  }
  if (source.type === "review_comment") {
    return `${source.title ?? source.id}${source.path ? ` (${source.path})` : ""}`;
  }
  return `${source.type} ${source.id}${source.title ? ` - ${source.title}` : ""}`;
}

function toolDefinitions(): unknown[] {
  return [
    {
      name: "get_file_memory",
      description: "Return concise, source-backed memory for an indexed file.",
      inputSchema: {
        type: "object",
        properties: {
          repo: { type: "string" },
          filePath: { type: "string" },
          includeTiming: { type: "boolean", description: "Debug only: include MCP timing in the JSON response." }
        },
        required: ["repo", "filePath"]
      }
    },
    {
      name: "get_change_context",
      description: "Prepare historical context before editing one or more indexed files.",
      inputSchema: {
        type: "object",
        properties: {
          repo: { type: "string" },
          task: { type: "string" },
          files: {
            type: "array",
            items: { type: "string" }
          },
          includeRaw: {
            type: "boolean",
            description: "Debug/inspection only: include raw file memories and historical evidence arrays. Defaults to false."
          },
          includeTiming: { type: "boolean", description: "Debug only: include MCP timing in the JSON response." }
        },
        required: ["repo", "task", "files"]
      }
    },
    {
      name: "explain_why_code_exists",
      description: "Explain why code may exist using indexed local history, with confidence and evidence.",
      inputSchema: {
        type: "object",
        properties: {
          repo: { type: "string" },
          filePath: { type: "string" },
          question: { type: "string" },
          symbol: { type: "string" },
          line: { type: "number" },
          includeTiming: { type: "boolean", description: "Debug only: include MCP timing in the JSON response." }
        },
        required: ["repo", "filePath", "question"]
      }
    },
    {
      name: "review_change",
      description: "Review a proposed or completed change against indexed engineering history and likely reviewer concerns.",
      inputSchema: {
        type: "object",
        properties: {
          repo: { type: "string" },
          diffSummary: { type: "string" },
          files: {
            type: "array",
            items: { type: "string" }
          },
          includeRaw: {
            type: "boolean",
            description: "Debug/inspection only: include raw review fields and full evidence metadata. Defaults to false."
          },
          includeTiming: { type: "boolean", description: "Debug only: include MCP timing in the JSON response." }
        },
        required: ["repo", "diffSummary"]
      }
    }
  ];
}

function promptDefinitions(): unknown[] {
  return [
    {
      name: "prepare_change",
      description: "Gather Suvadu memory before editing code.",
      arguments: [
        { name: "repo", description: "Suvadu repository name.", required: true },
        { name: "task", description: "The coding task or intended change.", required: true },
        { name: "files", description: "Comma-separated file paths likely to be edited.", required: true }
      ]
    },
    {
      name: "review_my_change",
      description: "Check a proposed or completed change against historical reviewer concerns.",
      arguments: [
        { name: "repo", description: "Suvadu repository name.", required: true },
        { name: "diffSummary", description: "Concise summary of the actual code change.", required: true },
        { name: "files", description: "Comma-separated changed file paths.", required: false }
      ]
    },
    {
      name: "explain_code",
      description: "Explain why code exists using Suvadu memory, while separating mechanics from historical intent.",
      arguments: [
        { name: "repo", description: "Suvadu repository name.", required: true },
        { name: "filePath", description: "File path to explain.", required: true },
        { name: "question", description: "Why/how question about the code.", required: true },
        { name: "symbol", description: "Optional symbol, parameter, endpoint, or method name.", required: false }
      ]
    }
  ];
}

function getPrompt(params: unknown): unknown {
  const prompt = params as PromptGetParams;
  if (!prompt?.name) {
    throw new Error("Missing prompt name");
  }
  const args = prompt.arguments ?? {};
  if (prompt.name === "prepare_change") {
    return promptResponse(
      "prepare_change",
      `You are preparing to edit code with Suvadu memory.

Repository: ${optionalPromptValue(args, "repo")}
Task: ${optionalPromptValue(args, "task")}
Files: ${optionalPromptValue(args, "files")}

Before editing:
1. Call Suvadu tool get_change_context with repo, task, and files.
2. Start from the returned briefing: why this matters, risks, guidance, tests, and sources.
3. If you encounter a surprising parameter, branch, workaround, endpoint, migration, or validation rule, call explain_why_code_exists for that file/symbol before changing it.
4. Use code reading for mechanics and Suvadu evidence for historical intent.
5. Do not treat low-confidence memory as fact. Keep source references in mind for your final explanation.
6. Make the smallest change consistent with the task and the historical guidance.`
    );
  }
  if (prompt.name === "review_my_change") {
    return promptResponse(
      "review_my_change",
      `You are reviewing your change with Suvadu memory before finalizing.

Repository: ${optionalPromptValue(args, "repo")}
Diff summary: ${optionalPromptValue(args, "diffSummary")}
Files: ${optionalPromptValue(args, "files")}

Before final response or PR:
1. Call Suvadu tool review_change with repo, diffSummary, and files.
2. Check likely reviewer concerns, risky assumptions, tests to add, and source-backed evidence.
3. Inspect or run the suggested tests when practical.
4. If Suvadu points to prior PRs/Jira/review comments, account for those concerns in your implementation or explicitly explain why they do not apply.
5. Report remaining unknowns honestly; Suvadu may not index ADRs or incidents yet.`
    );
  }
  if (prompt.name === "explain_code") {
    return promptResponse(
      "explain_code",
      `You are explaining code using Suvadu memory.

Repository: ${optionalPromptValue(args, "repo")}
File: ${optionalPromptValue(args, "filePath")}
Question: ${optionalPromptValue(args, "question")}
Symbol: ${optionalPromptValue(args, "symbol")}

To answer:
1. Call Suvadu tool explain_why_code_exists with repo, filePath, question, and symbol if provided.
2. Separate "how the code works now" from "why history suggests it exists".
3. Cite Jira, PR, review-comment, and commit evidence when Suvadu provides it.
4. If confidence is low, say that the historical reason is not proven by indexed memory.
5. For "how" questions, read the code directly and use Suvadu for breadcrumbs, risks, and source references.`
    );
  }
  throw new Error(`Unknown prompt: ${prompt.name}`);
}

function promptResponse(name: string, text: string): unknown {
  return {
    description: `Suvadu ${name} prompt`,
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text
        }
      }
    ]
  };
}

function optionalPromptValue(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  return typeof value === "string" && value.trim().length > 0 ? value : `<${key}>`;
}

function send(message: unknown): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function newToolTiming(tool: string): McpToolTiming {
  return {
    tool,
    retrievalMs: 0,
    storageMs: 0,
    storageCalls: 0,
    serializationMs: 0,
    totalMs: 0,
    storeMethods: {}
  };
}

function createTimedStore(store: MemoryStore, timing: McpToolTiming): MemoryStore {
  return new Proxy(store, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver) as unknown;
      if (typeof value !== "function" || property === "close") {
        return value;
      }
      return async (...args: unknown[]) => {
        const startedAt = performance.now();
        try {
          return await (value as (...methodArgs: unknown[]) => Promise<unknown>).apply(target, args);
        } finally {
          recordStoreTiming(timing, String(property), performance.now() - startedAt);
        }
      };
    }
  }) as MemoryStore;
}

function recordStoreTiming(timing: McpToolTiming, method: string, elapsedMs: number): void {
  timing.storageMs += elapsedMs;
  timing.storageCalls += 1;
  const existing = timing.storeMethods[method] ?? { calls: 0, ms: 0 };
  timing.storeMethods[method] = {
    calls: existing.calls + 1,
    ms: existing.ms + elapsedMs
  };
}

function finalizeTiming(timing: McpToolTiming, startedAt: number): McpToolTiming {
  return {
    tool: timing.tool,
    retrievalMs: roundMs(timing.retrievalMs),
    storageMs: roundMs(timing.storageMs),
    storageCalls: timing.storageCalls,
    serializationMs: roundMs(timing.serializationMs),
    totalMs: roundMs(performance.now() - startedAt),
    storeMethods: Object.fromEntries(
      Object.entries(timing.storeMethods)
        .sort((left, right) => right[1].ms - left[1].ms)
        .map(([method, value]) => [
          method,
          {
            calls: value.calls,
            ms: roundMs(value.ms)
          }
        ])
    )
  };
}

function withTiming(payload: unknown, timing: McpToolTiming): unknown {
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    return {
      ...payload,
      _timing: timing
    };
  }
  return {
    result: payload,
    _timing: timing
  };
}

function isTimingLogEnabled(): boolean {
  return process.env.SUVADU_MCP_TIMING === "1" || process.env.SUVADU_MCP_TIMING === "true";
}

function roundStartupTiming(timing: McpStartupTiming): McpStartupTiming {
  return {
    configLoadMs: roundMs(timing.configLoadMs),
    storeOpenMs: roundMs(timing.storeOpenMs),
    totalMs: roundMs(timing.totalMs)
  };
}

function roundMs(value: number): number {
  return Math.round(value * 10) / 10;
}

function stringArg(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Missing required string argument: ${key}`);
  }
  return value;
}

function optionalStringArg(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function optionalNumberArg(args: Record<string, unknown>, key: string): number | undefined {
  const value = args[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function booleanArg(args: Record<string, unknown>, key: string): boolean | undefined {
  const value = args[key];
  return typeof value === "boolean" ? value : undefined;
}

function arrayArg(args: Record<string, unknown>, key: string): string[] {
  const value = args[key];
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new Error(`Missing required string array argument: ${key}`);
  }
  return value;
}

function optionalArrayArg(args: Record<string, unknown>, key: string): string[] | undefined {
  const value = args[key];
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new Error(`Expected string array argument: ${key}`);
  }
  return value;
}
