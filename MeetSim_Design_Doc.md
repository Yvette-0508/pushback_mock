# Design Document: Structured Expression Simulator  
**Working Title:** MeetSim / ChallengeMeet  
**Version:** 0.1 (MVP Focus)  
**Date:** October 30, 2026  

## 1. Overview

MeetSim is a real-time voice (and later video) AI simulator that places users inside a Zoom-style meeting interface to practice structured expression, persuasion, and composure under pressure.  

Users interact with configurable AI personas (interviewer, investor, difficult coworker, boss, etc.). The product emphasizes **structured thinking and clear communication** rather than pure entertainment or generic interview prep.

**Core differentiator:** High-fidelity meeting UI + role-specific pressure + explicit structured-expression feedback.

## 2. Goals & Non-Goals

### Goals
- Deliver natural, low-latency real-time voice conversation (target: 300–600 ms end-to-end after first turn).
- Support Practice Mode (real-time coaching) and Formal Mode (no real-time feedback, post-session report only).
- Allow users to configure roles and inject context (JD, project description, situation).
- Provide concrete feedback on structure (conclusion-first, logical layers, evidence, recovery after interruption).
- Offer both voice-only and video+voice experiences.

### Non-Goals (MVP)
- Full multi-person chaotic meetings with 4+ simultaneous AI agents.
- Perfect photorealistic real-time video generation from scratch.
- Enterprise SSO, team analytics dashboards, or LMS integration.
- Mobile native apps (start with responsive web).

## 3. User Personas

| Persona              | Primary Use Case                          | Key Pain Point                          |
|----------------------|-------------------------------------------|-----------------------------------------|
| Job Seeker           | Interview practice with real JD           | Answers become unstructured under pressure |
| Founder / Operator   | Investor or board simulation              | Loses structure when challenged on metrics |
| Individual Contributor / Manager | Difficult coworker or boss conversations | Gets emotional or defensive and loses clarity |
| Self-improver        | General structured speaking practice      | Knows theory but cannot execute live     |

## 4. Product Modes

### 4.1 Practice Mode
- Real-time or near-real-time feedback available (structure hints, interruption recovery prompts, quick scores).
- User can pause, request “better phrasing,” or see live structure tree.
- Ideal for skill building.

### 4.2 Formal Mode
- Zero real-time coaching during the session.
- Full pressure simulation.
- Comprehensive evaluation report generated only after the session ends.
- Ideal for final rehearsal.

Both modes support the same roles and UI.

## 5. Key Features

### 5.1 Meeting Interface
- Zoom-style layout (participant tiles, mute/unmute, leave, chat sidebar optional).
- Voice-only or video+voice tiles.
- Support for 1 AI participant (MVP) → 2–3 AI participants (later).

### 5.2 Role Configuration
Users select a role and optionally provide context:

| Role              | Context Input Examples                  | AI Behavior Focus                     | Structure Evaluation Focus                  |
|-------------------|-----------------------------------------|---------------------------------------|---------------------------------------------|
| Interviewer       | Job description, company, level         | Follow-up on experience, challenge claims | STAR completeness, specificity, relevance   |
| Investor          | One-liner, stage, deck summary          | Demand metrics, question defensibility | Conclusion-first, data support, risk handling |
| Potential Coworker| Scenario description                    | Push responsibility, question assumptions | Problem-Impact-Solution clarity, boundary setting |
| Boss              | Raise request, project pitch, etc.      | Time pressure, priority questioning   | Value-first framing                         |

System prompt and evaluation rubric are dynamically adjusted per role.

### 5.3 Structured Expression Feedback
- Structure visualization (conclusion → supporting points → evidence).
- Detection of logical jumps, missing conclusion, or weak support.
- Interruption recovery scoring: Did the user re-anchor the main point after being cut off?
- “Better version” rewrite of key answers.
- Role-specific scoring dimensions (e.g., data density for investors, STAR completeness for interviewers).

