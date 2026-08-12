// POST /api/source
//
// Body: { icp: {...}, keys: { exa, apollo?, llmProvider, llmApiKey, llmModel?, llmBaseUrl? } }
// Response: { candidates: [...] }
//
// This function is stateless and BYOK (bring your own keys): the caller's API keys
// travel in the request body, are used only to call Exa/Apollo/the caller's chosen LLM
// on the caller's behalf, and are never logged, stored, or written anywhere. There are
// no server-side environment variables or secrets for this project -- that's intentional.
//
// Pipeline: Exa search (a few phrasings, merged) -> LLM scores + shortlists against
// the ICP -> optional Apollo enrichment per shortlisted candidate (best-effort, parallel)
// -> one batched LLM call drafts a connection note + follow-up per candidate.
//
// This never contacts LinkedIn directly and never sends anything -- it drafts only.
//
// LLM providers: any of "anthropic" (native Messages API), or "openai" / "openrouter" /
// "custom" (all speak the OpenAI-compatible /chat/completions shape -- this covers OpenAI
// itself, OpenRouter, and most self-hosted or third-party OpenAI-compatible endpoints,
// e.g. Groq, Together, a local Ollama/LM Studio server). See PROVIDER_DEFAULTS below for
// default base URLs and models -- callers can override the model (and, for "custom", must
// supply their own base URL) via keys.llmModel / keys.llmBaseUrl.

const PROVIDER_DEFAULTS = {
  anthropic: {
    baseUrl: "https://api.anthropic.com/v1",
    // If you hit a "model not found" error, check https://docs.claude.com/en/docs/about-claude/models
    // for the current model slug.
    model: "claude-sonnet-4-5-20250929",
  },
  openai: {
    baseUrl: "https://api.openai.com/v1",
    // Check https://platform.openai.com/docs/models for the current recommended model.
    model: "gpt-4o-mini",
  },
  openrouter: {
    baseUrl: "https://openrouter.ai/api/v1",
    model: "", // no safe universal default -- OpenRouter hosts hundreds of models, caller must specify
  },
  custom: {
    baseUrl: "", // caller must supply keys.llmBaseUrl -- any OpenAI-compatible /chat/completions server
    model: "", // caller must supply keys.llmModel
  },
};

const HARD_MAX_CANDIDATES = 30; // server-side ceiling regardless of what the client requests

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Use POST" });
  }

  const body = req.body || {};
  const icp = body.icp || {};
  const keys = body.keys || {};

  if (!icp.roleTitle) {
    return res.status(400).json({ error: "icp.roleTitle is required" });
  }
  if (!keys.exa) {
    return res.status(400).json({ error: "keys.exa is required (get a free key at exa.ai)" });
  }
  if (!keys.llmApiKey) {
    return res.status(400).json({ error: "keys.llmApiKey is required (an Anthropic, OpenAI, OpenRouter, or other OpenAI-compatible API key)" });
  }

  const llm = resolveLlmConfig(keys);
  if (llm.error) {
    return res.status(400).json({ error: llm.error });
  }

  const maxCandidates = Math.min(Math.max(parseInt(icp.maxCandidates, 10) || 15, 1), HARD_MAX_CANDIDATES);

  try {
    // ---- 1. Search (a few phrasings, merged + deduped) ----
    const queries = buildQueries(icp);
    const resultSets = await Promise.all(queries.map((q) => searchExa(q, keys.exa)));
    const merged = dedupeByUrl(resultSets.flat());

    if (!merged.length) {
      return res.status(200).json({ candidates: [], note: "Exa returned no results for this ICP -- try broadening it." });
    }

    // ---- 2. Score + shortlist against the ICP ----
    let shortlist = await scoreWithLlm(icp, merged, llm, maxCandidates);
    if (!shortlist.length) {
      return res.status(200).json({ candidates: [], note: "No candidates scored 3+ against your must-haves. Try loosening a disqualifier or broadening the company pool." });
    }

    // ---- 3. Optional enrichment (best-effort, never blocks the run) ----
    if (keys.apollo) {
      shortlist = await Promise.all(
        shortlist.map(async (c) => {
          try {
            const email = await enrichApollo(c, keys.apollo);
            return { ...c, email: email || "" };
          } catch (e) {
            return { ...c, email: "" };
          }
        })
      );
    } else {
      shortlist = shortlist.map((c) => ({ ...c, email: "" }));
    }

    // ---- 4. Draft outreach for the whole shortlist in one batched call ----
    const drafted = await draftWithLlm(icp, shortlist, llm);

    return res.status(200).json({ candidates: drafted });
  } catch (err) {
    const message = err && err.message ? err.message : "Unexpected error";
    return res.status(502).json({ error: message });
  }
};

// ---------------------------------------------------------------------------
// LLM provider resolution
// ---------------------------------------------------------------------------

