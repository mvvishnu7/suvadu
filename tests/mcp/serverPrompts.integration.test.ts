import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp } from "node:fs/promises";

const execFileAsync = promisify(execFile);

test("MCP server exposes Suvadu prompts", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "suvadu-mcp-prompts-"));
  const workspace = path.join(root, "workspace");
  await mkdir(workspace, { recursive: true });
  await execFileAsync(process.execPath, [path.resolve("dist/src/cli/index.js"), "init"], { cwd: workspace });

  const server = execFile(process.execPath, [path.resolve("dist/src/cli/index.js"), "serve"], { cwd: workspace });
  assert.ok(server.stdout);
  assert.ok(server.stdin);
  const rl = createInterface({ input: server.stdout });
  try {
    server.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" })}\n`);
    const initialize = JSON.parse(String((await once(rl, "line"))[0]));
    assert.equal(initialize.result.capabilities.prompts !== undefined, true);

    server.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "prompts/list" })}\n`);
    const list = JSON.parse(String((await once(rl, "line"))[0]));
    const names = list.result.prompts.map((prompt: { name: string }) => prompt.name);
    assert.deepEqual(names, ["prepare_change", "review_my_change", "explain_code"]);

    server.stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "prompts/get",
        params: {
          name: "review_my_change",
          arguments: {
            repo: "payment-service",
            diffSummary: "Changed VAT rounding",
            files: "src/payment.ts"
          }
        }
      })}\n`
    );
    const prompt = JSON.parse(String((await once(rl, "line"))[0]));
    const text = prompt.result.messages[0].content.text;
    assert.match(text, /review_change/);
    assert.match(text, /Changed VAT rounding/);
  } finally {
    rl.close();
    server.kill();
  }
});

test("MCP tools can include debug timing without changing normal output", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "suvadu-mcp-timing-"));
  const workspace = path.join(root, "workspace");
  await mkdir(workspace, { recursive: true });
  await execFileAsync(process.execPath, [path.resolve("dist/src/cli/index.js"), "init"], { cwd: workspace });

  const server = execFile(process.execPath, [path.resolve("dist/src/cli/index.js"), "serve"], { cwd: workspace });
  assert.ok(server.stdout);
  assert.ok(server.stdin);
  const rl = createInterface({ input: server.stdout });
  try {
    server.stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "get_file_memory",
          arguments: {
            repo: "missing",
            filePath: "src/missing.ts"
          }
        }
      })}\n`
    );
    const normal = JSON.parse(String((await once(rl, "line"))[0]));
    const normalPayload = JSON.parse(normal.result.content[0].text);
    assert.equal(normalPayload._timing, undefined);
    assert.equal(typeof normal.result._meta.suvaduTiming.totalMs, "number");

    server.stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "get_file_memory",
          arguments: {
            repo: "missing",
            filePath: "src/missing.ts",
            includeTiming: true
          }
        }
      })}\n`
    );
    const timed = JSON.parse(String((await once(rl, "line"))[0]));
    const timedPayload = JSON.parse(timed.result.content[0].text);
    assert.equal(timedPayload._timing.tool, "get_file_memory");
    assert.equal(typeof timedPayload._timing.storageMs, "number");
    assert.equal(timedPayload._timing.storageCalls > 0, true);
  } finally {
    rl.close();
    server.kill();
  }
});
