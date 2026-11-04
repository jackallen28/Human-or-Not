/**
 * A stand-in Claude API that answers with realistic, varied content, used to
 * produce the screenshots in docs/. Same shape as mock-claude.mjs; better words.
 */
import http from 'node:http';

const MODELS = [
  { id: 'claude-haiku-4-5', display_name: 'Claude Haiku 4.5', created_at: '2025-10-01T00:00:00Z' },
  { id: 'claude-sonnet-5-5', display_name: 'Claude Sonnet 5.5', created_at: '2026-10-01T00:00:00Z' },
  { id: 'claude-opus-5-5', display_name: 'Claude Opus 5.5', created_at: '2026-10-02T00:00:00Z' },
];

const CHAT = [
  'ngl that prac lesson on fractions went sideways||kids were not having it',
  'yeah nah my mentor just let me drown lol',
  'honestly the readings this week were so dense',
  'i reckon explicit teaching gets a bad rap tbh',
  'haha fair. still havent started the TPA',
  'coffee was a mistake, i have a shift after this',
];

const ANALYSES = {
  1: {
    headline: 'The AI was caught asking too many questions and never complaining about anything.',
    summary: 'Students who probed for prac stories caught the AI quickly: it answered in tidy generalities and turned every reply back into a question. Students who stayed on theory found it much harder to tell. The real pairs found each other quickly — they swapped prac complaints within a minute.',
    aiTells: [
      { tell: 'Ended almost every message with a question', evidence: 'what did you think of the lecture?' },
      { tell: 'Never complained about workload, unlike every real student', evidence: 'the readings were really insightful' },
      { tell: 'Gave a balanced both-sides answer to an opinion question', evidence: 'there are good arguments either way' },
    ],
    humanSignals: [{ signal: 'Complained about the TPA and prac', evidence: 'still havent started the TPA lol' }],
    studentStrategies: ['Asked what happened on their last prac', 'Asked how many words the essay was', 'Sent nonsense to see if it played along'],
    interests: ['The TPA', 'Prac horror stories', 'Coffee', 'Part-time jobs'],
    misjudgements: [],
    guidance: [
      'End most messages on a statement, not a question',
      'Complain a little: the TPA, readings, being tired, juggling a shift',
      'Take a side on opinion questions and stick to it',
      'If asked about prac, talk about a lesson that went badly, in general terms',
    ],
  },
  2: {
    headline: 'Complaining made the AI far more convincing — until students asked about specific lectures.',
    summary: 'With guidance from round 1 the AI sounded like a tired preservice teacher, and the pass rate rose. Students adapted: the best catches came from asking what a specific lecturer had said this week, which the AI could only answer vaguely.',
    aiTells: [{ tell: 'Vague about specific lectures', evidence: 'yeah that one was pretty interesting' }],
    humanSignals: [{ signal: 'Named in-jokes from the unit', evidence: 'the jelly bean pyramid lol' }],
    studentStrategies: ['Asked about a specific lecture', 'Used in-jokes as passwords'],
    interests: ['The jelly bean pyramid activity', 'Group assignment stress'],
    misjudgements: [],
    guidance: [
      'End most messages on a statement, not a question',
      'Complain a little: the TPA, readings, being tired, juggling a shift',
      'If asked about a specific lecture you cannot place, say you zoned out or missed it',
      'Use the jelly bean pyramid and group assignment stress when they come up',
      'Take a side on opinion questions and stick to it',
    ],
  },
  3: {
    headline: 'Round 3 was the AI’s best: it played along with in-jokes and admitted to zoning out.',
    summary: 'Admitting it had missed a lecture closed the gap students had found in round 2. Most students now could not tell, and several said the AI was "too relatable to be a bot".',
    aiTells: [{ tell: 'Replied a little too consistently fast', evidence: '(timing)' }],
    humanSignals: [{ signal: 'Typos and corrections', evidence: 'teh*' }],
    studentStrategies: ['Watched reply timing', 'Asked it to do maths quickly'],
    interests: ['End of semester', 'Graduation'],
    misjudgements: ['Student 2 was called an AI for replying too quickly'],
    guidance: [
      'Vary how fast you reply; occasionally take a while',
      'If asked to do quick maths, get it slightly wrong or refuse',
      'Keep complaining, keep taking sides, keep admitting what you missed',
    ],
  },
  4: {
    headline: 'Without Opus the AI slipped a little, but the lessons it had learned held up.',
    summary: 'Haiku and Sonnet, working from three rounds of guidance, were caught slightly more often. The gap between them and Opus was smaller than the gap between round 1 and round 3 — the learning mattered more than the model.',
    aiTells: [{ tell: 'Occasionally too tidy', evidence: 'that is a great point actually' }],
    humanSignals: [], studentStrategies: ['Asked about the jelly bean pyramid again'], interests: [], misjudgements: [],
    guidance: ['Keep the round 3 guidance'],
  },
};

