// Cartesia Managed Agents integration (Ink STT + Cartesia-hosted LLM + Sonic TTS).
// Docs: https://docs.cartesia.ai/agents/introduction , API version 2026-08-14.
//
// One agent per PushBack role (each role has its own voice). The agent's
// instructions and greeting are dynamic-variable templates, so the per-session
// persona prompt (role + mode + pressure + user context) is injected at
// session_create time without re-configuring the agent.
const fs = require('fs');
const WebSocket = require('ws');
const { getRole } = require('./roles');

const CARTESIA_VERSION = '2026-08-14';
const TEMPLATE_VERSION = 1; // bump when the agent config below changes → agents are re-created
const AUDIO_FORMAT = 'pcm_24000'; // 16-bit mono PCM @ 24 kHz, both directions

// Default voice choice per role when no CARTESIA_VOICE_<ROLE> override is set:
// [gender filter for GET /voices, index into the results].
const ROLE_VOICE_PREF = {
  interviewer: ['feminine', 0],
  investor: ['feminine', 1],
  coworker: ['masculine', 0],
  boss: ['masculine', 1],
};

function createCartesia({
  apiKey,
  model = 'gpt-5.4-mini',
  env = {},
  fetchImpl = fetch,
  apiBase = 'https://api.cartesia.ai',
  wsBase = 'wss://api.cartesia.ai',
  cacheFile = null,
}) {
  const headers = { 'X-API-Key': apiKey, 'Cartesia-Version': CARTESIA_VERSION, 'Content-Type': 'application/json' };

  async function api(path, opts = {}) {
    const r = await fetchImpl(apiBase + path, { ...opts, headers });
    const text = await r.text();
    let data = {};
    try { data = text ? JSON.parse(text) : {}; } catch { data = { message: text }; }
    if (!r.ok) {
      const msg = data.message || data.error?.message || (typeof data.error === 'string' ? data.error : '') || text.slice(0, 200);
      throw new Error(`Cartesia ${r.status} on ${path}: ${msg}`);
    }
    return data;
  }

  const readCache = () => {
    if (!cacheFile) return {};
    try { return JSON.parse(fs.readFileSync(cacheFile, 'utf8')); } catch { return {}; }
  };
  const writeCache = (c) => {
    if (!cacheFile) return;
    try { fs.writeFileSync(cacheFile, JSON.stringify(c, null, 2)); } catch { /* non-fatal */ }
  };
  let cache = readCache();
  const inflight = {};
  const voiceCache = {};

  async function voiceFor(roleId) {
    const override = env[`CARTESIA_VOICE_${roleId.toUpperCase()}`];
    if (override) return override;
    if (voiceCache[roleId]) return voiceCache[roleId];
    const [gender, idx] = ROLE_VOICE_PREF[roleId] || ['feminine', 0];
    const list = await api(`/voices?limit=20&language=en&gender=${gender}`);
    let voices = list.data || [];
    if (!voices.length) voices = (await api('/voices?limit=20&language=en')).data || [];
    if (!voices.length) throw new Error('No Cartesia voices available for this account');
    voiceCache[roleId] = voices[idx % voices.length].id;
    return voiceCache[roleId];
  }

  function agentConfig(role, voiceId) {
    return {
      name: `PushBack ${role.label}`.slice(0, 64),
      description: `PushBack practice persona: ${role.personaName}, ${role.title}`,
      config: {
        instructions: '{{persona_instructions}}',
        initial_message: '{{opener}}',
        model: { id: model },
        language: { primary: 'en' },
        audio: { output: { voice_id: voiceId } },
        // Longer check-in than the default 8s: users pause to structure answers.
        turn: { inactivity_check_in_secs: 20, inactivity_end_call_secs: 240 },
        dynamic_variable_placeholders: {
          persona_instructions: `You are ${role.personaName}, ${role.title}. Play a demanding ${role.label.toLowerCase()} in a practice meeting. Keep turns short.`,
          opener: role.openers[0],
        },
      },
    };
  }

  // Returns the agent id for a role, creating (and caching) the agent if needed.
  async function agentFor(roleId) {
    const role = getRole(roleId);
    if (!role) throw new Error(`Unknown role "${roleId}"`);
    const override = env[`CARTESIA_AGENT_ID_${roleId.toUpperCase()}`];
    if (override) return override;
    if (inflight[roleId]) return inflight[roleId];
    inflight[roleId] = (async () => {
      const voiceId = await voiceFor(roleId);
      const sig = JSON.stringify({ v: TEMPLATE_VERSION, voiceId, model });
      if (cache[roleId]?.sig === sig && cache[roleId]?.id) return cache[roleId].id;
      const agent = await api('/v1/agents', { method: 'POST', body: JSON.stringify(agentConfig(role, voiceId)) });
      if (!agent.id) throw new Error('Cartesia did not return an agent id');
      cache = { ...readCache(), [roleId]: { id: agent.id, sig, voiceId, createdAt: new Date().toISOString() } };
      writeCache(cache);
      return agent.id;
    })();
    try { return await inflight[roleId]; } finally { delete inflight[roleId]; }
  }

  // Opens the upstream agent WebSocket (server-side, API key in header).
  function connect(agentId) {
    const url = `${wsBase}/v1/agents/websocket/${encodeURIComponent(agentId)}?cartesia_version=${CARTESIA_VERSION}`;
    return new WebSocket(url, { headers: { 'X-API-Key': apiKey } });
  }

  function sessionCreate({ instructions, opener }) {
    return {
      type: 'session_create',
      audio: { input_format: AUDIO_FORMAT, output_delivery: 'speaking_pace', continuous_input: true },
      dynamic_variables: { persona_instructions: instructions, opener },
    };
  }

  return { agentFor, voiceFor, connect, sessionCreate, model };
}

module.exports = { createCartesia, CARTESIA_VERSION, AUDIO_FORMAT, ROLE_VOICE_PREF };
