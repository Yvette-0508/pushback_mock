# PushBack — Practice structured expression under real meeting pressure

A practice simulator: you speak, a demanding persona pushes back, and at the end you get a structured report with scores and rewrites.

Voice: [Cartesia](https://cartesia.ai) (Ink 2 listening + Cartesia-hosted LLM + Sonic speaking). No OpenAI credits needed for voice. Reports & "Better phrasing" use any OpenAI-compatible chat-completions LLM (OpenAI by default, Anthropic / Groq / OpenRouter via env vars).

## Run it

```bash
cp .env.example .env          # paste your CARTESIA_API_KEY at minimum
npm install
npm start                     # first run creates the Cartesia agents
```

Open http://localhost:3000. First session with each role needs a few extra seconds (the role's agent is created then). Use **headphones** in voice mode.

## Define your own roles (and practice against your JDs)

Roles are read from `lib/roles.js` (4 built-ins) and optionally from a JSON file pointed to by `ROLES_FILE`. Put custom roles in a file you maintain (built-ins stay in code):

**`~/my-roles.json`**
```json
{
  "pm_pitch": {
    "label": "Product Manager",
    "personaName": "Riley Torres",
    "title": "Senior PM, Acme Pro",
    "contextLabel": "Feature pitch, metrics, tradeoffs",
    "contextPlaceholder": "Paste a feature pitch: problem, users, metrics, tradeoffs…",
    "behavior": [
      "Interrupt long walkthroughs and ask for the user story and the metric.",
      "Challenge scope: 'who is this NOT for?', 'what are we dropping?'",
      "Ask how you'll measure success in two weeks, not two quarters."
    ],
    "rubric": [
      { "key": "user_first", "label": "User-first", "desc": "Frames the problem in the user's terms, not the team's." },
      { "key": "metric_focus", "label": "Metric focus", "desc": "Defines a measurable success criterion." },
      { "key": "urgency", "label": "Urgency", "desc": "Argues why this matters now, not later." }
    ],
    "openers": [
      "I'm only free for ten minutes. Walk me through the pitch and what you're asking me to commit to."
    ],
    "demoQuestions": [
      "Who is this NOT for?",
      "What's the metric that would've mattered two weeks ago?",
      "What are we cutting to make room for this?"
    ]
  }
}
```

```bash
ROLES_FILE=~/my-roles.json npm start
```

The new role appears in the Role picker. Restart after editing the file.

## Practicing with a job description

Two complementary options:

1. **Built-in `Context (optional)` box** — paste a JD / deck / conflict scenario. The persona reads it and asks specific follow-ups; the same text is passed to the end-of-session report.
2. **Custom role + context file** (see above) — make a role that *is* the interview you're prepping for, then paste the JD in Context at runtime.

## Linear

Linear is **not connected to runtime content**. The Cartesia agent, the roles and the JD you paste don't read from Linear. Linear's MCP tools are only available where you configure them in your AI model (e.g., your coding agent) — useful as an authoring aid (e.g., "use the Linear doc for this project in pushback_mock rotes.json"), not as a runtime reader of live roles/JDs.

If you want runtime connection, you'd have to add it: a small Intake endpoint that fetches a Linear doc/issue and writes it into `text` on `context`, or a `ROLES_FILE` exporter. Happy to add it — tell me which.

## Projects (saved setups)

The **Project** row at the top of the Playground saves named setups — role + mode + pressure + context (your JD) — so each project maps to one role+JD combo. "Save current" stores the current form; clicking a chip loads it; × deletes it.

Storage backends:

- **Default:** a local JSON file (`.pushback-projects.json`, gitignored). Fine for one machine.
- **PostgreSQL:** set `DATABASE_URL` and projects live in the database — survives redeploys and is shared across devices. On DigitalOcean: create a Managed PostgreSQL cluster (the $15/mo 1 vCPU / 1 GB tier is more than enough — this table stores a few KB per project), copy the connection string from the control panel into `.env`, restart. The table (`pushback_projects`) is created automatically on startup.

```bash
DATABASE_URL=postgresql://doadmin:PASSWORD@your-cluster.db.ondigitalocean.com:25060/defaultdb?sslmode=require
```

## Environment variables

Everything is optional; without keys it runs in demo mode (browser speech + scripted persona + heuristic report).

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | Server port |
| `CARTESIA_API_KEY` | — | Enables Cartesia voice. Required for the real voice loop. |
| `CARTESIA_AGENT_MODEL` | `gpt-5.4-mini` | LLM inside the Cartesia agent (listed by `GET /v1/agents/models`). |
| `CARTESIA_VOICE_INTERVIEWER` | auto | Force a specific Cartesia voice per role (also `_INVESTOR`, `_COWORKER`, `_BOSS`). |
| `CARTESIA_AGENT_ID_INTERVIEWER` | auto-create | Use an agent you configured in the Cartesia Playground. |
| `VOICE_PROVIDER` | auto (`cartesia` when key set) | `demo` forces the browser-speech persona. |
| `ROLES_FILE` | — | JSON file with extra roles (see above). |
| `DATABASE_URL` | — | PostgreSQL connection string for the projects store (default: local JSON file). |
| `DATABASE_TABLE` | `pushback_projects` | Table name for projects. |
| `LLM_API_KEY` | — | Key for reports/"better phrasing". Any OpenAI-compatible provider. |
| `LLM_BASE_URL` | `https://api.openai.com/v1` | Base URL of `/chat/completions`. |
| `LLM_MODEL` | `gpt-4.1` | Model for reports/`better phrasing`. |
| `OPENAI_API_KEY` / `OPENAI_EVAL_MODEL` | — | Legacy shorthand for `LLM_API_KEY` / `LLM_MODEL`. |

## Notes & limits

- **Voice mode is voice-only** (no text entry during a conversation), matching Cartesia's agent API.
- **The persona doesn't cut you off** at a set pressure-second timer — the Cartesia agent has no "speak now" trigger. Instead, per-pressure prompt text makes the persona cut in more often in spirit.
- `CARTESIA_VOICE_<ROLE>` / `CARTESIA_AGENT_ID_<ROLE>` override the defaults but do NOT create features you didn't have: you still get one voice per role and one persona per session.
- Test suite (`npm test`, 22 tests) covers roles loading, config flow, evaluator, plus a mock Cartesia API + WebSocket so the **relay runs offline** without a real key.

## Development

```bash
npm test
```

Layout:
- `server.js` — Express app + web-socket relay to Cartesia.
- `lib/roles.js` — built-in roles, prompt builder, config validation.
- `lib/cartesia.js` — agent provisioning (voice pick, per-role agent, session-create).
- `lib/evaluator.js` — report prompt + LLM call (provider-agnostic) + heuristic fallback.
- `public/` — the PushBack dashboard (playground → meeting room → report).
