/**
 * Shaping what the bot sends: how long it may be, where to cut it, and the
 * lines it uses when the model is not choosing.
 *
 * The length rule is the single most effective thing in the app. The loudest
 * AI tell in a live chat is a paragraph in reply to a line, so the reply length
 * is not a setting — it is taken from the person being replied to, every turn,
 * and then enforced on the output whether the model complied or not.
 */

export const MIRROR_FLOOR = Number(process.env.BOT_MIRROR_FLOOR || 12);
export const MIRROR_CEILING = Number(process.env.BOT_MIRROR_CEILING || 160);

/**
 * @param {string[]} theirMessages  what the partner has written, oldest first
 * @returns {{target: number, cap: number, last: number}}
 */
export function mirrorBudget(theirMessages = []) {
  const recent = theirMessages.map((t) => String(t || '').trim()).filter(Boolean).slice(-3);
  if (!recent.length) return { target: MIRROR_FLOOR * 2, cap: 70, last: 0 };

  // Mostly the message being answered, lightly smoothed by the ones before, so
  // somebody who has gone quiet is followed within a turn.
  const last = recent[recent.length - 1].length;
  const earlier = recent.slice(0, -1);
  const earlierAvg = earlier.length ? earlier.reduce((n, t) => n + t.length, 0) / earlier.length : last;
  const blend = last * 0.8 + earlierAvg * 0.2;

  const target = Math.round(Math.min(MIRROR_CEILING, Math.max(MIRROR_FLOOR, blend * 1.25)));
  const cap = Math.min(Math.max(Math.round(target * 1.4), 60), Math.round(MIRROR_CEILING * 1.15));
  return { target, cap, last };
}

/**
 * Trim to a limit, ending on a sentence where possible. A message cut off
 * mid-word is its own tell, so: sentence, then clause, then word, and overshoot
 * slightly to finish a sentence rather than send a fragment.
 */
export function trimToSentence(text, limit) {
  const out = String(text || '');
  if (out.length <= limit) return out;
  const cut = out.slice(0, limit);
  const lastOf = (s, marks) => Math.max(...marks.map((m) => s.lastIndexOf(m)));

  const stop = lastOf(cut, ['.', '?', '!']);
  if (stop >= Math.min(20, limit * 0.3)) return cut.slice(0, stop + 1);
  const clause = lastOf(cut, [',', ';']);
  if (clause > limit * 0.4) return cut.slice(0, clause).trim();
  const space = cut.lastIndexOf(' ');
  if (space > limit * 0.6) return cut.slice(0, space);

  const firstStop = Math.min(...['.', '?', '!'].map((m) => out.indexOf(m)).filter((i) => i > 0).concat([Infinity]));
  if (firstStop !== Infinity && firstStop <= limit * 1.6) return out.slice(0, firstStop + 1);
  return cut;
}

/** Strip what a chat window has no business carrying. Keeps `||`, the burst marker. */
export function cleanReply(text) {
  return String(text || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[*_#>`]/g, '')
    .replace(/\s*[—–]\s*/g, ', ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ---------------------------------------------------------------- filler lines

/**
 * Openers that presuppose a shared situation. A bare "hey" from the bot was the
 * most-shared tell in earlier trials — "a classmate doesn't just walk up and say
 * hello" — so there are none here, and none repeats within an activity.
 */
const OPENERS = {
  secondary: [
    'did you get any of that last bit', 'so tired rn', 'is this marked or nah',
    'how long is this going for', 'i was not ready for this lol', 'whos idea was this',
    'my laptop is on 4%', 'ok i actually dont mind this topic', 'starving',
    'wait are we meant to be talking about the work', 'this better count for something',
    'ngl i zoned out for half of that', 'whats the go with this', 'hot in here today',
    'lowkey forgot what we did last lesson', 'is the bell soon', 'i reckon this is a test',
  ],
  preservice: [
    'did you get through the readings this week', 'running on about four hours sleep',
    'is this going to be on the assessment', 'how long does this go for', 'coffee was a mistake',
    'my prac starts next week and im not ready', 'ok this is kind of fun actually',
    'i have a shift after this', 'wait what are we meant to be doing', 'that last lecture dragged',
    'still havent started the essay', 'honestly could use a nap', 'this room is freezing',
    'anyone else find the readings this week dense', 'love a bit of group work',
  ],
};

/** When the API is unreachable or returns nothing. Short, and never a refusal. */
const OFFLINE = {
  secondary: ['idk', 'maybe', 'yeah', 'nah', 'fair', 'lol', 'true', 'wait what', 'probs', 'same', 'huh', 'sure', 'hmm'],
  preservice: ['yeah fair', 'maybe', 'hmm', 'true', 'not sure tbh', 'ha', 'same', 'go on', 'right', 'could be', 'yep'],
};

function draw(lines, used) {
  const fresh = lines.filter((line) => !used.has(line));
  const from = fresh.length ? fresh : lines;
  if (!fresh.length) used.clear();
  const pick = from[Math.floor(Math.random() * from.length)];
  used.add(pick);
  return pick;
}

export const opener = (setId, used) => draw(OPENERS[setId] || OPENERS.secondary, used);
export const offlineLine = (setId, used) => draw(OFFLINE[setId] || OFFLINE.secondary, used);
