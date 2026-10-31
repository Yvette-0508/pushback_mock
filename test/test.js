// Offline test suite: no API keys, no network. Run with: npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const { ROLES, PRESSURE, validateConfig, buildInstructions, getRole, publicRoles, sanitizeContext } = require('../lib/roles');
const analyzer = require('../lib/analyzer');
const { evaluateSession, rephrase, buildEvalPrompt, REPORT_SCHEMA } = require('../lib/evaluator');
const { createApp } = require('../server');

test('roles: 4 roles with rubric, persona, openers', () => {
  assert.equal(Object.keys(ROLES).length, 4);
  for (const r of Object.values(ROLES)) {
    assert.ok(r.personaName && r.title);
    assert.equal(r.rubric.length, 3);
    assert.equal(r.behavior.length, 3);
    assert.ok(r.openers.length && r.demoQuestions.length >= 3);
  }
});

test('roles: validateConfig accepts valid, sanitizes pressure/context, rejects bad role/mode', () => {
  const ok = validateConfig({ role: 'interviewer', mode: 'practice', pressure: 'high', context: '  text  ' });
  assert.equal(ok.ok, true);
  assert.equal(ok.config.pressure, 'high');
  assert.equal(ok.config.context, 'text');
  assert.equal(validateConfig({ role: 'nope', mode: 'practice' }).ok, false);
  assert.equal(validateConfig({ role: 'boss', mode: 'nope' }).ok, false);
  assert.equal(validateConfig({ role: 'investor', mode: 'formal', pressure: 'extreme' }).config.pressure, 'medium');
  assert.equal(sanitizeContext('a\0b').includes('\0'), false);
});

test('roles: buildInstructions contains persona, behavior, context, pressure; never empty', () => {
  for (const key of Object.keys(PRESSURE)) {
    const ins = buildInstructions({ role: 'investor', mode: 'formal', pressure: key, context: 'Seed stage, $1M ARR' });
    assert.match(ins, /Priya Raman/);
    assert.match(ins, /\$1M ARR/);
    assert.match(ins, /Formal/);
  }
  const low = buildInstructions({ role: 'boss', mode: 'practice', pressure: 'low' });
  assert.match(low, /patient/i);
  assert.match(low, /do not cut in/);
  assert.match(buildInstructions({ role: 'boss', mode: 'formal', pressure: 'high' }), /25\+ seconds/);
  assert.ok(!low.includes('"""'), 'context block omitted when empty');
});

// ---- analyzer ----
const good = 'We reduced latency by 40%. First, we profiled the top endpoints; second, we added caching for the 3 heaviest queries. As a result, p95 dropped from 800ms to 480ms, which saved $50k a month.';
const bad = 'um so basically i think we like did some stuff and you know it kind of worked i guess yeah';

test('analyzer: good turn scores high, bad turn scores low', () => {
  const g = analyzer.analyzeTurn(good), b = analyzer.analyzeTurn(bad);
  assert.equal(g.conclusionFirst, true);
  assert.ok(g.evidence >= 3 && g.signposts >= 2 && g.numbers >= 2);
  assert.equal(b.conclusionFirst, false);
  assert.ok(b.fillers >= 3 && b.hedges >= 1);
  assert.equal(b.evidence, 0);
});

test('analyzer: practice hints fire appropriately per role', () => {
  const hsBad = analyzer.hintsForTurn(bad, 'interviewer').hints;
  assert.ok(hsBad.some((h) => h.level === 'warn'), 'bad answer gets a warning');
  const hsGood = analyzer.hintsForTurn(good, 'interviewer').hints;
  assert.ok(hsGood.every((h) => h.level !== 'warn'), 'good answer gets no warnings');
  const inv = analyzer.hintsForTurn('We are doing really well and growing fast with customers.', 'investor').hints;
  assert.ok(inv.some((h) => /metric/i.test(h.text)), 'investor: no-number warning');
  const tiny = analyzer.hintsForTurn('hi.', 'boss').hints;
  assert.equal(tiny.length, 0, 'no hints for trivial turn');
});

