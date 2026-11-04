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
import { TEACHERS, findTeacher, ownerOf, publicTeachers, teacherWarnings } from './teachers.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(here, '..', 'public');
const templateDir = path.join(here, '..', 'templates');

const PORT = Number(process.env.PORT || 3000);
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
console.log(`[server] Teachers: ${TEACHERS.map((t) => `${t.name} (/teacher/${t.id}${t.code ? '' : ', not set up'})`).join(', ')}`);
for (const warning of teacherWarnings()) console.warn(`[server] ${warning}`);

// An activity that was live when the server stopped cannot be resumed; keep it
// downloadable and say what happened.
for (const record of await store.list('activities')) {
  if (record.status === 'live') {
    record.status = 'interrupted';
    await store.put('activities', record.id, record);
  }
}

/** The activity each teacher is running right now, by teacher id. */
const lives = new Map();
const liveFor = (teacherId) => lives.get(teacherId) || null;

// --------------------------------------------------------------------- http

const app = express();
const server = http.createServer(app);
const io = new SocketServer(server);

app.use(express.json({ limit: '25mb' }));
app.use(express.static(publicDir));
// /teacher lists the teacher consoles; /teacher/1, /teacher/2 … are the consoles.
app.get('/teacher', (_req, res) => res.sendFile(path.join(publicDir, 'teachers.html')));
app.get('/teacher/:id', (req, res, next) => {
  if (!TEACHERS.some((t) => t.id === req.params.id)) return next();
  res.sendFile(path.join(publicDir, 'teacher.html'));
});
app.get('/teachers.json', (_req, res) => res.json(publicTeachers()));
// Pinged by the open teacher console so a free Render instance does not fall
// asleep in the middle of a lesson.
app.get('/healthz', (_req, res) => res.json({ ok: true, live: [...lives.values()].filter((l) => l.phase !== PHASES.FINISHED).length }));

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

/** Every /api route below needs a teacher's slot and password, and sees only that teacher's things. */
function teacherOnly(req, res, next) {
  const teacher = findTeacher(req.get('x-teacher-id') || '1', req.get('x-teacher-code'));
  if (!teacher) return res.status(401).json({ error: 'Wrong password for this teacher.' });
  req.teacher = teacher;
  next();
}

/** A stored record, only if it belongs to the signed-in teacher. */
async function owned(req, collection, id) {
  const record = await store.get(collection, id);
  return record && ownerOf(record) === req.teacher.id ? record : null;
}
const mineOnly = (req, list) => list.filter((r) => ownerOf(r) === req.teacher.id);
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
    teacher: { id: req.teacher.id, name: req.teacher.name },
    live: (() => { const live = liveFor(req.teacher.id); return live ? { id: live.record.id, name: live.record.name, phase: live.phase } : null; })(),
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

api.get('/contexts', wrap(async (req, res) => {
  const all = mineOnly(req, await store.list('contexts'));
  res.json(all.sort((a, b) => b.createdAt - a.createdAt).map(contextSummary));
}));

api.get('/contexts/:id', wrap(async (req, res) => {
  const context = await owned(req, 'contexts', req.params.id);
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
    teacherId: req.teacher.id,
    name: String(req.body?.name || 'My class').trim().slice(0, 80) || 'My class',
    files, words, status: 'training', createdAt: Date.now(), updatedAt: Date.now(),
    learnings: [], sampleMessages: [], brief: '',
  };
  await store.put('contexts', context.id, context);
  runTraining(context.id);
  res.json(contextSummary(context));
}));

