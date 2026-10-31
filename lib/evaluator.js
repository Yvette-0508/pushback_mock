// Post-session evaluation engine (Design Doc §6.1 "Post-session Analyzer", §8).
// Uses a strong reasoning model via OpenAI when configured, otherwise falls
// back to the local heuristic analyzer so the app works fully offline.
const { getRole, MODES } = require('./roles');
const analyzer = require('./analyzer');

const REPORT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['scores', 'overall', 'summary', 'rubric', 'structureMap', 'strengths', 'breakdowns', 'interruptionRecovery', 'roleInsights', 'topAction'],
  properties: {
    scores: {
      type: 'object', additionalProperties: false, required: ['structured', 'persuasion', 'composure'],
      properties: { structured: { type: 'integer' }, persuasion: { type: 'integer' }, composure: { type: 'integer' } },
    },
    overall: { type: 'integer' },
    summary: { type: 'string' },
    rubric: {
      type: 'array',
      items: { type: 'object', additionalProperties: false, required: ['key', 'label', 'score', 'comment'], properties: { key: { type: 'string' }, label: { type: 'string' }, score: { type: 'integer' }, comment: { type: 'string' } } },
    },
    structureMap: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false, required: ['question', 'conclusion', 'points', 'issues'],
        properties: {
          question: { type: 'string' },
          conclusion: { type: 'string' },
          points: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['text', 'hasEvidence'], properties: { text: { type: 'string' }, hasEvidence: { type: 'boolean' } } } },
          issues: { type: 'array', items: { type: 'string' } },
        },
      },
    },
    strengths: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['quote', 'why'], properties: { quote: { type: 'string' }, why: { type: 'string' } } } },
    breakdowns: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['quote', 'issue', 'better'], properties: { quote: { type: 'string' }, issue: { type: 'string' }, better: { type: 'string' } } } },
    interruptionRecovery: {
      type: 'object', additionalProperties: false, required: ['count', 'recovered', 'analysis', 'moments'],
      properties: {
        count: { type: 'integer' }, recovered: { type: 'integer' }, analysis: { type: 'string' },
        moments: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['quote', 'recovered'], properties: { quote: { type: 'string' }, recovered: { type: 'boolean' } } } },
      },
    },
    roleInsights: { type: 'array', items: { type: 'string' } },
    topAction: { type: 'string' },
  },
};

function normalizeTranscript(transcript) {
  if (!Array.isArray(transcript)) return [];
  return transcript
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.text === 'string')
    .slice(0, 400)
    .map((m) => ({ role: m.role, text: m.text.slice(0, 4000), interrupted: !!m.interrupted, t: Number(m.t) || 0 }));
}

function formatTranscript(transcript, role) {
  return transcript
    .map((m) => `${m.role === 'user' ? 'USER' : role.personaName.toUpperCase()}${m.interrupted ? ' [interrupted the user]' : ''}: ${m.text}`)
    .join('\n');
}

function buildEvalPrompt({ role, mode, context, transcript }) {
  return [
    `You are an expert communication coach evaluating a ${MODES[mode]?.label || mode}-mode simulation where the user spoke with an AI ${role.label.toLowerCase()} (${role.personaName}).`,
    'Evaluate the USER only, focused on STRUCTURED EXPRESSION: conclusion-first, logical layers, evidence/support, and recovery after interruption.',
    '',
    'Role-specific rubric (score each 0–100):',
    ...role.rubric.map((r) => `- ${r.key} — ${r.label}: ${r.desc}`),
    '',
    'Instructions:',
    '- scores.structured / persuasion / composure and overall are 0–100 integers. Be calibrated and honest; average performance ≈ 55–65.',
    '- structureMap: for up to 6 key user answers, extract the conclusion, supporting points (flag hasEvidence), and structural issues (logical jumps, missing conclusion, weak support).',
    '- strengths: up to 3 verbatim user quotes with why they worked.',
    '- breakdowns: up to 3 verbatim user quotes with the issue and a rewritten "better" version in the user\'s voice.',
    '- interruptionRecovery: turns marked [interrupted the user] are AI interruptions; judge whether the user re-anchored their main point afterwards.',
    '- roleInsights: 2–4 specific observations (e.g., "You never led with the metric when challenged").',
    '- topAction: ONE prioritized, concrete improvement action.',
    '- Respond in the same language the user mostly used.',
    '- If there are few or no user turns, say so and score low.',
    context ? `\nContext the user provided (${role.contextLabel}):\n"""\n${context}\n"""` : '',
    '\nTranscript:\n"""\n' + formatTranscript(transcript, role) + '\n"""',
  ].join('\n');
}