test('analyzer: interruption recovery detection', () => {
  assert.equal(analyzer.recoveredAfterInterruption('As I was saying, the main point is the latency problem.'), true);
  assert.equal(analyzer.recoveredAfterInterruption('The answer is yes, we can ship it by Friday.'), true);
  assert.equal(analyzer.recoveredAfterInterruption('um well okay uh maybe we could try something else entirely different what do you think about that'), false);
});

// ---- fallback report ----
const empty = [];
const sample = [
  { role: 'assistant', text: 'Walk me through a project you are proud of.', t: 0 },
  { role: 'assistant', text: 'Sorry to cut in — what\'s the bottom line?', interrupted: true, t: 1 },
  { role: 'user', text: good, t: 2 },
  { role: 'assistant', text: 'Tell me about a failure.', t: 3 },
  { role: 'user', text: bad, t: 4 },
];

test('evaluator (offline): decreases monotonically from good-only → mixed → bad-only transcript', async () => {
  const tGood = [{ role: 'user', text: good }];
  const tBad = [{ role: 'user', text: bad }];
  const opts = (transcript) => ({ config: validateConfig({ role: 'interviewer', mode: 'formal', context: 'JD' }).config, transcript, apiKey: '' });
  const rGood = await evaluateSession(opts(tGood));
  const rMix = await evaluateSession(opts(sample));
  const rBad = await evaluateSession(opts(tBad));
  assert.ok(rGood.overall > rMix.overall, `good (${rGood.overall}) > mixed (${rMix.overall})`);
  assert.ok(rMix.overall > rBad.overall, `mixed (${rMix.overall}) > bad (${rBad.overall})`);
  for (const r of [rGood, rMix, rBad]) {
    assert.ok(r.overall >= 0 && r.overall <= 100);
    for (const k of ['structured', 'persuasion', 'composure']) assert.ok(r.scores[k] >= 0 && r.scores[k] <= 100);
  }
});

test('evaluator (offline): no score on empty engine text; low scores on empty transcript', async () => {
  const cfg = validateConfig({ role: 'boss', mode: 'practice', context: '' }).config;
  const rEmpty = await evaluateSession({ config: cfg, transcript: empty, apiKey: '' });
  assert.match(rEmpty.summary, /no answers/i);
  assert.ok(rEmpty.overall < 55, `empty session scores low (${rEmpty.overall})`);
  assert.equal(rEmpty.interruptionRecovery.count, 0);
  const onlyAI = await evaluateSession({ config: cfg, transcript: [{ role: 'assistant', text: 'hello?' }], apiKey: '' });
  assert.ok(onlyAI.overall < 55, `assistant-only transcript scores low (${onlyAI.overall})`);
});

test('evaluator (offline): schema completeness of report', async () => {
  const r = await evaluateSession({ config: validateConfig({ role: 'coworker', mode: 'practice', context: 'x' }).config, transcript: sample, apiKey: '' });
  for (const k of REPORT_SCHEMA.required) assert.ok(r[k] !== undefined, `missing ${k}`);
  assert.equal(r.rubric.length, 3);
  assert.ok(Array.isArray(r.structureMap) && Array.isArray(r.strengths) && Array.isArray(r.breakdowns));
  assert.ok(r.breakdowns.length >= 1 && r.breakdowns[0].better.length > 10, 'better-version rewrite present');
  assert.ok(r.topAction.length > 10);
});

test('evaluator: eval prompt embeds transcript + role rubric', () => {
  const role = getRole('investor');
  const p = buildEvalPrompt({ role, mode: 'formal', context: 'deck', transcript: sample });
  assert.match(p, /Conclusion-first/);
  assert.match(p, /USER: /);
  assert.match(p, /\[interrupted the user\]/);
  assert.match(p, /deck/);
});

