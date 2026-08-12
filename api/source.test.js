// Manual test harness -- not a real test framework, just enough to exercise
// api/source.js end to end with mocked network calls (no real API keys available
// in this environment). Run with: node api/source.test.js

const handler = require("./source.js");

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
  console.log("body:", JSON.stringify(res.body, null, 2).slice(0, 2000));
  return res;
}

function assert(cond, msg) {
  if (!cond) throw new Error("ASSERTION FAILED: " + msg);
}

// Shared mock candidates used by every provider's mocked search results.
function exaResults() {
  return {
    ok: true,
    json: async () => ({
      results: [
        {
          title: "Priya Raman - Senior Backend Engineer at Recur Payments | LinkedIn",
          url: "https://www.linkedin.com/in/priya-raman-example",
          author: "Priya Raman",
          text: "Priya Raman leads backend engineering at Recur Payments, a Series B fintech, focused on the billing and ledger systems.",
          highlights: ["led the ledger rewrite"],
        },
        {
          title: "Jordan Ahn - Staff Engineer at Fintrace | LinkedIn",
          url: "https://www.linkedin.com/in/jordan-ahn-example",
          author: "Jordan Ahn",
          text: "Jordan Ahn is a Staff Engineer at Fintrace working on distributed payment retries and idempotency.",
          highlights: ["idempotency keys in payment retries"],
        },
      ],
    }),
  };
}

const SCORED = [
  { id: "priya-raman", name: "Priya Raman", title: "Senior Backend Engineer", company: "Recur Payments", location: "Bengaluru", linkedinUrl: "https://www.linkedin.com/in/priya-raman-example", matchScore: 5, matchReason: "Led the ledger rewrite at a Series B fintech -- direct billing experience." },
  { id: "jordan-ahn", name: "Jordan Ahn", title: "Staff Engineer", company: "Fintrace", location: "Remote", linkedinUrl: "https://www.linkedin.com/in/jordan-ahn-example", matchScore: 4, matchReason: "Payments-adjacent distributed systems background." },
];
const DRAFTS = [
  { id: "priya-raman", connectionNote: "Hi Priya -- saw the ledger rewrite at Recur. Would love to connect.", followUpMessage: "Thanks for connecting! ... Open to a quick call?" },
  { id: "jordan-ahn", connectionNote: "Hi Jordan -- your work on payment retry idempotency caught my eye. Would love to connect.", followUpMessage: "Thanks for connecting! ... Open to a quick call?" },
];

function apolloMock(body) {
  if (body.name === "Priya Raman") return { ok: true, json: async () => ({ person: { email: "priya@example.com" } }) };
  if (body.name === "Jordan Ahn") return { ok: true, json: async () => ({ person: { email: "jordan@example.com" } }) };
  return { ok: true, json: async () => ({ person: {} }) };
}