api.put('/contexts/:id', wrap(async (req, res) => {
  const context = await owned(req, 'contexts', req.params.id);
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
  if (!await owned(req, 'contexts', req.params.id)) return res.status(404).json({ error: 'Not found.' });
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

api.get('/classes', wrap(async (req, res) => {
  const all = mineOnly(req, await store.list('classes'));
  res.json(all.sort((a, b) => b.createdAt - a.createdAt).map(classSummary));
}));

api.get('/classes/:id', wrap(async (req, res) => {
  const cls = await owned(req, 'classes', req.params.id);
  if (!cls) return res.status(404).json({ error: 'Not found.' });
  res.json(cls);
}));

api.post('/classes', wrap(async (req, res) => {
  const name = String(req.body?.name || '').trim().slice(0, 80);
  const count = Math.floor(Number(req.body?.count));
  if (!name) return res.status(400).json({ error: 'Give the class a name.' });
  if (!(count >= 1 && count <= 60)) return res.status(400).json({ error: 'Between 1 and 60 students.' });
  const contextId = req.body?.contextId && await owned(req, 'contexts', req.body.contextId) ? req.body.contextId : null;
  const codes = generateCodes(count, await allCodes());
  const cls = {
    id: newId('cls'),
    teacherId: req.teacher.id,
    name,
    ...readPersonas(req.body),
    contextId,
    students: codes.map((code, i) => ({ n: i + 1, label: `Student ${i + 1}`, code })),
    createdAt: Date.now(),
  };
  await store.put('classes', cls.id, cls);
  res.json(classSummary(cls));
}));

api.put('/classes/:id', wrap(async (req, res) => {
  const cls = await owned(req, 'classes', req.params.id);
  if (!cls) return res.status(404).json({ error: 'Not found.' });
  if (req.body?.name) cls.name = String(req.body.name).trim().slice(0, 80);
  if ('contextId' in (req.body || {})) {
    cls.contextId = req.body.contextId && await owned(req, 'contexts', req.body.contextId) ? req.body.contextId : null;
  }
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
  if (!await owned(req, 'classes', req.params.id)) return res.status(404).json({ error: 'Not found.' });
  const live = liveFor(req.teacher.id);
  if (live?.cls.id === req.params.id && live.phase !== PHASES.FINISHED) return res.status(409).json({ error: 'That class is in an activity right now.' });
  await store.remove('classes', req.params.id);
  res.json({ ok: true });
}));

api.get('/classes/:id/cards.pdf', wrap(async (req, res) => {
  const cls = await owned(req, 'classes', req.params.id);
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

api.get('/activities', wrap(async (req, res) => {
  const all = mineOnly(req, await store.list('activities'));
  res.json(all.sort((a, b) => b.createdAt - a.createdAt).map(activitySummary));
}));

api.post('/activities', wrap(async (req, res) => {
  const running = liveFor(req.teacher.id);
  if (running && running.phase !== PHASES.FINISHED) {
    return res.status(409).json({ error: `"${running.record.name}" is still running. Finish it first.` });
  }
  const cls = await owned(req, 'classes', req.body?.classId);
  if (!cls) return res.status(400).json({ error: 'Choose a class.' });
  const name = String(req.body?.name || '').trim().slice(0, 80);
  if (!name) return res.status(400).json({ error: 'Name the activity, e.g. "Preservice teachers, week 6".' });
  const context = cls.contextId ? await owned(req, 'contexts', cls.contextId) : null;
  const mode = MODES[req.body?.mode] ? req.body.mode : 'learn4';
  const record = {
    id: newId('act'),
    teacherId: req.teacher.id,
    teacherName: req.teacher.name,
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
  startLive(req.teacher.id, new LiveActivity({ record, cls, context, store }));
  res.json(activitySummary(record));
}));

api.get('/activities/:id/zip', wrap(async (req, res) => {
  const record = await owned(req, 'activities', req.params.id);
  if (!record) return res.status(404).json({ error: 'Not found.' });
  const cls = await store.get('classes', record.classId);
  const context = (record.contextId && await store.get('contexts', record.contextId)) || (record.contextBrief ? { brief: record.contextBrief } : null);
  const { name, buffer } = activityZip({ record, cls, context });
  res.setHeader('content-type', 'application/zip');
  res.setHeader('content-disposition', `attachment; filename="${name}"`);
  res.send(buffer);
}));

api.get('/activities/:id/overview', wrap(async (req, res) => {
  const record = await owned(req, 'activities', req.params.id);
  if (!record) return res.status(404).json({ error: 'Not found.' });
  res.json(overviewData(record));
}));

api.delete('/activities/:id', wrap(async (req, res) => {
  if (!await owned(req, 'activities', req.params.id)) return res.status(404).json({ error: 'Not found.' });
  const live = liveFor(req.teacher.id);
  if (live?.record.id === req.params.id && live.phase !== PHASES.FINISHED) {
    return res.status(409).json({ error: 'That activity is running.' });
  }
  await store.remove('activities', req.params.id);
  res.json({ ok: true });
}));

// ------------------------------------------------------------------- backup

api.get('/backup', wrap(async (req, res) => {
  const backup = {
    format: 'human-or-not-workspace',
    version: 1,
    teacher: req.teacher.name,
    savedAt: new Date().toISOString(),
    contexts: mineOnly(req, await store.list('contexts')),
    classes: mineOnly(req, await store.list('classes')),
    activities: mineOnly(req, await store.list('activities')),
  };
  res.setHeader('content-type', 'application/json');
  res.setHeader('content-disposition', `attachment; filename="human-or-not-backup-teacher-${req.teacher.id}-${backup.savedAt.slice(0, 10)}.json"`);
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
      // Never overwrite another teacher's record; a restore lands in this teacher's workspace.
      const existing = await store.get(collection, record.id);
      if (existing && ownerOf(existing) !== req.teacher.id) continue;
      record.teacherId = req.teacher.id;
      if (collection === 'activities' && record.status === 'live') record.status = 'interrupted';
      await store.put(collection, record.id, record);
      counts[collection] += 1;
    }
  }
  res.json({ ok: true, counts });
}));

// ------------------------------------------------------------ live activity
//
// Each teacher can have one activity live; several teachers can run theirs at
// once. Students are routed by their login code, which is unique across every
// teacher's classes.

const teacherSockets = new Map(); // teacher id -> Set of socket ids

const sendTo = (id, event, payload) => { if (id) io.sockets.sockets.get(id)?.emit(event, payload); };

function pushTeachers(teacherId) {
  const live = liveFor(teacherId);
  const view = live ? live.teacherView() : null;
  for (const id of teacherSockets.get(teacherId) || []) sendTo(id, 'live', view);
}
const queued = new Set();
function queueTeachers(teacherId) {
  if (queued.has(teacherId)) return;
  queued.add(teacherId);
  setImmediate(() => { queued.delete(teacherId); pushTeachers(teacherId); });
}
function pushStudent(live, n) {
  if (live) sendTo(live.studentSockets.get(n), 'state', live.studentView(n));
}
const pushStudents = (live) => { for (const n of live.studentSockets.keys()) pushStudent(live, n); };

function startLive(teacherId, activity) {
  const previous = liveFor(teacherId);
  if (previous) previous.removeAllListeners();
  const live = activity;
  live.studentSockets = new Map(); // n -> socket id
  lives.set(teacherId, live);
  live.on('phase', () => { pushStudents(live); queueTeachers(teacherId); });
  live.on('roster', () => { queueTeachers(teacherId); pushStudents(live); });
  live.on('message', (n, payload) => sendTo(live.studentSockets.get(n), 'message', payload));
  live.on('typing', (n, on) => sendTo(live.studentSockets.get(n), 'typing', on));
  live.on('typingOff', () => { for (const id of live.studentSockets.values()) sendTo(id, 'typing', false); });
  // Students waiting on the code screen join as soon as there is something to join.
  io.emit('activity:started');
  queueTeachers(teacherId);
}

/** The running activity whose class holds this login code. */
function liveForCode(rawCode) {
  const code = String(rawCode || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  for (const live of lives.values()) {
    if (live.phase !== PHASES.FINISHED && live.codes.has(code)) return live;
  }
  return null;
}

io.on('connection', (socket) => {
  let role = null;
  let teacher = null;
  let studentLive = null;

  socket.on('student:join', (payload, ack) => {
    const live = liveForCode(payload?.code);
    if (!live) {
      const anyRunning = [...lives.values()].some((l) => l.phase !== PHASES.FINISHED);
      return ack?.(anyRunning
        ? { ok: false, error: 'That code is not part of an activity that is running. Check it with your teacher.' }
        : { ok: false, code: 'not_started', error: 'Your teacher has not started an activity yet.' });
    }
    if (studentLive && studentLive !== live) studentLive.disconnect(socket.id);
    const result = live.join(payload?.code, socket.id);
    if (!result.ok) return ack?.(result);
    role = 'student';
    studentLive = live;
    socket.data.n = result.n;
    const previous = live.studentSockets.get(result.n);
    if (previous && previous !== socket.id) sendTo(previous, 'replaced');
    live.studentSockets.set(result.n, socket.id);
    ack?.({ ok: true, label: result.label, code: result.code, activity: live.record.name });
    pushStudent(live, result.n);
  });

  const mine = () => role === 'student' && studentLive && liveFor(ownerOf(studentLive.record)) === studentLive
    && studentLive.studentSockets.get(socket.data.n) === socket.id;

  socket.on('chat:send', (payload, ack) => {
    if (!mine()) return ack?.({ ok: false, error: 'Not signed in.' });
    ack?.(studentLive.sendMessage(socket.data.n, payload?.text));
  });
  socket.on('chat:typing', (on) => { if (mine()) studentLive.setTyping(socket.data.n, on); });
  socket.on('guess', (payload, ack) => {
    if (!mine()) return ack?.({ ok: false, error: 'Not signed in.' });
    const result = studentLive.guess(socket.data.n, payload?.guess);
    ack?.(result);
    pushStudent(studentLive, socket.data.n);
  });

  socket.on('teacher:auth', (payload, ack) => {
    const found = findTeacher(payload?.teacher || '1', payload?.code);
    if (!found) return ack?.({ ok: false, error: 'Wrong password for this teacher.' });
    if (teacher) teacherSockets.get(teacher.id)?.delete(socket.id);
    role = 'teacher';
    teacher = found;
    if (!teacherSockets.has(teacher.id)) teacherSockets.set(teacher.id, new Set());
    teacherSockets.get(teacher.id).add(socket.id);
    ack?.({ ok: true });
    const live = liveFor(teacher.id);
    socket.emit('live', live ? live.teacherView() : null);
  });

  const command = (event, run) => socket.on(event, async (payload, ack) => {
    if (role !== 'teacher' || !teacher) return ack?.({ ok: false, error: 'Not authorised.' });
    const live = liveFor(teacher.id);
    if (!live) return ack?.({ ok: false, error: 'No activity is running.' });
    const result = (await run(live, payload || {})) || { ok: true };
    ack?.(result);
    queueTeachers(teacher.id);
  });
  command('live:startRound', (live) => live.startRound());
  command('live:endRound', (live) => live.endRound());
  command('live:results', (live) => live.showResults());
  command('live:retryAnalysis', (live) => live.retryAnalysis());
  command('live:overview', (live) => live.showOverview());
  command('live:setModels', (live, p) => live.setModels(p.models));
  command('live:moreRounds', (live) => {
    const result = live.moreRounds();
    pushStudents(live);
    return result;
  });
  command('live:retryOverview', (live) => live.retryOverview());
  command('live:finish', async (live) => {
    const result = await live.finish();
    pushStudents(live);
    return result;
  });

  socket.on('disconnect', () => {
    if (teacher) teacherSockets.get(teacher.id)?.delete(socket.id);
    if (role === 'student' && studentLive) studentLive.disconnect(socket.id);
  });
});

// The countdown on the console stays accurate without a push every tick.
setInterval(() => {
  for (const [teacherId, live] of lives) if (live.phase === PHASES.ACTIVE) queueTeachers(teacherId);
}, 5000);

server.listen(PORT, () => {
  console.log(`[server] Listening on ${PORT}. Teacher consoles: ${TEACHERS.map((t) => `/teacher/${t.id}`).join(', ')}`);
});