function resolveLlmConfig(keys) {
  const provider = (keys.llmProvider || "anthropic").toLowerCase();
  const defaults = PROVIDER_DEFAULTS[provider];
  if (!defaults) {
    return { error: `Unknown llmProvider "${provider}". Use one of: ${Object.keys(PROVIDER_DEFAULTS).join(", ")}.` };
  }

  const baseUrl = (keys.llmBaseUrl || defaults.baseUrl || "").replace(/\/+$/, "");
  const model = keys.llmModel || defaults.model;

  if (provider === "custom" && !baseUrl) {
    return { error: 'keys.llmBaseUrl is required when llmProvider is "custom" (the base URL of your OpenAI-compatible endpoint, e.g. http://localhost:11434/v1).' };
  }
  if (!model) {
    return { error: `keys.llmModel is required for provider "${provider}" -- there's no safe default model to assume for it.` };
  }

  return { provider, apiKey: keys.llmApiKey, baseUrl, model };
}

// ---------------------------------------------------------------------------
// Exa search
// ---------------------------------------------------------------------------

function buildQueries(icp) {
  const must = arr(icp.mustHave).join(", ");
  const nice = arr(icp.niceToHave).join(", ");
  const base = `${icp.roleTitle || ""} ${icp.seniority ? "(" + icp.seniority + " level)" : ""}`.trim();

  const queries = [];
  queries.push(
    `${base} with experience in ${must || "the target role"}, based in ${icp.location || "any location"}, at companies like ${icp.companyPool || "relevant companies"}`
  );
  if (must) {
    queries.push(`Professionals with ${must} background, currently working as ${base}, ${icp.location || ""}`.trim());
  }
  if (icp.companyPool) {
    queries.push(`${base} who has worked at ${icp.companyPool}, ${nice ? "ideally with " + nice : ""}`.trim());
  }
  return queries.slice(0, 3);
}

