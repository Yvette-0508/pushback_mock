/* PushBack front-end: setup → meeting room → report.
 * Voice engines:
 *  - CartesiaEngine: Cartesia Managed Agent (Ink STT + hosted LLM + Sonic TTS) via the /ws/cartesia relay.
 *  - DemoEngine: browser SpeechRecognition + speechSynthesis + scripted persona (no API key needed).
 */
(() => {
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));
  const A = window.PushBackAnalyzer;
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const PROJECTS_KEY = 'pushback.projects';
  const loadLocalProjects = () => { try { return JSON.parse(localStorage.getItem(PROJECTS_KEY)) || []; } catch { return []; } };
  const saveLocalProjects = (list) => { try { localStorage.setItem(PROJECTS_KEY, JSON.stringify(list)); } catch {} };
  const state = {
    cfg: null, mode: 'practice', role: 'interviewer', pressure: 'medium', layout: localStorage.getItem('pushback.layout') || 'zoom',
    projects: [], activeProject: null,
    transcript: [], engine: null, startedAt: 0, timerId: null, muted: false, paused: false, report: null, latencies: [],
  };

  // ---------------- Setup screen ----------------
  async function init() {
    try {
      state.cfg = await (await fetch('/api/config')).json();
    } catch {
      return showBanner('Could not reach the PushBack server.');
    }
    const vp = state.cfg.voiceProvider;
    if (vp !== 'cartesia') {
      showBanner('Demo mode — no CARTESIA_API_KEY on the server. Voice uses browser speech with a scripted persona. Add a Cartesia key to .env for the real voice.');
    }
    $('#engineStat').textContent = vp === 'cartesia' ? 'Cartesia' : 'Demo voice';
    $('#modelPill').textContent = vp === 'cartesia' ? `cartesia · ${state.cfg.cartesiaModel}` : 'demo-voice';
    renderModes(); renderRoles(); renderPressure(); applyLayout();
    refreshProjects();
    const ctx = $('#context');
    ctx.addEventListener('input', updateEditor);
    ctx.addEventListener('scroll', () => { $('#gutter').scrollTop = ctx.scrollTop; });
    updateEditor();
    $$('#layoutSeg button').forEach((b) => b.addEventListener('click', () => { state.layout = b.dataset.layout; localStorage.setItem('pushback.layout', state.layout); applyLayout(); }));
    $('#joinBtn').addEventListener('click', joinMeeting);
    $('#againBtn').addEventListener('click', () => { state.report = null; $('[data-go="report"]').disabled = true; show('setup'); });
    $('#saveProjectBtn').addEventListener('click', saveCurrentProject);
    $('#downloadBtn').addEventListener('click', downloadReport);
    $('#clearBtn').addEventListener('click', () => {
      state.mode = 'practice'; state.role = 'interviewer'; state.pressure = 'medium';
      ctx.value = ''; updateEditor(); renderModes(); renderRoles(); renderPressure();
    });
    $('#announceClose').addEventListener('click', () => { $('#announce').classList.add('hidden'); document.body.classList.remove('has-strip'); });
    $('#navCollapse').addEventListener('click', () => document.body.classList.toggle('nav-collapsed'));
    $$('.nav-item[data-go]').forEach((n) => n.addEventListener('click', () => {
      if (n.disabled || $('#room').classList.contains('active')) return; // don't leave a live meeting via nav
      show(n.dataset.go);
    }));
    bindRoom();
  }
  function showBanner(t) { $('#banner').textContent = t; $('#announce').classList.remove('hidden'); document.body.classList.add('has-strip'); }
  function updateEditor() {
    if (state.activeProject) { state.activeProject = null; renderProjects(); }
    const v = $('#context').value;
    $('#ctxCount').textContent = `${v.length} / 6000`;
    $('#gutter').textContent = Array.from({ length: Math.max(1, v.split('\n').length) }, (_, i) => i + 1).join('\n');
  }
  function applyLayout() {
    document.body.classList.toggle('meet', state.layout === 'meet');
    $$('#layoutSeg button').forEach((b) => b.classList.toggle('on', b.dataset.layout === state.layout));
  }
  function renderModes() {
    if (state.activeProject) { state.activeProject = null; renderProjects(); }
    const ex = { practice: 'Pause anytime, see your answer as a structure tree.', formal: 'Like the real thing — one shot, scored at the end.' };
    $('#modeCards').innerHTML = state.cfg.modes.map((m) => `
      <button class="tcard ${m.id === state.mode ? 'selected' : ''}" data-mode="${m.id}">
        <span class="ttag">${esc(m.id)}</span>
        <div class="ttl">${esc(m.label)} mode</div>
        <div class="tdesc">${esc(m.desc)}</div>
        <div class="tex">${esc(ex[m.id] || '')}</div>
      </button>`).join('');
    $$('#modeCards .tcard').forEach((c) => c.addEventListener('click', () => { state.mode = c.dataset.mode; renderModes(); renderPreview(); }));
  }
  function renderRoles() {
    if (state.activeProject) { state.activeProject = null; renderProjects(); }
    $('#roleCards').innerHTML = state.cfg.roles.map((r) => `
      <button class="tcard ${r.id === state.role ? 'selected' : ''}" data-role="${r.id}">
        <span class="ttag">${esc(r.id)}</span>
        <div class="ttl">${esc(r.behavior[0])}</div>
        <div class="tex">${esc(r.personaName)}, ${esc(r.title)}</div>
      </button>`).join('');
    $$('#roleCards .tcard').forEach((c) => c.addEventListener('click', () => { state.role = c.dataset.role; renderRoles(); }));
    const role = currentRole();
    $('#contextLabel').innerHTML = `Paste the <b>${esc(role.contextLabel.toLowerCase())}</b> — the persona uses it as data to make questions specific.`;
    $('#context').placeholder = role.contextPlaceholder;
    renderPreview();
  }
  function renderPressure() {
    if (state.activeProject) { state.activeProject = null; renderProjects(); }
    $('#pressureSeg').innerHTML = state.cfg.pressure.map((p) => `<button data-p="${p.id}" class="${p.id === state.pressure ? 'on' : ''}" title="${esc(p.desc)}">${esc(p.label)}</button>`).join('');
    $$('#pressureSeg button').forEach((b) => b.addEventListener('click', () => { state.pressure = b.dataset.p; renderPressure(); }));
    const p = state.cfg.pressure.find((x) => x.id === state.pressure);
    $('#pressureDesc').textContent = p ? `${p.desc}${p.interruptAfterSec ? ` Cuts in after ~${p.interruptAfterSec}s of talking.` : ''}` : '';
    renderPreview();
  }

  function applyProject(p) {
    state.activeProject = p.id;
    state.mode = p.mode; state.role = p.role; state.pressure = p.pressure;
    $('#context').value = p.context || ''; updateEditor();
    renderModes(); renderRoles(); renderPressure(); renderProjects();
  }
  async function refreshProjects() {
    try {
      const r = await fetch('/api/projects');
      state.projects = r.ok ? await r.json() : loadLocalProjects();
    } catch {
      state.projects = loadLocalProjects();
    }
    saveLocalProjects(state.projects);
    renderProjects();
  }
  async function deleteProject(id) {
    state.projects = state.projects.filter((p) => String(p.id) !== String(id));
    if (String(state.activeProject) === String(id)) state.activeProject = null;
    saveLocalProjects(state.projects);
    renderProjects();
    try { await fetch(`/api/projects/${encodeURIComponent(id)}`, { method: 'DELETE' }); } catch {}
  }
  async function saveCurrentProject() {
    const role = currentRole(); if (!role) return;
    const name = prompt(`Save as project (role ${role.label}, ${state.mode}, ${state.pressure}) name:`, `${role.label} — ${new Date().toISOString().slice(0, 10)}`);
    if (!name) return;
    const trimmed = name.trim(); if (!trimmed) return;
    const payload = { name: trimmed.slice(0, 80), mode: state.mode, role: state.role, pressure: state.pressure, context: $('#context').value };
    try {
      const r = await fetch('/api/projects', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const saved = await r.json();
      state.projects = [saved, ...state.projects.filter((p) => p.name !== saved.name)];
      state.activeProject = saved.id;
    } catch {
      // Server unreachable — keep it in localStorage on this browser at least.
      const project = { id: 'p' + Date.now(), ...payload };
      state.projects = [project, ...state.projects.filter((p) => p.name !== trimmed)];
      state.activeProject = project.id;
      showBanner('Could not save the project to the server — keeping a copy in this browser instead.');
    }
    saveLocalProjects(state.projects);
    renderProjects();
  }
  function renderProjects() {
    const row = $('#projectsRow');
    if (!state.projects.length) {
      row.innerHTML = '<span class="muted small">No saved projects — pick a role, paste context, hit “Save current”.</span>';
      return;
    }
    row.innerHTML = state.projects.map((p) =>
      `<span class="proj-chip ${state.activeProject === p.id ? 'on' : ''}" data-id="${p.id}" data-name="${esc(p.name)}"><button class="m" data-open="${p.id}">${esc(p.name)}</button><button class="del" data-del="${p.id}" title="Delete">×</button></span>`,
    ).join('');
    row.querySelectorAll('[data-open]').forEach((b) => b.addEventListener('click', () => {
      const p = state.projects.find((x) => String(x.id) === b.dataset.open);
      if (p) applyProject(p);
    }));
    row.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', (e) => {
      e.stopPropagation();
      deleteProject(b.dataset.del);
    }));
  }

  // Right-hand preview panel: who you're about to meet and how you'll be scored.
  const CAP_ICONS = [
    '<svg viewBox="0 0 64 64" fill="none" stroke="currentColor" stroke-width="2"><rect x="10" y="8" width="44" height="48" rx="4"/><path d="M20 22h24M20 32h24M20 42h14"/></svg>',
    '<svg viewBox="0 0 64 64" fill="none" stroke="currentColor" stroke-width="2"><path d="M8 18V8h10M46 8h10v10M56 46v10H46M18 56H8V46"/><path d="m32 20 11 6v12l-11 6-11-6V26z"/><path d="m21 26 11 6 11-6M32 32v12"/></svg>',
    '<svg viewBox="0 0 64 64" fill="none" stroke="currentColor" stroke-width="2"><circle cx="32" cy="32" r="22"/><circle cx="32" cy="32" r="13"/><circle cx="32" cy="32" r="4"/></svg>',
  ];
  function renderPreview() {
    const role = currentRole(); if (!role) return;
    const p = state.cfg.pressure.find((x) => x.id === state.pressure);
    const mode = state.cfg.modes.find((m) => m.id === state.mode);
    $('#preview').innerHTML = `<div class="preview-inner">
      <div class="eyebrow">${esc(role.label)} · ${esc(mode?.label || '')} mode · ${esc(p?.label || '')} pressure</div>
      <h1 class="display">${esc(role.personaName)}</h1>
      <div class="display-sub">${esc(role.title)}</div>
      <div class="pink-card">
        <b>How ${esc(role.personaName.split(' ')[0])} will push back</b>
        ${role.behavior.map((b) => `<p>${esc(b)}</p>`).join('')}
        <a id="focusCtx">Add context for sharper questions</a>
      </div>
      <div class="cap-title">What you're scored on</div>
      <div class="cap-grid">${role.rubric.map((r, i) => `
        <div class="cap"><span class="cap-label">${esc(r.key.replace(/_/g, ' '))}</span>${CAP_ICONS[i % CAP_ICONS.length]}
          <div class="cap-name">${esc(r.label)}</div><div class="cap-desc">${esc(r.desc)}</div></div>`).join('')}
      </div>
      <div class="cap-title">Questions to expect</div>
      <div class="ex-list">
        <div class="ex"><b>Opener</b><span>${esc(role.openers[0])}</span></div>
        ${role.demoQuestions.slice(0, 3).map((q, i) => `<div class="ex"><b>Follow-up ${i + 1}</b><span>${esc(q)}</span></div>`).join('')}
      </div></div>`;
    $('#focusCtx').addEventListener('click', () => $('#context').focus());
  }
  const currentRole = () => state.cfg.roles.find((r) => r.id === state.role);
  const sessionConfig = () => ({ role: state.role, mode: state.mode, pressure: state.pressure, context: $('#context').value });
  const interruptAfterSec = () => (state.cfg.pressure.find((p) => p.id === state.pressure) || {}).interruptAfterSec || 0;
  function show(id) {
    $$('.screen').forEach((s) => s.classList.toggle('active', s.id === id));
    $$('.nav-item[data-go]').forEach((n) => n.classList.toggle('active', n.dataset.go === id));
    $('[data-go="room"]').disabled = id !== 'room';
    if (id === 'report' || state.report) $('[data-go="report"]').disabled = false;
    $('#sessionStat').textContent = id === 'room' ? `Live · ${currentRole().personaName}` : state.report ? `Last score ${state.report.overall}` : 'Not started';
  }

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
      if (state.cfg.voiceProvider === 'cartesia') {
        state.engine = new CartesiaEngine(sessionConfig(), role, handlers, interruptAfterSec());
        $('#engineBadge').textContent = `Cartesia · ${state.cfg.cartesiaModel}`;
      } else {
        state.engine = new DemoEngine(sessionConfig(), role, handlers, interruptAfterSec());
        $('#engineBadge').textContent = 'Demo voice';
      }
      // The Cartesia agent is voice-only (no text input event).
      $('#typeForm').classList.toggle('hidden', state.engine instanceof CartesiaEngine);
      await state.engine.start();
    } catch (err) {
      // Keep the reason visible: the fallback persona's opener overwrites the caption.
      showBanner(`Cartesia voice unavailable — ${err.message} Using browser speech + scripted persona instead.`);
      if (state.engine && !(state.engine instanceof DemoEngine)) {
        try { state.engine.stop(); } catch {}
        state.engine = new DemoEngine(sessionConfig(), role, handlers, interruptAfterSec());
        $('#engineBadge').textContent = 'Demo voice (fallback)';
        $('#typeForm').classList.remove('hidden');
        await state.engine.start();
      } else {
        handlers.onError(`Could not start voice: ${err.message} You can type your answers below.`);
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
      $('#sessionStat').textContent = `Last score ${state.report.overall}`;
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
    a.download = `pushback-report-${new Date().toISOString().slice(0, 19)}.json`;
    a.click();
  }

  // ---------------- Cartesia engine (Managed Agent via /ws/cartesia relay) ----------------
  // Mic → AudioWorklet (resample to 24 kHz, 16-bit PCM, 40 ms frames) → base64 audio_input.
  // audio_output (same format) is scheduled gaplessly through an AudioContext; audio_output_clear
  // (user barge-in) flushes it. Playback is routed through a MediaStream into <audio> so the
  // browser's echo canceller sees it.
  const CARTESIA_RATE = 24000;
  const CAPTURE_WORKLET = `
    class PcmCapture extends AudioWorkletProcessor {
      constructor() { super(); this.ratio = sampleRate / ${CARTESIA_RATE}; this.pos = 0; this.n = 0; this.out = new Int16Array(960); }
      process(inputs) {
        const ch = inputs[0] && inputs[0][0];
        if (!ch) return true;
        while (this.pos < ch.length) {
          const i = Math.floor(this.pos), f = this.pos - i, a = ch[i], b = i + 1 < ch.length ? ch[i + 1] : a;
          const v = Math.max(-1, Math.min(1, a + (b - a) * f));
          this.out[this.n++] = v < 0 ? v * 0x8000 : v * 0x7fff;
          if (this.n === this.out.length) { this.port.postMessage(this.out.buffer, [this.out.buffer]); this.out = new Int16Array(960); this.n = 0; }
          this.pos += this.ratio;
        }
        this.pos -= ch.length;
        return true;
      }
    }
    registerProcessor('pcm-capture', PcmCapture);`;
  const b64FromBytes = (u8) => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); };
  const bytesFromB64 = (b64) => { const s = atob(b64); const u8 = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u8[i] = s.charCodeAt(i); return u8; };

  class CartesiaEngine {
    constructor(config, role, h, interruptSec) {
      Object.assign(this, { config, role, h, interruptSec });
      this.sources = new Set(); this.playhead = 0; this.aiText = {}; this.ready = false; this.stopped = false;
    }
    async start() {
      // Create the AudioContext first, while we still have the click's user activation.
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
      this.ctx.resume().catch(() => {});
      this.out = this.ctx.createGain();
      this.sink = this.ctx.createMediaStreamDestination();
      this.out.connect(this.sink);
      const audio = $('#aiAudio'); audio.muted = false; audio.srcObject = this.sink.stream; audio.play().catch(() => {});

      this.mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } });
      const url = URL.createObjectURL(new Blob([CAPTURE_WORKLET], { type: 'application/javascript' }));
      await this.ctx.audioWorklet.addModule(url);
      URL.revokeObjectURL(url);
      this.capture = new AudioWorkletNode(this.ctx, 'pcm-capture');
      this.capture.port.onmessage = (e) => this.onMicFrame(e.data);
      const silent = this.ctx.createGain(); silent.gain.value = 0;
      this.ctx.createMediaStreamSource(this.mic).connect(this.capture);
      this.capture.connect(silent).connect(this.ctx.destination); // keeps the worklet pulled

      this.h.onStatus('(connecting to Cartesia…)');
      await new Promise((resolve, reject) => {
        const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/cartesia`);
        this.ws = ws;
        const timer = setTimeout(() => reject(new Error('Timed out connecting to Cartesia.')), 20000);
        ws.onopen = () => ws.send(JSON.stringify({ type: 'start', config: this.config }));
        ws.onmessage = (e) => {
          let ev; try { ev = JSON.parse(e.data); } catch { return; }
          if (!this.ready && ev.type === 'session_ready') { this.ready = true; clearTimeout(timer); resolve(); }
          if (!this.ready && (ev.type === 'proxy_error' || (ev.type === 'error' && ev.fatal))) { clearTimeout(timer); reject(new Error(ev.message || 'Cartesia error')); return; }
          this.onEvent(ev);
        };
        ws.onclose = (e) => {
          clearTimeout(timer);
          if (!this.ready) reject(new Error(`Cartesia connection closed (${e.code}${e.reason ? `: ${e.reason}` : ''}).`));
          else if (!this.stopped) { this.h.onError('Cartesia session ended. Click “End & get report” to see your report.'); this.h.onStatus('(disconnected)'); }
        };
        ws.onerror = () => {};
      });
      this.h.onStatus('');
    }
    onMicFrame(buf) {
      if (!this.ready || this.ws?.readyState !== 1) return;
      // Muted/paused mic tracks deliver silence; we still send it (continuous_input keeps the session alive).
      this.ws.send(JSON.stringify({ type: 'audio_input', audio: b64FromBytes(new Uint8Array(buf)) }));
    }
    onEvent(ev) {
      switch (ev.type) {
        case 'audio_output': this.play(ev.audio); break;
        case 'audio_output_clear': this.flush(); break;
        case 'turn_started': {
          const id = `cx-${ev.role}-${ev.turn}`;
          if (ev.role === 'user') { this.userSpeaking = true; this.h.onUserSpeaking(true); this.h.onMessage({ id, role: 'user' }); this.h.onCaption('You', '…'); }
          else { this.aiText[ev.turn] = ''; }
          break;
        }
        case 'turn_output_text_delta': {
          if (ev.role === 'user') break;
          this.aiText[ev.turn] = (this.aiText[ev.turn] || '') + (ev.text || '');
          this.h.onMessage({ id: `cx-assistant-${ev.turn}`, role: 'assistant', text: this.aiText[ev.turn] });
          this.h.onCaption(this.role.personaName, this.aiText[ev.turn]);
          break;
        }
        case 'turn_ended': {
          const id = `cx-${ev.role}-${ev.turn}`;
          const text = (ev.text || '').trim();
          if (ev.role === 'user') {
            this.userSpeaking = false; this.h.onUserSpeaking(false);
            this.h.onMessage({ id, role: 'user', text });
            if (text) { this.h.onCaption('You', text); this.h.onUserTurnFinal(text); this.stopAt = performance.now(); }
          } else {
            this.h.onMessage({ id, role: 'assistant', text: text || this.aiText[ev.turn] || '' });
          }
          break;
        }
        case 'error':
          this.h.onError(ev.message || 'Cartesia error');
          break;
        case 'proxy_error':
          this.h.onError(ev.message);
          break;
      }
    }
    play(b64) {
      if (this.paused) return;
      const u8 = bytesFromB64(b64);
      const pcm = new Int16Array(u8.buffer, 0, u8.length >> 1);
      if (!pcm.length) return;
      const buf = this.ctx.createBuffer(1, pcm.length, CARTESIA_RATE);
      const ch = buf.getChannelData(0);
      for (let i = 0; i < pcm.length; i++) ch[i] = pcm[i] / 0x8000;
      const src = this.ctx.createBufferSource();
      src.buffer = buf; src.connect(this.out);
      const t = Math.max(this.ctx.currentTime + 0.04, this.playhead);
      src.start(t);
      this.playhead = t + buf.duration;
      this.sources.add(src);
      if (this.stopAt) { this.h.onLatency(performance.now() - this.stopAt); this.stopAt = 0; }
      if (!this.aiSpeaking) { this.aiSpeaking = true; this.h.onAiSpeaking(true); }
      src.onended = () => {
        this.sources.delete(src);
        if (!this.sources.size) { this.aiSpeaking = false; this.h.onAiSpeaking(false); }
      };
    }
    flush() {
      this.sources.forEach((s) => { try { s.onended = null; s.stop(); } catch {} });
      this.sources.clear(); this.playhead = 0;
      if (this.aiSpeaking) { this.aiSpeaking = false; this.h.onAiSpeaking(false); }
    }
    sendText() { this.h.onError('Typing isn’t supported with the Cartesia voice agent — just speak.'); }
    setMuted(m) { this.mic?.getAudioTracks().forEach((t) => { t.enabled = !m && !this.paused; }); }
    setPaused(p) {
      this.paused = p;
      this.mic?.getAudioTracks().forEach((t) => { t.enabled = !p && !state.muted; });
      if (p) this.flush();
      if (this.out) this.out.gain.value = p ? 0 : 1;
    }
    stop() {
      this.stopped = true;
      try { this.ws?.close(1000, 'session ended'); } catch {}
      this.flush();
      this.mic?.getTracks().forEach((t) => t.stop());
      try { this.capture?.disconnect(); } catch {}
      this.ctx?.close().catch(() => {});
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
