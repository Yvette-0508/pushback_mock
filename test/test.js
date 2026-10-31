// Offline test suite: no API keys, no network. Run with: npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const { ROLES, PRESSURE, validateConfig, buildInstructions, getRole, publicRoles, sanitizeContext } = require('../lib/roles');
const analyzer = require('../lib/analyzer');
const { evaluateSession, rephrase, buildEvalPrompt, REPORT_SCHEMA } = require('../lib/evaluator');
const { createApp } = require('../server');

test('roles: 4 roles with voice, rubric, persona, openers', () => {
  assert.equal(Object.keys(ROLES).length, 4);
  for (const r of Object.values(ROLES)) {
    assert.ok(r.voice && r.personaName && r.title);
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
test('server: config exposes all roles; session guarded without key; evaluation works offline', async () => {
  const app = createApp({ env: { OPENAI_API_KEY: '' } });
  const srv = await new Promise((res) => { const s = app.listen(0, () => res(s)); });
  const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    const cfg = await (await fetch(`${base}/api/config`)).json();
    assert.equal(cfg.realtimeAvailable, false);
    assert.equal(cfg.roles.length, 4);
    assert.equal(cfg.roles.find((r) => r.id === 'boss').rubric[0].key, 'value_first');
    assert.equal(cfg.pressure.length, 3);

    const sess = await fetch(`${base}/api/realtime/session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(sess.status, 400);
    const sessNoKey = await fetch(`${base}/api/realtime/session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ role: 'interviewer', mode: 'formal' }) });
    assert.equal(sessNoKey.status, 503);

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
