/**
 * A stand-in for the Claude API, so the whole activity can run in a test
 * without credentials or cost. Recognises each kind of call by its system
 * prompt and answers in the shape the app expects.
 */
import http from 'node:http';

export const calls = [];

const MODELS = [
  { id: 'claude-haiku-4-5', display_name: 'Claude Haiku 4.5', created_at: '2025-10-01T00:00:00Z' },
  { id: 'claude-haiku-3-5', display_name: 'Claude Haiku 3.5', created_at: '2024-10-01T00:00:00Z' },
  { id: 'claude-sonnet-5-5', display_name: 'Claude Sonnet 5.5', created_at: '2026-10-01T00:00:00Z' },
  { id: 'claude-sonnet-5', display_name: 'Claude Sonnet 5', created_at: '2026-04-01T00:00:00Z' },
  { id: 'claude-opus-5-5', display_name: 'Claude Opus 5.5', created_at: '2026-10-02T00:00:00Z' },
  { id: 'claude-opus-5', display_name: 'Claude Opus 5', created_at: '2026-04-02T00:00:00Z' },
];

function reply(res, body) {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function message(model, text) {
  return {
    id: `msg_${Math.random().toString(36).slice(2)}`, type: 'message', role: 'assistant', model,
    content: [{ type: 'text', text }], stop_reason: 'end_turn', stop_sequence: null,
    usage: { input_tokens: 1200, output_tokens: 40, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  };
}

export function startMock(port) {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      // The suite runs in another process, so it reads the call log over HTTP.
      if (req.url === '/__calls') return reply(res, calls);
      if (req.url === '/__reset') { calls.length = 0; return reply(res, { ok: true }); }
      if (req.method === 'GET' && req.url.startsWith('/v1/models')) {
        return reply(res, { data: MODELS, has_more: false, first_id: MODELS[0].id, last_id: MODELS.at(-1).id });
      }
      const request = JSON.parse(body || '{}');
      const system = JSON.stringify(request.system || '');
      calls.push({ model: request.model, effort: request.output_config?.effort, system, messages: request.messages });

      // Haiku in this mock rejects effort, like Haiku 4.5 does, to exercise the retry.
      if (request.model.includes('haiku') && request.output_config?.effort) {
        res.writeHead(400, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'effort is not supported on this model' } }));
      }

      if (system.includes('prepare briefings')) {
        return reply(res, message(request.model, JSON.stringify({
          title: 'Year 10 Science — Ecosystems',
          summary: 'The AI now knows the ecosystems unit and how 10B writes.',
          brief: 'You are in Year 10 Science. You did the sea otter and kelp forest example.',
          sampleMessages: ['idk the otter one makes sense', 'ok but why does the kelp care'],
          strengths: ['Clear content list'],
          gaps: ['Add ten real example messages'],
        })));
      }
      if (system.includes('analyse transcripts')) {
        const round = /This is round (\d)/.exec(JSON.stringify(request.messages))?.[1];
        return reply(res, message(request.model, '```json\n' + JSON.stringify({
          headline: `Round ${round}: the AI asked too many questions.`,
          summary: 'Students caught it by asking about lunch.',
          aiTells: [{ tell: 'Too many questions', evidence: 'what do you think?' }],
          humanSignals: [{ signal: 'Typos', evidence: 'teh' }],
          studentStrategies: ['Asked about lunch'],
          interests: ['footy'],
          misjudgements: [],
          guidance: [`Round ${round} lesson: end on statements`, 'Talk about footy if it comes up'],
        }) + '\n```'));
      }
      if (system.includes('honest, engaging summaries')) {
        return reply(res, message(request.model, JSON.stringify({
          title: '10B vs the machine', subtitle: 'Four rounds of Human or Not?',
          roundNotes: ['r1', 'r2', 'r3', 'r4'],
          story: [{ heading: 'It started stiff', body: 'Too many questions.' }],
          opusImpact: { headline: 'Opus off made little difference', body: 'Small sample.' },
          keyFindings: ['Lunch questions worked'],
          quotes: [{ text: 'ngl ur a bot', context: 'Round 1' }],
          discussionQuestions: ['What gave it away?'],
          closing: 'Thanks 10B.',
        })));
      }
      // A chat turn.
      return reply(res, message(request.model, 'yeah nah not really||the otter thing tho'));
    });
  });
  return new Promise((resolve) => server.listen(port, () => resolve(server)));
}
