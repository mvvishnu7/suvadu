import type { Memory, SourceReference } from "../domain/types.js";
import { memoryId } from "../utils/ids.js";
import { nowIso } from "../utils/time.js";
import type { GitHubReviewComment } from "./githubClient.js";

export interface ReviewPatternInput {
  workspaceId: string;
  repoId: string;
  repoName: string;
  pullRequestNumber: number;
  comment: GitHubReviewComment;
  source: SourceReference;
}

interface ReviewPatternRule {
  category: string;
  title: string;
  summary: string;
  guidance: string[];
  pattern: RegExp;
}

const RULES: ReviewPatternRule[] = [
  {
    category: "architecture-flow",
    title: "Reviewers debated whether this behavior belongs in a separate flow",
    summary: "Past review discussion asked whether the behavior should be split into a separate flow or kept inside the existing use case.",
    guidance: [
      "Make the flow boundary explicit before changing this behavior.",
      "If you add a separate endpoint or use case, explain why it is worth the extra flow.",
      "If you keep the behavior inside the current flow, make required fields and skipped-state handling clear."
    ],
    pattern: /\b(flow|usecase|use case|endpoint|separate|split|architecture|current flow|same usecase)\b/i
  },
  {
    category: "testing",
    title: "Reviewers asked for focused test coverage",
    summary: "Past review comments asked for tests or coverage around similar behavior.",
    guidance: [
      "Add or update focused tests for the changed behavior.",
      "Prefer tests that cover the historical edge case named in the review.",
      "Inspect related integration tests before assuming coverage already exists."
    ],
    pattern: /\b(test|tests|coverage|case|assert|it should|missing test)\b/i
  },
  {
    category: "validation-edge-case",
    title: "Reviewers called out validation or edge-case assumptions",
    summary: "Past review comments questioned assumptions around validation, skipped values, nulls, boundaries, or edge cases.",
    guidance: [
      "Do not assume the happy path covers the skipped or edge state.",
      "Check how omitted, null, zero, and boundary values should behave.",
      "Add tests for the specific edge case before changing validation behavior."
    ],
    pattern: /\b(validation|validate|null|empty|zero|duration|edge|boundary|skipped|skip|must|required|optional)\b/i
  },
  {
    category: "api-contract",
    title: "Reviewers were sensitive to API shape and request fields",
    summary: "Past review comments discussed endpoint shape, request fields, parameters, or API contract clarity.",
    guidance: [
      "Avoid changing request fields or endpoint semantics without an explicit compatibility reason.",
      "Make required and optional fields clear for each flow.",
      "Check clients or frontend behavior before changing the public API shape."
    ],
    pattern: /\b(api|endpoint|request|response|param|parameter|field|contract|dto|body)\b/i
  },
  {
    category: "rollout-safety",
    title: "Reviewers raised rollout or fallback concerns",
    summary: "Past review comments mentioned rollout, fallback, flags, or safe release concerns.",
    guidance: [
      "Consider whether the change needs fallback behavior or a gradual rollout.",
      "Make failure behavior explicit before changing production-facing paths.",
      "Check whether old and new behavior must coexist during release."
    ],
    pattern: /\b(rollout|fallback|flag|feature flag|release|disable|enable|safe|rollback)\b/i
  }
];

export function buildReviewPatternMemory(input: ReviewPatternInput): Memory | null {
  const rule = RULES.find((item) => item.pattern.test(input.comment.body));
  if (!rule) {
    return null;
  }
  const now = nowIso();
  return {
    id: memoryId("review-pattern", input.repoName, rule.category, String(input.pullRequestNumber), String(input.comment.id)),
    type: "review-pattern",
    workspaceId: input.workspaceId,
    repoIds: [input.repoId],
    title: rule.title,
    summary: rule.summary,
    guidance: rule.guidance,
    confidence: 0.72,
    sourceReferences: [input.source],
    properties: {
      category: rule.category,
      pullRequestNumber: input.pullRequestNumber,
      reviewCommentId: input.comment.id,
      filePath: input.comment.path,
      excerpt: excerpt(input.comment.body)
    },
    createdAt: now,
    updatedAt: now
  };
}

function excerpt(value: string): string {
  const cleaned = value.replace(/\s+/g, " ").trim();
  return cleaned.length > 220 ? `${cleaned.slice(0, 220).trim()}...` : cleaned;
}
