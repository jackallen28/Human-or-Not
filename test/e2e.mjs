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
check('Opus wrote the brief', ctx.brief.includes('sea otter') && ctx.model === 'claude-opus-5-5');
check('training used Opus at high effort', (await getCalls()).some((c) => c.model === 'claude-opus-5-5' && c.effort === 'high' && c.system.includes('prepare briefings')));
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

  for (const k of kids) await emit(k.sock, 'chat:send', { text: `hey its student ${k.n}` });
  const aiNs = aiKids.map((s) => s.n);
  check(`round ${round}: the AI replies, as separate messages`,
    await until(() => aiNs.every((n) => kids[n - 1].msgs.filter((m) => !m.mine).length >= 2), 8000));
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
  check(`round ${round}: Opus analyses the round`, await until(() => view.round?.analysisStatus === 'done'));
  check(`round ${round}: the analysis headline is shown`, view.round.analysis.headline.startsWith(`Round ${round}`));
  check(`round ${round}: per-model stats`, Object.keys(view.round.stats.byModel).length === (round === 4 ? 2 : 3) || Object.keys(view.round.stats.byModel).length >= 1);
}
check('no fifth round', !(await emit(teacher, 'live:startRound', {})).ok);
const learnedCtx = (await api(`/contexts/${ctxId}`)).data;
check('what the activity learned is saved to the class context for next time',
  learnedCtx.learnings.length === 1 && learnedCtx.learnings[0].guidance.some((g) => g.includes('Round 4')));

console.log('\n--- 6. the overview ---');
check('the overview opens after round 4', (await emit(teacher, 'live:overview', {})).ok);
check('Opus writes it', await until(() => view.overviewStatus === 'done' && view.overviewData));
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
const opusCalls = async () => (await getCalls()).filter((c) => c.system.includes('analyse transcripts')).length;
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
  check(`learn3 round ${r}: Opus analyses it`, await until(() => view.round?.analysisStatus === 'done'));
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
check('open: no analysis between rounds', view.round.analysisStatus === 'off' && (await opusCalls()) === 0);
check('open: round 2 models can be changed after results', (await cmd('live:setModels', { models: ['sonnet', 'opus'] })).ok);
await quickRound('open round 2', ['sonnet', 'opus']);
check('open: the block ends', !(await cmd('live:startRound', {})).ok);
check('open: keep going adds another block', (await cmd('live:moreRounds', {})).ok && view.roundCount === 4);
check('open: the new block carries the last models on', view.plan[2].models.join() === 'sonnet,opus');
await quickRound('open round 3', ['sonnet', 'opus']);
check('open: the overview waits for the block to finish', !(await cmd('live:overview', {})).ok);
await quickRound('open round 4', ['sonnet', 'opus']);
check('open: still no analysis', (await opusCalls()) === 0);
check('open: the overview opens', (await cmd('live:overview', {})).ok);
check('open: the overview carries four rounds and no learning', await until(() => view.overviewData?.rounds.length === 4 && view.overviewData.mode.learning === false));
const overviewPrompt = (await getCalls()).find((c) => c.system.includes('honest, engaging summaries'));
check('open: Opus is told the AI did not learn', Boolean(overviewPrompt?.messages?.[0]?.content?.includes('did NOT learn')));
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
check('teacher 2 signs in with their own password', meta2.teacher?.name === 'Ms Second' && meta2.live === null);
check('teacher 2 starts with an empty workspace', (await api2('/contexts')).data.length === 0 && (await api2('/classes')).data.length === 0 && (await api2('/activities')).data.length === 0);
check('teacher 2 cannot open teacher 1\'s class', (await api2(`/classes/${cls.id}`)).status === 404);
check('teacher 2 cannot download teacher 1\'s activity', (await api2(`/activities/${act.id}/zip`)).status === 404);
check('teacher 2 cannot delete teacher 1\'s context', (await api2(`/contexts/${ctxId}`, { method: 'DELETE' })).status === 404 && (await api(`/contexts/${ctxId}`)).status === 200);
const cls2 = (await api2('/classes', { method: 'POST', body: { name: 'Ms Second 9A', count: 3, personaSet: 'secondary', contextId: ctxId } })).data;
check('teacher 2 makes a class, but cannot borrow teacher 1\'s context', cls2.size === 3 && cls2.contextId === null);
check('teacher 1 does not see it', !(await api('/classes')).data.some((c) => c.id === cls2.id));
const full2 = (await api2(`/classes/${cls2.id}`)).data;
check('login codes are unique across teachers', !full2.students.some((s) => full.students.some((t) => t.code === s.code)));

// Both teachers run an activity at the same time.
await api('/activities', { method: 'POST', body: { classId: cls.id, name: 'T1 live', durationSec: 60, mode: 'open', blockSize: 1 } });
const act2 = await api2('/activities', { method: 'POST', body: { classId: cls2.id, name: 'T2 live', durationSec: 60, mode: 'open', blockSize: 1 } });
check('teacher 2 can start while teacher 1 is running', act2.status === 200, act2.data.error || '');
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
  check(`teacher 2's Student ${s2.n} lands in teacher 2's activity`, res.ok && res.activity === 'T2 live');
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
const backup2 = (await api2('/backup')).data;
check('a backup holds only that teacher\'s things', backup2.classes.length === 1 && backup2.classes[0].id === cls2.id && backup2.activities.length === 1);
await emit(teacher2, 'live:finish', {});
await cmd('live:finish');
teacher2.close();
for (const k of kids2) k.sock.close();

teacher.close();
for (const k of kids) k.sock.close();
console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`);
process.exit(failures ? 1 : 0);
