import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function runGit(repoPath: string, args: string[], options?: { maxBuffer?: number }): Promise<string> {
  const result = await execFileAsync("git", ["-C", repoPath, ...args], {
    encoding: "utf8",
    maxBuffer: options?.maxBuffer ?? 20 * 1024 * 1024
  });
  return result.stdout;
}

export async function isGitInstalled(): Promise<boolean> {
  try {
    await execFileAsync("git", ["--version"], {
      encoding: "utf8",
      maxBuffer: 1024 * 1024
    });
    return true;
  } catch {
    return false;
  }
}

export async function getGitHead(repoPath: string): Promise<string | null> {
  try {
    return (await runGit(repoPath, ["rev-parse", "HEAD"])).trim();
  } catch {
    return null;
  }
}

export async function isGitRepository(path: string): Promise<boolean> {
  try {
    const output = await runGit(path, ["rev-parse", "--is-inside-work-tree"]);
    return output.trim() === "true";
  } catch {
    return false;
  }
}

export interface GitHubRemoteInfo {
  host: string;
  owner: string;
  repo: string;
  remote: string;
  url: string;
}

export async function detectGitHubRemote(repoPath: string): Promise<GitHubRemoteInfo | null> {
  let remoteNames: string[];
  try {
    remoteNames = (await runGit(repoPath, ["remote"]))
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return null;
  }
  const orderedRemoteNames = remoteNames.includes("origin")
    ? ["origin", ...remoteNames.filter((remote) => remote !== "origin")]
    : remoteNames;
  for (const remote of orderedRemoteNames) {
    try {
      const url = (await runGit(repoPath, ["remote", "get-url", remote])).trim();
      const parsed = parseGitHubRemoteUrl(url);
      if (parsed) {
        return {
          ...parsed,
          remote,
          url
        };
      }
    } catch {
      // Try the next configured remote.
    }
  }
  return null;
}

export function parseGitHubRemoteUrl(remoteUrl: string): Pick<GitHubRemoteInfo, "host" | "owner" | "repo"> | null {
  const value = remoteUrl.trim();
  if (!value) {
    return null;
  }

  if (!value.includes("://")) {
    const scpLike = /^(?:[^@]+@)?([^:]+):([^/]+)\/(.+?)(?:\.git)?\/?$/.exec(value);
    if (scpLike) {
      const [, host, owner, repo] = scpLike;
      return normalizeGitHubParts(host, owner, repo);
    }
  }

  try {
    const url = new URL(value);
    const [owner, repo] = url.pathname.replace(/^\/+|\/+$/g, "").split("/");
    return normalizeGitHubParts(url.hostname, owner, repo);
  } catch {
    return null;
  }
}

function normalizeGitHubParts(host: string | undefined, owner: string | undefined, repo: string | undefined): Pick<GitHubRemoteInfo, "host" | "owner" | "repo"> | null {
  if (!host || !owner || !repo || !isLikelyGitHubHost(host)) {
    return null;
  }
  const cleanRepo = repo.replace(/\.git$/i, "");
  if (!cleanRepo) {
    return null;
  }
  return {
    host,
    owner,
    repo: cleanRepo
  };
}

function isLikelyGitHubHost(host: string): boolean {
  return host.toLowerCase().includes("github");
}
