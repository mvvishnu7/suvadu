import test from "node:test";
import assert from "node:assert/strict";
import { GitHubClient } from "../../src/indexing/githubClient.js";

test("fetches closed GitHub pull requests with changed files and Jira keys", async () => {
  const requested: string[] = [];
  const client = new GitHubClient({
    token: "token",
    fetchImpl: (async (url) => {
      requested.push(String(url));
      if (String(url).includes("/pulls/32/files")) {
        return new Response(JSON.stringify([{ filename: "src/payment.ts" }]), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
      if (String(url).includes("/pulls/32/comments")) {
        return new Response(
          JSON.stringify([
            {
              id: 123,
              body: "Please add PAY-813 compatibility coverage for includeLegacyFees.",
              path: "src/payment.ts",
              line: 12,
              html_url: "https://github.com/acme/payment-service/pull/32#discussion_r123",
              user: { login: "reviewer" }
            }
          ]),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      return new Response(
        JSON.stringify([
          {
            number: 32,
            title: "PAY-813 Preserve legacy fees",
            body: "Keep includeLegacyFees for invoice clients.",
            state: "closed",
            merged_at: "2026-04-01T10:00:00Z",
            html_url: "https://github.com/acme/payment-service/pull/32",
            merge_commit_sha: "abc123",
            user: { login: "dev" }
          }
        ]),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }) as typeof fetch
  });

  const pulls = await client.listClosedPullRequests(
    { owner: "acme", repo: "payment-service" },
    { maxPullRequests: 1 }
  );

  assert.equal(pulls[0]?.number, 32);
  assert.deepEqual(pulls[0]?.changedFiles, ["src/payment.ts"]);
  assert.deepEqual(pulls[0]?.jiraKeys, ["PAY-813"]);
  assert.equal(pulls[0]?.reviewComments.length, 1);
  assert.deepEqual(pulls[0]?.reviewComments[0]?.jiraKeys, ["PAY-813"]);
  assert.equal(pulls[0]?.reviewComments[0]?.path, "src/payment.ts");
  assert.ok(requested.some((url) => url.includes("/pulls?state=closed")));
  assert.ok(requested.some((url) => url.includes("/pulls/32/files")));
  assert.ok(requested.some((url) => url.includes("/pulls/32/comments")));
});
