import test from "node:test";
import assert from "node:assert/strict";
import { extractAdfText, JiraCloudClient } from "../../src/indexing/jiraCloudClient.js";

test("extracts readable text from Jira Cloud ADF", () => {
  const text = extractAdfText({
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [
          { type: "text", text: "Legacy clients" },
          { type: "text", text: " need skip estimation." }
        ]
      }
    ]
  });
  assert.equal(text, "Legacy clients need skip estimation.");
});

test("fetches a Jira Cloud issue without exposing credentials", async () => {
  const requested: Array<{ url: string; authorization?: string }> = [];
  const client = new JiraCloudClient({
    baseUrl: "https://example.atlassian.net",
    email: "dev@example.com",
    apiToken: "token",
    fetchImpl: (async (url, init) => {
      requested.push({
        url: String(url),
        authorization: init?.headers instanceof Headers ? init.headers.get("Authorization") ?? undefined : (init?.headers as Record<string, string>).Authorization
      });
      return new Response(
        JSON.stringify({
          key: "FEAT-101",
          fields: {
            summary: "Skip impact estimation for legacy flow",
            description: {
              type: "doc",
              content: [{ type: "paragraph", content: [{ type: "text", text: "Operators need to submit without estimation." }] }]
            },
            status: { name: "Done" },
            issuetype: { name: "Story" },
            updated: "2026-04-01T10:00:00.000+0000"
          }
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }) as typeof fetch
  });

  const issue = await client.getIssue("FEAT-101");
  assert.equal(issue?.title, "Skip impact estimation for legacy flow");
  assert.equal(issue?.description, "Operators need to submit without estimation.");
  assert.equal(issue?.url, "https://example.atlassian.net/browse/FEAT-101");
  assert.ok(requested[0]?.authorization?.startsWith("Basic "));
  assert.ok(!requested[0]?.authorization?.includes("token"));
});
