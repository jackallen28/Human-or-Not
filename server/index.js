import 'dotenv/config';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { Server as SocketServer } from 'socket.io';
import { openStore, newId } from './store.js';
import { hasApiKey, models, resolveModels } from './claude.js';
import { contextWordCount, extractSamples, trainContext } from './analysis.js';
import { PERSONA_SETS, personaCatalog, personaSet } from './personas.js';
import { buildCardsPdf, generateCodes } from './pdf.js';
import { LiveActivity, PHASES } from './activity.js';
import { MODES, MAX_ROUNDS, buildPlan, clampBlock, ensurePlan, modeInfo } from './modes.js';
import { activityZip, overviewData } from './report.js';
import { createZip } from './zip.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(here, '..', 'public');
const templateDir = path.join(here, '..', 'templates');

const PORT = Number(process.env.PORT || 3000);
const TEACHER_CODE = String(process.env.TEACHER_CODE || process.env.TEACHER_PASSCODE || 'teacher');
const TEMPLATES = ['01-about-the-class.md', '02-what-we-have-learned.md', '03-student-voice.md'];

// ------------------------------------------------------------------ startup

const store = await openStore();
await resolveModels();

const onFreeRenderDisk = store.kind === 'files' && process.env.RENDER && !process.env.DATA_DIR;
console.log('[server] Human or Not? — educator edition');
console.log(`[server] Storage: ${store.describe()}${onFreeRenderDisk ? ' — NOT PERSISTENT on Render (wiped when the service sleeps). Add DATABASE_URL.' : ''}`);
console.log(hasApiKey()
  ? `[server] Claude models: ${Object.values(models()).map((m) => `${m.label} (${m.id}, ${m.source})`).join(', ')}`
  : '[server] No ANTHROPIC_API_KEY — AI partners send filler lines and nothing is analysed.');
if (!process.env.TEACHER_CODE && !process.env.TEACHER_PASSCODE) {
  console.warn('[server] TEACHER_CODE is not set; the teacher code is "teacher". Set one before class.');
}

// An activity that was live when the server stopped cannot be resumed; keep it
// downloadable and say what happened.
for (const record of await store.list('activities')) {
  if (record.status === 'live') {
    record.status = 'interrupted';
    await store.put('activities', record.id, record);
  }
}

/** The one activity running right now, if any. */
let live = null;

// --------------------------------------------------------------------- http

const app = express();
const server = http.createServer(app);
const io = new SocketServer(server);

app.use(express.json({ limit: '25mb' }));
app.use(express.static(publicDir));
app.get('/teacher', (_req, res) => res.sendFile(path.join(publicDir, 'teacher.html')));
// Pinged by the open teacher console so a free Render instance does not fall
// asleep in the middle of a lesson.
app.get('/healthz', (_req, res) => res.json({ ok: true, live: Boolean(live) }));

app.get('/templates/:name', (req, res) => {
  if (!TEMPLATES.includes(req.params.name)) return res.status(404).end();
  res.setHeader('content-type', 'text/markdown; charset=utf-8');
  res.setHeader('content-disposition', `attachment; filename="${req.params.name}"`);
  res.sendFile(path.join(templateDir, req.params.name));
});
app.get('/templates-all.zip', (_req, res) => {
  const zip = createZip(TEMPLATES.map((name) => ({
    name: `human-or-not-context/${name}`, content: fs.readFileSync(path.join(templateDir, name), 'utf8'),
  })));
  res.setHeader('content-type', 'application/zip');
  res.setHeader('content-disposition', 'attachment; filename="human-or-not-context-files.zip"');
  res.send(zip);
});

/** Every /api route below needs the teacher code. */
function teacherOnly(req, res, next) {
  if (String(req.get('x-teacher-code') || '') !== TEACHER_CODE) return res.status(401).json({ error: 'Wrong teacher code.' });
  next();
}
const api = express.Router();
api.use(teacherOnly);
app.use('/api', api);

const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((err) => {
  console.error('[api]', err);
  res.status(500).json({ error: err.message || 'Something went wrong.' });
});

function joinUrl(req) {
  const fixed = (process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || '').replace(/\/+$/, '');
  return fixed || `${req.protocol}://${req.get('host')}`;
}

