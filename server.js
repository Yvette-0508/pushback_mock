// PushBack MVP server: static UI + session orchestration endpoints.
// API keys never leave the server:
//  - Voice: the browser talks to /ws/cartesia, which relays to a Cartesia Managed
//    Agent (Ink STT + Cartesia-hosted LLM + Sonic TTS) using the server-side key.
//  - Reports / "better phrasing": any OpenAI-compatible chat-completions LLM (LLM_*),
//    with a local heuristic fallback when none is configured or it fails.
require('dotenv').config();
const path = require('path');
const express = require('express');
const { WebSocketServer } = require('ws');
const { MODES, PRESSURE, validateConfig, buildInstructions, getRole, publicRoles } = require('./lib/roles');
const { evaluateSession, rephrase } = require('./lib/evaluator');
const { createCartesia } = require('./lib/cartesia');
const { createStore, sanitizeProject, sanitizeReport } = require('./lib/projects');

// cartesia | demo. VOICE_PROVIDER=demo forces the browser-speech demo voice.
function pickVoiceProvider(env) {
  if ((env.VOICE_PROVIDER || '').toLowerCase() === 'demo') return 'demo';
  return env.CARTESIA_API_KEY ? 'cartesia' : 'demo';
}

// Report/rephrase LLM: any OpenAI-compatible /chat/completions endpoint.
// OPENAI_API_KEY / OPENAI_EVAL_MODEL are still honored as shorthands for OpenAI.
function llmConfig(env) {
  return {
    apiKey: env.LLM_API_KEY || env.OPENAI_API_KEY || '',
    baseUrl: (env.LLM_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, ''),
    model: env.LLM_MODEL || env.OPENAI_EVAL_MODEL || 'gpt-4.1',
  };
}