test('evaluator: LLM path without key falls back; rephrase works offline', async () => {
  const cfg = validateConfig({ role: 'boss', mode: 'practice', context: 'raise' }).config;
  const r = await evaluateSession({ config: cfg, transcript: sample, apiKey: '' });
  assert.equal(r.source, 'heuristic');
  const rep = await rephrase({ text: bad, question: 'q', roleId: 'boss', apiKey: '' });
  assert.ok(typeof rep.better === 'string' && !rep.better.includes('\n'));
  assert.ok(rep.better.length > 10 && rep.source === 'heuristic');
  const repEmpty = await rephrase({ text: '  ', question: 'q', roleId: 'boss', apiKey: '' });
  assert.equal(repEmpty.better, '');
});

// ---- server API ----
test('server: config exposes all roles; demo voice without keys; Realtime endpoint gone; evaluation works offline', async () => {
  const app = createApp({ env: { OPENAI_API_KEY: '', LLM_API_KEY: '', CARTESIA_API_KEY: '' } });
  const srv = await new Promise((res) => { const s = app.listen(0, () => res(s)); });
  const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    const cfg = await (await fetch(`${base}/api/config`)).json();
    assert.equal(cfg.voiceProvider, 'demo');
    assert.equal(cfg.llmEvaluation, false);
    assert.equal(cfg.realtimeAvailable, undefined, 'OpenAI Realtime removed');
    assert.equal(cfg.roles.length, 4);
    assert.equal(cfg.roles.find((r) => r.id === 'boss').rubric[0].key, 'value_first');
    assert.equal(cfg.pressure.length, 3);

    const sess = await fetch(`${base}/api/realtime/session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(sess.status, 404, 'Realtime session endpoint removed');

    const ev = await fetch(`${base}/api/evaluate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ config: { role: 'investor', mode: 'practice' }, transcript: sample }) });
    assert.equal(ev.status, 200);
    const report = await ev.json();
    assert.equal(report.source, 'heuristic');
    assert.ok(report.rubric.some((x) => x.key === 'data_support'));

    const rp = await fetch(`${base}/api/rephrase`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: bad, question: 'why?', role: 'investor' }) });
    assert.equal(rp.status, 200);
    assert.ok((await rp.json()).better.length > 10);

    const rpBad = await fetch(`${base}/api/rephrase`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'x', role: 'nope' }) });
    assert.equal(rpBad.status, 400);
  } finally { srv.close(); }
});

test('publicRoles: openers hidden only from nothing (demo persona is documented)', () => {
  assert.ok(publicRoles().every((r) => r.contextLabel && r.contextPlaceholder));
});

// ---- Cartesia voice (mock Cartesia REST + agent WebSocket; no network) ----
const { WebSocketServer, WebSocket: WSClient } = require('ws');
const { pickVoiceProvider, startServer, llmConfig } = require('../server');
const { callLLMJson, parseJsonReply } = require('../lib/evaluator');
const { createCartesia } = require('../lib/cartesia');

test('voice provider: cartesia with key, demo otherwise or when forced; OpenAI key alone no longer selects a voice', () => {
  assert.equal(pickVoiceProvider({}), 'demo');
  assert.equal(pickVoiceProvider({ OPENAI_API_KEY: 'x' }), 'demo');
  assert.equal(pickVoiceProvider({ CARTESIA_API_KEY: 'y' }), 'cartesia');
  assert.equal(pickVoiceProvider({ CARTESIA_API_KEY: 'y', VOICE_PROVIDER: 'demo' }), 'demo');
});

