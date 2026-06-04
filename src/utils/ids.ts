import { createHash } from "node:crypto";

export function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

export function workspaceId(name: string): string {
  return `workspace:${slug(name)}`;
}

export function repoId(name: string): string {
  return `repo:${slug(name)}`;
}

export function fileNodeId(repoName: string, filePath: string): string {
  return `file:${slug(repoName)}:${normalizeIdPart(filePath)}`;
}

export function commitNodeId(repoName: string, hash: string): string {
  return `commit:${slug(repoName)}:${hash}`;
}

export function pullRequestNodeId(repoName: string, number: number): string {
  return `pr:${slug(repoName)}:${number}`;
}

export function reviewCommentNodeId(repoName: string, pullRequestNumber: number, commentId: number | string): string {
  return `review-comment:${slug(repoName)}:${pullRequestNumber}:${normalizeIdPart(String(commentId))}`;
}

export function issueCommentNodeId(repoName: string, pullRequestNumber: number, commentId: number | string): string {
  return `issue-comment:${slug(repoName)}:${pullRequestNumber}:${normalizeIdPart(String(commentId))}`;
}

export function jiraNodeId(key: string): string {
  return `jira:${key.toUpperCase()}`;
}

export function jiraCommentNodeId(key: string, commentId: string | number): string {
  return `jira-comment:${key.toUpperCase()}:${String(commentId)}`;
}

export function relationshipId(type: string, fromNodeId: string, toNodeId: string): string {
  return `rel:${type}:${sha256(`${fromNodeId}->${toNodeId}`).slice(0, 24)}`;
}

export function memoryId(...parts: string[]): string {
  return `memory:${sha256(parts.join("\n")).slice(0, 32)}`;
}

export function slug(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
}

function normalizeIdPart(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\/+/, "");
}
