// MeetSim MVP server: static UI + session orchestration endpoints.
// The OpenAI API key never leaves the server; the browser receives a
// short-lived ephemeral client secret for the Realtime WebRTC connection.
require('dotenv').config();
const path = require('path');
const express = require('express');
const { MODES, PRESSURE, validateConfig, buildInstructions, getRole, publicRoles } = require('./lib/roles');
const { evaluateSession, rephrase } = require('./lib/evaluator');

function createApp(opts = {}) {
  const env = { ...process.env, ...(opts.env || {}) };
  const apiKey = env.OPENAI_API_KEY || '';
  const realtimeModel = env.OPENAI_REALTIME_MODEL || 'gpt-realtime';
  const evalModel = env.OPENAI_EVAL_MODEL || 'gpt-4.1';
  const transcribeModel = env.OPENAI_TRANSCRIBE_MODEL || 'gpt-4o-mini-transcribe';
  const fetchImpl = opts.fetch || fetch;

  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));
  app.use(express.static(path.join(__dirname, 'public')));
  app.get('/lib/analyzer.js', (req, res) => res.sendFile(path.join(__dirname, 'lib', 'analyzer.js')));

  app.get('/api/config', (req, res) => {
    res.json({
      roles: publicRoles(),
      modes: Object.values(MODES),
      pressure: Object.entries(PRESSURE).map(([id, p]) => ({ id, ...p })),
      realtimeAvailable: !!apiKey,
      llmEvaluation: !!apiKey,
      realtimeModel,
    });
  });

  // Mint an ephemeral Realtime client secret with role instructions baked in.
  app.post('/api/realtime/session', async (req, res) => {
    const v = validateConfig(req.body);
    if (!v.ok) return res.status(400).json({ error: v.errors.join('; ') });
    if (!apiKey) return res.status(503).json({ error: 'OPENAI_API_KEY not configured; use demo mode.' });
    const role = getRole(v.config.role);
    try {
      const r = await fetchImpl('https://api.openai.com/v1/realtime/client_secrets', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          expires_after: { anchor: 'created_at', seconds: 600 },
          session: {
            type: 'realtime',
            model: realtimeModel,
            instructions: buildInstructions(v.config),
            audio: {
              input: {
                transcription: { model: transcribeModel },
                turn_detection: { type: 'server_vad', silence_duration_ms: 500, interrupt_response: true, create_response: true },
              },
              output: { voice: role.voice },
            },
          },
        }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) return res.status(502).json({ error: data.error?.message || `OpenAI error ${r.status}` });
      res.json({ clientSecret: data.value, expiresAt: data.expires_at, model: realtimeModel });
    } catch (err) {
      res.status(502).json({ error: err.message });
    }
  });

  app.post('/api/evaluate', async (req, res) => {
    const v = validateConfig(req.body?.config);
    if (!v.ok) return res.status(400).json({ error: v.errors.join('; ') });
    try {
      const report = await evaluateSession({ config: v.config, transcript: req.body.transcript, apiKey, model: evalModel, fetchImpl });
      res.json(report);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/rephrase', async (req, res) => {
    const { text, question, role } = req.body || {};
    if (!getRole(role)) return res.status(400).json({ error: 'Unknown role' });
    try {
      res.json(await rephrase({ text, question, roleId: role, apiKey, model: evalModel, fetchImpl }));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return app;
}

if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  createApp().listen(port, () => {
    console.log(`MeetSim running at http://localhost:${port}`);
    if (!process.env.OPENAI_API_KEY) console.log('No OPENAI_API_KEY set — running in demo mode (browser speech + heuristic reports).');
  });
}

module.exports = { createApp };
