# Design Document: Live Coding Interview Simulator  
**Working Title:** MeetSim v2.0 / CodeMeet  
**Version:** 2.0  
**Date:** October 30, 2026  

## 1. Overview

MeetSim v2.0 is a real-time coding interview simulator. The primary interface is a CoderPad-style collaborative IDE. An AI interviewer appears as a small live avatar in the top-right corner, speaking and interacting with the user while both parties can view and edit code in real time.

The session focuses on the interviewer **explaining, asking questions, and coding together** with the candidate. After the session ends, the interviewer generates a structured interview evaluation (面评).

**Core shift from v1.0:** From pure conversational practice → live collaborative coding + voice interaction.

## 2. Goals & Non-Goals

### Goals
- Deliver a CoderPad-like shared IDE as the main workspace.
- Provide a persistent small live avatar (top-right) that speaks in real time with low latency.
- Support the AI interviewer actively coding, modifying code, and walking through solutions live.
- Allow the user to code while being interrupted, questioned, or guided by the interviewer.
- Generate a post-session interview evaluation report (面评) covering technical depth, communication, and problem-solving.
- Maintain Practice Mode (real-time hints) and Formal Mode (no real-time help, post-only evaluation).

### Non-Goals (v2.0 MVP)
- Full multi-interviewer panels.
- Complex system design whiteboard (focus on coding problems first).
- Perfect video lip-sync for the avatar (voice + simple visual presence is acceptable for MVP).
- Automated code execution environment beyond basic run support (can be added later).

## 3. User Personas

| Persona              | Primary Use Case                          | Key Pain Point                          |
|----------------------|-------------------------------------------|-----------------------------------------|
| Software Engineer    | Live coding interview practice            | Freezes when interviewer asks to modify code live |
| Interviewer / Coach  | Running mock interviews with evaluation   | Hard to simulate realistic coding pressure |
| Self-improver        | Practicing explaining code while writing  | Can write code but struggles to narrate clearly |

## 4. Product Modes

### 4.1 Practice Mode
- Real-time structure and communication hints available.
- AI can offer gentle prompts when the user is stuck or unstructured.
- User can request “show a better approach” or “explain this step.”

### 4.2 Formal Mode
- No real-time coaching.
- Full interview pressure.
- Evaluation report (面评) generated only after the session.

## 5. Key Features

### 5.1 Main Interface Layout
- **Left / Center:** Full CoderPad-style collaborative IDE (code editor with syntax highlighting, file tree optional, run button).
- **Top-Right:** Small live avatar tile (persistent) that shows the interviewer speaking.
- **Bottom or Side:** Optional chat / notes panel.
- Shared cursor and real-time code synchronization between user and AI interviewer.

### 5.2 Live Coding Interaction
- AI interviewer can:
  - Explain a problem verbally while the user reads the prompt.
  - Write initial skeleton code or start coding a solution.
  - Ask the user to take over and continue.
  - Interrupt and ask the user to modify existing code (“What if we need to handle X?”).
  - Review the user’s code out loud and suggest changes.
- User and AI edit the same document in real time.
- Voice narration is synchronized with code changes where possible.

### 5.3 Role & Context
- Primary role: **Coding Interviewer**.
- Context inputs:
  - Problem description / LeetCode-style prompt.
  - Language preference (Python, JavaScript, Java, etc.).
  - Difficulty and focus (algorithms, data structures, system design coding, etc.).
  - Company style (optional: “Google-style”, “startup practical”, etc.).
- AI adjusts questioning style and evaluation criteria based on context.

### 5.4 Post-Session Interview Evaluation (面评)
Generated after the session ends, covering:
1. Overall recommendation (Strong Hire / Hire / No Hire / Strong No Hire).
2. Technical assessment (correctness, efficiency, edge cases, code quality).
3. Communication assessment (clarity of explanation, structured thinking while coding).
4. Problem-solving process (how the user approached the problem, response to hints/interruptions).
5. Key moments (quoted or referenced code + speech).
6. Specific improvement suggestions.
7. One prioritized next practice focus.

