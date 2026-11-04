/**
 * Regenerates the screenshots in docs/screenshots by running a whole activity
 * against a realistic stand-in for the Claude API.
 *
 *   PW_CHROMIUM=/path/to/chrome node test/screenshots.mjs
 */
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { io } from 'socket.io-client';
import { startDemo } from './demo-claude.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(here, '..', 'docs', 'screenshots');
const URL = 'http://localhost:3600';
const CODE = 'demo';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const emit = (s, e, p) => new Promise((r) => s.emit(e, p, r));
fs.mkdirSync(OUT, { recursive: true });

const mock = await startDemo(3601);
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hon-shots-'));
const server = spawn('node', [path.join(here, '..', 'server', 'index.js')], {
  env: {
    ...process.env, PORT: '3600', TEACHER_CODE: CODE, DATA_DIR: dataDir, DATABASE_URL: '',
    PUBLIC_URL: 'https://human-or-not.onrender.com',
    ANTHROPIC_API_KEY: 'sk-ant-demo', ANTHROPIC_BASE_URL: 'http://localhost:3601',
    BOT_THINK_MS: '200', BOT_REPLY_CAP_MS: '500', BOT_WPM_MIN: '400', BOT_WPM_MAX: '500', BOT_HOLD_BACK: '1',
  },
  stdio: 'ignore',
});
await sleep(1500);

const browser = await chromium.launch(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {});
const t = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 });
const shot = (page, name, opts = {}) => page.screenshot({ path: path.join(OUT, `${name}.png`), ...opts });

// ---------------------------------------------------------------- console
await t.goto(`${URL}/teacher`, { waitUntil: 'networkidle' });
await t.fill('#auth-code', CODE);
await t.click('#auth-btn');
await t.waitForSelector('#screen-app:not(.hidden)');
await sleep(400);
await shot(t, 'console-home');

await t.click('[data-tab="train"]');
const files = {
  about: '# 01\n## The class\nSecond-year Bachelor of Education (Secondary), EDU3001 tutorial, 24 students.\n## Who the students are\n20-30, juggling prac, the TPA and part-time work.\n## How they talk and write\nlower case, lol, tbh, complaining about the TPA.',
  learned: '# 02\n## What has been covered so far\nWeeks 1-6: explicit teaching, cognitive load, differentiation, the jelly bean pyramid, the APSTs.',
};
for (const [slot, text] of Object.entries(files)) {
  const f = path.join(dataDir, `${slot}.md`);
  fs.writeFileSync(f, text);
  await t.click(`.drop[data-slot="${slot}"]`);
  await t.setInputFiles('#ctx-file', f);
  await sleep(150);
}
await t.fill('#ctx-name', 'EDU3001 week 6');
await t.click('#ctx-train');
await t.waitForSelector('text=Ready', { timeout: 10000 });
await sleep(300);
await shot(t, 'train', { fullPage: true });

await t.click('[data-tab="classes"]');
await t.fill('#cls-name', 'EDU3001 Tutorial 2');
await t.fill('#cls-count', '8');
await sleep(200);
await shot(t, 'personas-secondary', { fullPage: true });
await t.click('[data-set="preservice"]');
await sleep(200);
await shot(t, 'personas-preservice', { fullPage: true });
const dl = t.waitForEvent('download');
await t.click('#cls-create');
const pdfPath = path.join(dataDir, 'cards.pdf');
await (await dl).saveAs(pdfPath);
execFileSync('pdftoppm', ['-r', '110', '-png', '-f', '1', '-l', '1', pdfPath, path.join(dataDir, 'cards')]);
fs.copyFileSync(fs.readdirSync(dataDir).filter((f) => f.startsWith('cards') && f.endsWith('.png')).map((f) => path.join(dataDir, f))[0], path.join(OUT, 'login-cards.png'));

await t.click('[data-tab="activities"]');
await t.fill('#act-name', 'Preservice teachers — week 6');
await t.selectOption('#act-duration', '180');
await sleep(200);
await shot(t, 'activity-modes', { fullPage: true });
await t.click('#act-start');
await t.waitForSelector('#live-lobby:not(.hidden)');

// --------------------------------------------------------------- students
const cls = (await (await fetch(`${URL}/api/classes`, { headers: { 'x-teacher-code': CODE } })).json())[0];
const full = await (await fetch(`${URL}/api/classes/${cls.id}`, { headers: { 'x-teacher-code': CODE } })).json();

const phone = await browser.newPage({ viewport: { width: 400, height: 780 }, deviceScaleFactor: 2 });
await phone.goto(URL, { waitUntil: 'networkidle' });
await shot(phone, 'student-join');
await phone.fill('#code', full.students[0].code);
await phone.click('#join-btn');

const watcher = io(URL);
await new Promise((r) => watcher.on('connect', r));
let view = null;
watcher.on('live', (v) => { view = v; });
await emit(watcher, 'teacher:auth', { code: CODE });

const kids = {};
for (const s of full.students.slice(1)) {
  const sock = io(URL);
  await new Promise((r) => sock.on('connect', r));
  await emit(sock, 'student:join', { code: s.code });
  kids[s.n] = sock;
}
await sleep(600);
await shot(t, 'lobby');

