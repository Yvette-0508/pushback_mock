// Heuristic structured-expression analyzer.
// Used for (a) live Practice-Mode hints in the browser and (b) the offline
// fallback report when no LLM key is configured. UMD: works in Node + browser.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MeetSimAnalyzer = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const FILLERS = ['um', 'uh', 'like', 'you know', 'kind of', 'sort of', 'basically', 'actually', 'i mean', 'literally'];
  const HEDGES = ['i think', 'i guess', 'maybe', 'probably', 'i feel like', 'hopefully', 'not sure'];
  const CONCLUSION_MARKERS = ['the bottom line', 'in short', 'my answer is', 'the answer is', 'the key', 'the main', 'my recommendation', 'i recommend', 'we should', 'the short answer', 'in summary', 'to summarize', 'the point is', 'my point is', 'yes', 'no', 'simply put', 'the headline'];
  const SIGNPOSTS = ['first', 'second', 'third', 'finally', 'firstly', 'secondly', 'lastly', 'two reasons', 'three reasons', 'two things', 'three things', 'one ', 'another', 'next', 'then'];
  const EVIDENCE = ['for example', 'for instance', 'because', 'data', 'measured', 'percent', '%', 'grew', 'reduced', 'increased', 'decreased', 'users', 'customers', 'revenue', '$', 'k ', 'million', 'result'];
  const STAR = {
    situation: ['when i was', 'at my', 'our team', 'the situation', 'we had', 'there was', 'back in', 'at the time', 'context'],
    task: ['my goal', 'i was responsible', 'i needed to', 'my job', 'the task', 'my role', 'i owned', 'tasked'],
    action: ['i built', 'i led', 'i designed', 'i wrote', 'i decided', 'i implemented', 'i created', 'i proposed', 'i worked', 'i talked', 'i set up', 'i drove', 'i ran'],
    result: ['as a result', 'result', 'which led', 'reduced', 'increased', 'improved', 'saved', 'grew', 'outcome', 'shipped', 'launched', '%', 'percent'],
  };
  const PIS = {
    problem: ['the problem', 'the issue', 'is broken', 'failing', 'blocked', 'the challenge', 'concern'],
    impact: ['impact', 'which means', 'costing', 'delays', 'affects', 'customers', 'risk', 'because of this'],
    solution: ['i propose', 'what i need', 'can we', 'could you', 'my ask', 'the fix', 'solution', 'i suggest', 'let\'s', 'i\'ll'],
  };
  const VALUE = ['revenue', 'customers', 'cost', 'save', 'business', 'growth', 'value', 'impact', 'roi', 'retention', 'risk', 'deadline'];
  const RECOVER = ['as i was saying', 'to answer your question', 'to your point', 'back to', 'my main point', 'the key point', 'coming back', 'to be clear', 'so to answer', 'bottom line', 'in short'];

  function norm(t) { return ' ' + String(t || '').toLowerCase().replace(/[“”]/g, '"').replace(/\s+/g, ' ') + ' '; }
  function words(t) { return String(t || '').trim().split(/\s+/).filter(Boolean); }
  function countHits(text, list) {
    let n = 0;
    for (const p of list) {
      const re = new RegExp('(^|[^a-z])' + p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?=[^a-z]|$)', 'g');
      const m = text.match(re); if (m) n += m.length;
    }
    return n;
  }
  function hasAny(text, list) { return countHits(text, list) > 0; }
  function sentences(t) { return String(t || '').split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean); }
  function clamp(n, lo = 0, hi = 100) { return Math.max(lo, Math.min(hi, Math.round(n))); }

  // Analyze one user turn. Returns metrics + structure tree.
  function analyzeTurn(text) {
    const raw = String(text || '').trim();
    const t = norm(raw);
    const w = words(raw);
    const sents = sentences(raw);
    const first = norm(sents[0] || '');
    const firstWords = words(sents[0] || '').length;
    const conclusionFirst = hasAny(first, CONCLUSION_MARKERS) || (firstWords > 0 && firstWords <= 20 && !hasAny(first, ['so um', 'well', 'um', 'uh', 'good question', 'let me think']));
    const numbers = (raw.match(/\d[\d,.]*\s*(%|percent|k|x|m|million|billion|users|customers|ms|days|weeks|months)?/gi) || []).length;
    const evidence = countHits(t, EVIDENCE) + numbers;
    const signposts = countHits(t, SIGNPOSTS);
    const fillers = countHits(t, FILLERS);
    const hedges = countHits(t, HEDGES);
    const star = {};
    for (const k of Object.keys(STAR)) star[k] = hasAny(t, STAR[k]);
    const pis = {};
    for (const k of Object.keys(PIS)) pis[k] = hasAny(t, PIS[k]);
    const valueWords = countHits(t, VALUE);
    const iCount = countHits(t, ['i']);
    const weCount = countHits(t, ['we']);

    // Structure tree: conclusion = first sentence, points = remaining sentences
    // with evidence attached if they contain numbers/evidence markers.
    const tree = {
      conclusion: sents[0] || '',
      points: sents.slice(1, 6).map((s) => ({ text: s, hasEvidence: hasAny(norm(s), EVIDENCE) || /\d/.test(s) })),
    };

    return {
      wordCount: w.length,
      sentenceCount: sents.length,
      conclusionFirst, numbers, evidence, signposts, fillers, hedges, star, pis,
      valueWords, ownership: iCount >= weCount ? 'personal' : 'team',
      fillerRate: w.length ? fillers / w.length : 0,
      tree,
    };
  }

  // Live coaching hints (Practice Mode) for one turn.
  function hintsForTurn(text, roleId) {
    const a = analyzeTurn(text);
    const hints = [];
    if (a.wordCount < 4) return { analysis: a, hints };
    if (!a.conclusionFirst) hints.push({ level: 'warn', text: 'Lead with your conclusion — state the answer in the first sentence.' });
    if (a.wordCount > 140) hints.push({ level: 'warn', text: `That answer was ${a.wordCount} words. Aim for a 1-sentence headline + 2–3 points.` });
    if (a.wordCount > 40 && a.signposts === 0) hints.push({ level: 'info', text: 'Signpost your points ("Two reasons: first… second…").' });
    if (a.wordCount > 25 && a.evidence === 0) hints.push({ level: 'warn', text: 'No evidence — add a number, example, or result.' });
    if (a.fillerRate > 0.04) hints.push({ level: 'info', text: `High filler rate (${a.fillers} fillers). Pause silently instead.` });
    if (a.hedges >= 2) hints.push({ level: 'info', text: 'Too many hedges ("I think", "maybe"). Commit to your position.' });
    if (roleId === 'interviewer') {
      const missing = Object.keys(a.star).filter((k) => !a.star[k]);
      if (a.wordCount > 40 && missing.length) hints.push({ level: 'info', text: `STAR: missing ${missing.join(', ')}.` });
      if (a.ownership === 'team' && a.wordCount > 30) hints.push({ level: 'info', text: 'Lots of "we" — clarify what YOU did.' });
    } else if (roleId === 'investor') {
      if (a.numbers === 0 && a.wordCount >= 10) hints.push({ level: 'warn', text: 'Investors want metrics. Lead with the number.' });
    } else if (roleId === 'coworker') {
      const missing = Object.keys(a.pis).filter((k) => !a.pis[k]);
      if (a.wordCount > 30 && missing.length) hints.push({ level: 'info', text: `Problem-Impact-Solution: missing ${missing.join(', ')}.` });
    } else if (roleId === 'boss') {
      if (a.valueWords === 0 && a.wordCount > 15) hints.push({ level: 'warn', text: 'Frame it in business value first.' });
    }
    if (!hints.length) hints.push({ level: 'good', text: 'Clear and structured. Keep it up.' });
    return { analysis: a, hints };
  }

  // Did the user re-anchor after being interrupted?
  function recoveredAfterInterruption(nextUserText) {
    const t = norm(nextUserText);
    const a = analyzeTurn(nextUserText);
    return hasAny(t, RECOVER) || a.conclusionFirst;
  }

  // Fallback full-session report (offline, no LLM). Same shape as the LLM report.
  function heuristicReport(transcript, roleRubric, roleId) {
    const userTurns = transcript.filter((m) => m.role === 'user' && m.text && m.text.trim());
    const analyses = userTurns.map((m) => ({ m, a: analyzeTurn(m.text) }));
    const n = analyses.length || 1;
    const avg = (f) => analyses.reduce((s, x) => s + f(x.a), 0) / n;

    const cfRate = avg((a) => (a.conclusionFirst ? 1 : 0));
    const evRate = avg((a) => (a.evidence > 0 ? 1 : 0));
    const sigRate = avg((a) => (a.signposts > 0 || a.wordCount < 40 ? 1 : 0));
    const fillerRate = avg((a) => a.fillerRate);
    const hedgeRate = avg((a) => Math.min(a.hedges, 3) / 3);
    const lengthPenalty = avg((a) => (a.wordCount > 160 ? 1 : 0));

    // Interruption recovery
    const interruptions = [];
    transcript.forEach((m, i) => {
      if (m.role === 'assistant' && m.interrupted) {
        const next = transcript.slice(i + 1).find((x) => x.role === 'user');
        if (next) interruptions.push({ at: m.text, response: next.text, recovered: recoveredAfterInterruption(next.text) });
      }
    });
    const recRate = interruptions.length ? interruptions.filter((x) => x.recovered).length / interruptions.length : null;

    const structured = clamp(100 * (0.4 * cfRate + 0.3 * evRate + 0.3 * sigRate) - 20 * lengthPenalty);
    const persuasion = clamp(100 * (0.6 * evRate + 0.4 * cfRate) - 30 * hedgeRate);
    const composure = clamp(100 - fillerRate * 800 - hedgeRate * 25 - (recRate === null ? 0 : (1 - recRate) * 30));

    const rubricScores = (roleRubric || []).map((r) => {
      let s;
      switch (r.key) {
        case 'star': s = avg((a) => Object.values(a.star).filter(Boolean).length / 4) * 100; break;
        case 'specificity': s = avg((a) => Math.min(1, a.numbers / 2) * 0.6 + (a.ownership === 'personal' ? 0.4 : 0.1)) * 100; break;
        case 'relevance': s = 60 + 30 * cfRate; break;
        case 'conclusion_first': s = cfRate * 100; break;
        case 'data_support': s = avg((a) => Math.min(1, a.numbers / 2)) * 100; break;
        case 'risk_handling': s = avg((a) => (/(risk|mitigat|plan|if .* then|hedge)/i.test(userTurns.map((u) => u.text).join(' ')) ? 1 : 0.4)) * 70 + 15; break;
        case 'pis_clarity': s = avg((a) => Object.values(a.pis).filter(Boolean).length / 3) * 100; break;
        case 'boundary_setting': s = 50 + 40 * (1 - hedgeRate); break;
        case 'composure': s = composure; break;
        case 'value_first': s = avg((a) => (a.valueWords > 0 ? 1 : 0)) * 100; break;
        case 'conciseness': s = 100 - avg((a) => Math.min(1, Math.max(0, a.wordCount - 60) / 120)) * 100; break;
        case 'prioritization': s = 50 + 40 * evRate; break;
        default: s = 60;
      }
      return { key: r.key, label: r.label, score: clamp(s), comment: r.desc };
    });

    const ranked = analyses.slice().sort((x, y) => scoreTurn(y.a) - scoreTurn(x.a));
    const strengths = ranked.slice(0, 2).filter((x) => scoreTurn(x.a) >= 2).map((x) => ({ quote: truncate(x.m.text, 220), why: describeStrength(x.a) }));
    const breakdowns = ranked.slice(-2).reverse().filter((x) => scoreTurn(x.a) < 3).map((x) => ({ quote: truncate(x.m.text, 220), issue: describeIssue(x.a, roleId), better: betterVersion(x.m.text, roleId) }));

    const structureMap = analyses.slice(0, 6).map((x) => {
      const q = previousAssistant(transcript, x.m);
      return { question: q ? truncate(q.text, 160) : '', conclusion: truncate(x.a.tree.conclusion, 200), points: x.a.tree.points.map((p) => ({ text: truncate(p.text, 160), hasEvidence: p.hasEvidence })), issues: x.a.conclusionFirst ? [] : ['Conclusion not stated up front'] };
    });

    const weakest = rubricScores.slice().sort((a, b) => a.score - b.score)[0];
    const topAction = !userTurns.length
      ? 'Complete a full session — answer at least 3 questions so there is something to evaluate.'
      : cfRate < 0.6
        ? 'Start every answer with a one-sentence conclusion, then give 2–3 supporting points.'
        : evRate < 0.6
          ? 'Attach one concrete number or example to every claim you make.'
          : weakest ? `Focus on ${weakest.label.toLowerCase()}: ${weakest.comment}` : 'Keep practicing under higher pressure.';

    const insights = [];
    if (roleId === 'investor' && avg((a) => (a.numbers > 0 ? 1 : 0)) < 0.5) insights.push('You rarely led with a metric when challenged.');
    if (roleId === 'interviewer' && avg((a) => (a.star.result ? 1 : 0)) < 0.5) insights.push('Most stories ended without a clear, measurable result.');
    if (roleId === 'coworker' && avg((a) => (a.pis.solution ? 1 : 0)) < 0.5) insights.push('You described the problem but rarely made a concrete ask.');
    if (roleId === 'boss' && avg((a) => (a.valueWords > 0 ? 1 : 0)) < 0.5) insights.push('You did not frame your request in terms of business value.');
    if (avg((a) => a.wordCount) > 120) insights.push(`Average answer length was ${Math.round(avg((a) => a.wordCount))} words — long for a live meeting.`);
    if (!insights.length) insights.push('Your answers were generally on-format for this role.');

    return {
      source: 'heuristic',
      scores: { structured, persuasion, composure },
      overall: clamp((structured + persuasion + composure) / 3),
      summary: userTurns.length ? `You answered ${userTurns.length} time(s). ${Math.round(cfRate * 100)}% of answers led with a conclusion and ${Math.round(evRate * 100)}% included evidence.` : 'No answers were captured in this session.',
      rubric: rubricScores,
      structureMap,
      strengths,
      breakdowns,
      interruptionRecovery: {
        count: interruptions.length,
        recovered: interruptions.filter((x) => x.recovered).length,
        analysis: interruptions.length ? `You were interrupted ${interruptions.length} time(s) and re-anchored your main point ${interruptions.filter((x) => x.recovered).length} time(s).` : 'You were not interrupted in this session.',
        moments: interruptions.slice(0, 4).map((x) => ({ quote: truncate(x.response, 200), recovered: x.recovered })),
      },
      roleInsights: insights,
      topAction,
    };
  }

  function previousAssistant(transcript, msg) {
    const i = transcript.indexOf(msg);
    for (let j = i - 1; j >= 0; j--) if (transcript[j].role === 'assistant') return transcript[j];
    return null;
  }
  function scoreTurn(a) { return (a.conclusionFirst ? 1 : 0) + (a.evidence > 0 ? 1 : 0) + (a.signposts > 0 ? 1 : 0) + (a.fillerRate < 0.03 ? 1 : 0) - (a.wordCount > 160 ? 1 : 0); }
  function describeStrength(a) {
    const r = [];
    if (a.conclusionFirst) r.push('led with a clear conclusion');
    if (a.evidence) r.push('backed it with evidence');
    if (a.signposts) r.push('signposted the structure');
    return r.length ? 'You ' + r.join(', ') + '.' : 'Concise and direct.';
  }
  function describeIssue(a, roleId) {
    const r = [];
    if (!a.conclusionFirst) r.push('the conclusion was buried');
    if (!a.evidence) r.push('no supporting evidence');
    if (a.wordCount > 160) r.push('too long');
    if (a.fillerRate > 0.04) r.push('many filler words');
    if (roleId === 'investor' && !a.numbers) r.push('no metrics');
    return r.length ? r.join('; ') : 'could be tighter';
  }
  function truncate(s, n) { s = String(s || ''); return s.length > n ? s.slice(0, n - 1) + '…' : s; }
  function stripFillers(s) {
    let out = ' ' + s + ' ';
    for (const f of FILLERS.concat(HEDGES)) out = out.replace(new RegExp('[\\s,]+' + f + '(?=[\\s,.!?])', 'gi'), '');
    return out.replace(/\s+/g, ' ').replace(/^[\s,]+/, '').trim();
  }
  function betterVersion(text, roleId) {
    const sents = sentences(stripFillers(text));
    if (!sents.length) return '';
    const withEvidence = sents.filter((s) => /\d/.test(s) || hasAny(norm(s), EVIDENCE));
    const headline = (withEvidence[withEvidence.length - 1] || sents[sents.length - 1]).replace(/^(so|and|but)\s+/i, '');
    const rest = sents.filter((s) => s !== headline).slice(0, 2);
    const lead = roleId === 'investor' ? 'The headline number: ' : roleId === 'boss' ? 'The business value: ' : 'Bottom line: ';
    let out = lead + headline;
    if (rest.length) out += ' ' + (rest.length > 1 ? 'Two supporting points — first, ' + lc(rest[0]) + ' Second, ' + lc(rest[1]) : 'Supporting that: ' + lc(rest[0]));
    if (!withEvidence.length) out += ' [Add one concrete number or example here.]';
    return out;
  }
  function lc(s) { return s.charAt(0).toLowerCase() + s.slice(1); }

  return { analyzeTurn, hintsForTurn, recoveredAfterInterruption, heuristicReport, betterVersion };
});