### 5.4 Session Flow
1. Choose mode (Practice / Formal).
2. Select role + inject context.
3. Enter Zoom-style room.
4. Conduct conversation (AI can interrupt, challenge, go silent).
5. End session → receive report (immediate in Practice; post-only in Formal).

## 6. Technical Architecture

### 6.1 High-Level Stack (MVP)

```
[Browser – Zoom-style UI]
        │
        ▼
[WebRTC / LiveKit]
        │
        ▼
[Realtime Voice Layer]
   ├── OpenAI Realtime API (primary)
   └── Gemini Live API (fallback / cost option)
        │
        ▼
[Session Orchestrator]
   ├── Role & Context Manager
   ├── Practice/Formal Mode Controller
   └── Evaluation Engine
        │
        ▼
[Post-session Analyzer]
   └── LLM-based structure scoring + report generation
```

### 6.2 Recommended Realtime APIs

| Layer          | Primary Recommendation              | Alternative                  | Notes                                      |
|----------------|-------------------------------------|------------------------------|--------------------------------------------|
| Voice          | OpenAI Realtime API (gpt-realtime-2.1 or GPT-Live) | Gemini Live API             | Best latency + interruption support       |
| Transport      | LiveKit or direct WebRTC            | Pure WebSocket               | Lower latency with WebRTC                  |
| Video Avatar   | HeyGen LiveAvatar (later phase)     | Anam / D-ID / Tavus          | Add after voice is solid                   |
| Evaluation     | Strong reasoning model (Claude / GPT / Gemini) | —                          | Used after session for detailed report     |

### 6.3 Latency Targets
- Voice end-to-end (user stop → first AI audio): 300–600 ms (steady state).
- Acceptable maximum: < 800 ms.
- Video avatar will add latency; prioritize voice quality first.

## 7. Data & Privacy

- Sessions are private by default.
- Audio is processed in real time; transcripts stored only if user opts in for history/reports.
- Context (JD, project text) is used only for the session and evaluation.
- No training on user data without explicit consent.

## 8. Evaluation Report Structure (Formal Mode)

1. Overall score (Structured Expression, Persuasion, Composure).
2. Structure map of key answers.
3. Moments of strength (quoted).
4. Moments of breakdown (quoted + suggested better phrasing).
5. Interruption recovery analysis.
6. Role-specific insights (e.g., “You never led with the metric when challenged”).
7. One prioritized improvement action.

## 9. MVP Scope (Phase 1)

**Must have**
- Zoom-style web UI (voice only).
- Practice + Formal modes.
- 3 roles: Interviewer, Investor, Coworker.
- Context injection (text paste).
- OpenAI Realtime integration with interruption support.
- Post-session structured evaluation report.
- Basic structure visualization in the report.

**Nice to have in MVP**
- Live structure hints in Practice Mode.
- “Better version” rewrites.

**Later phases**
- Video avatars.
- Multi-agent meetings.
- Saved role templates.
- Progress tracking over time.
- Mobile apps.

## 10. Success Metrics

- Session completion rate.
- Users returning for a second session within 7 days.
- Qualitative feedback on “Did the pressure feel real?” and “Did the feedback help me structure better?”
- Average latency (p50 / p95) of voice responses.

## 11. Risks & Mitigations

| Risk                        | Mitigation                                      |
|-----------------------------|-------------------------------------------------|
| Latency feels unnatural     | Prioritize OpenAI Realtime + WebRTC; set clear user expectation |
| AI too soft or too random   | Strong role-specific system prompts + evaluation rubrics |
| Evaluation quality low      | Use a strong reasoning model for post-session analysis; iterate on prompts |
| Cost of realtime APIs       | Offer Gemini Live as lower-cost option; monitor usage |

## 12. Next Steps

1. Build minimal Zoom-style UI + OpenAI Realtime voice loop.
2. Implement role + context injection into system prompt.
3. Create Practice vs Formal mode flag (controls real-time feedback visibility).
4. Develop post-session evaluation prompt and report UI.
5. User test with 5–10 people on interviewer and investor scenarios.

---

**Document Owner:** [Your Name]  
**Status:** Draft for MVP planning  