## 6. Technical Architecture

### 6.1 High-Level Stack

```
[Browser]
 ├── CoderPad-style IDE (Monaco / CodeMirror + CRDT or OT for collab)
 └── Top-right Avatar Tile (video or animated presence)
        │
        ▼
[WebRTC / LiveKit]
        │
        ▼
[Realtime Voice Layer]
   ├── OpenAI Realtime API (primary)
   └── Gemini Live API (fallback)
        │
        ▼
[Session Orchestrator]
   ├── Code Sync Manager (shared document)
   ├── Role & Problem Context
   ├── Practice/Formal Mode Controller
   └── Evaluation Engine
        │
        ▼
[Post-session Analyzer]
   └── LLM generates structured 面评 from transcript + code history
```

### 6.2 Recommended Components

| Layer              | Recommendation                          | Notes                                      |
|--------------------|-----------------------------------------|--------------------------------------------|
| Code Editor        | Monaco Editor + Yjs (CRDT)              | Real-time collaborative editing            |
| Voice              | OpenAI Realtime API                     | Low latency, interruption support          |
| Transport          | LiveKit                                 | Handles voice + potential video avatar     |
| Avatar (v2.0)      | Simple animated avatar or HeyGen LiveAvatar | Start simple; upgrade later               |
| Evaluation         | Strong reasoning model                  | Processes full transcript + code diff      |

### 6.3 Latency Targets
- Voice response: 300–600 ms end-to-end (steady state).
- Code sync: < 100 ms for local edits to appear for the other party.
- Avatar presence should not block the coding experience.

## 7. Session Flow

1. User selects Practice or Formal mode.
2. User pastes or selects a coding problem + language.
3. Enters the IDE room; interviewer avatar appears top-right and starts speaking.
4. Interviewer explains the problem and may begin coding or ask the user to start.
5. Real-time collaborative coding + voice discussion continues.
6. Session ends → system generates the 面评 report.

## 8. Data & Privacy

- Code and voice transcript are used only for the session and evaluation.
- User can choose whether to save the session history.
- No training on user code or speech without explicit consent.

## 9. MVP Scope (v2.0)

**Must have**
- CoderPad-style shared IDE (single language, e.g. Python or JavaScript).
- Top-right live speaking avatar (voice-driven; visual can be simple).
- Real-time voice interaction with interruption support.
- AI can write and edit code in the shared editor.
- Practice + Formal modes.
- Post-session 面评 report.
- Basic problem context injection.

**Nice to have**
- Multiple languages.
- Code execution / run button.
- Live structure hints in Practice Mode.

**Later**
- Full video avatar with lip-sync.
- Multi-file projects.
- System design mode.
- Saved problem sets and progress tracking.

## 10. Success Metrics

- Session completion rate.
- Users reporting the experience feels like a real coding interview.
- Quality of generated 面评 (user feedback on usefulness).
- Voice latency (p50 / p95).
- Code collaboration smoothness (no major sync issues).

## 11. Risks & Mitigations

| Risk                              | Mitigation                                              |
|-----------------------------------|---------------------------------------------------------|
| Voice + code sync feels laggy     | Prioritize OpenAI Realtime + optimized CRDT sync       |
| AI coding quality is inconsistent | Strong system prompts + ability for user to correct    |
| Evaluation report is generic      | Feed both transcript and code history into evaluation LLM |
| High API cost                     | Offer Gemini Live option; monitor session length       |

## 12. Next Steps

1. Prototype shared Monaco editor with basic real-time sync.
2. Integrate OpenAI Realtime voice with top-right avatar placeholder.
3. Enable AI to push code changes into the shared editor.
4. Build post-session 面评 generation pipeline.
5. Test with 5–10 users on standard algorithm problems.

---

**Document Owner:** [Your Name]  
**Status:** Draft for v2.0 planning  
**Relation to v1.0:** Evolves the Zoom-style meeting simulator into a coding-interview focused IDE experience while retaining Practice/Formal modes and structured evaluation.
