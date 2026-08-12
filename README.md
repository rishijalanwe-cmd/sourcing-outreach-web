# Sourcing + Outreach Agent

A free recruiting tool: describe who you're hiring for, it searches for real candidates, scores
them against your must-haves, and drafts (never sends) a personalized LinkedIn connection note
and follow-up for each one. Anyone with the link can use it — no account, no login.

**Bring your own keys.** This tool doesn't have a shared API key or a database. Every visitor
pastes their own Exa key, their own LLM provider key (Anthropic, OpenAI, OpenRouter, or any
OpenAI-compatible endpoint — see below), and optionally an Apollo key, used only for their own
searches. That's not a limitation, it's the point: it's the only way a public, login-free link
doesn't turn into an open invoice on someone else's card.

**Drafts only.** It never sends a LinkedIn connection request, message, or email, and never
automates LinkedIn's UI. Every message is a draft — you copy it and send it yourself, from your
own account. Automating LinkedIn actions risks the sending account and breaks LinkedIn's terms;
this tool sources via web search (Exa), not by scripting LinkedIn's site.

## How it works

```
Your browser (public/index.html)
   │  POST /api/source  { icp, keys }
   ▼
Vercel serverless function (api/source.js)
   │
   ├─▶ Exa: search a few query phrasings, merge + dedupe
   ├─▶ Your LLM (Anthropic / OpenAI / OpenRouter / custom): score results against your must-haves/disqualifiers, shortlist
   ├─▶ Apollo (optional): best-effort email lookup per shortlisted candidate
   └─▶ Your LLM: draft a connection note + follow-up for the whole shortlist, one call
   │
   ▼
Results returned to your browser — nothing is stored server-side
```

No database, no environment variables, no server-side secrets. The only state is whatever's
currently in your browser tab; export a CSV from the Source tab if you want to keep a record
across sessions.

## Run it locally

```bash
git clone https://github.com/rishijalanwe-cmd/sourcing-outreach-web.git
cd sourcing-outreach-web
npm install -g vercel   # if you don't have it
vercel dev
```

Open the local URL it prints, go to "Your keys," paste your own Exa key and an LLM provider key
(Apollo optional), and try a search. No environment variables to set — keys are entered in the
browser.

Run the (mocked, no real keys needed) test suite for `api/source.js` with `npm test`.

## Deploy your own copy

**Fastest — a live URL in about a minute, no GitHub required:**
```bash
npm install -g vercel   # if you don't have it
vercel login
cd sourcing-outreach-web
vercel --prod
```
That's it. Vercel prints a live URL. No environment variables to configure — this project
doesn't need any.

**Public GitHub repo with continuous deployment (this is how the live copy runs):**
1. Fork or clone [github.com/rishijalanwe-cmd/sourcing-outreach-web](https://github.com/rishijalanwe-cmd/sourcing-outreach-web),
   or push your own copy the same way:
   ```bash
   git init
   git add .
   git commit -m "Initial commit"
   git branch -M main
   git remote add origin https://github.com/<you>/sourcing-outreach-web.git
   git push -u origin main
   ```
2. Go to [vercel.com/new](https://vercel.com/new), sign in (GitHub OAuth is the easy path),
   and import the repo you just pushed. Vercel auto-detects it (static `public/` + `api/`
   functions, no framework needed) and deploys it. Every future push to `main` redeploys
   automatically.

Either path works with the completely free Vercel Hobby tier — this project has no dependencies
and each `/api/source` call comfortably finishes in well under Hobby's function time limit.

## Get API keys (for people using the deployed link)

- **Exa** (required) — [exa.ai](https://exa.ai), free tier available.
- **An LLM provider key** (required — pick one in the "Your keys" tab):
  - **Anthropic** — [console.anthropic.com](https://console.anthropic.com), pay-as-you-go; a run of 15-25 candidates costs a few cents. Default model needs no extra setup.
  - **OpenAI** — [platform.openai.com](https://platform.openai.com), pay-as-you-go. Default model needs no extra setup.
  - **OpenRouter** — [openrouter.ai](https://openrouter.ai/keys), one key for many models (including free-tier ones). You must specify a model string yourself, e.g. `anthropic/claude-3.5-sonnet` or `openai/gpt-4o-mini` — there's no safe universal default.
  - **Custom (any OpenAI-compatible endpoint)** — for a self-hosted or local model server (e.g. Ollama, LM Studio, a proxy). Set the Base URL and Model fields to match your endpoint.
- **Apollo** (optional, enables email enrichment) — [apollo.io](https://apollo.io), free plan has limited credits.

## Project structure

| Path | What it is |
|---|---|
| `public/index.html` | The entire frontend — single file, no build step, no framework. |
| `api/source.js` | The one serverless function: search → score → enrich → draft. |
| `api/source.test.js` | Mocked end-to-end test (no real API keys needed) — `npm test`. |
| `vercel.json` | Sets `maxDuration` for the function. |

## Fork it

It's MIT licensed — change the scoring rubric, the outreach tone, add a stage past sourcing,
point it at a different search provider, whatever's useful to you. If you build on it, a note
back to the original would be appreciated but isn't required.

## What this deliberately doesn't do

No accounts, no database, no server-side API keys, no LinkedIn automation, no auto-send. If you
want persistence across sessions or across a team, that's a deliberate next step someone would
add (e.g. wiring in a database + auth) — not something this base version does, on purpose, to
keep it simple, free to run, and low-risk to deploy publicly.