test('llm config: LLM_* wins, OPENAI_* shorthand still works, trailing slash trimmed', () => {
  assert.deepEqual(llmConfig({}), { apiKey: '', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4.1' });
  assert.deepEqual(llmConfig({ OPENAI_API_KEY: 'o', OPENAI_EVAL_MODEL: 'gpt-x' }), { apiKey: 'o', baseUrl: 'https://api.openai.com/v1', model: 'gpt-x' });
  assert.deepEqual(llmConfig({ OPENAI_API_KEY: 'o', LLM_API_KEY: 'k', LLM_BASE_URL: 'https://api.groq.com/openai/v1/', LLM_MODEL: 'llama' }),
    { apiKey: 'k', baseUrl: 'https://api.groq.com/openai/v1', model: 'llama' });
});

test('llm: uses custom base URL; falls back from json_schema to json_object; parses fenced JSON', async () => {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    const body = JSON.parse(opts.body); calls.push({ url, body, auth: opts.headers.Authorization });
    if (body.response_format.type === 'json_schema') return { ok: false, status: 400, text: async () => 'json_schema unsupported' };
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '```json\n{"better":"B","why":"W"}\n```' } }] }) };
  };
  const out = await callLLMJson({ apiKey: 'k', baseUrl: 'https://llm.example/v1/', model: 'm', prompt: 'p', schemaName: 's', schema: { type: 'object' }, fetchImpl });
  assert.deepEqual(out, { better: 'B', why: 'W' });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, 'https://llm.example/v1/chat/completions');
  assert.equal(calls[1].body.response_format.type, 'json_object');
  assert.match(calls[1].body.messages[0].content, /JSON Schema/);
  assert.equal(calls[0].auth, 'Bearer k');
  assert.deepEqual(parseJsonReply('Sure! {"a":1} done'), { a: 1 });
  assert.throws(() => parseJsonReply('no json here'));
});

test('evaluator: partial LLM report gets safe defaults; LLM failure falls back to heuristic with warning', async () => {
  const cfg = validateConfig({ role: 'interviewer', mode: 'formal' }).config;
  const partial = async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: JSON.stringify({ overall: 140, scores: { structured: 50 } }) } }] }) });
  const r = await evaluateSession({ config: cfg, transcript: sample, apiKey: 'k', model: 'm', fetchImpl: partial });
  assert.equal(r.source, 'llm');
  assert.equal(r.overall, 100, 'clamped');
  assert.ok(Array.isArray(r.breakdowns) && Array.isArray(r.interruptionRecovery.moments));
  const broke = async () => ({ ok: false, status: 429, text: async () => 'insufficient_quota' });
  const f = await evaluateSession({ config: cfg, transcript: sample, apiKey: 'k', model: 'm', fetchImpl: broke });
  assert.equal(f.source, 'heuristic');
  assert.match(f.warning, /429/);
});

function mockCartesiaFetch(log) {
  return async (url, opts = {}) => {
    const u = new URL(url);
    log.push({ method: opts.method || 'GET', path: u.pathname + u.search, headers: opts.headers, body: opts.body ? JSON.parse(opts.body) : null });
    const json = (status, obj) => ({ ok: status < 300, status, text: async () => JSON.stringify(obj), json: async () => obj });
    if (u.pathname === '/voices') {
      const g = u.searchParams.get('gender');
      return json(200, { data: [{ id: `${g}-voice-a` }, { id: `${g}-voice-b` }], has_more: false });
    }
    if (u.pathname === '/v1/agents' && opts.method === 'POST') return json(201, { id: `agent_${log.length}` });
    return json(404, { message: 'not found' });
  };
}

test('cartesia: agentFor picks a per-role voice, creates templated agent once, caches it', async () => {
  const log = [];
  const c = createCartesia({ apiKey: 'sk_test', fetchImpl: mockCartesiaFetch(log), env: {}, cacheFile: null });
  const id1 = await c.agentFor('investor');
  const id2 = await c.agentFor('investor');
  assert.equal(id1, id2, 'second call served from cache');
  const creates = log.filter((l) => l.method === 'POST');
  assert.equal(creates.length, 1);
  const cfg = creates[0].body.config;
  assert.equal(cfg.instructions, '{{persona_instructions}}');
  assert.equal(cfg.initial_message, '{{opener}}');
  assert.equal(cfg.audio.output.voice_id, 'feminine-voice-b', 'investor = 2nd feminine voice');
  assert.equal(creates[0].headers['X-API-Key'], 'sk_test');
  assert.equal(creates[0].headers['Cartesia-Version'], '2026-08-14');
  const env = createCartesia({ apiKey: 'k', fetchImpl: mockCartesiaFetch([]), env: { CARTESIA_AGENT_ID_BOSS: 'agent_fixed' } });
  assert.equal(await env.agentFor('boss'), 'agent_fixed');
  await assert.rejects(c.agentFor('nope'), /Unknown role/);
});