function createApp(opts = {}) {
  const env = { ...process.env, ...(opts.env || {}) };
  const llm = llmConfig(env);
  const fetchImpl = opts.fetch || fetch;
  const voiceProvider = pickVoiceProvider(env);
  const cartesiaModel = env.CARTESIA_AGENT_MODEL || 'gpt-5.4-mini';
  const projects = createStore({ env });
  const cartesia = env.CARTESIA_API_KEY
    ? createCartesia({
      apiKey: env.CARTESIA_API_KEY, model: cartesiaModel, env, fetchImpl,
      apiBase: opts.cartesiaApiBase, wsBase: opts.cartesiaWsBase,
      cacheFile: opts.cartesiaCacheFile === undefined ? path.join(__dirname, '.cartesia-agents.json') : opts.cartesiaCacheFile,
    })
    : null;

  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));
  app.locals.projects = projects;
  projects.init().catch((e) => console.error('projects init failed:', e.message));
  app.use(express.static(path.join(__dirname, 'public')));
  app.get('/lib/analyzer.js', (req, res) => res.sendFile(path.join(__dirname, 'lib', 'analyzer.js')));

  // Projects (a named saved setup: role+mode+pressure+context).
  app.get('/api/projects', async (req, res) => {
    try { res.json(await app.locals.projects.list()); } catch (e) { res.status(500).json({ error: e.message }); }
  });
  app.post('/api/projects', async (req, res) => {
    const { ROLES } = require('./lib/roles');
    const ok = sanitizeProject(req.body, Object.keys(ROLES));
    if (ok.error) return res.status(400).json({ error: ok.error });
    const now = new Date().toISOString();
    const project = { id: 'p_' + Math.random().toString(36).slice(2, 10), ...ok.project, createdAt: now, updatedAt: now };
    try { await app.locals.projects.upsert(project); res.json(project); } catch (e) { res.status(500).json({ error: e.message }); }
  });
  app.delete('/api/projects/:id', async (req, res) => {
    try {
      const deleted = await app.locals.projects.remove(String(req.params.id).slice(0, 40));
      res.json({ ok: true, deleted });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Reports are graded per project: a saved trial (one meeting's evaluation).
  app.get('/api/projects/:id/reports', async (req, res) => {
    try { res.json(await app.locals.projects.listReports(String(req.params.id).slice(0, 40))); } catch (e) { res.status(500).json({ error: e.message }); }
  });
  app.post('/api/reports', async (req, res) => {
    const projects = await app.locals.projects.list().catch(() => []);
    const ok = sanitizeReport(req.body, projects.map((p) => p.id));
    if (ok.error) return res.status(400).json({ error: ok.error });
    const row = ok.reportRow;
    const now = new Date().toISOString();
    const saved = { id: 'r_' + Math.random().toString(36).slice(2, 10), ...row, createdAt: now };
    try { await app.locals.projects.addReport(saved); res.json({ id: saved.id, createdAt: saved.createdAt }); } catch (e) { res.status(500).json({ error: e.message }); }
  });
  app.get('/api/reports/:id', async (req, res) => {
    try {
      const r = await app.locals.projects.getReport(String(req.params.id).slice(0, 40));
      if (!r) return res.status(404).json({ error: 'Not found.' });
      res.json(r);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  app.delete('/api/reports/:id', async (req, res) => {
    try {
      const deleted = await app.locals.projects.removeReport(String(req.params.id).slice(0, 40));
      res.json({ ok: true, deleted });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/config', (req, res) => {
    res.json({
      roles: publicRoles(),
      modes: Object.values(MODES),
      pressure: Object.entries(PRESSURE).map(([id, p]) => ({ id, ...p })),
      voiceProvider,
      llmEvaluation: !!llm.apiKey,
      llmModel: llm.apiKey ? llm.model : null,
      cartesiaModel: cartesia ? cartesiaModel : null,
      projectsBackend: projects.kind,
    });
  });

  app.post('/api/evaluate', async (req, res) => {
    const v = validateConfig(req.body?.config);
    if (!v.ok) return res.status(400).json({ error: v.errors.join('; ') });
    try {
      const report = await evaluateSession({ config: v.config, transcript: req.body.transcript, ...llm, fetchImpl });
      res.json(report);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/rephrase', async (req, res) => {
    const { text, question, role } = req.body || {};
    if (!getRole(role)) return res.status(400).json({ error: 'Unknown role' });
    try {
      res.json(await rephrase({ text, question, roleId: role, ...llm, fetchImpl }));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.locals.cartesia = cartesia;
  app.locals.voiceProvider = voiceProvider;
  app.locals.projectsStore = { kind: projects.kind };
  return app;
}

// Relay browser <-> Cartesia agent WebSocket. Protocol from the browser:
//   1st message: {"type":"start","config":{role,mode,pressure,context}}
//   then: Cartesia client events (audio_input ...), forwarded verbatim.
// Server -> browser: Cartesia server events verbatim, plus {"type":"proxy_error","message"}.
function attachVoiceRelay(server, app) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1 << 20 });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname !== '/ws/cartesia') return socket.destroy();
    // Block cross-site pages from using this server's Cartesia key.
    const origin = req.headers.origin;
    if (origin) {
      try { if (new URL(origin).host !== req.headers.host) return socket.destroy(); } catch { return socket.destroy(); }
    }
    wss.handleUpgrade(req, socket, head, (ws) => handleRelay(ws, app.locals.cartesia));
  });
  return wss;
}

function handleRelay(client, cartesia) {
  let upstream = null;
  let started = false;
  let pending = [];
  const send = (obj) => { if (client.readyState === 1) client.send(JSON.stringify(obj)); };
  const fail = (message) => {
    send({ type: 'proxy_error', message });
    try { client.close(4000, 'relay error'); } catch {}
    try { upstream?.terminate(); } catch {}
  };

  client.on('message', async (raw) => {
    const text = raw.toString();
    if (started) {
      if (upstream?.readyState === 1) upstream.send(text);
      else if (upstream?.readyState === 0) pending.push(text);
      return;
    }
    started = true;
    let msg;
    try { msg = JSON.parse(text); } catch { return fail('First message must be JSON {"type":"start"}.'); }
    if (msg.type !== 'start') return fail('First message must be {"type":"start","config":{...}}.');
    if (!cartesia) return fail('CARTESIA_API_KEY is not configured on the server.');
    const v = validateConfig(msg.config);
    if (!v.ok) return fail(v.errors.join('; '));
    const role = getRole(v.config.role);

    let agentId;
    try { agentId = await cartesia.agentFor(v.config.role); } catch (err) { return fail(err.message); }
    if (client.readyState !== 1) return;

    upstream = cartesia.connect(agentId);
    upstream.on('open', () => {
      upstream.send(JSON.stringify(cartesia.sessionCreate({ instructions: buildInstructions(v.config), opener: role.openers[0] })));
      pending.forEach((m) => upstream.send(m));
      pending = [];
    });
    upstream.on('message', (data) => { if (client.readyState === 1) client.send(data.toString()); });
    upstream.on('unexpected-response', (req, res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => fail(`Cartesia rejected the connection (${res.statusCode}): ${body.slice(0, 200)}`));
    });
    upstream.on('error', (err) => fail(`Cartesia connection error: ${err.message}`));
    upstream.on('close', (code, reason) => {
      if (client.readyState !== 1) return;
      const r = String(reason || '').slice(0, 100);
      if (code !== 1000) send({ type: 'proxy_error', message: `Cartesia closed the session (${code}${r ? `: ${r}` : ''})` });
      client.close(code === 1000 ? 1000 : 4001, r || 'upstream closed');
    });
  });
  client.on('close', () => { try { upstream?.close(1000, 'client left'); } catch {} });
  client.on('error', () => {});
}

function startServer(opts = {}) {
  const app = createApp(opts);
  const server = app.listen(opts.port ?? (Number(process.env.PORT) || 3000));
  attachVoiceRelay(server, app);
  return { app, server };
}

if (require.main === module) {
  const { app, server } = startServer();
  server.on('listening', () => {
    console.log(`PushBack running at http://localhost:${server.address().port}`);
    console.log(app.locals.voiceProvider === 'cartesia' ? 'Voice: Cartesia Managed Agent (Ink + hosted LLM + Sonic).'
      : 'Voice: demo mode (browser speech + scripted persona) — set CARTESIA_API_KEY for Cartesia.');
    const llm = llmConfig({ ...process.env });
    console.log(llm.apiKey ? `Reports: ${llm.model} via ${llm.baseUrl}` : 'Reports: heuristic analyzer (no LLM_API_KEY set).');
    console.log(`Projects store: ${app.locals.projects.kind}${app.locals.projects.kind === 'json' ? ' (.pushback-projects.json; set DATABASE_URL for Postgres)' : ''}`);
  });
}

module.exports = { createApp, startServer, attachVoiceRelay, pickVoiceProvider, llmConfig };