const OVERVIEW = {
  title: 'EDU3001 vs the machine',
  subtitle: 'Four rounds, one AI learning to sound like a preservice teacher',
  roundNotes: [
    'Polite, curious and caught — too many questions, no complaints.',
    'Learned to complain about the TPA; caught on specific lectures.',
    'Admitted to zoning out and played along with in-jokes. Its best round.',
    'Opus off. Haiku and Sonnet held on to most of what was learned.',
  ],
  story: [
    { heading: 'It started too nice', body: 'In round 1 the AI asked a question in almost every message and never complained. Real preservice teachers complain. You noticed.' },
    { heading: 'It learned your grievances', body: 'By round 2 it was tired, behind on the TPA and juggling a shift. The pass rate jumped.' },
    { heading: 'You raised the bar', body: 'So you started asking about specific lectures and the jelly bean pyramid. Passwords only a real classmate would know.' },
    { heading: 'It learned to say "I missed that"', body: 'In round 3 it stopped bluffing. Admitting it had zoned out was more human than any answer.' },
  ],
  opusImpact: {
    headline: 'Switching Opus off cost less than you might think',
    body: 'Round 4 dropped from 75% to 50% — but with four AI chats a round, that is one student. What the AI had learned from you mattered more than which model was talking.',
  },
  keyFindings: [
    'The AI got harder to catch every round it learned from you: 25% → 50% → 75%.',
    'The best detector was lived experience — prac, lectures, in-jokes — not grammar.',
    'Real students spotted each other by complaining — the one thing the AI would not do at first.',
    'Switching Opus off mattered less than the lessons already learned.',
  ],
  quotes: [
    { text: 'nah you’re too relatable to be a bot', context: 'Round 3 — said to Claude Sonnet' },
    { text: 'what did you think of the lecture?', context: 'Round 1 — the question that gave it away' },
    { text: 'honestly i zoned out for that whole lecture', context: 'Round 3 — Claude Opus, passing as human' },
  ],
  discussionQuestions: [
    'What made you decide your partner was an AI? Did that still work by round 3?',
    'The AI learned your class in under an hour. What does that mean for written reflections and assessment?',
    'Complaining was the giveaway. What does "sounding human" actually mean?',
  ],
  closing: 'It had every word you used — and none of your prac.',
};

const BRIEF = {
  title: 'EDU3001 — Preservice teachers, week 6',
  summary: 'The AI knows the week 1–6 content of EDU3001, how second-year preservice teachers write in a chat, and what is going on for them right now: prac, the TPA and part-time work.',
  brief: 'You are a second-year Bachelor of Education student...',
  sampleMessages: ['still havent started the TPA lol', 'my mentor teacher is lovely but so busy', 'the jelly bean pyramid was actually fun'],
  strengths: ['Clear week-by-week content', 'Great detail on prac and the TPA'],
  gaps: ['Add 10–20 real (paraphrased) chat messages to file 03', 'Name two in-jokes from recent tutorials'],
};

function message(model, text) {
  return {
    id: `msg_${Math.random().toString(36).slice(2)}`, type: 'message', role: 'assistant', model,
    content: [{ type: 'text', text }], stop_reason: 'end_turn', stop_sequence: null,
    usage: { input_tokens: 3200, output_tokens: 60, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  };
}

export function startDemo(port) {
  let chatTurn = 0;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const send = (obj) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
      if (req.url.startsWith('/v1/models')) return send({ data: MODELS, has_more: false });
      const request = JSON.parse(body || '{}');
      const system = JSON.stringify(request.system || '');
      if (request.model.includes('haiku') && request.output_config?.effort) {
        res.writeHead(400, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'effort not supported' } }));
      }
      if (system.includes('prepare briefings')) return send(message(request.model, JSON.stringify(BRIEF)));
      if (system.includes('analyse transcripts')) {
        const round = /This is round (\d)/.exec(JSON.stringify(request.messages))?.[1] || '1';
        return send(message(request.model, JSON.stringify(ANALYSES[round])));
      }
      if (system.includes('honest, engaging summaries')) return send(message(request.model, JSON.stringify(OVERVIEW)));
      return send(message(request.model, CHAT[chatTurn++ % CHAT.length]));
    });
  });
  return new Promise((resolve) => server.listen(port, () => resolve(server)));
}
