import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Search1APIPlugin } from "../index.mjs";
import { context } from "./helpers.mjs";

const baseUrl = "https://search1api.invalid";
const agentback = "https://agentback.app";
const json = (value, status = 200) => new Response(JSON.stringify(value), { status });

// Every fetch is replaced: no real API or Agentback project is reached.
async function stub(t, handler) {
  const directory = await mkdtemp(join(tmpdir(), "search1api-feedback-test-"));
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.SEARCH1API_API_KEY;
  delete process.env.SEARCH1API_API_KEY;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const call = { url: new URL(String(url)), ...init };
    calls.push(call);
    assert.ok([baseUrl, agentback].includes(call.url.origin));
    return handler(call);
  };
  t.after(async () => {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.SEARCH1API_API_KEY;
    else process.env.SEARCH1API_API_KEY = originalKey;
    await rm(directory, { recursive: true, force: true });
  });
  const input = { directory, client: { auth: { set: async () => {} } } };
  return { calls, input };
}

const report = { message: "Empty results for a known page", intent: "Find docs", category: "bug", model: "fixture-model" };

test("feedback is signed with the user's Search1API identity and sent to Agentback", async (t) => {
  const f = await stub(t, (call) =>
    call.url.origin === baseUrl
      ? json({ account: "user_fixture", signature: "f".repeat(64) })
      : json({ id: "fb_fixture" }, 201));
  const plugin = await Search1APIPlugin(f.input, { baseUrl, apiKey: "fixture-key" });
  // The agent decides what to send from the description alone.
  assert.match(plugin.tool.send_feedback.description, /agentback\.app/);
  assert.match(plugin.tool.send_feedback.description, /linked to their Search1API account/);
  assert.doesNotMatch(plugin.tool.send_feedback.args.properties.intent.description, /trying to accomplish/);
  const text = await plugin.tool.send_feedback.execute(report, context());
  assert.equal(text, "Feedback recorded (fb_fixture). Thank you.");
  assert.equal(f.calls[0].url.pathname, "/feedback/identity");
  assert.equal(new Headers(f.calls[0].headers).get("authorization"), "Bearer fixture-key");
  assert.match(f.calls[1].url.pathname, /^\/f\/af_[a-f0-9]{64}$/);
  assert.equal(f.calls[1].method, "POST");
  assert.deepEqual(JSON.parse(f.calls[1].body), {
    message: report.message,
    intent: report.intent,
    category: "bug",
    agent: { name: "Magpie", model: "fixture-model" },
    source: "direct",
    account: "user_fixture",
    account_signature: "f".repeat(64),
  });
});

test("feedback without a credential or identity is still sent, and failures never throw", async (t) => {
  let status = 201;
  const f = await stub(t, (call) =>
    call.url.origin === baseUrl ? json({ message: "unauthorized" }, 401) : json(status === 201 ? { id: "fb_anon" } : { error: "x" }, status));
  const plugin = await Search1APIPlugin(f.input, { baseUrl });
  const message = { message: "Missing capability" };
  assert.equal(await plugin.tool.send_feedback.execute(message, context()), "Feedback recorded (fb_anon). Thank you.");
  assert.equal(f.calls.length, 1);
  assert.deepEqual(JSON.parse(f.calls[0].body), { message: "Missing capability", agent: { name: "Magpie" }, source: "direct" });

  const keyed = await Search1APIPlugin(f.input, { baseUrl, apiKey: "revoked-key" });
  status = 503;
  assert.match(await keyed.tool.send_feedback.execute(message, context()), /not recorded \(HTTP 503\)/);
  assert.equal(JSON.parse(f.calls.at(-1).body).account, undefined);
  globalThis.fetch = async () => { throw new TypeError("offline"); };
  assert.match(await keyed.tool.send_feedback.execute(message, context()), /could not be reached/);
});

test("invalid feedback is refused before any request", async (t) => {
  const f = await stub(t, () => json({}));
  const plugin = await Search1APIPlugin(f.input, { baseUrl, apiKey: "fixture-key" });
  for (const args of [{}, { message: "" }, { message: "x", category: "praise" }, { message: "x", extra: 1 }])
    await assert.rejects(plugin.tool.send_feedback.execute(args, context()));
  assert.equal(f.calls.length, 0);
});
