Boolean strings. X-Ray search operators. Endless site:linkedin.com/in queries.

For years, that's what passed for "advanced" sourcing. I don't think it needs to be anymore.

A couple of weeks ago, Abhishek Vijayvergiya (Fabric) posted that he was giving away 6 Claude agents that handle a recruiter's most annoying work. I commented "Agents," he sent over the toolkit, and it got me thinking — what if this didn't need a terminal or Claude Code to run? What if anyone could just open a link and use it?

So I built one of the six — Sourcing + Outreach — into a free, no-login web tool:

→ You describe who you're hiring for as a scorecard, not a job title — mission, must-haves, disqualifiers. Not "Senior Engineer," but what they actually need to have already done.
→ It searches the open web for real candidates matching that brief. No Boolean strings, no X-Ray operators, no keyword soup.
→ It scores every candidate against your must-haves and drops anyone who trips a disqualifier — so you're reviewing a shortlist, not wading through near-misses.
→ It drafts a personalized LinkedIn connection note and follow-up for each one, grounded in something real about them. Not a mail-merge template with their first name swapped in.
→ It never sends anything, ever. Every message is a draft. You read it, you edit it, you hit send yourself.
→ No sign-up, no shared backend, nothing stored anywhere.

One thing to know before you click: it's bring-your-own-API-key. You'll need a free Exa key and an Anthropic key (Apollo is optional, for email lookup) — a few minutes to grab both. That's the trade-off for a tool with no login that anyone can use without me footing the bill for every search. Once they're in, it's yours to run as much as you want.

Built entirely with Claude, start to finish — which is honestly half the point of this post. The barrier to going from "cool toolkit I found on LinkedIn" to "live tool anyone can use" is a lot lower than it used to be.

Try it: https://sourcing-outreach.vercel.app/

Real thanks to Abhishek Vijayvergiya and the team at Fabric for open-sourcing the toolkit this is built on top of. If you'd rather have sourcing, screening, and interviews done for you instead of running this yourself, go look at what they're building at fabrichq.ai.

Sourcing shouldn't be the bottleneck between you and a good hire. Curious what you'd want a tool like this to do next.
