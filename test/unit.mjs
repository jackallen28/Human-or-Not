/** Unit checks: no server, no network. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mirrorBudget, trimToSentence, cleanReply, opener } from '../server/text.js';
import { buildCardsPdf, generateCodes } from '../server/pdf.js';
import { PERSONA_SETS, activePersonas, personaCatalog } from '../server/personas.js';
import { fileStore, pgStore } from '../server/store.js';
import { parseJsonLoose } from '../server/claude.js';
import { cleanContextFile, contextWordCount, extractSamples } from '../server/analysis.js';
import { buildSharedPrompt } from '../server/bot.js';

let failures = 0;
const check = (label, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`);
  if (!cond) failures++;
};

console.log('--- reply length follows the student ---');
check('a short message gets a short reply', mirrorBudget(['lol']).cap <= 70);
check('a long message gets more room', mirrorBudget(['x'.repeat(150)]).target > mirrorBudget(['hey']).target * 3);
check('never an essay', mirrorBudget(['x'.repeat(3000)]).cap <= 200);
check('trim ends on a sentence', trimToSentence('Short one. Then a long second sentence that goes on.', 30) === 'Short one.');
check('markdown and em dashes are stripped', cleanReply('**yes** — maybe') === 'yes, maybe');
const used = new Set();
const openers = Array.from({ length: 12 }, () => opener('secondary', used));
check('openers never repeat in an activity', new Set(openers).size === 12);
check('no opener is a bare greeting', openers.every((o) => !/^(hi|hey|hello|yo)$/i.test(o)));

console.log('\n--- personas ---');
check('two persona sets', Object.keys(PERSONA_SETS).join(',') === 'secondary,preservice');
check('at least six personas each', Object.values(PERSONA_SETS).every((s) => s.personas.length >= 6));
check('unticked personas are respected', activePersonas('preservice', ['P2']).map((p) => p.id).join() === 'P2');
check('nothing ticked means all of them', activePersonas('secondary', []).length === PERSONA_SETS.secondary.personas.length);
check('catalog carries summaries', personaCatalog()[0].personas.every((p) => p.summary.length > 10));
const prompt = buildSharedPrompt({ personaSetId: 'preservice', context: { brief: 'BRIEF', sampleMessages: ['ok'], learnings: [{ guidance: ['OLD LESSON'] }] }, guidance: ['NEW LESSON'] });
check('the briefing carries the brief, samples and both kinds of learning',
  prompt.includes('BRIEF') && prompt.includes('- ok') && prompt.includes('OLD LESSON') && prompt.includes('NEW LESSON'));
check('the preservice set says who it is', prompt.includes('initial teacher education'));
check('safeguards come last', prompt.lastIndexOf('SAFEGUARDS') > prompt.lastIndexOf('RULES'));

console.log('\n--- codes and cards ---');
const codes = generateCodes(40);
check('codes are unique', new Set(codes).size === 40);
check('codes avoid confusable characters', codes.every((c) => /^[A-Z]{4}[2-9]{4}$/.test(c) && !/[IO]/.test(c)));
const pdf = buildCardsPdf({ title: 'Year 10 – 10B', joinUrl: 'example.onrender.com', cards: codes.slice(0, 13).map((code, i) => ({ label: `Student ${i + 1}`, code })) });
check('the PDF has a header and trailer', pdf.subarray(0, 8).toString() === '%PDF-1.4' && pdf.toString('latin1').trimEnd().endsWith('%%EOF'));
check('13 cards make two pages', /\/Count 2/.test(pdf.toString('latin1')));
const xref = Number(/startxref\n(\d+)/.exec(pdf.toString('latin1'))[1]);
check('the xref offset points at the xref table', pdf.subarray(xref, xref + 4).toString() === 'xref');

console.log('\n--- context files ---');
const voice = fs.readFileSync(new URL('../templates/03-student-voice.md', import.meta.url), 'utf8');
check('template notes are stripped', !cleanContextFile(voice).includes('HOW TO FILL'));
check('an empty template counts as nearly no words', contextWordCount({ a: voice }) < 25, String(contextWordCount({ a: voice })));
check('example messages are extracted', extractSamples('## Example messages\n- idk\n- nah fair\n\n## Notes on style\nx').join('|') === 'idk|nah fair');
check('loose JSON parsing copes with fences and chatter',
  parseJsonLoose('Here you go:\n```json\n{"a":1}\n```')?.a === 1 && parseJsonLoose('nope') === null);

console.log('\n--- storage ---');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hon-'));
const files = fileStore(dir);
await files.init();
await files.put('classes', 'cls_a', { id: 'cls_a', name: 'A' });
check('file store round-trips', (await files.get('classes', 'cls_a'))?.name === 'A');
check('file store lists', (await files.list('classes')).length === 1);
await files.remove('classes', 'cls_a');
check('file store removes', (await files.get('classes', 'cls_a')) === null);
let threw = false;
try { await files.get('classes', '../etc'); } catch { threw = true; }
check('ids cannot escape the data folder', threw);

const { newDb } = await import('pg-mem');
const { Pool } = newDb().adapters.createPg();
const pg = pgStore(new Pool());
await pg.init();
await pg.put('activities', 'act_1', { id: 'act_1', rounds: [1, 2] });
await pg.put('activities', 'act_1', { id: 'act_1', rounds: [1, 2, 3] });
check('postgres store upserts', (await pg.get('activities', 'act_1'))?.rounds.length === 3);
check('postgres store lists', (await pg.list('activities')).length === 1);
await pg.remove('activities', 'act_1');
check('postgres store removes', (await pg.get('activities', 'act_1')) === null);

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`);
process.exit(failures ? 1 : 0);
