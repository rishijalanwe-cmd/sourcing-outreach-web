// Manual test harness -- mirrors api/source.test.js. Run with: node api/scorecard.test.js

const handler = require("./scorecard.js");

function mockRes() {
  const res = { statusCode: 200, body: null };
  res.status = function (code) { res.statusCode = code; return res; };
  res.json = function (obj) { res.body = obj; return res; };
  res.setHeader = function () { return res; };
  return res;
}

async function run(name, req) {
  const res = mockRes();
  await handler(req, res);
  console.log(`\n=== ${name} ===`);
  console.log("status:", res.statusCode);
  console.log("body:", JSON.stringify(res.body, null, 2).slice(0, 1500));
  return res;
}

function assert(cond, msg) {
  if (!cond) throw new Error("ASSERTION FAILED: " + msg);
}

const CONVO = [
  { role: "user", content: "I need a scorecard for a Senior Backend Engineer." },
  { role: "assistant", content: "Why does this role exist right now?" },
  { role: "user", content: "Our two engineers can't keep up with the roadmap and we need someone senior to own the payments service." },
  { role: "assistant", content: "If this person crushes it, what's different in 12 months?" },
  { role: "user", content: "Payments service is rock solid, ships independently, and the other two engineers focus on product." },
];

async function main() {
  const realFetch = global.fetch;

  // ---- missing llm key ----
  await run("missing llm key", { method: "POST", body: { mode: "chat", messages: CONVO, keys: {} } });

  // ---- wrong method ----
  await run("wrong method", { method: "GET", body: {} });

  // ---- chat mode with no messages ----
  await run("chat mode, no messages -> 400", {
    method: "POST",
    body: { mode: "chat", messages: [], keys: { llmApiKey: "x" } },
  });

  // ---- finalize mode too early (only 1 user turn) ----
  await run("finalize too early -> 400", {
    method: "POST",
    body: { mode: "finalize", messages: [{ role: "user", content: "hi" }], keys: { llmApiKey: "x" } },
  });

  // ---- chat mode happy path via Anthropic (default) ----
  {
    global.fetch = async (url, opts) => {
      assert(String(url).includes("api.anthropic.com"), "expected Anthropic call, got " + url);
      const body = JSON.parse(opts.body);
      assert(body.messages.length === CONVO.length, "expected all prior turns forwarded, got " + body.messages.length);
      assert(body.messages[0].role === "user" && body.messages[1].role === "assistant", "expected roles preserved in order");
      assert(body.system.includes("Who Method"), "expected the scorecard persona system prompt");
      return { ok: true, json: async () => ({ content: [{ text: "Good. What's the seniority level -- mid, senior, staff?" }] }) };
    };
    try {
      const res = await run("chat happy path -- anthropic", {
        method: "POST",
        body: { mode: "chat", messages: CONVO, keys: { llmApiKey: "fake" } },
      });
      assert(res.statusCode === 200, "expected 200");
      assert(res.body.reply.includes("seniority"), "expected the mocked reply back, got " + res.body.reply);
      console.log("PASSED");
    } finally {
      global.fetch = realFetch;
    }
  }

  // ---- chat mode happy path via OpenRouter (verifies multi-turn message forwarding on the OpenAI-compatible path) ----
  {
    global.fetch = async (url, opts) => {
      assert(String(url).endsWith("/chat/completions"), "expected chat/completions endpoint, got " + url);
      const body = JSON.parse(opts.body);
      // system + all prior turns
      assert(body.messages.length === CONVO.length + 1, "expected system + all turns, got " + body.messages.length);
      assert(body.messages[0].role === "system", "expected first message to be system");
      assert(body.model === "anthropic/claude-3.5-sonnet", "expected caller's model forwarded");
      return { ok: true, json: async () => ({ choices: [{ message: { content: "Got it. What's the team missing today?" } }] }) };
    };
    try {
      const res = await run("chat happy path -- openrouter", {
        method: "POST",
        body: {
          mode: "chat",
          messages: CONVO,
          keys: { llmProvider: "openrouter", llmApiKey: "fake-or", llmModel: "anthropic/claude-3.5-sonnet" },
        },
      });
      assert(res.statusCode === 200, "expected 200");
      assert(res.body.reply.length > 0, "expected a reply");
      console.log("PASSED");
    } finally {
      global.fetch = realFetch;
    }
  }

  // ---- finalize mode happy path ----
  const SCORECARD_JSON = {
    roleTitle: "Senior Backend Engineer",
    seniority: "Senior",
    mission: "Own the payments service end to end so it ships independently of the founding engineers.",
    outcomes: [
      { outcome: "Ship v2 of the payments service", measure: "Zero P1 incidents for 90 days post-launch", priority: "Critical" },
      { outcome: "Free up the other two engineers", measure: "They spend 0 hours/week on payments by Month 3", priority: "Important" },
    ],
    competencies: {
      roleSpecific: [{ name: "Distributed systems", five: "Has shipped a payments or ledger system solo", one: "Only worked in a pair/team on core infra", weight: "High", minScore: "4" }],
      cultural: [{ name: "Ownership", five: "Proactively flags risk before asked", one: "Waits to be told", weight: "High", minScore: "4" }],
      leadership: [],
    },
    hiringBar: { minAverage: "3.5", hardStops: "No score below 3 on distributed systems", cultureNonNegotiables: "Ownership" },
    antiPatterns: ["Someone who's only ever worked with a dedicated SRE team to lean on"],
  };
  {
    global.fetch = async (url, opts) => {
      const body = JSON.parse(opts.body);
      const lastMsg = body.messages[body.messages.length - 1];
      assert(lastMsg.content.includes("Compile everything"), "expected the finalize instruction appended as the last turn");
      return { ok: true, json: async () => ({ content: [{ text: JSON.stringify(SCORECARD_JSON) }] }) };
    };
    try {
      const res = await run("finalize happy path", {
        method: "POST",
        body: { mode: "finalize", messages: CONVO, keys: { llmApiKey: "fake" } },
      });
      assert(res.statusCode === 200, "expected 200, got " + res.statusCode);
      assert(res.body.scorecard.mission.includes("payments"), "expected mission in response");
      assert(res.body.scorecard.outcomes.length === 2, "expected 2 outcomes");
      assert(res.body.scorecard.competencies.leadership.length === 0, "expected empty leadership array preserved, not dropped");
      assert(res.body.scorecard.antiPatterns.length === 1, "expected 1 anti-pattern");
      console.log("PASSED");
    } finally {
      global.fetch = realFetch;
    }
  }

  // ---- finalize mode -- model returns garbage, should 502 not crash ----
  global.fetch = async () => ({ ok: true, json: async () => ({ content: [{ text: "sorry, I can't do that as JSON" }] }) });
  try {
    await run("finalize -- model returns non-JSON -> 502", {
      method: "POST",
      body: { mode: "finalize", messages: CONVO, keys: { llmApiKey: "fake" } },
    });
  } finally {
    global.fetch = realFetch;
  }

  // ---- unknown provider -> 400 ----
  await run("unknown provider -> 400", {
    method: "POST",
    body: { mode: "chat", messages: CONVO, keys: { llmProvider: "made-up", llmApiKey: "x" } },
  });
}

main().then(() => {
  console.log("\ndone.");
  process.exit(0);
}).catch((err) => {
  console.error("\nTEST FAILURE:", err);
  process.exit(1);
});