async function main() {
  const realFetch = global.fetch;

  // ---- Test 1: missing keys should 400, not crash ----
  await run("missing exa key", {
    method: "POST",
    body: { icp: { roleTitle: "Senior Backend Engineer" }, keys: {} },
  });
  await run("missing llm key", {
    method: "POST",
    body: { icp: { roleTitle: "Senior Backend Engineer" }, keys: { exa: "x" } },
  });

  // ---- Test 2: wrong method ----
  await run("wrong method", { method: "GET", body: {} });

  // ---- Test 3: happy path via Anthropic (default provider) ----
  {
    const calls = [];
    global.fetch = async (url, opts) => {
      calls.push(String(url));
      const body = opts && opts.body ? JSON.parse(opts.body) : {};
      if (String(url).includes("api.exa.ai")) return exaResults();
      if (String(url).includes("api.anthropic.com")) {
        const isDraft = body.system && body.system.startsWith("You draft recruiting outreach");
        return { ok: true, json: async () => ({ content: [{ text: JSON.stringify(isDraft ? DRAFTS : SCORED) }] }) };
      }
      if (String(url).includes("api.apollo.io")) return apolloMock(body);
      throw new Error("Unexpected fetch to " + url);
    };
    try {
      const res = await run("happy path -- anthropic (default, no llmProvider given)", {
        method: "POST",
        body: {
          icp: { roleTitle: "Senior Backend Engineer", mustHave: ["payments"], maxCandidates: 10 },
          keys: { exa: "fake", apollo: "fake", llmApiKey: "fake" },
        },
      });
      assert(res.statusCode === 200, "expected 200, got " + res.statusCode);
      assert(res.body.candidates.length === 2, "expected 2 candidates");
      const priya = res.body.candidates.find((c) => c.id === "priya-raman");
      const jordan = res.body.candidates.find((c) => c.id === "jordan-ahn");
      assert(priya.email === "priya@example.com", "priya's own email, got " + priya.email);
      assert(jordan.email === "jordan@example.com", "jordan's own email (not priya's), got " + jordan.email);
      assert(priya.connectionNote.length > 0, "expected a connection note");
      console.log("anthropic call count:", calls.filter((c) => c.includes("anthropic")).length, "(expect 2: score + draft)");
      console.log("PASSED");
    } finally {
      global.fetch = realFetch;
    }
  }

  // ---- Test 4: happy path via OpenRouter (OpenAI-compatible /chat/completions shape) ----
  {
    const calls = [];
    global.fetch = async (url, opts) => {
      calls.push(String(url));
      const body = opts && opts.body ? JSON.parse(opts.body) : {};
      if (String(url).includes("api.exa.ai")) return exaResults();
      if (String(url).includes("openrouter.ai")) {
        assert(url.endsWith("/chat/completions"), "expected OpenRouter chat/completions endpoint, got " + url);
        assert(opts.headers.Authorization === "Bearer fake-or-key", "expected Bearer auth header for OpenRouter");
        assert(body.model === "anthropic/claude-3.5-sonnet", "expected the caller-specified model to be forwarded, got " + body.model);
        const sysMsg = body.messages.find((m) => m.role === "system");
        const isDraft = sysMsg && sysMsg.content.startsWith("You draft recruiting outreach");
        return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(isDraft ? DRAFTS : SCORED) } }] }) };
      }
      throw new Error("Unexpected fetch to " + url);
    };
    try {
      const res = await run("happy path -- openrouter", {
        method: "POST",
        body: {
          icp: { roleTitle: "Senior Backend Engineer", maxCandidates: 10 },
          keys: { exa: "fake", llmProvider: "openrouter", llmApiKey: "fake-or-key", llmModel: "anthropic/claude-3.5-sonnet" },
        },
      });
      assert(res.statusCode === 200, "expected 200, got " + res.statusCode);
      assert(res.body.candidates.length === 2, "expected 2 candidates via OpenRouter");
      assert(res.body.candidates[0].email === "", "no apollo key given -> email should be empty string, got " + JSON.stringify(res.body.candidates[0].email));
      console.log("PASSED");
    } finally {
      global.fetch = realFetch;
    }
  }

  // ---- Test 5: openrouter/custom without a model -> clear 400, not a crash or silent bad default ----
  await run("openrouter missing model -> 400", {
    method: "POST",
    body: { icp: { roleTitle: "Engineer" }, keys: { exa: "x", llmProvider: "openrouter", llmApiKey: "y" } },
  });

  // ---- Test 6: custom provider without a base URL -> clear 400 ----
  await run("custom provider missing base URL -> 400", {
    method: "POST",
    body: { icp: { roleTitle: "Engineer" }, keys: { exa: "x", llmProvider: "custom", llmApiKey: "y", llmModel: "llama3" } },
  });

  // ---- Test 7: unknown provider -> clear 400 ----
  await run("unknown provider -> 400", {
    method: "POST",
    body: { icp: { roleTitle: "Engineer" }, keys: { exa: "x", llmProvider: "made-up-provider", llmApiKey: "y" } },
  });

  // ---- Test 8: custom provider hits the caller's own base URL ----
  {
    global.fetch = async (url, opts) => {
      if (String(url).includes("api.exa.ai")) return exaResults();
      if (String(url).startsWith("http://localhost:11434/v1/chat/completions")) {
        const body = JSON.parse(opts.body);
        const sysMsg = body.messages.find((m) => m.role === "system");
        const isDraft = sysMsg && sysMsg.content.startsWith("You draft recruiting outreach");
        return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(isDraft ? DRAFTS : SCORED) } }] }) };
      }
      throw new Error("Unexpected fetch to " + url);
    };
    try {
      const res = await run("happy path -- custom OpenAI-compatible (e.g. local Ollama)", {
        method: "POST",
        body: {
          icp: { roleTitle: "Senior Backend Engineer", maxCandidates: 10 },
          keys: { exa: "fake", llmProvider: "custom", llmApiKey: "unused-or-anything", llmModel: "llama3", llmBaseUrl: "http://localhost:11434/v1/" },
        },
      });
      assert(res.statusCode === 200, "expected 200, got " + res.statusCode);
      assert(res.body.candidates.length === 2, "expected 2 candidates via custom endpoint");
      console.log("PASSED (trailing slash in llmBaseUrl handled correctly)");
    } finally {
      global.fetch = realFetch;
    }
  }

  // ---- Test 9: Exa key present but Exa API errors -- should 502, not crash ----
  global.fetch = async (url) => {
    if (String(url).includes("api.exa.ai")) {
      return { ok: false, status: 401, text: async () => "invalid api key" };
    }
    throw new Error("should not reach " + url);
  };
  try {
    await run("Exa auth error", {
      method: "POST",
      body: { icp: { roleTitle: "Engineer" }, keys: { exa: "bad", llmApiKey: "x" } },
    });
  } finally {
    global.fetch = realFetch;
  }
}

main().then(() => {
  console.log("\ndone.");
  process.exit(0);
}).catch((err) => {
  console.error("\nTEST FAILURE:", err);
  process.exit(1);
});
