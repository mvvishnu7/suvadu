const DEFAULT_JIRA_KEY_PATTERN = /\b[A-Z][A-Z0-9]+-[0-9]+\b/g;

export function detectJiraKeys(text: string, projectKeys?: string[]): string[] {
  const matches = new Set<string>();
  for (const match of text.matchAll(DEFAULT_JIRA_KEY_PATTERN)) {
    const key = match[0].toUpperCase();
    if (!projectKeys || projectKeys.length === 0) {
      matches.add(key);
      continue;
    }
    const project = key.split("-")[0];
    if (projectKeys.map((p) => p.toUpperCase()).includes(project)) {
      matches.add(key);
    }
  }
  return [...matches].sort();
}