test('cartesia relay: browser start → session_create with persona vars; events relayed both ways', async () => {
  // Mock Cartesia agent WebSocket.
  const seen = { headers: null, path: null, msgs: [] };
  const mock = new WebSocketServer({ port: 0 });
  await new Promise((r) => mock.on('listening', r));
  mock.on('connection', (ws, req) => {
    seen.headers = req.headers; seen.path = req.url;
    ws.on('message', (d) => {
      const m = JSON.parse(d.toString()); seen.msgs.push(m);
      if (m.type === 'session_create') ws.send(JSON.stringify({ type: 'session_ready', call_id: 'ac_1', audio: m.audio }));
      if (m.type === 'audio_input') {
        ws.send(JSON.stringify({ type: 'turn_ended', turn: 1, role: 'user', text: 'hello' }));
        ws.send(JSON.stringify({ type: 'audio_output', audio: Buffer.alloc(480).toString('base64') }));
      }
    });
  });
  const mockPort = mock.address().port;
  const { server } = startServer({
    port: 0,
    env: { CARTESIA_API_KEY: 'sk_test', OPENAI_API_KEY: '', LLM_API_KEY: '' },
    fetch: mockCartesiaFetch([]),
    cartesiaApiBase: 'http://mock.invalid',
    cartesiaWsBase: `ws://127.0.0.1:${mockPort}`,
    cartesiaCacheFile: null,
  });
  await new Promise((r) => server.on('listening', r));
  const base = `127.0.0.1:${server.address().port}`;
  try {
    const cfg = await (await fetch(`http://${base}/api/config`)).json();
    assert.equal(cfg.voiceProvider, 'cartesia');

    const got = [];
    const ws = new WSClient(`ws://${base}/ws/cartesia`);
    await new Promise((r) => ws.on('open', r));
    ws.on('message', (d) => got.push(JSON.parse(d.toString())));
    ws.send(JSON.stringify({ type: 'start', config: { role: 'interviewer', mode: 'formal', pressure: 'high', context: 'Staff engineer at Acme' } }));
    const waitFor = async (pred, ms = 3000) => { const t0 = Date.now(); while (!pred()) { if (Date.now() - t0 > ms) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 20)); } };
    await waitFor(() => got.some((m) => m.type === 'session_ready'));

    assert.equal(seen.headers['x-api-key'], 'sk_test', 'API key sent upstream as header');
    assert.match(seen.path, /^\/v1\/agents\/websocket\/agent_\d+\?cartesia_version=2026-08-14$/);
    const sc = seen.msgs.find((m) => m.type === 'session_create');
    assert.equal(sc.audio.input_format, 'pcm_24000');
    assert.match(sc.dynamic_variables.persona_instructions, /Morgan Lee/);
    assert.match(sc.dynamic_variables.persona_instructions, /Staff engineer at Acme/);
    assert.match(sc.dynamic_variables.opener, /walk me through/i);

    ws.send(JSON.stringify({ type: 'audio_input', audio: Buffer.alloc(1920).toString('base64') }));
    await waitFor(() => got.some((m) => m.type === 'audio_output'));
    assert.ok(got.some((m) => m.type === 'turn_ended' && m.text === 'hello'));
    ws.close();

    // Bad first message → proxy_error.
    const bad = new WSClient(`ws://${base}/ws/cartesia`);
    await new Promise((r) => bad.on('open', r));
    const errs = [];
    bad.on('message', (d) => errs.push(JSON.parse(d.toString())));
    bad.send(JSON.stringify({ type: 'start', config: { role: 'nope', mode: 'formal' } }));
    await waitFor(() => errs.length > 0);
    assert.equal(errs[0].type, 'proxy_error');
    assert.match(errs[0].message, /Unknown role/);

    // Cross-origin page is refused.
    const xo = new WSClient(`ws://${base}/ws/cartesia`, { headers: { origin: 'https://evil.example' } });
    await assert.rejects(new Promise((res, rej) => { xo.on('open', res); xo.on('error', rej); }));
  } finally {
    server.close(); mock.close();
  }
});
