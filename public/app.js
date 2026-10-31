/* MeetSim front-end: setup → meeting room → report.
 * Two voice engines:
 *  - RealtimeEngine: OpenAI Realtime API over WebRTC (ephemeral key from /api/realtime/session).
 *  - DemoEngine: browser SpeechRecognition + speechSynthesis + scripted persona (no API key needed).
 */
(() => {
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));
  const A = window.MeetSimAnalyzer;
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const state = {
    cfg: null, mode: 'practice', role: 'interviewer', pressure: 'medium', layout: localStorage.getItem('meetsim.layout') || 'zoom',
    transcript: [], engine: null, startedAt: 0, timerId: null, muted: false, paused: false, report: null, latencies: [],
  };

  // ---------------- Setup screen ----------------
  async function init() {
    try {
      state.cfg = await (await fetch('/api/config')).json();
    } catch {
      return showBanner('Could not reach the MeetSim server.');
    }
    if (!state.cfg.realtimeAvailable) {
      showBanner('Demo mode: no OPENAI_API_KEY on the server. Voice uses your browser\'s speech recognition/synthesis with a scripted persona; reports use the local heuristic analyzer. Add a key to .env for the full realtime experience.');
    }
    renderModes(); renderRoles(); renderPressure(); applyLayout();
    $('#context').addEventListener('input', (e) => { $('#ctxCount').textContent = `${e.target.value.length} / 6000`; });
    $$('#layoutSeg button').forEach((b) => b.addEventListener('click', () => { state.layout = b.dataset.layout; localStorage.setItem('meetsim.layout', state.layout); applyLayout(); }));
    $('#joinBtn').addEventListener('click', joinMeeting);
    $('#againBtn').addEventListener('click', () => { state.report = null; show('setup'); });
    $('#downloadBtn').addEventListener('click', downloadReport);
    bindRoom();
  }
  function showBanner(t) { const b = $('#banner'); b.textContent = t; b.classList.remove('hidden'); }
  function applyLayout() {
    document.body.classList.toggle('meet', state.layout === 'meet');
    $$('#layoutSeg button').forEach((b) => b.classList.toggle('on', b.dataset.layout === state.layout));
  }
  function renderModes() {
    $('#modeCards').innerHTML = state.cfg.modes.map((m) => `
      <button class="card ${m.id === state.mode ? 'selected' : ''}" data-mode="${m.id}">
        <h3>${m.id === 'practice' ? '🧭' : '🎯'} ${esc(m.label)} Mode</h3><p>${esc(m.desc)}</p>
      </button>`).join('');
    $$('#modeCards .card').forEach((c) => c.addEventListener('click', () => { state.mode = c.dataset.mode; renderModes(); }));
  }
  function renderRoles() {
    $('#roleCards').innerHTML = state.cfg.roles.map((r) => `
      <button class="card ${r.id === state.role ? 'selected' : ''}" data-role="${r.id}">
        <h3>${esc(r.label)}</h3>
        <p>${esc(r.behavior[0])}</p>
        <div class="persona">${esc(r.personaName)} · ${esc(r.title)}</div>
        <div class="chips">${r.rubric.map((x) => `<span class="chip">${esc(x.label)}</span>`).join('')}</div>
      </button>`).join('');
    $$('#roleCards .card').forEach((c) => c.addEventListener('click', () => { state.role = c.dataset.role; renderRoles(); }));
    const role = currentRole();
    $('#contextLabel').textContent = role.contextLabel;
    $('#context').placeholder = role.contextPlaceholder;
  }
  function renderPressure() {
    $('#pressureSeg').innerHTML = state.cfg.pressure.map((p) => `<button data-p="${p.id}" class="${p.id === state.pressure ? 'on' : ''}" title="${esc(p.desc)}">${esc(p.label)}</button>`).join('');
    $$('#pressureSeg button').forEach((b) => b.addEventListener('click', () => { state.pressure = b.dataset.p; renderPressure(); }));
  }
  const currentRole = () => state.cfg.roles.find((r) => r.id === state.role);
  const sessionConfig = () => ({ role: state.role, mode: state.mode, pressure: state.pressure, context: $('#context').value });
  const interruptAfterSec = () => (state.cfg.pressure.find((p) => p.id === state.pressure) || {}).interruptAfterSec || 0;
  function show(id) { $$('.screen').forEach((s) => s.classList.toggle('active', s.id === id)); }

  // ---------------- Room ----------------
  function bindRoom() {
    $('#muteBtn').addEventListener('click', () => setMuted(!state.muted));
    $('#pauseBtn').addEventListener('click', () => setPaused(true));
    $('#resumeBtn').addEventListener('click', () => setPaused(false));
    $('#betterBtn').addEventListener('click', betterPhrasing);
    $('#chatBtn').addEventListener('click', () => $('#sidebar').classList.toggle('collapsed'));
    $('#leaveBtn').addEventListener('click', endSession);
    $$('.tab').forEach((t) => t.addEventListener('click', () => selectTab(t.dataset.tab)));
    $('#typeForm').addEventListener('submit', (e) => {
      e.preventDefault();
      const v = $('#typeInput').value.trim();
      if (!v || !state.engine) return;
      $('#typeInput').value = '';
      state.engine.sendText(v);
    });
    document.addEventListener('keydown', (e) => {
      if (!$('#room').classList.contains('active') || e.target.tagName === 'INPUT') return;
      if (e.key === 'm' && (e.metaKey || e.ctrlKey || e.altKey)) { e.preventDefault(); setMuted(!state.muted); }
    });
  }
  function selectTab(name) {
    $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
    $$('.tab-panel').forEach((p) => p.classList.toggle('active', p.id === `tab-${name}`));
  }

  async function joinMeeting() {
    const role = currentRole();
    state.transcript = []; state.latencies = []; state.muted = false; state.paused = false;
    document.body.classList.toggle('formal', state.mode === 'formal');
    $('#roomTitle').textContent = `${role.label} meeting`;
    $('#modeBadge').textContent = state.mode === 'formal' ? 'Formal' : 'Practice';
    $('#aiAvatar').textContent = role.personaName.split(' ').map((w) => w[0]).join('');
    $('#aiName').textContent = role.personaName;
    $('#aiTitle').textContent = role.title;
    $('#transcript').innerHTML = ''; $('#caption').innerHTML = ''; $('#latency').textContent = '';
    $('#hints').innerHTML = '<p class="muted small">Hints appear after each answer.</p>';
    $('#liveTree').innerHTML = '<p class="muted small">—</p>';
    $('#better').innerHTML = '<p class="muted small">Click “Better phrasing” in the toolbar.</p>';
    selectTab('chat'); setMuted(false);
    show('room');

    const handlers = {
      onUserSpeaking: (on) => $('#userTile').classList.toggle('speaking', on),
      onAiSpeaking: (on) => $('#aiTile').classList.toggle('speaking', on),
      onCaption: (who, text) => { $('#caption').innerHTML = text ? `<span class="who">${esc(who)}</span>${esc(text)}` : ''; },
      onMessage: upsertMessage,
      onUserTurnFinal: handleUserTurnFinal,
      onLatency: (ms) => { state.latencies.push(ms); $('#latency').textContent = `AI response ${Math.round(ms)} ms`; },
      onStatus: (t) => { $('#micState').textContent = t; },
      onError: (msg) => { $('#caption').innerHTML = `<span class="who">⚠</span>${esc(msg)}`; },
    };

    const joinBtn = $('#joinBtn'); joinBtn.disabled = true;
    try {
      if (state.cfg.realtimeAvailable) {
        state.engine = new RealtimeEngine(sessionConfig(), role, handlers, interruptAfterSec());
        $('#engineBadge').textContent = `Realtime · ${state.cfg.realtimeModel}`;
      } else {
        state.engine = new DemoEngine(sessionConfig(), role, handlers, interruptAfterSec());
        $('#engineBadge').textContent = 'Demo voice';
      }
      $('#typeForm').classList.remove('hidden');
      await state.engine.start();
    } catch (err) {
      handlers.onError(`Could not start voice: ${err.message}. You can type your answers below.`);
      if (state.engine && !(state.engine instanceof DemoEngine)) {
        try { state.engine.stop(); } catch {}
        state.engine = new DemoEngine(sessionConfig(), role, handlers, interruptAfterSec(), { noMic: true });
        $('#engineBadge').textContent = 'Text fallback';
        await state.engine.start();
      }
    } finally { joinBtn.disabled = false; }

    state.startedAt = Date.now();
    clearInterval(state.timerId);
    state.timerId = setInterval(() => {
      const s = Math.floor((Date.now() - state.startedAt) / 1000);
      $('#timer').textContent = `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
    }, 500);
  }

  // Transcript messages keyed by id so streaming updates replace in place.
  function upsertMessage(msg) {
    let m = state.transcript.find((x) => x.id === msg.id);
    if (!m) { m = { id: msg.id, role: msg.role, text: '', t: Date.now() - state.startedAt, interrupted: false }; state.transcript.push(m); }
    if (msg.text !== undefined) m.text = msg.text;
    if (msg.interrupted) m.interrupted = true;
    renderTranscript();
    return m;
  }
  function renderTranscript() {
    const role = currentRole();
    const el = $('#transcript');
    el.innerHTML = state.transcript.filter((m) => m.text).map((m) => `
      <div class="msg ${m.role}"><div class="who">${m.role === 'user' ? 'You' : esc(role.personaName)}${m.interrupted ? '<span class="tag">interrupted you</span>' : ''}</div>
      <div class="bubble">${esc(m.text)}</div></div>`).join('');
    el.scrollTop = el.scrollHeight;
  }

  function handleUserTurnFinal(text) {
    if (state.mode !== 'practice' || !text || !text.trim()) return;
    const { analysis, hints } = A.hintsForTurn(text, state.role);
    $('#hints').innerHTML = hints.map((h) => `<div class="hint ${h.level}">${esc(h.text)}</div>`).join('');
    $('#liveTree').innerHTML = treeHtml({ conclusion: analysis.tree.conclusion, points: analysis.tree.points, missing: !analysis.conclusionFirst });
  }

  function treeHtml({ conclusion, points, missing }) {
    return `<div class="node concl ${missing ? 'missing' : ''}">${missing ? '⚠ ' : '◆ '}${esc(conclusion || '(no conclusion)')}</div>
      <div class="children">${(points || []).map((p) => `<div class="node">${esc(p.text)}<span class="ev ${p.hasEvidence ? 'yes' : 'no'}">${p.hasEvidence ? '● evidence' : '○ no evidence'}</span></div>`).join('') || '<p class="muted small">No supporting points.</p>'}</div>`;
  }

  async function betterPhrasing() {
    const lastUser = [...state.transcript].reverse().find((m) => m.role === 'user' && m.text.trim());
    selectTab('coach');
    if (!lastUser) { $('#better').innerHTML = '<p class="muted small">Answer a question first.</p>'; return; }
    const idx = state.transcript.indexOf(lastUser);
    const q = [...state.transcript.slice(0, idx)].reverse().find((m) => m.role === 'assistant');
    $('#better').innerHTML = '<p class="muted small">Rewriting…</p>';
    try {
      const r = await (await fetch('/api/rephrase', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: lastUser.text, question: q?.text || '', role: state.role }) })).json();
      $('#better').innerHTML = `${esc(r.better)}${r.why ? `<p class="muted small">${esc(r.why)}</p>` : ''}`;
    } catch (e) { $('#better').textContent = 'Rewrite failed: ' + e.message; }
  }

  function setMuted(m) {
    state.muted = m;
    const b = $('#muteBtn'); b.classList.toggle('off', m);
    b.querySelector('.ico').textContent = m ? '🔇' : '🎙';
    b.querySelector('span:last-child').textContent = m ? 'Unmute' : 'Mute';
    $('#micState').textContent = m ? '(muted)' : '';
    state.engine?.setMuted(m);
  }
  function setPaused(p) {
    state.paused = p;
    $('#pausedOverlay').classList.toggle('hidden', !p);
    state.engine?.setPaused(p);
  }

  async function endSession() {
    clearInterval(state.timerId);
    try { state.engine?.stop(); } catch {}
    state.engine = null;
    $('#pausedOverlay').classList.add('hidden');
    show('report');
    $('#reportBody').innerHTML = '<div class="loading"><div class="spinner"></div><p>Analyzing your session…</p></div>';
    const transcript = state.transcript.filter((m) => m.text && m.text.trim()).map(({ role, text, t, interrupted }) => ({ role, text, t, interrupted }));
    try {
      const res = await fetch('/api/evaluate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ config: sessionConfig(), transcript }) });
      const report = await res.json();
      if (!res.ok) throw new Error(report.error || res.statusText);
      state.report = { ...report, transcript, config: sessionConfig(), durationSec: Math.round((Date.now() - state.startedAt) / 1000), latencies: state.latencies };
      renderReport(state.report);
    } catch (e) {
      $('#reportBody').innerHTML = `<div class="r-card">Report failed: ${esc(e.message)}</div>`;
    }
  }

  // ---------------- Report ----------------
  function ring(v, label, big) {
    const c = v >= 75 ? 'var(--good)' : v >= 50 ? 'var(--warn)' : 'var(--bad)';
    return `<div class="score ${big ? 'overall' : ''}"><div class="ring" style="--p:${v};--c:${c}"><div>${v}</div></div><div class="l">${esc(label)}</div></div>`;
  }
  function renderReport(r) {
    const role = state.cfg.roles.find((x) => x.id === r.config.role);
    const pct = (arr, p) => { if (!arr.length) return null; const s = [...arr].sort((a, b) => a - b); return Math.round(s[Math.min(s.length - 1, Math.floor(p * s.length))]); };
    const p50 = pct(r.latencies, 0.5), p95 = pct(r.latencies, 0.95);
    $('#reportBody').innerHTML = `
      ${r.warning ? `<div class="banner">${esc(r.warning)}</div>` : ''}
      <p class="muted">${esc(role.label)} · ${r.config.mode === 'formal' ? 'Formal' : 'Practice'} mode · ${Math.floor(r.durationSec / 60)}m ${r.durationSec % 60}s
        · ${r.source === 'llm' ? `evaluated by ${esc(r.model)}` : 'heuristic evaluation'}${p50 !== null ? ` · latency p50 ${p50} ms / p95 ${p95} ms` : ''}</p>

      <div class="r-card"><h2><span class="n">1</span> Overall score</h2>
        <div class="scores">${ring(r.overall, 'Overall', true)}${ring(r.scores.structured, 'Structured Expression')}${ring(r.scores.persuasion, 'Persuasion')}${ring(r.scores.composure, 'Composure')}</div>
        <p>${esc(r.summary)}</p>
        ${(r.rubric || []).map((x) => `<div class="rubric-row"><div class="row"><span>${esc(x.label)}</span><b>${x.score}</b></div><div class="bar"><i style="width:${x.score}%"></i></div><div class="muted small">${esc(x.comment)}</div></div>`).join('')}
      </div>

      <div class="r-card"><h2><span class="n">2</span> Structure map of key answers</h2>
        ${(r.structureMap || []).length ? r.structureMap.map((s) => `<div class="smap">${s.question ? `<div class="q">Q: ${esc(s.question)}</div>` : ''}<div class="tree">${treeHtml({ conclusion: s.conclusion, points: s.points, missing: (s.issues || []).length > 0 })}</div>${(s.issues || []).length ? `<div class="issues">${s.issues.map(esc).join(' · ')}</div>` : ''}</div>`).join('') : '<p class="muted">No answers to map.</p>'}
      </div>

      <div class="r-card"><h2><span class="n">3</span> Moments of strength</h2>
        ${(r.strengths || []).length ? r.strengths.map((s) => `<div class="item"><blockquote class="quote">“${esc(s.quote)}”</blockquote><div class="why">${esc(s.why)}</div></div>`).join('') : '<p class="muted">None identified this time.</p>'}
      </div>

      <div class="r-card"><h2><span class="n">4</span> Moments of breakdown</h2>
        ${(r.breakdowns || []).length ? r.breakdowns.map((s) => `<div class="item"><blockquote class="quote bad">“${esc(s.quote)}”</blockquote><div class="why">${esc(s.issue)}</div>${s.better ? `<div class="better-box"><b>BETTER VERSION</b>${esc(s.better)}</div>` : ''}</div>`).join('') : '<p class="muted">No major breakdowns.</p>'}
      </div>

      <div class="r-card"><h2><span class="n">5</span> Interruption recovery</h2>
        <p>${esc(r.interruptionRecovery?.analysis || '')}</p>
        ${(r.interruptionRecovery?.moments || []).map((m) => `<div class="item"><blockquote class="quote ${m.recovered ? '' : 'bad'}">“${esc(m.quote)}”</blockquote><div class="why">${m.recovered ? '✓ Re-anchored the main point' : '✗ Did not re-anchor'}</div></div>`).join('')}
      </div>

      <div class="r-card"><h2><span class="n">6</span> ${esc(role.label)}-specific insights</h2>
        <ul class="ins">${(r.roleInsights || []).map((x) => `<li>${esc(x)}</li>`).join('')}</ul>
      </div>

      <div class="r-card action"><h2><span class="n">7</span> Your #1 improvement action</h2>${esc(r.topAction)}</div>

      <div class="r-card"><h2>Transcript</h2>
        ${r.transcript.map((m) => `<div class="msg ${m.role}"><div class="who">${m.role === 'user' ? 'You' : esc(role.personaName)}${m.interrupted ? '<span class="tag">interrupted you</span>' : ''}</div><div class="bubble">${esc(m.text)}</div></div>`).join('') || '<p class="muted">Empty.</p>'}
      </div>`;
  }
  function downloadReport() {
    if (!state.report) return;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(state.report, null, 2)], { type: 'application/json' }));
    a.download = `meetsim-report-${new Date().toISOString().slice(0, 19)}.json`;
    a.click();
  }

  // ---------------- Realtime engine (OpenAI WebRTC) ----------------
  class RealtimeEngine {
    constructor(config, role, h, interruptSec) { Object.assign(this, { config, role, h, interruptSec }); this.aiItems = {}; }
    async start() {
      const tok = await fetch('/api/realtime/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(this.config) });
      const data = await tok.json();
      if (!tok.ok) throw new Error(data.error || 'session failed');

      this.pc = new RTCPeerConnection();
      const audio = $('#aiAudio');
      this.pc.ontrack = (e) => { audio.srcObject = e.streams[0]; };
      this.mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      this.mic.getTracks().forEach((t) => this.pc.addTrack(t, this.mic));
      this.dc = this.pc.createDataChannel('oai-events');
      this.dc.onmessage = (e) => this.onEvent(JSON.parse(e.data));
      this.dc.onopen = () => this.send({ type: 'response.create' }); // AI opens the meeting

      const offer = await this.pc.createOffer();
      await this.pc.setLocalDescription(offer);
      const sdp = await fetch('https://api.openai.com/v1/realtime/calls', {
        method: 'POST', body: offer.sdp, headers: { Authorization: `Bearer ${data.clientSecret}`, 'Content-Type': 'application/sdp' },
      });
      if (!sdp.ok) throw new Error(`WebRTC negotiation failed (${sdp.status})`);
      await this.pc.setRemoteDescription({ type: 'answer', sdp: await sdp.text() });
      this.h.onStatus('');
    }
    send(ev) { if (this.dc?.readyState === 'open') this.dc.send(JSON.stringify(ev)); }
    onEvent(ev) {
      switch (ev.type) {
        case 'input_audio_buffer.speech_started':
          this.userSpeaking = true; this.h.onUserSpeaking(true);
          this.h.onMessage({ id: ev.item_id, role: 'user' });
          this.armInterrupt();
          break;
        case 'input_audio_buffer.speech_stopped':
          this.userSpeaking = false; this.h.onUserSpeaking(false); this.disarmInterrupt();
          this.stopAt = performance.now();
          break;
        case 'conversation.item.input_audio_transcription.delta': {
          const m = this.h.onMessage({ id: ev.item_id, role: 'user' });
          this.h.onMessage({ id: ev.item_id, text: (m.text || '') + (ev.delta || '') });
          this.h.onCaption('You', m.text);
          break;
        }
        case 'conversation.item.input_audio_transcription.completed':
          this.h.onMessage({ id: ev.item_id, role: 'user', text: (ev.transcript || '').trim() });
          this.h.onUserTurnFinal((ev.transcript || '').trim());
          break;
        case 'output_audio_buffer.started':
          this.aiSpeaking = true; this.h.onAiSpeaking(true); this.markLatency();
          break;
        case 'output_audio_buffer.stopped':
        case 'output_audio_buffer.cleared':
          this.aiSpeaking = false; this.h.onAiSpeaking(false);
          break;
        case 'response.output_audio_transcript.delta':
        case 'response.audio_transcript.delta': {
          this.markLatency();
          const id = ev.item_id;
          this.aiItems[id] = (this.aiItems[id] || '') + ev.delta;
          this.h.onMessage({ id, role: 'assistant', text: this.aiItems[id], interrupted: this.pendingInterrupt });
          this.h.onCaption(this.role.personaName, this.aiItems[id]);
          break;
        }
        case 'response.output_audio_transcript.done':
        case 'response.audio_transcript.done':
          this.h.onMessage({ id: ev.item_id, role: 'assistant', text: ev.transcript || this.aiItems[ev.item_id] });
          this.pendingInterrupt = false;
          break;
        case 'error':
          this.h.onError(ev.error?.message || 'Realtime error');
          break;
      }
    }
    markLatency() { if (this.stopAt) { this.h.onLatency(performance.now() - this.stopAt); this.stopAt = 0; } }
    // AI interrupts the user if they talk past the pressure threshold.
    armInterrupt() {
      this.disarmInterrupt();
      if (!this.interruptSec || this.paused) return;
      this.intTimer = setTimeout(() => {
        if (!this.userSpeaking || this.aiSpeaking) return;
        this.pendingInterrupt = true;
        this.send({ type: 'response.create', response: { instructions: 'The user has been talking for a long time. Interrupt them NOW, naturally and briefly (e.g., "Sorry to cut in —"), and ask for their bottom line or challenge the weakest part of what they just said. One sentence.' } });
      }, this.interruptSec * 1000);
    }
    disarmInterrupt() { clearTimeout(this.intTimer); }
    sendText(text) {
      const id = 'typed-' + Date.now();
      this.h.onMessage({ id, role: 'user', text });
      this.h.onUserTurnFinal(text);
      this.send({ type: 'conversation.item.create', item: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } });
      this.stopAt = performance.now();
      this.send({ type: 'response.create' });
    }
    setMuted(m) { this.mic?.getAudioTracks().forEach((t) => { t.enabled = !m && !this.paused; }); }
    setPaused(p) {
      this.paused = p;
      this.mic?.getAudioTracks().forEach((t) => { t.enabled = !p && !state.muted; });
      const audio = $('#aiAudio');
      if (p) { this.send({ type: 'response.cancel' }); this.send({ type: 'output_audio_buffer.clear' }); audio.muted = true; this.disarmInterrupt(); }
      else audio.muted = false;
    }
    stop() {
      this.disarmInterrupt();
      try { this.dc?.close(); } catch {}
      try { this.pc?.close(); } catch {}
      this.mic?.getTracks().forEach((t) => t.stop());
      $('#aiAudio').srcObject = null;
      this.h.onAiSpeaking(false); this.h.onUserSpeaking(false);
    }
  }

  // ---------------- Demo engine (no API key) ----------------
  class DemoEngine {
    constructor(config, role, h, interruptSec, opts = {}) {
      Object.assign(this, { config, role, h, interruptSec, opts });
      this.qIndex = 0; this.turn = 0; this.buffer = ''; this.stopped = false;
      const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
      this.SR = opts.noMic ? null : SR;
    }
    async start() {
      if (!this.SR) this.h.onStatus('(type below — speech recognition unavailable)');
      await this.say(this.role.openers[0]);
      this.listen();
    }
    listen() {
      if (!this.SR || this.stopped) return;
      const rec = new this.SR();
      rec.continuous = true; rec.interimResults = true; rec.lang = navigator.language || 'en-US';
      rec.onresult = (e) => {
        if (this.speaking || state.paused) return;
        let interim = '';
        for (let i = e.resultIndex; i < e.results.length; i++) {
          const r = e.results[i];
          if (r.isFinal) this.buffer += ' ' + r[0].transcript; else interim += r[0].transcript;
        }
        const live = (this.buffer + ' ' + interim).trim();
        if (!live) return;
        if (!this.turnStart) { this.turnStart = performance.now(); this.h.onUserSpeaking(true); this.armInterrupt(); }
        this.h.onMessage({ id: this.userId(), role: 'user', text: live });
        this.h.onCaption('You', live);
        clearTimeout(this.silenceTimer);
        this.silenceTimer = setTimeout(() => this.finishUserTurn(), 1400);
      };
      rec.onerror = (e) => { if (e.error === 'not-allowed') { this.h.onError('Microphone blocked — type your answers below.'); this.SR = null; } };
      rec.onend = () => { if (!this.stopped && this.SR) setTimeout(() => { try { rec.start(); } catch {} }, 150); };
      try { rec.start(); } catch {}
      this.rec = rec;
    }
    userId() { return `demo-user-${this.turn}`; }
    armInterrupt() {
      clearTimeout(this.intTimer);
      if (!this.interruptSec) return;
      this.intTimer = setTimeout(() => {
        if (!this.turnStart || this.speaking) return;
        this.finishUserTurn(true);
      }, this.interruptSec * 1000);
    }
    finishUserTurn(interrupt = false) {
      clearTimeout(this.silenceTimer); clearTimeout(this.intTimer);
      const text = state.transcript.find((m) => m.id === this.userId())?.text?.trim() || '';
      this.buffer = ''; this.turnStart = 0; this.h.onUserSpeaking(false);
      if (!text) return;
      this.turn++;
      this.h.onUserTurnFinal(text);
      this.respond(text, interrupt);
    }
    sendText(text) {
      clearTimeout(this.silenceTimer); clearTimeout(this.intTimer);
      this.buffer = ''; this.turnStart = 0;
      this.h.onMessage({ id: this.userId(), role: 'user', text });
      this.finishUserTurn();
    }
    // Scripted persona: chooses a follow-up that targets the weakest part of the answer.
    pickReply(text, interrupt) {
      const a = A.analyzeTurn(text);
      if (interrupt) return 'Sorry to cut in — what\'s the bottom line here?';
      if (state.pressure === 'high' && this.turn % 3 === 0) return '…Okay.';
      if (a.wordCount < 8) return 'Can you say more? That was pretty thin.';
      if (this.role.id === 'investor' && a.numbers === 0) return 'I didn\'t hear a single number. What are the actual metrics?';
      if (this.role.id === 'interviewer' && !a.star.result) return 'And what was the result? How did you measure it?';
      if (this.role.id === 'interviewer' && a.ownership === 'team') return 'You keep saying "we". What did YOU do specifically?';
      if (this.role.id === 'coworker' && !a.pis.solution) return 'Okay, so what exactly are you asking me to do?';
      if (this.role.id === 'boss' && a.valueWords === 0) return 'What\'s in it for the business, though?';
      if (!a.conclusionFirst) return 'I\'m not sure what your point is. Give me the one-sentence answer.';
      const q = this.role.demoQuestions[this.qIndex % this.role.demoQuestions.length];
      this.qIndex++;
      return q;
    }
    async respond(text, interrupt) {
      const thinkMs = 350 + Math.random() * 300;
      const t0 = performance.now();
      await new Promise((r) => setTimeout(r, thinkMs));
      if (this.stopped) return;
      this.h.onLatency(performance.now() - t0);
      await this.say(this.pickReply(text, interrupt), interrupt);
    }
    say(text, interrupted = false) {
      const id = `demo-ai-${Date.now()}`;
      this.h.onMessage({ id, role: 'assistant', text, interrupted });
      this.h.onCaption(this.role.personaName, text);
      return new Promise((resolve) => {
        if (!('speechSynthesis' in window) || this.stopped) return resolve();
        speechSynthesis.cancel();
        const u = new SpeechSynthesisUtterance(text);
        u.rate = 1.05;
        this.speaking = true; this.h.onAiSpeaking(true);
        const done = () => { this.speaking = false; this.h.onAiSpeaking(false); this.buffer = ''; resolve(); };
        u.onend = done; u.onerror = done;
        speechSynthesis.speak(u);
        setTimeout(() => { if (this.speaking) done(); }, 15000);
      });
    }
    setMuted(m) {
      this.muted = m;
      if (!this.rec) return;
      if (m) { this.SRsaved = this.SR; this.SR = null; try { this.rec.stop(); } catch {} }
      else if (this.SRsaved) { this.SR = this.SRsaved; this.listen(); }
    }
    setPaused(p) { if (p) { speechSynthesis?.cancel(); clearTimeout(this.intTimer); clearTimeout(this.silenceTimer); } }
    stop() {
      this.stopped = true; this.SR = null;
      clearTimeout(this.intTimer); clearTimeout(this.silenceTimer);
      try { this.rec?.stop(); } catch {}
      if ('speechSynthesis' in window) speechSynthesis.cancel();
      this.h.onAiSpeaking(false); this.h.onUserSpeaking(false);
    }
  }

  init();
})();
