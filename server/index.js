import 'dotenv/config';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { marked } from 'marked';
import { Server as SocketServer } from 'socket.io';
import { openStore, newId } from './store.js';
import { hasApiKey, models, resolveModels } from './claude.js';
import { analystInfo, contextWordCount, extractSamples, trainContext } from './analysis.js';
import { PERSONA_SETS, personaCatalog, personaSet } from './personas.js';
import { buildCardsPdf, generateCodes } from './pdf.js';
import { LiveActivity, PHASES, MAX_ACTIVITY_STUDENTS, MAX_CLASS_STUDENTS } from './activity.js';
import { MODES, MAX_ROUNDS, buildPlan, clampBlock, ensurePlan, modeInfo } from './modes.js';
import { activityZip, classZip, overviewData, saveName } from './report.js';
import { createZip } from './zip.js';
import { ADMIN_ID, TEACHERS, findTeacher, isAdmin, ownerOf, publicTeachers, teacherWarnings } from './teachers.js';

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
  ? `[server] Claude models: ${Object.values(models()).map((m) => `${m.label} (${m.id}, ${m.source})`).join(', ')}; briefs and analysis: ${analystInfo().label} at ${analystInfo().effort} effort`
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

// The README, as the "About" section under the teacher list. The developer
// sections at the end are left out; screenshots are served from docs/.
const aboutHtml = (() => {
  try {
    const readme = fs.readFileSync(path.join(here, '..', 'README.md'), 'utf8');
    const forTeachers = readme.split(/^## Running it on your own computer/m)[0].replace(/\n---\s*$/, '');
    return marked.parse(forTeachers.replace(/(["(])docs\/screenshots\//g, '$1/docs/screenshots/'));
  } catch (err) {
    console.warn('[server] Could not read README.md:', err.message);
    return '<p>The guide is not available on this server.</p>';
  }
})();
app.get('/about.html', (_req, res) => res.type('html').send(aboutHtml));
app.use('/docs/screenshots', express.static(path.join(here, '..', 'docs', 'screenshots')));
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

/**
 * Every /api route below needs a teacher's slot and password. Teacher 1 is the
 * admin: only they change the setup (contexts, classes, backups), and what
 * they set up is available to every teacher. Each teacher runs and sees their
 * own activities; the admin sees everyone's.
 */
function teacherOnly(req, res, next) {
  const teacher = findTeacher(req.get('x-teacher-id') || '1', req.get('x-teacher-code'));
  if (!teacher) return res.status(401).json({ error: 'Wrong password for this teacher.' });
  req.teacher = { ...teacher, admin: isAdmin(teacher) };
  next();
}
function adminOnly(req, res, next) {
  if (req.teacher?.admin) return next();
  res.status(403).json({ error: `Only ${TEACHERS.find((t) => t.id === ADMIN_ID)?.name || 'Teacher 1'} (the admin) can change the setup.` });
}
/** Activities: your own, or everyone's for the admin. */
const canSeeActivity = (req, a) => Boolean(a) && (req.teacher.admin || ownerOf(a) === req.teacher.id);
async function visibleActivity(req, id) {
  const record = await store.get('activities', id);
  return canSeeActivity(req, record) ? record : null;
}

/** A stored record, only if it belongs to the signed-in teacher. */
async function owned(req, collection, id) {
  const record = await store.get(collection, id);
  return record && ownerOf(record) === req.teacher.id ? record : null;
}
const api = express.Router();
api.use(teacherOnly);
app.use('/api', api);

const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((err) => {
  console.error('[api]', err);
  res.status(500).json({ error: err.message || 'Something went wrong.' });
});

/**
 * The address students type: PUBLIC_URL if set; otherwise the address the
 * teacher is using right now (so a custom domain just works); otherwise
 * Render's own onrender.com address.
 */
function joinUrl(req) {
  const fixed = (process.env.PUBLIC_URL || '').trim().replace(/\/+$/, '');
  if (fixed) return /^https?:\/\//.test(fixed) ? fixed : `https://${fixed}`;
  const host = req.get('host');
  if (host && !/^(localhost|127\.)/.test(host) && process.env.RENDER) return `https://${host}`;
  if (host) return `${req.protocol}://${host}`;
  return (process.env.RENDER_EXTERNAL_URL || '').replace(/\/+$/, '');
}

api.get('/meta', wrap(async (req, res) => {
  res.json({
    hasApiKey: hasApiKey(),
    models: models(),
    analyst: analystInfo(),
    personaSets: personaCatalog(),
    modes: Object.values(MODES),
    maxStudentsPerClass: MAX_CLASS_STUDENTS,
    maxStudentsPerActivity: MAX_ACTIVITY_STUDENTS,
    maxRounds: MAX_ROUNDS,
    storage: { kind: store.kind, description: store.describe(), persistent: !onFreeRenderDisk },
    joinUrl: joinUrl(req).replace(/^https?:\/\//, ''),
    teacher: { id: req.teacher.id, name: req.teacher.name, admin: req.teacher.admin },
    teachers: publicTeachers(),
    live: (() => { const live = liveFor(req.teacher.id); return live ? { id: live.record.id, name: live.record.name, phase: live.phase } : null; })(),
  });
}));

// ----------------------------------------------------------------- contexts

/** Can this teacher use a context: their own, or one shared with them. */
const canUse = (req, c) => Boolean(c) && (ownerOf(c) === req.teacher.id || ownerOf(c) === ADMIN_ID || (c.sharedWith || []).includes(req.teacher.id));
async function usable(req, id) {
  const context = id ? await store.get('contexts', id) : null;
  return canUse(req, context) ? context : null;
}
const teacherName = (id) => TEACHERS.find((t) => t.id === id)?.name || `Teacher ${id}`;
const MAX_UPDATE = 4000;

/** The bits of a context the list view needs (not the whole brief). */
const contextSummary = (req) => (c) => {
  const mine = ownerOf(c) === req.teacher.id;
  return {
    id: c.id, name: c.name, title: c.title, status: c.status, error: c.error || null, summary: c.summary,
    strengths: c.strengths || [], gaps: c.gaps || [], words: c.words, samples: (c.sampleMessages || []).length,
    learnings: (c.learnings || []).length, createdAt: c.createdAt, updatedAt: c.updatedAt,
    files: Object.fromEntries(Object.entries(c.files || {}).map(([k, v]) => [k, Boolean(v && v.trim())])),
    mine,
    owner: { id: ownerOf(c), name: teacherName(ownerOf(c)) },
    sharedWith: mine ? (c.sharedWith || []) : [],
    updates: (c.updates || []).map((u) => ({ id: u.id, text: u.text, at: u.at })),
  };
};

/**
 * Rebuild a context's brief from its files and updates. If the files or
 * updates change while Claude is working, it goes round again so the newest
 * version always wins.
 */
async function runTraining(id) {
  const context = await store.get('contexts', id);
  if (!context) return;
  const revision = context.revision || 0;
  let result = null;
  let error = null;
  try {
    result = await trainContext({ name: context.name, files: context.files, updates: context.updates || [] });
  } catch (err) {
    console.warn('[train] failed:', err.message);
    error = err;
  }
  const fresh = await store.get('contexts', id);
  if (!fresh) return;
  if ((fresh.revision || 0) !== revision) return runTraining(id);
  if (result) {
    Object.assign(fresh, {
      title: result.title, summary: result.summary, brief: result.brief, sampleMessages: result.sampleMessages,
      strengths: result.strengths, gaps: result.gaps, model: result.model, status: 'ready', error: null,
      trainedAt: Date.now(), updatedAt: Date.now(),
    });
  } else {
    fresh.status = 'failed';
    fresh.error = error.message;
    // Still usable: the bots can read the files directly.
    fresh.brief = fresh.brief || Object.values(fresh.files).join('\n\n');
    fresh.sampleMessages = fresh.sampleMessages?.length ? fresh.sampleMessages : extractSamples(fresh.files.voice);
  }
  await store.put('contexts', id, fresh);
}

/** Save a changed context and start training it again. */
async function retrain(context) {
  context.revision = (context.revision || 0) + 1;
  context.status = 'training';
  context.updatedAt = Date.now();
  await store.put('contexts', context.id, context);
  runTraining(context.id);
}

api.get('/contexts', wrap(async (req, res) => {
  const all = (await store.list('contexts')).filter((c) => canUse(req, c));
  // Your own first, then those shared with you; newest first within each.
  all.sort((a, b) => (ownerOf(b) === req.teacher.id) - (ownerOf(a) === req.teacher.id) || b.createdAt - a.createdAt);
  res.json(all.map(contextSummary(req)));
}));

api.get('/contexts/:id', wrap(async (req, res) => {
  const context = await usable(req, req.params.id);
  if (!context) return res.status(404).json({ error: 'Not found.' });
  res.json({ ...context, mine: ownerOf(context) === req.teacher.id, owner: { id: ownerOf(context), name: teacherName(ownerOf(context)) } });
}));

api.post('/contexts', adminOnly, wrap(async (req, res) => {
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
    learnings: [], sampleMessages: [], brief: '', updates: [], sharedWith: [], revision: 0,
  };
  await store.put('contexts', context.id, context);
  runTraining(context.id);
  res.json(contextSummary(req)(context));
}));

api.put('/contexts/:id', adminOnly, wrap(async (req, res) => {
  const context = await owned(req, 'contexts', req.params.id);
  if (!context) return res.status(404).json({ error: 'Only the teacher who made this context can change it.' });
  for (const key of ['about', 'learned', 'voice']) {
    if (typeof req.body?.files?.[key] === 'string' && req.body.files[key].trim()) context.files[key] = req.body.files[key];
  }
  if (req.body?.name) context.name = String(req.body.name).slice(0, 80);
  context.words = contextWordCount(context.files);
  await retrain(context);
  res.json(contextSummary(req)(context));
}));

// A written update on top of the files: "Today we covered…". Dated, kept in
// order, and given priority over the files where they disagree.
api.post('/contexts/:id/updates', adminOnly, wrap(async (req, res) => {
  const context = await owned(req, 'contexts', req.params.id);
  if (!context) return res.status(404).json({ error: 'Only the teacher who made this context can update it.' });
  const text = String(req.body?.text || '').trim().slice(0, MAX_UPDATE);
  if (text.length < 3) return res.status(400).json({ error: 'Write the update first.' });
  context.updates = [...(context.updates || []), { id: newId('upd'), text, at: Date.now() }].slice(-30);
  await retrain(context);
  res.json(contextSummary(req)(context));
}));

api.delete('/contexts/:id/updates/:updateId', adminOnly, wrap(async (req, res) => {
  const context = await owned(req, 'contexts', req.params.id);
  if (!context) return res.status(404).json({ error: 'Only the teacher who made this context can change it.' });
  const before = (context.updates || []).length;
  context.updates = (context.updates || []).filter((u) => u.id !== req.params.updateId);
  if (context.updates.length === before) return res.status(404).json({ error: 'Not found.' });
  await retrain(context);
  res.json(contextSummary(req)(context));
}));

// Share with other teachers: they can use it for their classes, read it and
// copy it, but only the owner can change it.
api.put('/contexts/:id/share', adminOnly, wrap(async (req, res) => {
  const context = await owned(req, 'contexts', req.params.id);
  if (!context) return res.status(404).json({ error: 'Only the teacher who made this context can share it.' });
  const valid = new Set(TEACHERS.map((t) => t.id).filter((id) => id !== req.teacher.id));
  context.sharedWith = [...new Set((Array.isArray(req.body?.teachers) ? req.body.teachers : []).map(String))].filter((id) => valid.has(id));
  context.updatedAt = Date.now();
  await store.put('contexts', context.id, context);
  res.json(contextSummary(req)(context));
}));

// Make your own editable copy of a context (your own or one shared with you).
api.post('/contexts/:id/copy', adminOnly, wrap(async (req, res) => {
  const source = await usable(req, req.params.id);
  if (!source) return res.status(404).json({ error: 'Not found.' });
  const copy = {
    ...structuredClone(source),
    id: newId('ctx'),
    teacherId: req.teacher.id,
    name: `${source.name} (copy)`.slice(0, 80),
    title: source.title ? `${source.title} (copy)`.slice(0, 120) : source.title,
    sharedWith: [],
    learnings: [],
    copiedFrom: { id: source.id, owner: teacherName(ownerOf(source)) },
    createdAt: Date.now(),
    updatedAt: Date.now(),
    revision: 0,
  };
  if (copy.status === 'training') copy.status = 'ready';
  await store.put('contexts', copy.id, copy);
  res.json(contextSummary(req)(copy));
}));

api.delete('/contexts/:id', adminOnly, wrap(async (req, res) => {
  if (!await owned(req, 'contexts', req.params.id)) return res.status(404).json({ error: 'Only the teacher who made this context can delete it.' });
  await store.remove('contexts', req.params.id);
  res.json({ ok: true });
}));

// ------------------------------------------------------------------ classes

const classSummary = (req) => (c) => {
  const mine = ownerOf(c) === req.teacher.id;
  return {
    id: c.id, name: c.name, size: c.students.length, personaSet: c.personaSet,
    personaSetLabel: personaSet(c.personaSet).label, personas: c.personas, contextId: c.contextId,
    createdAt: c.createdAt, mine, owner: { id: ownerOf(c), name: teacherName(ownerOf(c)) },
    sharedWith: mine ? (c.sharedWith || []) : [],
  };
};

/** A class this teacher may run activities with: their own, or one shared with them. */
async function usableClass(req, id) {
  const cls = id ? await store.get('classes', id) : null;
  return canUse(req, cls) ? cls : null;
}
/** Is any teacher running an activity with this class right now? */
const classInUse = (id) => [...lives.values()].some((l) => l.cls.id === id && l.phase !== PHASES.FINISHED);

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
  const all = (await store.list('classes')).filter((c) => canUse(req, c));
  all.sort((a, b) => (ownerOf(b) === req.teacher.id) - (ownerOf(a) === req.teacher.id) || b.createdAt - a.createdAt);
  // How much the AI has picked up from this class's activities, and how many it has.
  const activities = await store.list('activities');
  const contexts = new Map((await store.list('contexts')).map((c) => [c.id, c]));
  const activityClass = new Map(activities.map((a) => [a.id, a.classId]));
  res.json(all.map((c) => ({
    ...classSummary(req)(c),
    activities: activities.filter((a) => a.classId === c.id).length,
    learnedFrom: (contexts.get(c.contextId)?.learnings || []).filter((l) => (l.classId || activityClass.get(l.activityId)) === c.id).length,
  })));
}));

/**
 * Reset a class: the AI forgets what it picked up from this class's
 * activities, so the next one starts from the original context (the files and
 * the admin's written updates). Optionally its past activities are deleted too.
 */
api.post('/classes/:id/reset', adminOnly, wrap(async (req, res) => {
  const cls = await store.get('classes', req.params.id);
  if (!cls) return res.status(404).json({ error: 'Not found.' });
  if (classInUse(cls.id)) return res.status(409).json({ error: 'An activity is running with this class. Finish it first.' });
  const activities = (await store.list('activities')).filter((a) => a.classId === cls.id);
  const ids = new Set(activities.map((a) => a.id));
  let forgotten = 0;
  for (const context of await store.list('contexts')) {
    const before = (context.learnings || []).length;
    context.learnings = (context.learnings || []).filter((l) => !(l.classId === cls.id || ids.has(l.activityId)));
    if (context.learnings.length !== before) {
      forgotten += before - context.learnings.length;
      await store.put('contexts', context.id, context);
    }
  }
  let deleted = 0;
  if (req.body?.deleteActivities) {
    for (const a of activities) { await store.remove('activities', a.id); deleted += 1; }
  }
  res.json({ ok: true, forgotten, deleted });
}));

// ------------------------------------------------------------- reset data

/**
 * Admin only. scope "activities": delete every activity (contexts and classes
 * stay, and the AI forgets what it learned from them). scope "everything":
 * delete every context, class and activity. Refused while anything is live.
 */
api.post('/reset', adminOnly, wrap(async (req, res) => {
  if (req.body?.confirm !== 'RESET') return res.status(400).json({ error: 'Type RESET to confirm.' });
  const scope = req.body?.scope === 'everything' ? 'everything' : req.body?.scope === 'activities' ? 'activities' : null;
  if (!scope) return res.status(400).json({ error: 'Choose what to reset.' });
  if ([...lives.values()].some((l) => l.phase !== PHASES.FINISHED)) {
    return res.status(409).json({ error: 'An activity is running. Every teacher must finish theirs first.' });
  }
  const counts = { contexts: 0, classes: 0, activities: 0 };
  for (const a of await store.list('activities')) { await store.remove('activities', a.id); counts.activities += 1; }
  if (scope === 'everything') {
    for (const c of await store.list('classes')) { await store.remove('classes', c.id); counts.classes += 1; }
    for (const c of await store.list('contexts')) { await store.remove('contexts', c.id); counts.contexts += 1; }
  } else {
    for (const c of await store.list('contexts')) {
      if ((c.learnings || []).length) { c.learnings = []; await store.put('contexts', c.id, c); }
    }
  }
  lives.clear();
  for (const t of TEACHERS) pushTeachers(t.id);
  console.log(`[server] ${req.teacher.name} reset ${scope}:`, counts);
  res.json({ ok: true, scope, counts });
}));

api.get('/classes/:id', wrap(async (req, res) => {
  const cls = await usableClass(req, req.params.id);
  if (!cls) return res.status(404).json({ error: 'Not found.' });
  res.json(cls);
}));

api.post('/classes', adminOnly, wrap(async (req, res) => {
  const name = String(req.body?.name || '').trim().slice(0, 80);
  const count = Math.floor(Number(req.body?.count));
  if (!name) return res.status(400).json({ error: 'Give the class a name.' });
  if (!(count >= 1 && count <= MAX_CLASS_STUDENTS)) return res.status(400).json({ error: `Between 1 and ${MAX_CLASS_STUDENTS} students.` });
  const contextId = await usable(req, req.body?.contextId) ? req.body.contextId : null;
  const codes = generateCodes(count, await allCodes());
  const cls = {
    id: newId('cls'),
    teacherId: req.teacher.id,
    name,
    ...readPersonas(req.body),
    contextId,
    sharedWith: [],
    students: codes.map((code, i) => ({ n: i + 1, label: `Student ${i + 1}`, code })),
    createdAt: Date.now(),
  };
  await store.put('classes', cls.id, cls);
  res.json(classSummary(req)(cls));
}));

api.put('/classes/:id', adminOnly, wrap(async (req, res) => {
  const cls = await owned(req, 'classes', req.params.id);
  if (!cls) return res.status(404).json({ error: 'Only the teacher who made this class can change it.' });
  if (req.body?.name) cls.name = String(req.body.name).trim().slice(0, 80);
  if ('contextId' in (req.body || {})) {
    cls.contextId = await usable(req, req.body.contextId) ? req.body.contextId : null;
  }
  if (req.body?.personaSet) Object.assign(cls, readPersonas(req.body));
  const count = Math.floor(Number(req.body?.count));
  if (count > cls.students.length && count <= MAX_CLASS_STUDENTS) {
    const codes = generateCodes(count - cls.students.length, await allCodes());
    codes.forEach((code) => {
      const n = cls.students.length + 1;
      cls.students.push({ n, label: `Student ${n}`, code });
    });
  }
  await store.put('classes', cls.id, cls);
  res.json(classSummary(req)(cls));
}));

// Share a class: other teachers can run activities with it (and print its
// cards), each with up to 50 of its students at a time.
api.put('/classes/:id/share', adminOnly, wrap(async (req, res) => {
  const cls = await owned(req, 'classes', req.params.id);
  if (!cls) return res.status(404).json({ error: 'Only the teacher who made this class can share it.' });
  const valid = new Set(TEACHERS.map((t) => t.id).filter((id) => id !== req.teacher.id));
  cls.sharedWith = [...new Set((Array.isArray(req.body?.teachers) ? req.body.teachers : []).map(String))].filter((id) => valid.has(id));
  await store.put('classes', cls.id, cls);
  res.json(classSummary(req)(cls));
}));

// Every activity run with this class, one folder each. The class's owner gets
// every teacher's; a teacher it is shared with gets their own.
api.get('/classes/:id/activities.zip', wrap(async (req, res) => {
  const cls = await usableClass(req, req.params.id);
  if (!cls) return res.status(404).json({ error: 'Not found.' });
  const isOwner = ownerOf(cls) === req.teacher.id;
  const records = (await store.list('activities'))
    .filter((a) => a.classId === cls.id && (isOwner || ownerOf(a) === req.teacher.id))
    .sort((a, b) => a.createdAt - b.createdAt);
  if (!records.length) return res.status(404).json({ error: 'No activities have been run with this class yet.' });
  const entries = [];
  for (const record of records) {
    const context = (record.contextId && await store.get('contexts', record.contextId)) || (record.contextBrief ? { brief: record.contextBrief } : null);
    entries.push({ record, cls, context });
  }
  const { name, buffer } = classZip({ cls, entries });
  res.setHeader('content-type', 'application/zip');
  res.setHeader('content-disposition', `attachment; filename="${name}"`);
  res.send(buffer);
}));

api.delete('/classes/:id', adminOnly, wrap(async (req, res) => {
  if (!await owned(req, 'classes', req.params.id)) return res.status(404).json({ error: 'Only the teacher who made this class can delete it.' });
  if (classInUse(req.params.id)) return res.status(409).json({ error: 'That class is in an activity right now.' });
  await store.remove('classes', req.params.id);
  res.json({ ok: true });
}));

api.get('/classes/:id/cards.pdf', wrap(async (req, res) => {
  const cls = await usableClass(req, req.params.id);
  if (!cls) return res.status(404).json({ error: 'Not found.' });
  // The cards print the full address, e.g. https://human-or-not.allentronics.com.au/
  const pdf = buildCardsPdf({ title: cls.name, joinUrl: `${joinUrl(req)}/`, cards: cls.students });
  res.setHeader('content-type', 'application/pdf');
  res.setHeader('content-disposition', `attachment; filename="${cls.name.replace(/[^\w -]+/g, '').trim() || 'class'} - login cards.pdf"`);
  res.send(pdf);
}));

// --------------------------------------------------------------- activities

const activitySummary = (a) => ({
  id: a.id, name: a.name, teacherId: ownerOf(a), teacherName: a.teacherName || `Teacher ${ownerOf(a)}`, classId: a.classId, className: a.className, saveName: saveName(a), contextName: a.contextName, status: a.status,
  rounds: a.rounds.length, planned: ensurePlan(a).plan.length, mode: modeInfo(a.mode).short,
  hasOverview: Boolean(a.overview), createdAt: a.createdAt, finishedAt: a.finishedAt || null,
  fooled: a.rounds.map((r) => r.stats?.aiFooledRate ?? null),
});

api.get('/activities', wrap(async (req, res) => {
  const all = (await store.list('activities')).filter((a) => canSeeActivity(req, a));
  res.json(all.sort((a, b) => b.createdAt - a.createdAt).map(activitySummary));
}));

api.post('/activities', wrap(async (req, res) => {
  const running = liveFor(req.teacher.id);
  if (running && running.phase !== PHASES.FINISHED) {
    return res.status(409).json({ error: `"${running.record.name}" is still running. Finish it first.` });
  }
  const cls = await usableClass(req, req.body?.classId);
  if (!cls) return res.status(400).json({ error: 'Choose a class.' });
  const name = String(req.body?.name || '').trim().slice(0, 80);
  if (!name) return res.status(400).json({ error: 'Name the activity, e.g. "Preservice teachers, week 6".' });
  // The class's own context, chosen by the class's owner, also when the class is shared.
  const context = cls.contextId ? await store.get('contexts', cls.contextId) : null;
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
  const record = await visibleActivity(req, req.params.id);
  if (!record) return res.status(404).json({ error: 'Not found.' });
  const cls = await store.get('classes', record.classId);
  const context = (record.contextId && await store.get('contexts', record.contextId)) || (record.contextBrief ? { brief: record.contextBrief } : null);
  const { name, buffer } = activityZip({ record, cls, context });
  res.setHeader('content-type', 'application/zip');
  res.setHeader('content-disposition', `attachment; filename="${name}"`);
  res.send(buffer);
}));

api.get('/activities/:id/overview', wrap(async (req, res) => {
  const record = await visibleActivity(req, req.params.id);
  if (!record) return res.status(404).json({ error: 'Not found.' });
  res.json(overviewData(record));
}));

api.delete('/activities/:id', wrap(async (req, res) => {
  if (!await visibleActivity(req, req.params.id)) return res.status(404).json({ error: 'Not found.' });
  if ([...lives.values()].some((l) => l.record.id === req.params.id && l.phase !== PHASES.FINISHED)) {
    return res.status(409).json({ error: 'That activity is running.' });
  }
  await store.remove('activities', req.params.id);
  res.json({ ok: true });
}));

// ------------------------------------------------------------------- backup

api.get('/backup', adminOnly, wrap(async (req, res) => {
  const backup = {
    format: 'human-or-not-workspace',
    version: 1,
    savedAt: new Date().toISOString(),
    // Everything on the server: the setup and every teacher's activities.
    contexts: await store.list('contexts'),
    classes: await store.list('classes'),
    activities: await store.list('activities'),
  };
  res.setHeader('content-type', 'application/json');
  res.setHeader('content-disposition', `attachment; filename="human-or-not-backup-${backup.savedAt.slice(0, 10)}.json"`);
  res.send(JSON.stringify(backup));
}));

api.post('/restore', adminOnly, wrap(async (req, res) => {
  const backup = req.body;
  if (backup?.format !== 'human-or-not-workspace') return res.status(400).json({ error: 'That is not a Human or Not? backup file.' });
  const counts = {};
  for (const collection of ['contexts', 'classes', 'activities']) {
    counts[collection] = 0;
    for (const record of Array.isArray(backup[collection]) ? backup[collection] : []) {
      if (!record?.id || !/^[A-Za-z0-9_-]{1,80}$/.test(record.id)) continue;
      // Records keep the teacher they belong to; older backups belong to the admin.
      record.teacherId = ownerOf(record);
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

/**
 * The running activities this login code could join. A class shared between
 * teachers can be in several at once; a student who has already joined one
 * always goes back to it, and full activities are skipped.
 */
function livesForCode(rawCode) {
  const code = String(rawCode || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const running = [...lives.values()].filter((l) => l.phase !== PHASES.FINISHED && l.codes.has(code));
  const already = running.find((l) => l.hasJoined(code));
  if (already) return { lives: [already], full: false };
  const open = running.filter((l) => l.hasRoom());
  return { lives: open, full: running.length > 0 && open.length === 0 };
}

io.on('connection', (socket) => {
  let role = null;
  let teacher = null;
  let studentLive = null;

  socket.on('student:join', (payload, ack) => {
    const found = livesForCode(payload?.code);
    if (found.full) {
      return ack?.({ ok: false, code: 'full', error: `Every activity for this class is full (${MAX_ACTIVITY_STUDENTS} students each). Ask your teacher.` });
    }
    if (!found.lives.length) {
      const anyRunning = [...lives.values()].some((l) => l.phase !== PHASES.FINISHED);
      return ack?.(anyRunning
        ? { ok: false, error: 'That code is not part of an activity that is running. Check it with your teacher.' }
        : { ok: false, code: 'not_started', error: 'Your teacher has not started an activity yet.' });
    }
    // Several teachers are running this class: the student says whose room they are in.
    let live = found.lives[0];
    if (found.lives.length > 1) {
      live = found.lives.find((l) => l.record.id === payload?.activityId);
      if (!live) {
        return ack?.({
          ok: false, code: 'choose', error: 'Which teacher are you with?',
          options: found.lives.map((l) => ({ id: l.record.id, teacher: l.record.teacherName || teacherName(ownerOf(l.record)), activity: l.record.name })),
        });
      }
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