async function searchExa(query, apiKey) {
  const resp = await fetch("https://api.exa.ai/search", {
    method: "POST",
    headers: { "x-api-key": apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({
      query,
      numResults: 20,
      category: "people",
      contents: { text: { maxCharacters: 800 }, highlights: true },
    }),
  });
  if (!resp.ok) {
    const text = await safeText(resp);
    throw new Error(`Exa search failed (${resp.status}): ${text.slice(0, 300)}`);
  }
  const data = await resp.json();
  return Array.isArray(data.results) ? data.results : [];
}

function dedupeByUrl(results) {
  const seen = new Set();
  const out = [];
  for (const r of results) {
    const key = r.url || r.id;
    if (key && !seen.has(key)) {
      seen.add(key);
      out.push(r);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// LLM: score + shortlist
// ---------------------------------------------------------------------------

async function scoreWithLlm(icp, results, llm, maxCandidates) {
  const system = [
    "You score candidate search results against a hiring ICP for a scorecard-first recruiting workflow.",
    "Score each 1-5 against the must-have signals. Anything that clearly trips a disqualifier is excluded even if the profile reads well.",
    "Only include candidates scoring 3 or higher, sorted by score descending, capped at the requested max.",
    "Respond with STRICT JSON ONLY -- no prose, no markdown code fences -- an array of objects with exactly these fields:",
    'id (short url-safe slug from the name), name, title, company, location, linkedinUrl, matchScore (1-5 integer), matchReason (one sentence, cite the specific evidence).',
    "If the search result text doesn't clearly show a LinkedIn URL, use the result's url field as linkedinUrl.",
    "Do not invent details not supported by the provided text.",
  ].join(" ");

  const user = [
    `ICP:`,
    `Title: ${icp.roleTitle || ""}`,
    `Seniority: ${icp.seniority || ""}`,
    `Must-have: ${arr(icp.mustHave).join(", ")}`,
    `Nice-to-have: ${arr(icp.niceToHave).join(", ")}`,
    `Disqualifiers: ${arr(icp.disqualifiers).join(", ")}`,
    `Company pool: ${icp.companyPool || ""}`,
    `Location: ${icp.location || ""}`,
    `Max candidates: ${maxCandidates}`,
    ``,
    `Search results (JSON):`,
    JSON.stringify(
      results.map((r) => ({
        title: r.title,
        url: r.url,
        author: r.author,
        text: (r.text || "").slice(0, 500),
        highlights: r.highlights,
      }))
    ),
  ].join("\n");

  const text = await callLlm(system, user, llm, 4000);
  return parseJsonArray(text);
}

// ---------------------------------------------------------------------------
// Apollo enrichment (best-effort)
// ---------------------------------------------------------------------------

async function enrichApollo(candidate, apiKey) {
  const domain = guessDomain(candidate.company);
  if (!domain) return "";

  const resp = await fetch("https://api.apollo.io/api/v1/people/match", {
    method: "POST",
    headers: { "x-api-key": apiKey, "Content-Type": "application/json", "Cache-Control": "no-cache" },
    body: JSON.stringify({ name: candidate.name, domain, reveal_personal_emails: false }),
  });
  if (!resp.ok) return "";
  const data = await resp.json();
  return (data && data.person && data.person.email) || "";
}

function guessDomain(company) {
  if (!company) return "";
  const cleaned = company
    .toLowerCase()
    .replace(/\b(inc|llc|ltd|limited|corp|corporation|co)\b\.?/g, "")
    .replace(/[^a-z0-9]/g, "");
  return cleaned ? `${cleaned}.com` : "";
}

// ---------------------------------------------------------------------------
// LLM: draft outreach (batched, one call for the whole shortlist)
// ---------------------------------------------------------------------------

async function draftWithLlm(icp, candidates, llm) {
  const system = [
    "You draft recruiting outreach. You never send anything -- you only draft. The human sends it themselves.",
    "For each candidate, write two things:",
    "1) connectionNote: a LinkedIn connection note, under 300 characters, referencing one specific true thing about them (their title/company/matchReason) -- no pitch, no generic compliment, goal is just to get accepted.",
    "2) followUpMessage: 3-5 sentences for after they accept -- the specific thing that made you think of them, the role framed by outcome not a bullet list, one honest line about stage/scope, and a low-friction ask for a short call. No superlatives, no urgency pressure, don't make it read like a template.",
    "Respond with STRICT JSON ONLY -- an array of objects with fields: id, connectionNote, followUpMessage. Match ids exactly to the candidates provided.",
  ].join(" ");

  const user = [
    `Role: ${icp.roleTitle || ""}`,
    `Company pool / context: ${icp.companyPool || ""}`,
    `Location: ${icp.location || ""}`,
    ``,
    `Candidates (JSON):`,
    JSON.stringify(candidates.map((c) => ({ id: c.id, name: c.name, title: c.title, company: c.company, matchReason: c.matchReason }))),
  ].join("\n");

  const text = await callLlm(system, user, llm, 4000);
  const drafts = parseJsonArray(text);
  const byId = new Map(drafts.map((d) => [d.id, d]));

  return candidates.map((c) => ({
    ...c,
    connectionNote: (byId.get(c.id) && byId.get(c.id).connectionNote) || "",
    followUpMessage: (byId.get(c.id) && byId.get(c.id).followUpMessage) || "",
    status: "New",
  }));
}

// ---------------------------------------------------------------------------
// LLM call helper -- branches to the Anthropic Messages API, or to the
// OpenAI-compatible /chat/completions shape used by OpenAI, OpenRouter, and
// most other providers (self-hosted included).
// ---------------------------------------------------------------------------

async function callLlm(system, userText, llm, maxTokens) {
  if (llm.provider === "anthropic") {
    return callAnthropic(system, userText, llm, maxTokens);
  }
  return callOpenAiCompatible(system, userText, llm, maxTokens);
}

async function callAnthropic(system, userText, llm, maxTokens) {
  const resp = await fetch(`${llm.baseUrl}/messages`, {
    method: "POST",
    headers: {
      "x-api-key": llm.apiKey,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: llm.model,
      max_tokens: maxTokens,
      system,
      messages: [{ role: "user", content: userText }],
    }),
  });
  if (!resp.ok) {
    const text = await safeText(resp);
    throw new Error(`Anthropic call failed (${resp.status}): ${text.slice(0, 300)}`);
  }
  const data = await resp.json();
  const block = data && data.content && data.content[0];
  return (block && block.text) || "";
}

async function callOpenAiCompatible(system, userText, llm, maxTokens) {
  const headers = {
    Authorization: `Bearer ${llm.apiKey}`,
    "Content-Type": "application/json",
  };
  // OpenRouter looks at these for its own attribution/analytics -- optional, harmless elsewhere.
  if (llm.provider === "openrouter") {
    headers["HTTP-Referer"] = "https://sourcing-outreach-agent.example";
    headers["X-Title"] = "Sourcing + Outreach Agent";
  }

  const resp = await fetch(`${llm.baseUrl}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: llm.model,
      max_tokens: maxTokens,
      messages: [
        { role: "system", content: system },
        { role: "user", content: userText },
      ],
    }),
  });
  if (!resp.ok) {
    const text = await safeText(resp);
    throw new Error(`${capitalize(llm.provider)} call failed (${resp.status}): ${text.slice(0, 300)}`);
  }
  const data = await resp.json();
  const choice = data && data.choices && data.choices[0];
  return (choice && choice.message && choice.message.content) || "";
}

function capitalize(s) {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

function parseJsonArray(text) {
  if (!text) return [];
  // Strip markdown code fences if the model added them despite instructions.
  const cleaned = text.trim().replace(/^```(json)?/i, "").replace(/```$/, "").trim();
  try {
    const parsed = JSON.parse(cleaned);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    // Last resort: grab the first [...] block in the text.
    const match = cleaned.match(/\[[\s\S]*\]/);
    if (match) {
      try {
        const parsed = JSON.parse(match[0]);
        return Array.isArray(parsed) ? parsed : [];
      } catch (e2) {
        return [];
      }
    }
    return [];
  }
}

// ---------------------------------------------------------------------------
// small utils
// ---------------------------------------------------------------------------

function arr(v) {
  if (Array.isArray(v)) return v;
  if (typeof v === "string" && v.trim()) return v.split(",").map((s) => s.trim()).filter(Boolean);
  return [];
}

async function safeText(resp) {
  try {
    return await resp.text();
  } catch (e) {
    return "";
  }
}
