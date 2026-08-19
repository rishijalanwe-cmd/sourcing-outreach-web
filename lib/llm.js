// Shared LLM provider logic used by every api/*.js endpoint.
//
// BYOK: the caller's key travels in the request body and is used only to call the
// caller's chosen provider on the caller's behalf. Never logged, stored, or written
// anywhere. No server-side environment variables or secrets.
//
// Providers: "anthropic" (native Messages API), or "openai" / "openrouter" / "custom"
// (all speak the OpenAI-compatible /chat/completions shape). See PROVIDER_DEFAULTS
// for default base URLs and models -- callers can override the model (and, for
// "custom", must supply their own base URL) via keys.llmModel / keys.llmBaseUrl.

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

// callLlm(system, messages, llm, maxTokens)
//   system:   string -- the system prompt
//   messages: array of { role: "user" | "assistant", content: string }, in order.
//             A single one-shot call is just [{ role: "user", content: "..." }].
//   llm:      the object returned by resolveLlmConfig()
//   maxTokens: response token cap
//
// Branches to the Anthropic Messages API, or to the OpenAI-compatible
// /chat/completions shape used by OpenAI, OpenRouter, and most other
// providers (self-hosted included). Returns the assistant's reply text.
async function callLlm(system, messages, llm, maxTokens) {
  if (llm.provider === "anthropic") {
    return callAnthropic(system, messages, llm, maxTokens);
  }
  return callOpenAiCompatible(system, messages, llm, maxTokens);
}

async function callAnthropic(system, messages, llm, maxTokens) {
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
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
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

async function callOpenAiCompatible(system, messages, llm, maxTokens) {
  const headers = {
    Authorization: `Bearer ${llm.apiKey}`,
    "Content-Type": "application/json",
  };
  // OpenRouter looks at these for its own attribution/analytics -- optional, harmless elsewhere.
  if (llm.provider === "openrouter") {
    headers["HTTP-Referer"] = "https://sourcing-outreach-agent.example";
    headers["X-Title"] = "Fabric Hiring Agents (community build)";
  }

  const resp = await fetch(`${llm.baseUrl}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: llm.model,
      max_tokens: maxTokens,
      messages: [{ role: "system", content: system }, ...messages.map((m) => ({ role: m.role, content: m.content }))],
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
  const cleaned = stripCodeFence(text);
  try {
    const parsed = JSON.parse(cleaned);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
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

function parseJsonObject(text) {
  if (!text) return null;
  const cleaned = stripCodeFence(text);
  try {
    const parsed = JSON.parse(cleaned);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch (e) {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        const parsed = JSON.parse(match[0]);
        return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
      } catch (e2) {
        return null;
      }
    }
    return null;
  }
}

function stripCodeFence(text) {
  return text.trim().replace(/^```(json)?/i, "").replace(/```$/, "").trim();
}

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

module.exports = {
  PROVIDER_DEFAULTS,
  resolveLlmConfig,
  callLlm,
  parseJsonArray,
  parseJsonObject,
  arr,
  safeText,
};