// How many AI-paired students guess "human" each round: 25%, 50%, 75%, 50%.
const FOOLED = { 1: 1, 2: 2, 3: 3, 4: 2 };
const LINES = ['did you get to the readings', 'my prac mentor was so nice tho', 'lol same', 'wait which lecture', 'so tired today', 'ok thats fair'];
let sent = 0;
let chatShot = false;

for (let round = 1; round <= 4; round++) {
  if (round === 1) await t.click('#btn-start-1'); else await t.click('#btn-next');
  await t.waitForSelector('#live-active:not(.hidden)');
  await sleep(300);
  const me = view.students.find((s) => s.n === 1);
  for (const line of ['ngl this week has been a lot', 'how was your prac', 'haha same, still havent started the TPA']) {
    await phone.fill('#msg', line);
    await phone.press('#msg', 'Enter');
    for (const sock of Object.values(kids)) await emit(sock, 'chat:send', { text: LINES[sent++ % LINES.length] });
    await sleep(1800);
  }
  await sleep(1500);
  if (round === 1) await shot(t, 'live-round');
  // The phone shot should show a conversation with the AI, whichever round that falls in.
  if (!chatShot && (me?.partner === 'ai' || round === 4)) { await shot(phone, 'student-chat'); chatShot = true; }
  await t.click('#btn-end');
  await sleep(400);

  // Guesses: AI partners fool the planned number; classmates are mostly spotted.
  let fooledLeft = FOOLED[round];
  for (const s of view.students.filter((x) => x.inRound)) {
    const guess = s.partner === 'ai'
      ? (fooledLeft-- > 0 ? 'human' : 'ai')
      : (round === 1 && s.n === 6 ? 'ai' : 'human');
    if (s.n === 1) await phone.click(guess === 'human' ? '#guess-human' : '#guess-ai');
    else if (kids[s.n]) await emit(kids[s.n], 'guess', { guess });
  }
  await t.waitForSelector('#live-results:not(.hidden)');
  await t.waitForFunction(() => !document.getElementById('btn-next').disabled, null, { timeout: 15000 });
  await sleep(1500);
  if (round === 1) {
    await shot(t, 'results', { fullPage: true });
    await shot(phone, 'student-result');
  }
  void me;
}

// --------------------------------------------------------------- overview
await t.click('#btn-next');
await t.waitForSelector('.ov-root', { timeout: 15000 });
await t.click('.ov-play'); // pause autoplay
const slide = async (index, name, wait = 3500) => {
  await t.click(`.ov-dots span[data-i="${index}"]`);
  await sleep(wait);
  const box = await t.locator('.ov-root').boundingBox();
  await t.screenshot({ path: path.join(OUT, `${name}.png`), clip: box });
};
const count = await t.locator('.ov-slide').count();
const titles = await t.locator('.ov-slide .ov-kicker').allTextContents();
await slide(0, 'overview-title', 2000);
await slide(1, 'overview-plan', 2600);
await slide(2, 'overview-chart', 4000);
await slide(3, 'overview-models', 4200);
for (let i = 4; i < count; i++) {
  const kicker = (await t.locator('.ov-slide').nth(i).locator('.ov-kicker').textContent().catch(() => '')) || '';
  if (/taught/i.test(kicker)) await slide(i, 'overview-learning', 3200);
  if (/story/i.test(kicker)) await slide(i, 'overview-story', 4200);
  if (/round 4/i.test(kicker)) await slide(i, 'overview-opus', 3200);
  if (/chats/i.test(kicker)) await slide(i, 'overview-quotes', 3500);
  if (/findings/i.test(kicker)) await slide(i, 'overview-findings', 3200);
}
void titles;

// ------------------------------------------------------------- open play
await emit(watcher, 'live:finish', {});
await fetch(`${URL}/api/activities`, {
  method: 'POST', headers: { 'content-type': 'application/json', 'x-teacher-code': CODE },
  body: JSON.stringify({ classId: cls.id, name: 'Open play — Friday', durationSec: 180, mode: 'open', blockSize: 2, models: ['haiku', 'sonnet', 'opus'] }),
});
for (const s of full.students.slice(1)) await emit(kids[s.n], 'student:join', { code: s.code });
await sleep(400);
for (let round = 1; round <= 2; round++) {
  if (round === 2) await emit(watcher, 'live:setModels', { models: ['opus'] });
  await emit(watcher, 'live:startRound', {});
  await sleep(300);
  for (const sock of Object.values(kids)) await emit(sock, 'chat:send', { text: LINES[sent++ % LINES.length] });
  await sleep(1500);
  await emit(watcher, 'live:endRound', {});
  await sleep(200);
  let fooledLeft = round;
  for (const st of view.students.filter((x) => x.inRound)) {
    const guess = st.partner === 'ai' ? (fooledLeft-- > 0 ? 'human' : 'ai') : 'human';
    if (kids[st.n]) await emit(kids[st.n], 'guess', { guess });
  }
  await emit(watcher, 'live:results', {});
  await sleep(300);
  if (round === 1) {
    await t.waitForSelector('#live-results:not(.hidden)');
    await sleep(800);
    await shot(t, 'open-play-results', { fullPage: true });
  }
}
await t.waitForSelector('#btn-more:not(.hidden)');
await sleep(600);
await shot(t, 'open-play-keep-going', { fullPage: true });

await browser.close();
watcher.close();
for (const s of Object.values(kids)) s.close();
server.kill();
mock.close();
console.log(`Saved ${fs.readdirSync(OUT).length} screenshots to ${OUT}`);
