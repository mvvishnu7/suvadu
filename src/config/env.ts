export interface JiraCloudEnv {
  baseUrl: string;
  email: string;
  apiToken: string;
}

export function loadJiraCloudEnv(configBaseUrl?: string): JiraCloudEnv | null {
  const baseUrl = process.env.JIRA_BASE_URL ?? configBaseUrl;
  const email = process.env.JIRA_EMAIL;
  const apiToken = process.env.JIRA_API_TOKEN;
  if (!baseUrl || !email || !apiToken) {
    return null;
  }
  return {
    baseUrl: baseUrl.replace(/\/+$/, ""),
    email,
    apiToken
  };
}

export function missingJiraCloudEnvVars(configBaseUrl?: string): string[] {
  const missing: string[] = [];
  if (!process.env.JIRA_BASE_URL && !configBaseUrl) {
    missing.push("JIRA_BASE_URL or jira.baseUrl");
  }
  if (!process.env.JIRA_EMAIL) {
    missing.push("JIRA_EMAIL");
  }
  if (!process.env.JIRA_API_TOKEN) {
    missing.push("JIRA_API_TOKEN");
  }
  return missing;
}