api.get('/meta', wrap(async (req, res) => {
  res.json({
    hasApiKey: hasApiKey(),
    models: models(),
    personaSets: personaCatalog(),
    modes: Object.values(MODES),
    maxRounds: MAX_ROUNDS,
    storage: { kind: store.kind, description: store.describe(), persistent: !onFreeRenderDisk },
    joinUrl: joinUrl(req).replace(/^https?:\/\//, ''),
    live: live ? { id: live.record.id, name: live.record.name, phase: live.phase } : null,
  });
}));

// ----------------------------------------------------------------- contexts

/** The bits of a context the list view needs (not the whole brief). */
const contextSummary = (c) => ({
  id: c.id, name: c.name, title: c.title, status: c.status, error: c.error || null, summary: c.summary,
  strengths: c.strengths || [], gaps: c.gaps || [], words: c.words, samples: (c.sampleMessages || []).length,
  learnings: (c.learnings || []).length, createdAt: c.createdAt, updatedAt: c.updatedAt,
  files: Object.fromEntries(Object.entries(c.files || {}).map(([k, v]) => [k, Boolean(v && v.trim())])),
});

async function runTraining(id) {
  const context = await store.get('contexts', id);
  if (!context) return;
  try {
    const result = await trainContext({ name: context.name, files: context.files });
    Object.assign(context, {
      title: result.title, summary: result.summary, brief: result.brief, sampleMessages: result.sampleMessages,
      strengths: result.strengths, gaps: result.gaps, model: result.model, status: 'ready', error: null,
      trainedAt: Date.now(), updatedAt: Date.now(),
    });
  } catch (err) {
    console.warn('[train] failed:', err.message);
    context.status = 'failed';
    context.error = err.message;
    // Still usable: the bots can read the files directly.
    context.brief = context.brief || Object.values(context.files).join('\n\n');
    context.sampleMessages = context.sampleMessages?.length ? context.sampleMessages : extractSamples(context.files.voice);
  }
  await store.put('contexts', id, context);
}

api.get('/contexts', wrap(async (_req, res) => {
  const all = await store.list('contexts');
  res.json(all.sort((a, b) => b.createdAt - a.createdAt).map(contextSummary));
}));

api.get('/contexts/:id', wrap(async (req, res) => {
  const context = await store.get('contexts', req.params.id);
  if (!context) return res.status(404).json({ error: 'Not found.' });
  res.json(context);
}));

api.post('/contexts', wrap(async (req, res) => {
  const files = {
    about: String(req.body?.files?.about || ''),
    learned: String(req.body?.files?.learned || ''),
    voice: String(req.body?.files?.voice || ''),
  };
  const words = contextWordCount(files);
  if (words < 25) {
    return res.status(400).json({ error: 'There is not enough in those files yet. Fill in at least files 01 and 02 — the more you give, the harder the AI is to catch.' });
  }
  const context = {
    id: newId('ctx'),
    name: String(req.body?.name || 'My class').trim().slice(0, 80) || 'My class',
    files, words, status: 'training', createdAt: Date.now(), updatedAt: Date.now(),
    learnings: [], sampleMessages: [], brief: '',
  };
  await store.put('contexts', context.id, context);
  runTraining(context.id);
  res.json(contextSummary(context));
}));

api.put('/contexts/:id', wrap(async (req, res) => {
  const context = await store.get('contexts', req.params.id);
  if (!context) return res.status(404).json({ error: 'Not found.' });
  for (const key of ['about', 'learned', 'voice']) {
    if (typeof req.body?.files?.[key] === 'string' && req.body.files[key].trim()) context.files[key] = req.body.files[key];
  }
  if (req.body?.name) context.name = String(req.body.name).slice(0, 80);
  context.words = contextWordCount(context.files);
  context.status = 'training';
  context.updatedAt = Date.now();
  await store.put('contexts', context.id, context);
  runTraining(context.id);
  res.json(contextSummary(context));
}));

api.delete('/contexts/:id', wrap(async (req, res) => {
  await store.remove('contexts', req.params.id);
  res.json({ ok: true });
}));

// ------------------------------------------------------------------ classes

const classSummary = (c) => ({
  id: c.id, name: c.name, size: c.students.length, personaSet: c.personaSet,
  personaSetLabel: personaSet(c.personaSet).label, personas: c.personas, contextId: c.contextId,
  createdAt: c.createdAt,
});

async function allCodes() {
  return new Set((await store.list('classes')).flatMap((c) => c.students.map((s) => s.code)));
}

function readPersonas(body) {
  const setId = PERSONA_SETS[body?.personaSet] ? body.personaSet : 'secondary';
  const valid = new Set(PERSONA_SETS[setId].personas.map((p) => p.id));
  const chosen = (Array.isArray(body?.personas) ? body.personas : []).filter((id) => valid.has(id));
  return { personaSet: setId, personas: chosen.length ? chosen : [...valid] };
}

api.get('/classes', wrap(async (_req, res) => {
  const all = await store.list('classes');
  res.json(all.sort((a, b) => b.createdAt - a.createdAt).map(classSummary));
}));

api.get('/classes/:id', wrap(async (req, res) => {
  const cls = await store.get('classes', req.params.id);
  if (!cls) return res.status(404).json({ error: 'Not found.' });
  res.json(cls);
}));

api.post('/classes', wrap(async (req, res) => {
  const name = String(req.body?.name || '').trim().slice(0, 80);
  const count = Math.floor(Number(req.body?.count));
  if (!name) return res.status(400).json({ error: 'Give the class a name.' });
  if (!(count >= 1 && count <= 60)) return res.status(400).json({ error: 'Between 1 and 60 students.' });
  const codes = generateCodes(count, await allCodes());
  const cls = {
    id: newId('cls'),
    name,
    ...readPersonas(req.body),
    contextId: req.body?.contextId || null,
    students: codes.map((code, i) => ({ n: i + 1, label: `Student ${i + 1}`, code })),
    createdAt: Date.now(),
  };
  await store.put('classes', cls.id, cls);
  res.json(classSummary(cls));
}));

api.put('/classes/:id', wrap(async (req, res) => {
  const cls = await store.get('classes', req.params.id);
  if (!cls) return res.status(404).json({ error: 'Not found.' });
  if (req.body?.name) cls.name = String(req.body.name).trim().slice(0, 80);
  if ('contextId' in (req.body || {})) cls.contextId = req.body.contextId || null;
  if (req.body?.personaSet) Object.assign(cls, readPersonas(req.body));
  const count = Math.floor(Number(req.body?.count));
  if (count > cls.students.length && count <= 60) {
    const codes = generateCodes(count - cls.students.length, await allCodes());
    codes.forEach((code) => {
      const n = cls.students.length + 1;
      cls.students.push({ n, label: `Student ${n}`, code });
    });
  }
  await store.put('classes', cls.id, cls);
  res.json(classSummary(cls));
}));

api.delete('/classes/:id', wrap(async (req, res) => {
  if (live?.cls.id === req.params.id) return res.status(409).json({ error: 'That class is in an activity right now.' });
  await store.remove('classes', req.params.id);
  res.json({ ok: true });
}));

api.get('/classes/:id/cards.pdf', wrap(async (req, res) => {
  const cls = await store.get('classes', req.params.id);
  if (!cls) return res.status(404).json({ error: 'Not found.' });
  const pdf = buildCardsPdf({ title: cls.name, joinUrl: joinUrl(req).replace(/^https?:\/\//, ''), cards: cls.students });
  res.setHeader('content-type', 'application/pdf');
  res.setHeader('content-disposition', `attachment; filename="${cls.name.replace(/[^\w -]+/g, '').trim() || 'class'} - login cards.pdf"`);
  res.send(pdf);
}));

// --------------------------------------------------------------- activities

const activitySummary = (a) => ({
  id: a.id, name: a.name, className: a.className, contextName: a.contextName, status: a.status,
  rounds: a.rounds.length, planned: ensurePlan(a).plan.length, mode: modeInfo(a.mode).short,
  hasOverview: Boolean(a.overview), createdAt: a.createdAt, finishedAt: a.finishedAt || null,
  fooled: a.rounds.map((r) => r.stats?.aiFooledRate ?? null),
});

api.get('/activities', wrap(async (_req, res) => {
  const all = await store.list('activities');
  res.json(all.sort((a, b) => b.createdAt - a.createdAt).map(activitySummary));
}));

api.post('/activities', wrap(async (req, res) => {
  if (live && live.phase !== PHASES.FINISHED) {
    return res.status(409).json({ error: `"${live.record.name}" is still running. Finish it first.` });
  }
  const cls = await store.get('classes', req.body?.classId);
  if (!cls) return res.status(400).json({ error: 'Choose a class.' });
  const name = String(req.body?.name || '').trim().slice(0, 80);
  if (!name) return res.status(400).json({ error: 'Name the activity, e.g. "Preservice teachers, week 6".' });
  const context = cls.contextId ? await store.get('contexts', cls.contextId) : null;
  const mode = MODES[req.body?.mode] ? req.body.mode : 'learn4';
  const record = {
    id: newId('act'),
    name,
    classId: cls.id,
    className: cls.name,
    contextId: context?.id || null,
    contextName: context ? (context.title || context.name) : null,
    contextBrief: context?.brief || '',
    personaSet: cls.personaSet,
    personaSetLabel: personaSet(cls.personaSet).label,
    personas: cls.personas,
    durationSec: Math.max(60, Math.min(600, Number(req.body?.durationSec) || 180)),
    aiRatio: Math.max(0.2, Math.min(0.8, Number(req.body?.aiRatio) || 0.5)),
    models: models(),
    mode,
    blockSize: mode === 'open' ? clampBlock(req.body?.blockSize) : null,
    plan: buildPlan(mode, { finalModels: req.body?.finalModels, models: req.body?.models, blockSize: req.body?.blockSize }),
    status: 'live',
    createdAt: Date.now(),
    rounds: [],
  };
  await store.put('activities', record.id, record);
  startLive(new LiveActivity({ record, cls, context, store }));
  res.json(activitySummary(record));
}));

api.get('/activities/:id/zip', wrap(async (req, res) => {
  const record = await store.get('activities', req.params.id);
  if (!record) return res.status(404).json({ error: 'Not found.' });
  const cls = await store.get('classes', record.classId);
  const context = (record.contextId && await store.get('contexts', record.contextId)) || (record.contextBrief ? { brief: record.contextBrief } : null);
  const { name, buffer } = activityZip({ record, cls, context });
  res.setHeader('content-type', 'application/zip');
  res.setHeader('content-disposition', `attachment; filename="${name}"`);
  res.send(buffer);
}));

api.get('/activities/:id/overview', wrap(async (req, res) => {
  const record = await store.get('activities', req.params.id);
  if (!record) return res.status(404).json({ error: 'Not found.' });
  res.json(overviewData(record));
}));

api.delete('/activities/:id', wrap(async (req, res) => {
  if (live?.record.id === req.params.id && live.phase !== PHASES.FINISHED) {
    return res.status(409).json({ error: 'That activity is running.' });
  }
  await store.remove('activities', req.params.id);
  res.json({ ok: true });
}));

// ------------------------------------------------------------------- backup

api.get('/backup', wrap(async (_req, res) => {
  const backup = {
    format: 'human-or-not-workspace',
    version: 1,
    savedAt: new Date().toISOString(),
    contexts: await store.list('contexts'),
    classes: await store.list('classes'),
    activities: await store.list('activities'),
  };
  res.setHeader('content-type', 'application/json');
  res.setHeader('content-disposition', `attachment; filename="human-or-not-backup-${backup.savedAt.slice(0, 10)}.json"`);
  res.send(JSON.stringify(backup));
}));

api.post('/restore', wrap(async (req, res) => {
  const backup = req.body;
  if (backup?.format !== 'human-or-not-workspace') return res.status(400).json({ error: 'That is not a Human or Not? backup file.' });
  const counts = {};
  for (const collection of ['contexts', 'classes', 'activities']) {
    counts[collection] = 0;
    for (const record of Array.isArray(backup[collection]) ? backup[collection] : []) {
      if (!record?.id || !/^[A-Za-z0-9_-]{1,80}$/.test(record.id)) continue;
      if (collection === 'activities' && record.status === 'live') record.status = 'interrupted';
      await store.put(collection, record.id, record);
      counts[collection] += 1;
    }
  }
  res.json({ ok: true, counts });
}));

// ------------------------------------------------------------ live activity

const teacherSockets = new Set();
const studentSockets = new Map(); // n -> socket id, for the live activity

function pushTeachers() {
  const view = live ? live.teacherView() : null;
  for (const id of teacherSockets) io.sockets.sockets.get(id)?.emit('live', view);
}
let queued = false;
function queueTeachers() {
  if (queued) return;
  queued = true;
  setImmediate(() => { queued = false; pushTeachers(); });
}
function pushStudent(n) {
  const id = studentSockets.get(n);
  if (id && live) io.sockets.sockets.get(id)?.emit('state', live.studentView(n));
}

function startLive(activity) {
  if (live) live.removeAllListeners();
  live = activity;
  studentSockets.clear();
  live.on('phase', () => { for (const n of studentSockets.keys()) pushStudent(n); queueTeachers(); });
  live.on('roster', () => { queueTeachers(); for (const n of studentSockets.keys()) pushStudent(n); });
  live.on('message', (n, payload) => io.sockets.sockets.get(studentSockets.get(n))?.emit('message', payload));
  live.on('typing', (n, on) => io.sockets.sockets.get(studentSockets.get(n))?.emit('typing', on));
  live.on('typingOff', () => io.emit('typing', false));
  // Students waiting on the code screen join as soon as there is something to join.
  io.emit('activity:started');
  queueTeachers();
}

io.on('connection', (socket) => {
  let role = null;

  socket.on('student:join', (payload, ack) => {
    if (!live || live.phase === PHASES.FINISHED) return ack?.({ ok: false, code: 'not_started', error: 'Your teacher has not started an activity yet.' });
    const result = live.join(payload?.code, socket.id);
    if (!result.ok) return ack?.(result);
    role = 'student';
    socket.data.n = result.n;
    socket.data.activityId = live.record.id;
    const previous = studentSockets.get(result.n);
    if (previous && previous !== socket.id) io.sockets.sockets.get(previous)?.emit('replaced');
    studentSockets.set(result.n, socket.id);
    ack?.({ ok: true, label: result.label, code: result.code, activity: live.record.name });
    pushStudent(result.n);
  });

  const mine = () => role === 'student' && live && socket.data.activityId === live.record.id;

  socket.on('chat:send', (payload, ack) => {
    if (!mine()) return ack?.({ ok: false, error: 'Not signed in.' });
    ack?.(live.sendMessage(socket.data.n, payload?.text));
  });
  socket.on('chat:typing', (on) => { if (mine()) live.setTyping(socket.data.n, on); });
  socket.on('guess', (payload, ack) => {
    if (!mine()) return ack?.({ ok: false, error: 'Not signed in.' });
    const result = live.guess(socket.data.n, payload?.guess);
    ack?.(result);
    pushStudent(socket.data.n);
  });

  socket.on('teacher:auth', (payload, ack) => {
    if (String(payload?.code || '') !== TEACHER_CODE) return ack?.({ ok: false, error: 'Wrong teacher code.' });
    role = 'teacher';
    teacherSockets.add(socket.id);
    ack?.({ ok: true });
    socket.emit('live', live ? live.teacherView() : null);
  });

  const command = (event, run) => socket.on(event, async (payload, ack) => {
    if (role !== 'teacher') return ack?.({ ok: false, error: 'Not authorised.' });
    if (!live) return ack?.({ ok: false, error: 'No activity is running.' });
    const result = (await run(payload || {})) || { ok: true };
    ack?.(result);
    queueTeachers();
  });
  command('live:startRound', () => live.startRound());
  command('live:endRound', () => live.endRound());
  command('live:results', () => live.showResults());
  command('live:retryAnalysis', () => live.retryAnalysis());
  command('live:overview', () => live.showOverview());
  command('live:setModels', (p) => live.setModels(p.models));
  command('live:moreRounds', () => {
    const result = live.moreRounds();
    for (const n of studentSockets.keys()) pushStudent(n);
    return result;
  });
  command('live:retryOverview', () => live.retryOverview());
  command('live:finish', async () => {
    const result = await live.finish();
    for (const n of studentSockets.keys()) pushStudent(n);
    return result;
  });

  socket.on('disconnect', () => {
    teacherSockets.delete(socket.id);
    if (role === 'student' && live) live.disconnect(socket.id);
  });
});

// The countdown on the console stays accurate without a push every tick.
setInterval(() => { if (live?.phase === PHASES.ACTIVE) queueTeachers(); }, 5000);

server.listen(PORT, () => {
  console.log(`[server] Listening on ${PORT}. Teacher console: /teacher`);
});
