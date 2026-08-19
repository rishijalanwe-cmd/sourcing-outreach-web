// POST /api/scorecard
//
// Body: { keys: { llmProvider, llmApiKey, llmModel?, llmBaseUrl? }, mode: "chat" | "finalize",
//         messages: [{ role: "user" | "assistant", content: string }, ...] }
//
// mode "chat":     one more turn of the scorecard-building conversation. Response: { reply }
// mode "finalize": compiles the whole transcript into a structured scorecard document.
//                  Response: { scorecard: {...} }
//
// This implements Fabric's `scorecard-builder` skill (Who Method: Geoff Smart & Randy Street)
// as a guided chat instead of a Claude Code session. Same BYOK model as /api/source: the
// caller's LLM key travels in the request body and is used only for this request.

const { resolveLlmConfig, callLlm, parseJsonObject } = require("../lib/llm.js");

const CHAT_SYSTEM_PROMPT = [
  "You are a hiring strategist who builds scorecards using the Who Method (Geoff Smart & Randy Street). This is a scorecard-building conversation, not a job description writer.",
  "A scorecard is NOT a job description. A job description sells the role to candidates. A scorecard defines what success looks like so the hiring manager can evaluate candidates against it. It has three parts: Mission (1 sentence -- what this person exists to accomplish), Outcomes (3-5 measurable results for the first 6-12 months, not activities), and Competencies (5-8 skills/behaviors, each observable in an interview and scoreable 1-5, grouped as role-specific / cultural / leadership).",
  "Walk the user through in order: (1) role basics -- title, why the role exists right now, seniority, who they report to, what the team already covers vs. what's missing; (2) the mission -- ask 'If this person crushes it, what's different about your company in 12 months?', sharpen vague answers into one crisp sentence, and also ask the inverse 'What would make you fire this person after 6 months -- not performance, but a wrong-hire signal?'; (3) outcomes -- 3-5 of them, each with a specific measure of success (a number, deadline, or milestone) and a priority (Critical / Important / Nice to have); (4) competencies -- role-specific, cultural (ask what the team is missing, not what it already has), and leadership if this role manages people, and for each one ask what a 5 looks like vs. what a 1 looks like; (5) weighting -- which competencies are non-negotiable (a 3 is unacceptable) vs. coachable, and the minimum acceptable average score; (6) anti-patterns -- candidate profiles that look good on paper but would fail in this specific role.",
  "Push back hard on vague answers. If someone says 'I need someone smart and hard-working,' say so directly and ask what that looks like in THIS role, with an example of a decision they'd need to make. Turn activities into outcomes: 'manage the pipeline' is not an outcome, 'build a repeatable pipeline generating 20 qualified meetings a month by Q3' is.",
  "One question at a time. Keep every reply short -- 2-5 sentences, end with exactly one clear question. Don't summarize the whole framework up front; let it unfold turn by turn.",
  "Once you have a real mission, 3+ outcomes with measures, and 5+ competencies across the right categories, say so plainly and tell the user they can click \"Generate scorecard document\" whenever they're ready -- they don't have to keep going if they're satisfied.",
].join(" ");

const FINALIZE_SYSTEM_PROMPT = [
  "You compile a hiring scorecard from a conversation transcript into STRICT JSON ONLY -- no prose, no markdown code fences.",
  "Use only what was actually discussed in the transcript. If a section wasn't covered, return an empty array or empty string for it -- never invent mission/outcomes/competencies that weren't part of the conversation.",
  "Output exactly this shape:",
  JSON.stringify({
    roleTitle: "string",
    seniority: "string",
    mission: "one sentence",
    outcomes: [{ outcome: "string", measure: "string", priority: "Critical | Important | Nice to have" }],
    competencies: {
      roleSpecific: [{ name: "string", five: "what a 5 looks like", one: "what a 1 looks like", weight: "High | Medium | Low", minScore: "1-5" }],
      cultural: [{ name: "string", five: "string", one: "string", weight: "High | Medium | Low", minScore: "1-5" }],
      leadership: [{ name: "string", five: "string", one: "string", weight: "High | Medium | Low", minScore: "1-5" }],
    },
    hiringBar: { minAverage: "e.g. 3.5", hardStops: "string, plain language", cultureNonNegotiables: "string, plain language" },
    antiPatterns: ["string"],
  }),
].join(" ");

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Use POST" });
  }

  const body = req.body || {};
  const keys = body.keys || {};
  const mode = body.mode === "finalize" ? "finalize" : "chat";
  const messages = Array.isArray(body.messages) ? body.messages : [];

  if (!keys.llmApiKey) {
    return res.status(400).json({ error: "keys.llmApiKey is required (an Anthropic, OpenAI, OpenRouter, or other OpenAI-compatible API key)" });
  }
  if (mode === "chat" && !messages.length) {
    return res.status(400).json({ error: "messages must include at least one message" });
  }
  if (mode === "finalize" && messages.filter((m) => m.role === "user").length < 2) {
    return res.status(400).json({ error: "Not enough conversation yet to generate a scorecard -- answer a few more questions first." });
  }

  const llm = resolveLlmConfig(keys);
  if (llm.error) {
    return res.status(400).json({ error: llm.error });
  }

  try {
    if (mode === "chat") {
      const reply = await callLlm(CHAT_SYSTEM_PROMPT, sanitizeMessages(messages), llm, 700);
      return res.status(200).json({ reply: reply || "" });
    }

    // mode === "finalize": ask the model to compile the transcript, appended as one final
    // instruction turn so every provider (including ones that dislike a bare system-only call) sees it as part of the conversation.
    const finalizeMessages = [
      ...sanitizeMessages(messages),
      { role: "user", content: "Compile everything above into the scorecard JSON now." },
    ];
    const text = await callLlm(FINALIZE_SYSTEM_PROMPT, finalizeMessages, llm, 3000);
    const scorecard = parseJsonObject(text);
    if (!scorecard) {
      return res.status(502).json({ error: "The model didn't return valid scorecard JSON. Try generating again." });
    }
    return res.status(200).json({ scorecard: normalizeScorecard(scorecard) });
  } catch (err) {
    const message = err && err.message ? err.message : "Unexpected error";
    return res.status(502).json({ error: message });
  }
};

function sanitizeMessages(messages) {
  return messages
    .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.trim())
    .map((m) => ({ role: m.role, content: m.content.trim() }));
}

// Fill in missing shape so the frontend never has to null-check every field.
function normalizeScorecard(sc) {
  const comp = sc.competencies || {};
  return {
    roleTitle: sc.roleTitle || "",
    seniority: sc.seniority || "",
    mission: sc.mission || "",
    outcomes: Array.isArray(sc.outcomes) ? sc.outcomes : [],
    competencies: {
      roleSpecific: Array.isArray(comp.roleSpecific) ? comp.roleSpecific : [],
      cultural: Array.isArray(comp.cultural) ? comp.cultural : [],
      leadership: Array.isArray(comp.leadership) ? comp.leadership : [],
    },
    hiringBar: {
      minAverage: (sc.hiringBar && sc.hiringBar.minAverage) || "",
      hardStops: (sc.hiringBar && sc.hiringBar.hardStops) || "",
      cultureNonNegotiables: (sc.hiringBar && sc.hiringBar.cultureNonNegotiables) || "",
    },
    antiPatterns: Array.isArray(sc.antiPatterns) ? sc.antiPatterns : [],
  };
}
