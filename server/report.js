import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createZip } from './zip.js';

/**
 * Everything the educator downloads at the end: one ZIP with the raw data,
 * the analysis, the overview, and a readable report.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(here, '..', 'public');

const esc = (v) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const csvCell = (v) => { const t = String(v ?? ''); return /[",\n\r]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; };
const csv = (rows) => `${rows.map((r) => r.map(csvCell).join(',')).join('\r\n')}\r\n`;
const pct = (v) => (v === null || v === undefined ? '—' : `${v}%`);
const when = (ms) => (ms ? new Date(ms).toISOString().replace('T', ' ').slice(0, 19) : '');
const slug = (s) => String(s || 'activity').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'activity';

function labeller(cls) {
  const map = new Map((cls?.students || []).map((s) => [s.n, s.label]));
  return (n) => map.get(n) || `Student ${n}`;
}

// ------------------------------------------------------------------ raw data

export function messagesCsv(record, cls) {
  const label = labeller(cls);
  const rows = [['round', 'conversation', 'conversation_type', 'model', 'persona', 'speaker', 'is_ai', 'timestamp', 'text']];
  for (const round of record.rounds) {
    for (const conv of round.conversations) {
      for (const m of conv.messages) {
        rows.push([round.number, conv.id, conv.type, conv.modelLabel || '', conv.personaLabel || '',
          m.from === 'ai' ? 'AI' : label(m.from), m.from === 'ai' ? 1 : 0, when(m.ts), m.text]);
      }
    }
  }
  return csv(rows);
}

export function resultsCsv(record, cls) {
  const label = labeller(cls);
  const rows = [['round', 'student', 'partner', 'model', 'persona', 'guess', 'correct', 'messages_sent', 'conversation']];
  for (const round of record.rounds) {
    for (const conv of round.conversations) {
      for (const n of conv.members) {
        const g = round.guesses[n] || '';
        rows.push([round.number, label(n), conv.type === 'ai' ? 'AI' : 'classmate', conv.modelLabel || '',
          conv.personaLabel || '', g ? (g === 'ai' ? 'AI' : 'classmate') : '', g ? (g === conv.type ? 1 : 0) : '',
          conv.messages.filter((m) => m.from === n).length, conv.id]);
      }
    }
  }
  return csv(rows);
}

export function roundsCsv(record) {
  const rows = [['round', 'models', 'students', 'ai_conversations', 'answered', 'accuracy_pct', 'ai_fooled_pct', 'human_spotted_pct',
    'haiku_fooled_pct', 'sonnet_fooled_pct', 'opus_fooled_pct', 'guidance_items_after_round']];
  for (const r of record.rounds) {
    const s = r.stats || {};
    const m = s.byModel || {};
    rows.push([r.number, r.models.join(' '), s.students ?? '', s.aiConversations ?? '', s.answered ?? '', s.accuracy ?? '',
      s.aiFooledRate ?? '', s.humanSpotRate ?? '', m.haiku?.fooledRate ?? '', m.sonnet?.fooledRate ?? '', m.opus?.fooledRate ?? '',
      r.analysis?.guidance?.length ?? '']);
  }
  return csv(rows);
}

export function transcriptText(record, cls) {
  const label = labeller(cls);
  const out = [`${record.name} — ${record.className}`, ''];
  for (const round of record.rounds) {
    out.push(`==================== ROUND ${round.number} (${round.models.join(', ')}) ====================`, '');
    for (const conv of round.conversations) {
      const who = conv.type === 'ai'
        ? `${label(conv.members[0])} with AI — ${conv.modelLabel}, persona "${conv.personaLabel}"`
        : `${conv.members.map(label).join(' with ')} (both human)`;
      out.push(`--- ${conv.id}: ${who}`);
      for (const m of conv.messages) out.push(`[${when(m.ts).slice(11)}] ${m.from === 'ai' ? 'AI' : label(m.from)}: ${m.text}`);
      const guesses = conv.members.map((n) => `${label(n)} guessed ${round.guesses[n] === 'ai' ? 'AI' : round.guesses[n] === 'human' ? 'classmate' : '(no guess)'}`);
      out.push(`Guesses: ${guesses.join('; ')}`, '');
    }
  }
  return out.join('\n');
}

export function analysisMarkdown(round) {
  const a = round.analysis;
  const s = round.stats || {};
  const lines = [
    `# Round ${round.number} — analysis`,
    '',
    `Models in play: ${round.models.join(', ')}. ${round.note || ''}`,
    `AI passed as human: ${pct(s.aiFooledRate)} (${s.aiFooled ?? 0} of ${s.aiAnswered ?? 0}). Overall accuracy: ${pct(s.accuracy)}.`,
    '',
  ];
  if (!a) return [...lines, `_Analysis ${round.analysisStatus || 'not run'}${round.analysisError ? `: ${round.analysisError}` : ''}._`, ''].join('\n');
  const list = (title, items, fmt = (x) => x) => (items?.length ? [`## ${title}`, '', ...items.map((x) => `- ${fmt(x)}`), ''] : []);
  return [
    ...lines,
    `**${a.headline}**`, '', a.summary, '',
    ...list('What gave the AI away', a.aiTells, (x) => `${x.tell} — _${x.evidence}_`),
    ...list('What real students did', a.humanSignals, (x) => `${x.signal} — _${x.evidence}_`),
    ...list('How students tried to catch it', a.studentStrategies),
    ...list('What students were interested in', a.interests),
    ...list('Real students taken for an AI', a.misjudgements),
    ...list('Guidance given to the AI for the next round', a.guidance),
  ].join('\n');
}

// ------------------------------------------------------------------ report

function statsTable(record) {
  const rows = record.rounds.map((r) => {
    const s = r.stats || {};
    const m = s.byModel || {};
    return `<tr><td>Round ${r.number}</td><td>${esc(r.models.join(', '))}</td><td>${s.students ?? '—'}</td>
      <td><strong>${pct(s.aiFooledRate)}</strong></td><td>${pct(m.haiku?.fooledRate)}</td><td>${pct(m.sonnet?.fooledRate)}</td>
      <td>${pct(m.opus?.fooledRate)}</td><td>${pct(s.accuracy)}</td></tr>`;
  }).join('');
  return `<table><thead><tr><th>Round</th><th>Models</th><th>Students</th><th>AI passed as human</th><th>Haiku</th><th>Sonnet</th><th>Opus</th><th>Class accuracy</th></tr></thead><tbody>${rows}</tbody></table>`;
}

export function reportHtml(record, cls, context) {
  const o = record.overview;
  const label = labeller(cls);
  const cost = record.rounds.reduce((sum, r) => sum + Object.values(r.stats?.byModel || {}).reduce((n, m) => n + (m.costUsd || 0), 0), 0);
  const rounds = record.rounds.map((r) => {
    const a = r.analysis;
    const convs = r.conversations.map((c) => `
      <details><summary>${esc(c.type === 'ai' ? `${label(c.members[0])} ↔ AI (${c.modelLabel}, ${c.personaLabel})` : c.members.map(label).join(' ↔ '))}
        — guesses: ${esc(c.members.map((n) => r.guesses[n] === 'ai' ? 'AI' : r.guesses[n] === 'human' ? 'classmate' : '—').join(', '))}</summary>
        <div class="t">${c.messages.map((m) => `<div class="${m.from === 'ai' ? 'ai' : ''}"><b>${esc(m.from === 'ai' ? 'AI' : label(m.from))}:</b> ${esc(m.text)}</div>`).join('') || '<em>No messages.</em>'}</div>
      </details>`).join('');
    return `<section><h2>Round ${r.number} <small>${esc(r.note || '')}</small></h2>
      <p class="kpi">AI passed as human: <strong>${pct(r.stats?.aiFooledRate)}</strong> · class accuracy ${pct(r.stats?.accuracy)} · ${r.stats?.students ?? 0} students</p>
      ${a ? `<p class="headline">${esc(a.headline)}</p><p>${esc(a.summary)}</p>
        ${a.aiTells?.length ? `<h3>What gave the AI away</h3><ul>${a.aiTells.map((x) => `<li>${esc(x.tell)} <em>“${esc(x.evidence)}”</em></li>`).join('')}</ul>` : ''}
        ${a.studentStrategies?.length ? `<h3>How students tried to catch it</h3><ul>${a.studentStrategies.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
        ${a.guidance?.length ? `<h3>What the AI was told for the next round</h3><ol>${a.guidance.map((x) => `<li>${esc(x)}</li>`).join('')}</ol>` : ''}`
        : `<p><em>Analysis ${esc(r.analysisStatus || 'not run')}.</em></p>`}
      <h3>Transcripts</h3>${convs}</section>`;
  }).join('');

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(record.name)} — Human or Not? report</title>
<style>
body{font:15px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:#1d1a16;max-width:980px;margin:0 auto;padding:32px 22px 60px;background:#fffdf9}
h1{margin:0;color:#c96a12}h2{margin-top:40px;border-bottom:2px solid #f2c48a;padding-bottom:6px}h2 small{font-weight:400;color:#7a6f63;font-size:.7em}
.meta{color:#6d6358}.kpi{font-size:1.05em}.headline{font-weight:650;font-size:1.1em}
table{width:100%;border-collapse:collapse;margin:14px 0}th,td{text-align:left;padding:8px 10px;border-bottom:1px solid #eadfd2}th{font-size:.8em;text-transform:uppercase;color:#7a6f63}
details{margin:6px 0;border:1px solid #eadfd2;border-radius:8px;padding:6px 10px;background:#fff}summary{cursor:pointer}
.t{margin-top:8px;font-size:.92em}.t div{padding:2px 0}.t .ai{color:#2c4fb5}
.box{background:#fff4e6;border:1px solid #f2c48a;border-radius:10px;padding:14px 18px;margin:16px 0}
footer{margin-top:50px;color:#9a8e80;font-size:.8em}
</style></head><body>
<h1>${esc(record.name)}</h1>
<p class="meta">${esc(record.className)} · ${esc(record.contextName || 'no class context')} · ${esc(record.personaSetLabel || '')}<br>
Started ${esc(when(record.createdAt))} · ${record.rounds.length} of 4 rounds · ${Math.round(record.durationSec / 60)}-minute rounds · ${Math.round(record.aiRatio * 100)}% of students paired with the AI each round<br>
Estimated API cost of the chats: US$${cost.toFixed(2)} (analysis calls not included)</p>
${o ? `<div class="box"><h3 style="margin-top:0">${esc(o.title)}</h3><p>${esc(o.subtitle)}</p>
  ${o.keyFindings?.length ? `<ul>${o.keyFindings.map((f) => `<li>${esc(f)}</li>`).join('')}</ul>` : ''}
  <p><strong>${esc(o.opusImpact?.headline || '')}</strong> ${esc(o.opusImpact?.body || '')}</p></div>` : ''}
<h2>The four rounds at a glance</h2>
${statsTable(record)}
<p class="meta">"AI passed as human" is the share of students paired with an AI who guessed they had been talking to a classmate. Small classes mean small samples: one student is several percentage points.</p>
${o?.story?.length ? `<h2>How the AI learned this class</h2>${o.story.map((b) => `<h3>${esc(b.heading)}</h3><p>${esc(b.body)}</p>`).join('')}` : ''}
${o?.discussionQuestions?.length ? `<h2>Questions for discussion</h2><ol>${o.discussionQuestions.map((q) => `<li>${esc(q)}</li>`).join('')}</ol>` : ''}
${rounds}
${context?.brief ? `<h2>The class brief the AI worked from</h2><pre style="white-space:pre-wrap;font:inherit;background:#fff;border:1px solid #eadfd2;border-radius:8px;padding:14px">${esc(context.brief)}</pre>` : ''}
<footer>Human or Not? · powered and created by Allentronics Education Services</footer>
</body></html>`;
}

// ---------------------------------------------------------------- overview

/** The animated overview as one file that opens anywhere, offline. */
export function overviewHtml(record) {
  const js = fs.readFileSync(path.join(publicDir, 'js', 'overview.js'), 'utf8');
  const css = fs.readFileSync(path.join(publicDir, 'css', 'overview.css'), 'utf8');
  const logo = fs.readFileSync(path.join(publicDir, 'img', 'allentronics-logo.png')).toString('base64');
  const data = JSON.stringify(overviewData(record)).replace(/</g, '\\u003c');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(record.name)} — overview</title><style>${css}</style></head>