async function callOpenAIJson({ apiKey, model, prompt, schemaName, schema, fetchImpl = fetch }) {
  const res = await fetchImpl('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt }],
      response_format: { type: 'json_schema', json_schema: { name: schemaName, strict: true, schema } },
    }),
  });
  if (!res.ok) throw new Error(`OpenAI ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  return JSON.parse(data.choices[0].message.content);
}

function clampReport(r) {
  const c = (n) => Math.max(0, Math.min(100, Math.round(Number(n) || 0)));
  r.scores = { structured: c(r.scores?.structured), persuasion: c(r.scores?.persuasion), composure: c(r.scores?.composure) };
  r.overall = c(r.overall);
  (r.rubric || []).forEach((x) => { x.score = c(x.score); });
  return r;
}

async function evaluateSession({ config, transcript, apiKey, model, fetchImpl }) {
  const role = getRole(config.role);
  if (!role) throw new Error('Unknown role');
  const t = normalizeTranscript(transcript);
  const userTurns = t.filter((m) => m.role === 'user' && m.text.trim()).length;

  if (apiKey && userTurns > 0) {
    try {
      const report = await callOpenAIJson({
        apiKey, model, fetchImpl,
        prompt: buildEvalPrompt({ role, mode: config.mode, context: config.context, transcript: t }),
        schemaName: 'meetsim_report', schema: REPORT_SCHEMA,
      });
      return { ...clampReport(report), source: 'llm', model };
    } catch (err) {
      const fallback = analyzer.heuristicReport(t, role.rubric, role.id);
      return { ...fallback, warning: `LLM evaluation failed, showing heuristic report: ${err.message}` };
    }
  }
  return analyzer.heuristicReport(t, role.rubric, role.id);
}

async function rephrase({ text, question, roleId, apiKey, model, fetchImpl }) {
  const role = getRole(roleId);
  if (!role) throw new Error('Unknown role');
  const clean = String(text || '').slice(0, 3000);
  if (!clean.trim()) return { better: '', source: 'none' };
  if (apiKey) {
    try {
      const out = await callOpenAIJson({
        apiKey, model, fetchImpl, schemaName: 'rephrase',
        schema: { type: 'object', additionalProperties: false, required: ['better', 'why'], properties: { better: { type: 'string' }, why: { type: 'string' } } },
        prompt: `Rewrite the user's spoken answer to a ${role.label.toLowerCase()} so it is conclusion-first, with 2–3 signposted supporting points and concrete evidence. Keep it under 90 words, in the user's voice and language, spoken style. Do not invent specific numbers; use [placeholder] where a number is needed. Rubric focus: ${role.rubric.map((r) => r.label).join(', ')}.\n\nQuestion: ${String(question || '').slice(0, 600)}\nAnswer: ${clean}`,
      });
      return { ...out, source: 'llm' };
    } catch (err) { /* fall through */ }
  }
  return { better: analyzer.betterVersion(clean, role.id), why: 'Restructured conclusion-first with signposted support.', source: 'heuristic' };
}

module.exports = { evaluateSession, rephrase, buildEvalPrompt, normalizeTranscript, REPORT_SCHEMA };
