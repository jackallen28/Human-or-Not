/**
 * The three ways an educator can run an activity.
 *
 *   learn3  Three rounds, every model, the AI learning after each one.
 *   learn4  Three learning rounds, then a fourth with a different set of
 *           models (by default Opus is switched off). Students are not told.
 *   open    Rounds in blocks of X, as many blocks as the class wants. No
 *           learning between rounds; the educator picks the models for each
 *           round instead.
 */

export const FAMILY_ORDER = ['haiku', 'sonnet', 'opus'];
export const MAX_ROUNDS = 12;

export const MODES = {
  learn3: {
    id: 'learn3',
    label: 'Three rounds, learning',
    short: '3 rounds · learning',
    description: 'All three models every round. After each round Claude reads the chats and teaches the AI what gave it away.',
    learning: true,
  },
  learn4: {
    id: 'learn4',
    label: 'Four rounds, learning, then a switch',
    short: '4 rounds · learning + switch',
    description: 'Three learning rounds with all three models, then a fourth round with the models you choose — students are not told.',
    learning: true,
  },
  open: {
    id: 'open',
    label: 'Open play',
    short: 'Open play',
    description: 'Play a few rounds at a time and keep going as long as you like. No learning between rounds — you choose which models play each round.',
    learning: false,
  },
};

export const modeInfo = (id) => MODES[id] || MODES.learn4;

const name = (f) => f[0].toUpperCase() + f.slice(1);
export const modelList = (families) => families.map(name).join(', ').replace(/, ([^,]*)$/, ' and $1');

/** Keep only known families, in a fixed order; fall back when nothing is left. */
export function cleanFamilies(list, fallback = FAMILY_ORDER) {
  const set = new Set(Array.isArray(list) ? list : []);
  const out = FAMILY_ORDER.filter((f) => set.has(f));
  return out.length ? out : [...fallback];
}

/** A short line describing what changed between the full set and `families`. */
export function switchNote(families) {
  const off = FAMILY_ORDER.filter((f) => !families.includes(f));
  if (!off.length) return 'Same models, everything learned so far';
  return `${modelList(off)} switched off (students are not told)`;
}

function learningNote(n) {
  if (n === 1) return 'All models, from the class brief';
  return `All models + what ${n > 2 ? `rounds 1–${n - 1}` : 'round 1'} taught them`;
}

/** One round of the plan. `editable` rounds can have their models changed before they start. */
const round = (number, models, note, extra = {}) => ({ number, models, note, editable: false, secret: false, ...extra });

/**
 * Build an activity's round plan from the educator's choices.
 * @param {string} mode
 * @param {object} opts
 * @param {string[]} [opts.finalModels]  learn4: the models in the last round
 * @param {string[]} [opts.models]       open: the models for the first block
 * @param {number}   [opts.blockSize]    open: rounds per block
 */
export function buildPlan(mode, { finalModels, models, blockSize } = {}) {
  if (mode === 'learn3') {
    return [1, 2, 3].map((n) => round(n, [...FAMILY_ORDER], learningNote(n)));
  }
  if (mode === 'open') {
    const size = clampBlock(blockSize);
    const fams = cleanFamilies(models);
    return Array.from({ length: size }, (_, i) => round(i + 1, [...fams], openNote(fams), { editable: true }));
  }
  const last = cleanFamilies(finalModels, ['haiku', 'sonnet']);
  return [
    ...[1, 2, 3].map((n) => round(n, [...FAMILY_ORDER], learningNote(n))),
    round(4, last, switchNote(last), { editable: true, secret: last.length < FAMILY_ORDER.length, final: true }),
  ];
}

export const clampBlock = (n) => Math.max(1, Math.min(6, Math.round(Number(n) || 3)));
export const openNote = (families) => `${modelList(families)} · no learning`;

/** Open play: add another block of rounds, carrying on with the last round's models. */
export function extendPlan(plan, blockSize) {
  const size = Math.min(clampBlock(blockSize), MAX_ROUNDS - plan.length);
  const last = plan[plan.length - 1]?.models || FAMILY_ORDER;
  for (let i = 0; i < size; i++) {
    plan.push(round(plan.length + 1, [...last], openNote(last), { editable: true }));
  }
  return size;
}

/** Change the models of a round that has not started. Returns an error string or null. */
export function setRoundModels(record, number, families) {
  const entry = record.plan.find((p) => p.number === number);
  if (!entry) return 'There is no such round.';
  if (!entry.editable) return 'The models for this round are fixed by the mode.';
  if (number <= record.rounds.length) return 'That round has already started.';
  const fams = cleanFamilies(families, []);
  if (!fams.length) return 'Choose at least one model.';
  entry.models = fams;
  if (record.mode === 'open') entry.note = openNote(fams);
  else { entry.note = switchNote(fams); entry.secret = fams.length < FAMILY_ORDER.length; }
  return null;
}

/** Records made before modes existed are the original four-round activity. */
export function ensurePlan(record) {
  if (!record.mode) record.mode = 'learn4';
  if (!record.plan) record.plan = buildPlan(record.mode, {});
  return record;
}