<body class="ov-standalone"><div id="overview"></div>
<script>window.OVERVIEW_LOGO="data:image/png;base64,${logo}";</script>
<script>${js}</script>
<script>HumanOrNotOverview.render(document.getElementById('overview'), ${data});</script>
</body></html>`;
}

/** What the presentation needs: the numbers from the app, the words from Opus. */
export function overviewData(record) {
  return {
    activity: record.name,
    className: record.className,
    rounds: record.rounds.map((r) => ({
      number: r.number,
      models: r.models,
      aiFooledRate: r.stats?.aiFooledRate ?? null,
      accuracy: r.stats?.accuracy ?? null,
      students: r.stats?.students ?? 0,
      byModel: Object.fromEntries(Object.values(r.stats?.byModel || {}).map((m) => [m.family, { label: m.label, rate: m.fooledRate, n: m.answered }])),
      guidance: r.analysis?.guidance || [],
      headline: r.analysis?.headline || '',
    })),
    story: record.overview || null,
  };
}

// --------------------------------------------------------------------- zip

export function activityZip({ record, cls, context }) {
  const base = `human-or-not_${slug(record.name)}_${new Date(record.createdAt).toISOString().slice(0, 10)}`;
  const files = [
    { name: `${base}/README.txt`, content: readme(record) },
    { name: `${base}/report.html`, content: reportHtml(record, cls, context) },
    { name: `${base}/data/activity.json`, content: JSON.stringify({ activity: record, class: cls ? { ...cls, students: cls.students.map(({ n, label }) => ({ n, label })) } : null }, null, 2) },
    { name: `${base}/data/messages.csv`, content: messagesCsv(record, cls) },
    { name: `${base}/data/results.csv`, content: resultsCsv(record, cls) },
    { name: `${base}/data/rounds.csv`, content: roundsCsv(record) },
    { name: `${base}/data/transcripts.txt`, content: transcriptText(record, cls) },
  ];
  for (const round of record.rounds) {
    files.push({ name: `${base}/analysis/round-${round.number}.md`, content: analysisMarkdown(round) });
    if (round.analysis) files.push({ name: `${base}/analysis/round-${round.number}.json`, content: JSON.stringify(round.analysis, null, 2) });
  }
  if (record.overview) {
    files.push({ name: `${base}/overview/overview.html`, content: overviewHtml(record) });
    files.push({ name: `${base}/overview/overview.json`, content: JSON.stringify(record.overview, null, 2) });
  }
  if (context) {
    files.push({ name: `${base}/context/class-brief.md`, content: context.brief || '' });
    for (const [key, name] of [['about', '01-about-the-class.md'], ['learned', '02-what-we-have-learned.md'], ['voice', '03-student-voice.md']]) {
      if (context.files?.[key]) files.push({ name: `${base}/context/${name}`, content: context.files[key] });
    }
  }
  return { name: `${base}.zip`, buffer: createZip(files) };
}

function readme(record) {
  return [
    `Human or Not? — ${record.name} (${record.className})`,
    '',
    'report.html ................ start here: the four rounds, findings, and every transcript',
    'overview/overview.html ..... the animated end-of-activity overview; opens offline in any browser',
    'overview/overview.json ..... the overview content Claude Opus wrote',
    'analysis/round-N.md ........ what Opus found after each round, and the guidance it gave the AI',
    'analysis/round-N.json ...... the same, as data',
    'data/messages.csv .......... every message: round, conversation, model, persona, speaker, time, text',
    'data/results.csv ........... one row per student per round: partner, model, guess, correct',
    'data/rounds.csv ............ one row per round: the headline numbers',
    'data/transcripts.txt ....... every conversation, readable',
    'data/activity.json ......... everything above in one file (codes removed)',
    'context/ ................... the class context the AI was given',
    '',
    'Rounds 1-3 used Claude Haiku, Sonnet and Opus. Round 4 used Haiku and Sonnet only.',
    'Students are labelled "Student N" from the class list; no codes are included.',
    '',
  ].join('\n');
}
