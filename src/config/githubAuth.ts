import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface GitHubAuth {
  token: string;
  source: "gh" | "env";
}

export async function loadGitHubAuth(storedToken?: string): Promise<GitHubAuth | null> {
  // 1. Stored token from credentials.json (set via UI) — highest priority
  if (storedToken) {
    return { token: storedToken, source: "env" };
  }
  // 2. Environment variable
  const envToken = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  if (envToken) {
    return { token: envToken, source: "env" };
  }
  // 3. gh CLI fallback
  const ghToken = await tokenFromGh();
  if (ghToken) {
    return { token: ghToken, source: "gh" };
  }
  return null;
}

async function tokenFromGh(): Promise<string | null> {
  try {
    const status = await execFileAsync("gh", ["auth", "status"], {
      encoding: "utf8",
      maxBuffer: 1024 * 1024
    });
    if (ghStatusReportsInvalidAuth(`${status.stdout}\n${status.stderr}`)) {
      return null;
    }
    const result = await execFileAsync("gh", ["auth", "token"], {
      encoding: "utf8",
      maxBuffer: 1024 * 1024
    });
    const token = result.stdout.trim();
    return token.length > 0 ? token : null;
  } catch {
    return null;
  }
}

function ghStatusReportsInvalidAuth(output: string): boolean {
  return /\bfailed to log in\b/i.test(output) || /\btoken\b.*\binvalid\b/i.test(output);
}
