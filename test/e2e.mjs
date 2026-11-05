/** A whole activity: train, class, four rounds, analysis, overview, download, backup. */
import { io } from 'socket.io-client';

const URL = 'http://localhost:3500';
const CODE = 'test-code';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (label, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`);
  if (!cond) failures++;
};
const api = async (p, opts = {}) => {
  const res = await fetch(`${URL}/api${p}`, {
    ...opts,
    headers: { 'content-type': 'application/json', 'x-teacher-code': CODE, ...(opts.headers || {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const type = res.headers.get('content-type') || '';
  return { status: res.status, data: type.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer()) };
};
const emit = (s, ev, p) => new Promise((r) => s.emit(ev, p, r));
const MOCK = 'http://localhost:3501';
const getCalls = async () => (await fetch(`${MOCK}/__calls`)).json();
const resetCalls = () => fetch(`${MOCK}/__reset`);
const until = async (fn, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await sleep(150); } return false; };

console.log('--- set-up ---');
check('the console is locked without the code', (await fetch(`${URL}/api/meta`)).status === 401);
const meta = (await api('/meta')).data;
check('the newest model of each family is picked',
  meta.models.haiku.id === 'claude-haiku-4-5' && meta.models.sonnet.id === 'claude-sonnet-5-5' && meta.models.opus.id === 'claude-opus-5-5',
  JSON.stringify(Object.values(meta.models).map((m) => m.id)));
check('effort defaults: medium, medium, high',
  meta.models.haiku.effort === 'medium' && meta.models.sonnet.effort === 'medium' && meta.models.opus.effort === 'high');
check('both persona sets are offered', meta.personaSets.map((s) => s.id).join(',') === 'secondary,preservice');
for (const name of ['01-about-the-class.md', '02-what-we-have-learned.md', '03-student-voice.md']) {
  const res = await fetch(`${URL}/templates/${name}`);
  check(`template ${name} downloads`, res.status === 200 && /attachment/.test(res.headers.get('content-disposition')));
}
check('all templates download as a zip', (await fetch(`${URL}/templates-all.zip`)).headers.get('content-type') === 'application/zip');

console.log('\n--- 1. train ---');
const thin = await api('/contexts', { method: 'POST', body: { name: 'x', files: { about: '## The class\n', learned: '' } } });
check('a nearly empty context is refused and asks for more', thin.status === 400 && /more you give/.test(thin.data.error));
const about = '# 01\n## The class\nYear 10 Science, 10B, a government school in Melbourne, 24 students.\n## Who the students are\nFifteen and sixteen, sport-mad, tired after lunch.\n## How they talk and write\nlower case, idk, ngl, short.';
const learned = '# 02\n## What has been covered so far\nFood webs, energy pyramids, the ten percent rule, keystone species with the sea otter and kelp example.';
const created = await api('/contexts', { method: 'POST', body: { name: '10B Ecosystems', files: { about, learned, voice: '## Example messages\n- idk the otter one\n- ngl food webs r ok' } } });
check('a context is accepted and starts training', created.status === 200 && created.data.status === 'training');
const ctxId = created.data.id;
check('training finishes', await until(async () => (await api('/contexts')).data[0].status === 'ready'));
const ctx = (await api(`/contexts/${ctxId}`)).data;
check('Sonnet wrote the brief', ctx.brief.includes('sea otter') && ctx.model === 'claude-sonnet-5-5');
check('training used Sonnet at medium effort', (await getCalls()).some((c) => c.model === 'claude-sonnet-5-5' && c.effort === 'medium' && c.system.includes('prepare briefings')));
check('example messages merge the file and the brief', ctx.sampleMessages.includes('idk the otter one') && ctx.sampleMessages.includes('ok but why does the kelp care'));
check('gaps are reported back to the educator', ctx.gaps.length > 0);

console.log('\n--- 2. class ---');
const cls = (await api('/classes', { method: 'POST', body: { name: '10B Science', count: 5, personaSet: 'secondary', personas: ['S2', 'S3'], contextId: ctxId } })).data;
check('a class is created', cls.size === 5 && cls.personas.join() === 'S2,S3');
const full = (await api(`/classes/${cls.id}`)).data;
check('students are numbered with codes', full.students.every((s, i) => s.label === `Student ${i + 1}` && /^[A-Z]{4}\d{4}$/.test(s.code)));
const pdf = await api(`/classes/${cls.id}/cards.pdf`);
check('the login cards are a PDF', pdf.data.subarray(0, 5).toString() === '%PDF-');
check('the PDF carries the codes', pdf.data.toString('latin1').includes(full.students[0].code));

console.log('\n--- 3. start the activity ---');
check('an activity needs a name', (await api('/activities', { method: 'POST', body: { classId: cls.id } })).status === 400);
const act = (await api('/activities', { method: 'POST', body: { classId: cls.id, name: 'Week 6 trial', durationSec: 60, aiRatio: 0.6 } })).data;
check('the activity starts live', act.status === 'live');
check('a second one cannot start meanwhile', (await api('/activities', { method: 'POST', body: { classId: cls.id, name: 'x' } })).status === 409);

const teacher = io(URL);
await new Promise((r) => teacher.on('connect', r));
let view = null;
teacher.on('live', (v) => { view = v; });
check('the teacher socket needs the code', !(await emit(teacher, 'teacher:auth', { code: 'nope' })).ok);
check('the teacher socket signs in', (await emit(teacher, 'teacher:auth', { code: CODE })).ok);
await sleep(150);
check('the console sees the lobby', view?.phase === 'lobby' && view.classSize === 5);

console.log('\n--- 4. students join ---');
const kids = [];
for (const s of full.students) {
  const sock = io(URL);
  await new Promise((r) => sock.on('connect', r));
  const k = { sock, n: s.n, state: null, msgs: [] };
  sock.on('state', (st) => { k.state = st; });
  sock.on('message', (m) => k.msgs.push(m));
  const res = await emit(sock, 'student:join', { code: s.code.toLowerCase() });
  check(`Student ${s.n} joins (lower case accepted)`, res.ok && res.label === `Student ${s.n}`);
  kids.push(k);
}
const stranger = io(URL);
await new Promise((r) => stranger.on('connect', r));
check('a code from no class is refused', !(await emit(stranger, 'student:join', { code: 'ZZZZ9999' })).ok);
stranger.close();
await sleep(200);
check('everyone waits in the lobby', kids.every((k) => k.state?.phase === 'lobby'));
check('the console counts them', view.students.filter((s) => s.connected).length === 5);

console.log('\n--- 5. four rounds ---');
for (let round = 1; round <= 4; round++) {
  await resetCalls();
  const started = await emit(teacher, 'live:startRound', {});
  check(`round ${round} starts`, started.ok, started.error || '');
  await sleep(250);
  check(`round ${round}: everyone is in a conversation`, kids.every((k) => k.state?.inRound && k.state.phase === 'active'));
  const aiKids = view.students.filter((s) => s.partner === 'ai');
  check(`round ${round}: about 60% are with the AI, humans in pairs`,
    aiKids.length >= 3 && (5 - aiKids.length) % 2 === 0, `${aiKids.length} with AI`);
  const models = [...new Set(aiKids.map((s) => s.model))];
  if (round === 4) check('round 4 has no Opus', !models.some((m) => /opus/i.test(m)), models.join(','));
  else check(`round ${round} uses all three models`, models.length === 3, models.join(','));
  check(`round ${round}: personas come from the ticked set`, aiKids.every((s) => ['The checked-out one', 'The class clown'].includes(s.persona)));

  // Count only this round's messages: the lists carry over from earlier rounds.
  const before = kids.map((k) => k.msgs.length);
  for (const k of kids) await emit(k.sock, 'chat:send', { text: `hey its student ${k.n}` });
  const aiNs = aiKids.map((s) => s.n);
  const fromAiThisRound = (n) => kids[n - 1].msgs.slice(before[n - 1]).filter((m) => !m.mine).length;
  check(`round ${round}: the AI replies, as separate messages`,
    await until(() => aiNs.every((n) => fromAiThisRound(n) >= 2), 8000));
  check(`round ${round}: the replies came from the Claude API`, await until(async () => (await getCalls()).some((c) => c.system.includes('You are')), 4000));
  const calls = await getCalls();
  if (round === 2) {
    const chat = calls.find((c) => c.system.includes('WHAT YOU HAVE LEARNED'));
    check('round 2 bots are told what round 1 taught', Boolean(chat?.system.includes('Round 1 lesson')));
  }
  if (round === 1) {
    check('the bots were briefed with the class context', calls.some((c) => c.system.includes('sea otter')));
    check('Haiku was retried without effort; Opus kept high', calls.some((c) => c.model === 'claude-haiku-4-5' && !c.effort) || !aiKids.some((s) => /haiku/i.test(s.model)));
  }

  check(`round ${round} ends`, (await emit(teacher, 'live:endRound', {})).ok);
  await sleep(200);
  check(`round ${round}: students are asked to guess`, kids.every((k) => k.state?.phase === 'guess'));
  for (const k of kids) await emit(k.sock, 'guess', { guess: k.n % 2 ? 'ai' : 'human' });
  await sleep(300);
  check(`round ${round}: results appear once everyone has guessed`, view.phase === 'results' && kids.every((k) => k.state?.phase === 'results'));
  check(`round ${round}: each student sees their own result`, kids.every((k) => typeof k.state?.result?.correct === 'boolean'));
  check(`round ${round}: Claude analyses the round`, await until(() => view.round?.analysisStatus === 'done'));
  if (round === 1) check('the analysis uses Sonnet at medium effort', (await getCalls()).some((c) => c.system.includes('analyse transcripts') && c.model === 'claude-sonnet-5-5' && c.effort === 'medium'));
  check(`round ${round}: the analysis headline is shown`, view.round.analysis.headline.startsWith(`Round ${round}`));
  check(`round ${round}: per-model stats`, Object.keys(view.round.stats.byModel).length === (round === 4 ? 2 : 3) || Object.keys(view.round.stats.byModel).length >= 1);
}
check('no fifth round', !(await emit(teacher, 'live:startRound', {})).ok);
const learnedCtx = (await api(`/contexts/${ctxId}`)).data;
check('what the activity learned is saved to the class context for next time',
  learnedCtx.learnings.length === 1 && learnedCtx.learnings[0].guidance.some((g) => g.includes('Round 4')));

console.log('\n--- 6. the overview ---');
check('the overview opens after round 4', (await emit(teacher, 'live:overview', {})).ok);
check('Claude writes it', await until(() => view.overviewStatus === 'done' && view.overviewData));
check('the overview uses Sonnet at medium effort', (await getCalls()).some((c) => c.system.includes('honest, engaging summaries') && c.model === 'claude-sonnet-5-5' && c.effort === 'medium'));
check('it carries all four rounds and the story', view.overviewData.rounds.length === 4 && view.overviewData.story.title === '10B vs the machine');
check('students are told to look at the screen', kids.every((k) => k.state?.phase === 'overview'));

console.log('\n--- 7. the download ---');
const zip = await api(`/activities/${act.id}/zip`);
const text = zip.data.toString('latin1');
for (const f of ['report.html', 'overview/overview.html', 'overview/overview.json', 'data/messages.csv', 'data/results.csv',
  'data/rounds.csv', 'data/transcripts.txt', 'data/activity.json', 'analysis/round-1.md', 'analysis/round-4.json', 'context/class-brief.md', 'context/01-about-the-class.md']) {
  check(`the ZIP contains ${f}`, text.includes(f));
}
check('the ZIP has the transcripts', text.includes('hey its student 1'));
check('the ZIP does not leak login codes', !full.students.some((s) => text.includes(s.code)));
check('the standalone overview embeds its data and script', text.includes('HumanOrNotOverview.render'));

check('the activity finishes', (await emit(teacher, 'live:finish', {})).ok);
await sleep(200);
check('students see the end screen', kids.every((k) => k.state?.phase === 'finished'));
const list = (await api('/activities')).data;
check('it is listed as finished with four rounds', list[0].status === 'finished' && list[0].rounds === 4);

console.log('\n--- 8. backup and restore ---');
const backup = (await api('/backup')).data;
check('the backup holds everything', backup.contexts.length === 1 && backup.classes.length === 1 && backup.activities.length === 1);
await api(`/activities/${act.id}`, { method: 'DELETE' });
check('an activity can be deleted', (await api('/activities')).data.length === 0);
const restored = await api('/restore', { method: 'POST', body: backup });
check('a backup restores', restored.data.ok && restored.data.counts.activities === 1);
check('a non-backup is refused', (await api('/restore', { method: 'POST', body: { hello: 1 } })).status === 400);

console.log('\n--- 9. the other modes ---');
check('the three modes are offered', meta.modes.map((m) => m.id).join(',') === 'learn3,learn4,open');
const cmd = async (ev, p = {}) => { const r = await emit(teacher, ev, p); await sleep(200); return r; };
const analysisCalls = async () => (await getCalls()).filter((c) => c.system.includes('analyse transcripts')).length;
const rejoin = async () => {
  for (const k of kids) await emit(k.sock, 'student:join', { code: full.students[k.n - 1].code });
  await sleep(200);
};
const quickRound = async (label, expect) => {
  const started = await cmd('live:startRound', {});
  check(`${label} starts`, started.ok, started.error || '');
  await sleep(200);
  const used = [...new Set(view.students.filter((s) => s.partner === 'ai').map((s) => s.model.split(' ')[1].toLowerCase()))].sort();
  check(`${label} uses ${expect.join(', ')}`, used.join() === [...expect].sort().join() || (used.length && used.every((m) => expect.includes(m))), used.join(','));
  check(`${label} reveals`, (await cmd('live:results', {})).ok && view.phase === 'results');
};

// Three rounds, learning
await api('/activities', { method: 'POST', body: { classId: cls.id, name: 'Learn three', durationSec: 60, aiRatio: 0.6, mode: 'learn3' } });
await rejoin();
check('learn3: three rounds planned, all models', view.roundCount === 3 && view.plan.every((p) => p.models.length === 3));
check('learn3: the models are fixed', !(await cmd('live:setModels', { models: ['haiku'] })).ok);
for (let r = 1; r <= 3; r++) {
  await quickRound(`learn3 round ${r}`, ['haiku', 'sonnet', 'opus']);
  check(`learn3 round ${r}: Claude analyses it`, await until(() => view.round?.analysisStatus === 'done'));
}
check('learn3: no fourth round', !(await cmd('live:startRound', {})).ok);
check('learn3: no more rounds can be added', !(await cmd('live:moreRounds', {})).ok);
check('learn3: the overview opens after round 3', (await cmd('live:overview', {})).ok);
check('learn3: the overview carries three rounds', await until(() => view.overviewData?.rounds.length === 3 && view.overviewData.mode.id === 'learn3'));
await cmd('live:finish', {});
check('learn3: listed as finished', (await api('/activities')).data[0].status === 'finished');

// Four rounds, learning, then a switch the educator chose
const l4 = (await api('/activities', { method: 'POST', body: { classId: cls.id, name: 'Learn four', durationSec: 60, mode: 'learn4', finalModels: ['opus'] } })).data;
await rejoin();
check('learn4: round 4 uses the chosen models', view.plan[3].models.join() === 'opus' && view.plan[3].secret);
check('learn4: rounds 1–3 cannot be changed', !(await cmd('live:setModels', { models: ['haiku'] })).ok);
await cmd('live:finish', {});
await api(`/activities/${l4.id}`, { method: 'DELETE' });

// Open play
await resetCalls();
await api('/activities', { method: 'POST', body: { classId: cls.id, name: 'Open play', durationSec: 60, aiRatio: 0.6, mode: 'open', blockSize: 2, models: ['sonnet'] } });
await rejoin();
check('open: two rounds planned with the starting models', view.roundCount === 2 && view.plan.every((p) => p.models.join() === 'sonnet'));
check('open: round 1 models can be changed in the lobby', (await cmd('live:setModels', { models: ['haiku'] })).ok && view.plan[0].models.join() === 'haiku');
check('open: at least one model is required', !(await cmd('live:setModels', { models: [] })).ok);
await quickRound('open round 1', ['haiku']);
check('open: no analysis between rounds', view.round.analysisStatus === 'off' && (await analysisCalls()) === 0);
check('open: round 2 models can be changed after results', (await cmd('live:setModels', { models: ['sonnet', 'opus'] })).ok);
await quickRound('open round 2', ['sonnet', 'opus']);
check('open: the block ends', !(await cmd('live:startRound', {})).ok);
check('open: keep going adds another block', (await cmd('live:moreRounds', {})).ok && view.roundCount === 4);
check('open: the new block carries the last models on', view.plan[2].models.join() === 'sonnet,opus');
await quickRound('open round 3', ['sonnet', 'opus']);
check('open: the overview waits for the block to finish', !(await cmd('live:overview', {})).ok);
await quickRound('open round 4', ['sonnet', 'opus']);
check('open: still no analysis', (await analysisCalls()) === 0);
check('open: the overview opens', (await cmd('live:overview', {})).ok);
check('open: the overview carries four rounds and no learning', await until(() => view.overviewData?.rounds.length === 4 && view.overviewData.mode.learning === false));
const overviewPrompt = (await getCalls()).find((c) => c.system.includes('honest, engaging summaries'));
check('open: Claude is told the AI did not learn', Boolean(overviewPrompt?.messages?.[0]?.content?.includes('did NOT learn')));
await cmd('live:finish', {});
const openRow = (await api('/activities')).data[0];
check('open: listed with its mode and rounds', openRow.mode === 'Open play' && openRow.rounds === 4 && openRow.planned === 4 && openRow.hasOverview);

console.log('\n--- 10. several teachers ---');
const teachersList = await (await fetch(`${URL}/teachers.json`)).json();
check('three teacher consoles are listed', teachersList.map((t) => t.name).join('|') === 'Teacher 1|Ms Second|Teacher 3');
check('a teacher with no password is switched off', teachersList[2].ready === false && teachersList[0].ready && teachersList[1].ready);
check('the list never shows passwords', !JSON.stringify(teachersList).includes('code'));
check('each console has its own page', (await fetch(`${URL}/teacher/2`)).status === 200 && (await fetch(`${URL}/teacher/9`)).status === 404);
const api2 = (p, opts = {}) => api(p, { ...opts, headers: { 'x-teacher-id': '2', 'x-teacher-code': 'second-code', ...(opts.headers || {}) } });
check('teacher 2 cannot sign in with teacher 1\'s password', (await api('/meta', { headers: { 'x-teacher-id': '2' } })).status === 401);
check('teacher 3 cannot sign in at all', (await api('/meta', { headers: { 'x-teacher-id': '3', 'x-teacher-code': '' } })).status === 401);
const meta2 = (await api2('/meta')).data;
check('teacher 2 signs in with their own password, not as admin', meta2.teacher?.name === 'Ms Second' && meta2.teacher.admin === false && meta2.live === null);
check('teacher 1 is the admin', (await api('/meta')).data.teacher.admin === true);

// Teacher 1 sets up; everyone uses it.
check('teacher 2 sees the admin\'s contexts and classes', (await api2('/contexts')).data.some((c) => c.id === ctxId) && (await api2('/classes')).data.some((c) => c.id === cls.id));
check('teacher 2 can read a context and open a class', (await api2(`/contexts/${ctxId}`)).data.brief?.includes('sea otter') && (await api2(`/classes/${cls.id}`)).status === 200);
check('teacher 2 starts with no activities of their own', (await api2('/activities')).data.length === 0);
check('teacher 2 cannot download teacher 1\'s activity', (await api2(`/activities/${act.id}/zip`)).status === 404);
const forbidden = await Promise.all([
  api2('/contexts', { method: 'POST', body: { name: 'x', files: { about, learned } } }),
  api2(`/contexts/${ctxId}`, { method: 'PUT', body: { name: 'x' } }),
  api2(`/contexts/${ctxId}/updates`, { method: 'POST', body: { text: 'sneaky change' } }),
  api2(`/contexts/${ctxId}`, { method: 'DELETE' }),
  api2('/classes', { method: 'POST', body: { name: 'Mine', count: 3 } }),
  api2(`/classes/${cls.id}`, { method: 'PUT', body: { name: 'x' } }),
  api2(`/classes/${cls.id}`, { method: 'DELETE' }),
  api2('/backup'),
  api2('/restore', { method: 'POST', body: { format: 'human-or-not-workspace' } }),
]);
check('only the admin can change the setup or back up', forbidden.every((r) => r.status === 403), forbidden.map((r) => r.status).join(','));
check('nothing was changed', (await api(`/contexts/${ctxId}`)).status === 200 && (await api(`/classes/${cls.id}`)).data.name === '10B Science');

const cls2 = (await api('/classes', { method: 'POST', body: { name: '9A Science', count: 3, personaSet: 'secondary', contextId: ctxId } })).data;
check('the admin makes a second class', cls2.size === 3 && cls2.contextId === ctxId);
check('teacher 2 sees it straight away', (await api2('/classes')).data.some((c) => c.id === cls2.id));
const full2 = (await api(`/classes/${cls2.id}`)).data;
check('login codes are unique across classes', !full2.students.some((s) => full.students.some((t) => t.code === s.code)));

// Written updates
await resetCalls();
check('an empty update is refused', (await api(`/contexts/${ctxId}/updates`, { method: 'POST', body: { text: ' ' } })).status === 400);
const upd = await api(`/contexts/${ctxId}/updates`, { method: 'POST', body: { text: 'Day 2: we covered decomposition and the jam sandwich algorithm.' } });
check('an update is added and retraining starts', upd.status === 200 && upd.data.updates.length === 1 && upd.data.status === 'training');
check('retraining finishes', await until(async () => (await api(`/contexts/${ctxId}`)).data.status === 'ready'));
const trainCall = (await getCalls()).find((c) => c.system.includes('prepare briefings'));
check('Claude is given the update, dated, and told it wins over the files',
  Boolean(trainCall?.messages[0].content.includes('jam sandwich algorithm') && trainCall.messages[0].content.includes('the update wins') && /\[\d{4}-\d{2}-\d{2}\] Day 2/.test(trainCall.messages[0].content)));
check('teacher 2 sees the update', (await api2('/contexts')).data.find((c) => c.id === ctxId).updates.length === 1);
const updId = upd.data.updates[0].id;
check('teacher 2 cannot remove it', (await api2(`/contexts/${ctxId}/updates/${updId}`, { method: 'DELETE' })).status === 403);
check('the admin can remove it', (await api(`/contexts/${ctxId}/updates/${updId}`, { method: 'DELETE' })).data.updates.length === 0);
await until(async () => (await api(`/contexts/${ctxId}`)).data.status === 'ready');

// Both teachers run an activity at the same time.
await api('/activities', { method: 'POST', body: { classId: cls.id, name: 'T1 live', durationSec: 60, mode: 'open', blockSize: 1 } });
const act2 = await api2('/activities', { method: 'POST', body: { classId: cls2.id, name: 'T2 live', durationSec: 60, mode: 'open', blockSize: 1 } });
check('teacher 2 can start with the admin\'s class while teacher 1 is running', act2.status === 200, act2.data.error || '');
await rejoin();
const teacher2 = io(URL);
await new Promise((r) => teacher2.on('connect', r));
let view2 = null;
teacher2.on('live', (v) => { view2 = v; });
check('teacher 2\'s socket refuses teacher 1\'s password', !(await emit(teacher2, 'teacher:auth', { teacher: '2', code: CODE })).ok);
check('teacher 2\'s socket signs in', (await emit(teacher2, 'teacher:auth', { teacher: '2', code: 'second-code' })).ok);
const kids2 = [];
for (const s2 of full2.students) {
  const sock = io(URL);
  await new Promise((r) => sock.on('connect', r));
  const k = { sock, n: s2.n, state: null };
  sock.on('state', (st) => { k.state = st; });
  const res = await emit(sock, 'student:join', { code: s2.code });
  check(`9A's Student ${s2.n} lands in teacher 2's activity`, res.ok && res.activity === 'T2 live');
  kids2.push(k);
}
await sleep(300);
check('each console sees only its own students', view2?.name === 'T2 live' && view2.students.length === 3 && view.name === 'T1 live' && view.students.length === 5);
check('teacher 2 starts a round', (await emit(teacher2, 'live:startRound', {})).ok);
await sleep(300);
check('teacher 2\'s students are chatting', kids2.every((k) => k.state?.phase === 'active'));
check('teacher 1\'s students are still waiting', kids.every((k) => k.state?.phase === 'lobby'));
check('teacher 1\'s round controls do not touch teacher 2', (await cmd('live:startRound')).ok && view2.roundNumber === 1 && view.roundNumber === 1);
check('teacher 2 ends their own round only', (await emit(teacher2, 'live:endRound', {})).ok && (await sleep(200), kids2.every((k) => k.state?.phase === 'guess') && kids.every((k) => k.state?.phase === 'active')));
await emit(teacher2, 'live:finish', {});
await cmd('live:finish');
for (const k of kids2) k.sock.close();
const list2 = (await api2('/activities')).data;
check('teacher 2 sees only their own activities', list2.length === 1 && list2[0].id === act2.data.id);
const listAdmin = (await api('/activities')).data;
check('the admin sees every teacher\'s activities, labelled', listAdmin.some((a) => a.id === act2.data.id && a.teacherName === 'Ms Second') && listAdmin.some((a) => a.teacherId === '1'));
check('the admin can download teacher 2\'s activity', (await api(`/activities/${act2.data.id}/zip`)).status === 200);
const backupAll = (await api('/backup')).data;
check('the admin\'s backup holds everything, every teacher\'s activities included', backupAll.activities.some((a) => a.id === act2.data.id) && backupAll.classes.some((c) => c.id === cls2.id));

console.log('\n--- 11. one big class, several teachers ---');
check('a class can have up to 100 students', (await api('/classes', { method: 'POST', body: { name: 'Too big', count: 101 } })).status === 400);
const cohort = (await api('/classes', { method: 'POST', body: { name: 'TCHE2615 Cohort', count: 100, personaSet: 'preservice', contextId: ctxId } })).data;
check('a 100-student class is created', cohort.size === 100 && cohort.mine);
const cohortFull = (await api(`/classes/${cohort.id}`)).data;
const cards100 = await api(`/classes/${cohort.id}/cards.pdf`);
check('its login cards cover all 100', cards100.data.toString('latin1').includes(cohortFull.students[99].code));
const seen2 = (await api2('/classes')).data.find((c) => c.id === cohort.id);
check('teacher 2 sees it, set up by teacher 1', seen2 && !seen2.mine && seen2.owner.name === 'Teacher 1');
check('teacher 2 can print its cards', (await api2(`/classes/${cohort.id}/cards.pdf`)).status === 200);
check('teacher 2 cannot change or delete it', (await api2(`/classes/${cohort.id}`, { method: 'PUT', body: { name: 'x' } })).status === 403
  && (await api2(`/classes/${cohort.id}`, { method: 'DELETE' })).status === 403);

const a1 = (await api('/activities', { method: 'POST', body: { classId: cohort.id, name: 'Room A', mode: 'open', blockSize: 1 } })).data;
const a2 = (await api2('/activities', { method: 'POST', body: { classId: cohort.id, name: 'Room B', mode: 'open', blockSize: 1 } })).data;
check('both teachers run the same class at once', a1.status === 'live' && a2.status === 'live');
check('activities are saved as teacher_date_time_class', /^teacher-1_\d{4}-\d{2}-\d{2}_\d{2}-\d{2}_TCHE2615-Cohort$/.test(a1.saveName) && /^teacher-2_.*_TCHE2615-Cohort$/.test(a2.saveName));
check('teacher 2\'s activity uses the class\'s context', Boolean((await api2('/activities')).data.find((a) => a.id === a2.id)?.contextName));
check('the class cannot be deleted while in use', (await api(`/classes/${cohort.id}`, { method: 'DELETE' })).status === 409);

const pupil = io(URL);
await new Promise((r) => pupil.on('connect', r));
const code1 = cohortFull.students[0].code;
const ask = await emit(pupil, 'student:join', { code: code1 });
check('a student in both is asked which teacher', ask.code === 'choose' && ask.options.length === 2 && ask.options.some((o) => o.teacher === 'Ms Second' && o.activity === 'Room B'));
const chosen = await emit(pupil, 'student:join', { code: code1, activityId: a2.id });
check('they join the room they chose', chosen.ok && chosen.activity === 'Room B');
const again = await emit(pupil, 'student:join', { code: code1 });
check('coming back, they go straight to the same room', again.ok && again.activity === 'Room B');
pupil.close();
await cmd('live:finish');
await emit(teacher2, 'live:finish', {});

const ownerZip = await api(`/classes/${cohort.id}/activities.zip`);
const ownerText = ownerZip.data.toString('latin1');
check('the class owner downloads every teacher\'s activities, one folder each', ownerZip.status === 200
  && ownerText.includes(`TCHE2615-Cohort/${a1.saveName}/report.html`) && ownerText.includes(`TCHE2615-Cohort/${a2.saveName}/report.html`));
const otherZip = (await api2(`/classes/${cohort.id}/activities.zip`)).data.toString('latin1');
check('another teacher downloads only their own', otherZip.includes(a2.saveName) && !otherZip.includes(a1.saveName));
const oneZip = await fetch(`${URL}/api/activities/${a1.id}/zip`, { headers: { 'x-teacher-code': CODE } });
check('a single activity downloads under its save name', (oneZip.headers.get('content-disposition') || '').includes(`${a1.saveName}.zip`));

console.log('\n--- 12. resetting ---');
const clsRow = (await api('/classes')).data.find((c) => c.id === cls.id);
check('a class shows how much the AI learned from it', clsRow.activities > 0 && clsRow.learnedFrom > 0, `${clsRow.activities} activities, learned from ${clsRow.learnedFrom}`);
check('only the admin can reset a class', (await api2(`/classes/${cls.id}/reset`, { method: 'POST', body: {} })).status === 403);
const activitiesBefore = (await api('/activities')).data.filter((a) => a.classId === cls.id).length;
const r1 = (await api(`/classes/${cls.id}/reset`, { method: 'POST', body: { deleteActivities: false } })).data;
check('resetting a class makes the AI forget what it learned there', r1.ok && r1.forgotten > 0 && r1.deleted === 0);
const ctxAfter = (await api(`/contexts/${ctxId}`)).data;
const clsActivityIds = new Set((await api('/activities')).data.filter((a) => a.classId === cls.id).map((a) => a.id));
check('the context keeps its files and updates, without that class\'s learnings', ctxAfter.brief && !(ctxAfter.learnings || []).some((l) => l.classId === cls.id || clsActivityIds.has(l.activityId)));
check('its activities are kept unless asked', (await api('/activities')).data.filter((a) => a.classId === cls.id).length === activitiesBefore);
const r2 = (await api(`/classes/${cls.id}/reset`, { method: 'POST', body: { deleteActivities: true } })).data;
check('a class reset can also delete its activities', r2.deleted === activitiesBefore && !(await api('/activities')).data.some((a) => a.classId === cls.id));
check('its login codes still work after a reset', (await api(`/classes/${cls.id}`)).data.students[0].code === full.students[0].code);

check('a database reset needs RESET typed', (await api('/reset', { method: 'POST', body: { scope: 'everything', confirm: 'yes' } })).status === 400);
check('only the admin can reset the database', (await api2('/reset', { method: 'POST', body: { scope: 'everything', confirm: 'RESET' } })).status === 403);
await api2('/activities', { method: 'POST', body: { classId: cls2.id, name: 'Still going', mode: 'open', blockSize: 1 } });
check('no reset while any teacher is running an activity', (await api('/reset', { method: 'POST', body: { scope: 'activities', confirm: 'RESET' } })).status === 409);
await emit(teacher2, 'live:finish', {});
const ra = (await api('/reset', { method: 'POST', body: { scope: 'activities', confirm: 'RESET' } })).data;
check('"delete all activities" removes every teacher\'s activities', ra.ok && ra.counts.activities > 0 && (await api('/activities')).data.length === 0 && (await api2('/activities')).data.length === 0);
check('…and keeps contexts and classes, minus what was learned', (await api('/classes')).data.length > 0 && ((await api(`/contexts/${ctxId}`)).data.learnings || []).length === 0);
const re = (await api('/reset', { method: 'POST', body: { scope: 'everything', confirm: 'RESET' } })).data;
check('"reset everything" empties the site', re.ok && re.counts.classes > 0 && re.counts.contexts > 0
  && (await api('/classes')).data.length === 0 && (await api('/contexts')).data.length === 0 && (await api('/activities')).data.length === 0);
check('old login codes no longer work', (await emit(io(URL), 'student:join', { code: full.students[0].code })).ok === false);

teacher2.close();
teacher.close();
for (const k of kids) k.sock.close();
console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`);
process.exit(failures ? 1 : 0);
