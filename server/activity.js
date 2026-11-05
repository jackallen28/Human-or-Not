import { EventEmitter } from 'node:events';
import { buildPersonaPrompt, buildSharedPrompt, botReply, drawWpm, replyTiming } from './bot.js';
import { estimateCost, modelInfo } from './claude.js';
import { activePersonas, personaSet } from './personas.js';
import { opener } from './text.js';
import { analyseRound, buildOverview } from './analysis.js';
import { overviewData } from './report.js';
import { ensurePlan, extendPlan, modeInfo, setRoundModels, MAX_ROUNDS } from './modes.js';

/**
 * One activity, live, with one class. The rounds come from the activity's
 * plan (see modes.js):
 *
 *   learn3  three rounds, every model, Claude teaching the AI after each round
 *   learn4  the same, then a fourth round with the models the educator chose
 *           (by default Opus switched off; students are not told)
 *   open    blocks of rounds with no learning; the educator picks the models
 *           for each round and keeps adding blocks as long as they like
 *
 * In the learning modes, after each round's results Claude reads the transcripts
 * and writes guidance for the next round. At the end it writes the overview.
 * Everything is written to the store as it happens, so a finished activity
 * can be downloaded later and a crash mid-activity loses at most the round in
 * progress.
 */

/** At most this many students in one activity; a class can hold up to 100. */
export const MAX_ACTIVITY_STUDENTS = Math.max(2, Number(process.env.MAX_STUDENTS_PER_ACTIVITY) || 50);
export const MAX_CLASS_STUDENTS = 100;

export const PHASES = {
  LOBBY: 'lobby',       // students joining, waiting for a round
  ACTIVE: 'active',     // chatting, clock running
  GUESS: 'guess',       // time up, students guessing
  RESULTS: 'results',   // round revealed; analysis running or done
  OVERVIEW: 'overview', // the planned rounds are done; the animated overview is on screen
  FINISHED: 'finished',
};

const MAX_MESSAGE = 400;
const MIN_INTERVAL_MS = 350;
const HOLD_BACK = Number(process.env.BOT_HOLD_BACK || 0.45);

const shuffle = (list) => {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
};
const pct = (part, whole) => (whole ? Math.round((part / whole) * 100) : null);

export class LiveActivity extends EventEmitter {
  /**
   * @param {object} opts
   * @param {object} opts.record   the stored activity record
   * @param {object} opts.cls      the class
   * @param {object|null} opts.context  the class's context profile
   * @param {object} opts.store
   */
  constructor({ record, cls, context, store }) {
    super();
    this.record = ensurePlan(record);
    this.mode = modeInfo(this.record.mode);
    this.cls = cls;
    this.context = context;
    this.store = store;
    this.phase = PHASES.LOBBY;
    this.students = new Map(); // n -> {n, label, code, socketId, connected}
    this.codes = new Map(cls.students.map((s) => [s.code, s]));
    this.convs = new Map();    // runtime conversations of the current round
    this.timers = new Set();
    this.usedOpeners = new Set();
    this.endsAt = null;
    this.analysing = false;
    this.overviewing = false;
    this.lastSent = new Map();
  }

  get round() { return this.record.rounds[this.record.rounds.length - 1] || null; }
  get roundNumber() { return this.record.rounds.length; }
  get plan() { return this.record.plan; }
  get learning() { return this.mode.learning; }
  get planDone() { return this.roundNumber >= this.plan.length; }

  later(fn, ms) {
    const t = setTimeout(() => { this.timers.delete(t); fn(); }, ms);
    this.timers.add(t);
    return t;
  }

  clearTimers() {
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
  }

  save() {
    this.record.updatedAt = Date.now();
    return this.store.put('activities', this.record.id, this.record).catch((err) => {
      console.warn('[activity] could not save:', err.message);
    });
  }

  // ------------------------------------------------------------- students

  join(rawCode, socketId) {
    const code = String(rawCode || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    const entry = this.codes.get(code);
    if (!entry) return { ok: false, error: 'That code is not part of this class.' };
    const existing = this.students.get(entry.n);
    if (!existing && this.students.size >= MAX_ACTIVITY_STUDENTS) {
      return { ok: false, code: 'full', error: `This activity is full (${MAX_ACTIVITY_STUDENTS} students). Check with your teacher which room you are in.` };
    }
    const student = existing || { n: entry.n, label: entry.label, code, joinedAt: Date.now() };
    student.socketId = socketId;
    student.connected = true;
    this.students.set(entry.n, student);
    this.emit('roster');
    return { ok: true, n: entry.n, label: entry.label, code };
  }

  /** Has this code already joined (so it can always come back), or is there room for it? */
  hasJoined(code) { const entry = this.codes.get(code); return Boolean(entry && this.students.has(entry.n)); }
  hasRoom() { return this.students.size < MAX_ACTIVITY_STUDENTS; }

  disconnect(socketId) {
    for (const s of this.students.values()) {
      if (s.socketId === socketId) { s.connected = false; this.emit('roster'); }
    }
  }

  // --------------------------------------------------------------- rounds

  /** Start the next round. Only from the lobby or a finished round's results. */
  startRound() {
    if (![PHASES.LOBBY, PHASES.RESULTS].includes(this.phase)) {
      return { ok: false, error: 'A round is already under way.' };
    }
    if (this.planDone) {
      return { ok: false, error: this.mode.id === 'open' ? 'Add more rounds to keep going.' : 'All the rounds are done.' };
    }
    if (this.phase === PHASES.RESULTS && this.analysing) {
      return { ok: false, error: 'Claude is still analysing the last round. It will be ready in a moment.' };
    }
    const present = [...this.students.values()].filter((s) => s.connected);
    if (present.length === 0) return { ok: false, error: 'No students are logged in yet.' };

    const plan = this.plan[this.roundNumber];
    // The most recent guidance that exists: a failed analysis must not wipe
    // what earlier rounds learned. Open play does not learn between rounds.
    const guidance = this.learning
      ? [...this.record.rounds].reverse().find((r) => r.analysis?.guidance?.length)?.analysis.guidance || []
      : [];
    const setId = this.record.personaSet;
    const sharedPrompt = buildSharedPrompt({ personaSetId: setId, context: this.context, guidance });
    const personas = shuffle(activePersonas(setId, this.record.personas));

    // Pairing: a share with the AI, the rest in pairs. An odd number of humans
    // leaves one over, so they go to the AI instead.
    const order = shuffle(present.map((s) => s.n));
    let aiCount = Math.round(order.length * this.record.aiRatio);
    if (order.length === 1) aiCount = 1;
    if ((order.length - aiCount) % 2 === 1) aiCount = aiCount < order.length ? aiCount + 1 : aiCount - 1;
    const families = shuffle(plan.models);

    const round = {
      number: plan.number,
      models: [...plan.models],
      note: plan.note,
      secret: Boolean(plan.secret),
      startedAt: Date.now(),
      endedAt: null,
      durationSec: this.record.durationSec,
      guidanceUsed: guidance,
      conversations: [],
      guesses: {},
      stats: null,
      analysis: null,
      analysisStatus: this.learning ? 'pending' : 'off',
    };
    this.record.rounds.push(round);
    this.convs.clear();

    let id = 0;
    order.slice(0, aiCount).forEach((n, i) => {
      const family = families[i % families.length];
      const persona = personas[i % personas.length];
      this.addConversation(round, {
        id: `r${plan.number}c${++id}`, type: 'ai', members: [n], family,
        modelId: modelInfo(family).id, modelLabel: modelInfo(family).label,
        personaId: persona.id, personaLabel: persona.label,
      }, { persona, sharedPrompt });
    });
    const humans = order.slice(aiCount);
    for (let i = 0; i + 1 < humans.length; i += 2) {
      this.addConversation(round, { id: `r${plan.number}c${++id}`, type: 'human', members: [humans[i], humans[i + 1]] });
    }

    this.phase = PHASES.ACTIVE;
    this.endsAt = Date.now() + this.record.durationSec * 1000;
    this.later(() => this.endRound(), this.record.durationSec * 1000);

    for (const conv of this.convs.values()) {
      if (conv.record.type !== 'ai') continue;
      const waits = Math.random() < HOLD_BACK;
      conv.openerTimer = this.later(() => {
        if (this.phase !== PHASES.ACTIVE || conv.record.messages.length) return;
        this.deliver(conv, 'ai', opener(setId, this.usedOpeners));
      }, waits ? 25000 + Math.random() * 15000 : 3000 + Math.random() * 5000);
    }

    this.save();
    this.emit('phase');
    return { ok: true };
  }

  addConversation(round, record, runtime = {}) {
    const full = { ...record, messages: [], tokensIn: 0, tokensOut: 0, botTurns: 0, liveTurns: 0 };
    round.conversations.push(full);
    const conv = {
      record: full,
      persona: runtime.persona || null,
      personaPrompt: runtime.persona ? buildPersonaPrompt(runtime.persona) : '',
      sharedPrompt: runtime.sharedPrompt || '',
      wpm: drawWpm(this.record.personaSet),
      usedOffline: new Set(),
      busy: false,
      again: false,
    };
    this.convs.set(full.id, conv);
    return conv;
  }

  convFor(n) {
    for (const conv of this.convs.values()) if (conv.record.members.includes(n)) return conv;
    return null;
  }

  endRound() {
    if (this.phase !== PHASES.ACTIVE) return { ok: false, error: 'No round is running.' };
    this.clearTimers();
    this.phase = PHASES.GUESS;
    this.endsAt = null;
    this.round.endedAt = Date.now();
    this.emit('typingOff');
    this.save();
    this.emit('phase');
    // Nobody in the round (everyone dropped out) — straight to results.
    if (this.round.conversations.length === 0) this.showResults();
    return { ok: true };
  }

  sendMessage(n, raw) {
    if (this.phase !== PHASES.ACTIVE) return { ok: false, error: 'The chat is closed.' };
    const conv = this.convFor(n);
    if (!conv) return { ok: false, error: 'You are sitting this round out.' };
    const text = String(raw || '').replace(/\s+/g, ' ').trim().slice(0, MAX_MESSAGE);
    if (!text) return { ok: false, error: 'Empty message.' };
    const now = Date.now();
    if (now - (this.lastSent.get(n) || 0) < MIN_INTERVAL_MS) return { ok: false, error: 'Slow down a little.' };
    this.lastSent.set(n, now);
    this.deliver(conv, n, text);
    if (conv.record.type === 'ai') this.scheduleBot(conv);
    return { ok: true };
  }

  deliver(conv, from, text) {
    const message = { from, text, ts: Date.now() };
    conv.record.messages.push(message);
    for (const n of conv.record.members) this.emit('message', n, { mine: from === n, text, ts: message.ts });
  }

  setTyping(n, typing) {
    const conv = this.convFor(n);
    if (!conv || conv.record.type !== 'human' || this.phase !== PHASES.ACTIVE) return;
    for (const m of conv.record.members) if (m !== n) this.emit('typing', m, Boolean(typing));
  }

  // ------------------------------------------------------------------ bot

  scheduleBot(conv) {
    if (conv.busy) { conv.again = true; return; }
    if (conv.botTimer) { clearTimeout(conv.botTimer); this.timers.delete(conv.botTimer); }
    conv.botTimer = this.later(() => this.runBot(conv), 900 + Math.random() * 800);
  }

  history(conv) {
    const out = [];
    for (const m of conv.record.messages) {
      const role = m.from === 'ai' ? 'assistant' : 'user';
      const last = out[out.length - 1];
      if (last && last.role === role) last.content += `\n${m.text}`;
      else out.push({ role, content: m.text });
    }
    while (out.length && out[0].role === 'assistant') out.shift();
    return out;
  }

  pause(ms) {
    return new Promise((resolve) => { this.later(resolve, Math.max(0, ms)); });
  }

  async runBot(conv) {
    if (this.phase !== PHASES.ACTIVE) return;
    conv.busy = true;
    conv.again = false;
    const [n] = conv.record.members;
    try {
      const history = this.history(conv);
      if (!history.length) return;
      const startedAt = Date.now();
      const reply = await botReply({
        history,
        family: conv.record.family,
        sharedPrompt: conv.sharedPrompt,
        personaPrompt: conv.personaPrompt,
        setId: this.record.personaSet,
        used: conv.usedOffline,
      });
      if (this.phase !== PHASES.ACTIVE) return;
      conv.record.botTurns += 1;
      conv.record.tokensIn += reply.usage.input;
      conv.record.tokensOut += reply.usage.output;
      if (reply.live) conv.record.liveTurns += 1;

      for (const [index, part] of reply.parts.entries()) {
        const { thinkMs, typeMs } = replyTiming(part, conv.wpm);
        const wait = index === 0 ? thinkMs - (Date.now() - startedAt) : 500 + Math.random() * 1200;
        await this.pause(wait);
        if (this.phase !== PHASES.ACTIVE) return;
        this.emit('typing', n, true);
        await this.pause(index === 0 ? typeMs : Math.min(typeMs, 4000));
        if (this.phase !== PHASES.ACTIVE) return;
        this.emit('typing', n, false);
        this.deliver(conv, 'ai', part);
      }
    } catch (err) {
      console.warn('[activity] bot turn failed:', err.message);
    } finally {
      this.emit('typing', n, false);
      conv.busy = false;
      const last = conv.record.messages[conv.record.messages.length - 1];
      if (conv.again && last && last.from !== 'ai' && this.phase === PHASES.ACTIVE) this.scheduleBot(conv);
    }
  }

  // --------------------------------------------------------------- guesses

  guess(n, value) {
    if (this.phase !== PHASES.GUESS) return { ok: false, error: 'Not time to guess.' };
    if (!['human', 'ai'].includes(value)) return { ok: false, error: 'Pick classmate or AI.' };
    if (!this.convFor(n)) return { ok: false, error: 'You were not in this round.' };
    if (this.round.guesses[n]) return { ok: false, error: 'You have already guessed.' };
    this.round.guesses[n] = value;
    this.emit('roster');
    const waiting = this.round.conversations.flatMap((c) => c.members).filter((m) => !this.round.guesses[m]);
    // Everyone still connected has answered: reveal without waiting for the teacher.
    const stillHere = waiting.filter((m) => this.students.get(m)?.connected);
    if (stillHere.length === 0) this.showResults();
    return { ok: true };
  }

  // -------------------------------------------------------------- results

  computeStats(round) {
    const byModel = {};
    const byPersona = {};
    let paired = 0; let answered = 0; let correct = 0;
    let aiAnswered = 0; let aiFooled = 0; let humanAnswered = 0; let humanCorrect = 0;
    for (const conv of round.conversations) {
      for (const n of conv.members) {
        paired += 1;
        const g = round.guesses[n];
        if (!g) continue;
        answered += 1;
        if (g === conv.type) correct += 1;
        if (conv.type === 'ai') {
          aiAnswered += 1;
          if (g === 'human') aiFooled += 1;
        } else {
          humanAnswered += 1;
          if (g === 'human') humanCorrect += 1;
        }
      }
      if (conv.type !== 'ai') continue;
      const m = byModel[conv.family] ||= { family: conv.family, label: conv.modelLabel, conversations: 0, answered: 0, fooled: 0, tokensIn: 0, tokensOut: 0 };
      m.conversations += 1;
      m.tokensIn += conv.tokensIn;
      m.tokensOut += conv.tokensOut;
      const p = byPersona[conv.personaId] ||= { id: conv.personaId, label: conv.personaLabel, conversations: 0, answered: 0, fooled: 0 };
      p.conversations += 1;
      const g = round.guesses[conv.members[0]];
      if (g) { m.answered += 1; p.answered += 1; }
      if (g === 'human') { m.fooled += 1; p.fooled += 1; }
    }
    for (const m of Object.values(byModel)) {
      m.fooledRate = pct(m.fooled, m.answered);
      m.costUsd = Number(estimateCost(m.family, m.tokensIn, m.tokensOut).toFixed(4));
    }
    for (const p of Object.values(byPersona)) p.fooledRate = pct(p.fooled, p.answered);
    return {
      students: paired,
      aiConversations: round.conversations.filter((c) => c.type === 'ai').length,
      humanPairs: round.conversations.filter((c) => c.type === 'human').length,
      answered, correct,
      accuracy: pct(correct, answered),
      aiAnswered, aiFooled, aiFooledRate: pct(aiFooled, aiAnswered),
      humanAnswered, humanCorrect, humanSpotRate: pct(humanCorrect, humanAnswered),
      byModel, byPersona,
    };
  }

  showResults() {
    if (![PHASES.GUESS, PHASES.ACTIVE].includes(this.phase)) return { ok: false, error: 'No round to reveal.' };
    if (this.phase === PHASES.ACTIVE) this.endRound();
    this.clearTimers();
    this.phase = PHASES.RESULTS;
    this.round.stats = this.computeStats(this.round);
    this.save();
    this.emit('phase');
    if (this.learning) this.runAnalysis();
    return { ok: true };
  }

  /** Change the models of the next round (open play, or the switch round). */
  setModels(families) {
    if (![PHASES.LOBBY, PHASES.RESULTS].includes(this.phase)) return { ok: false, error: 'Wait until the round is over.' };
    if (this.planDone) return { ok: false, error: 'There is no next round yet.' };
    const error = setRoundModels(this.record, this.roundNumber + 1, families);
    if (error) return { ok: false, error };
    this.save();
    return { ok: true };
  }

  /** Open play: add another block of rounds. */
  moreRounds() {
    if (this.mode.id !== 'open') return { ok: false, error: 'Only open play can add rounds.' };
    if (this.phase !== PHASES.RESULTS || !this.planDone) return { ok: false, error: 'Finish the rounds you have first.' };
    if (this.plan.length >= MAX_ROUNDS) return { ok: false, error: `${MAX_ROUNDS} rounds is the most one activity can hold.` };
    extendPlan(this.plan, this.record.blockSize);
    this.save();
    return { ok: true };
  }

  async runAnalysis() {
    const round = this.round;
    if (!round || this.analysing || !this.learning) return;
    this.analysing = true;
    round.analysisStatus = 'running';
    this.emit('roster');
    try {
      const previous = this.record.rounds[round.number - 2]?.analysis?.guidance || [];
      round.analysis = await analyseRound({ activity: this.record, round, previousGuidance: previous });
      round.analysisStatus = 'done';
      // What this activity has learned so far carries forward to the class
      // context's next activity. Each round replaces the previous entry.
      await this.carryLearnings(round);
    } catch (err) {
      console.warn('[activity] analysis failed:', err.message);
      round.analysisStatus = 'failed';
      round.analysisError = err.message;
    } finally {
      this.analysing = false;
      await this.save();
      this.emit('roster');
    }
  }

  retryAnalysis() {
    if (this.phase !== PHASES.RESULTS || this.analysing || !this.learning) return { ok: false, error: 'Nothing to retry.' };
    this.runAnalysis();
    return { ok: true };
  }

  async carryLearnings(round) {
    if (!this.context || !round.analysis?.guidance?.length) return;
    const fresh = await this.store.get('contexts', this.context.id);
    if (!fresh) return;
    fresh.learnings = (fresh.learnings || []).filter((l) => l.activityId !== this.record.id);
    fresh.learnings.push({
      activityId: this.record.id,
      activityName: this.record.name,
      classId: this.record.classId,
      round: round.number,
      at: Date.now(),
      guidance: round.analysis.guidance,
    });
    fresh.learnings = fresh.learnings.slice(-10);
    await this.store.put('contexts', fresh.id, fresh);
  }

  // ------------------------------------------------------------- overview

  series() {
    return this.record.rounds.map((r) => ({
      round: r.number,
      models: r.models,
      aiFooledRate: r.stats?.aiFooledRate ?? null,
      accuracy: r.stats?.accuracy ?? null,
      aiAnswered: r.stats?.aiAnswered ?? 0,
      byModel: Object.fromEntries(Object.values(r.stats?.byModel || {}).map((m) => [m.family, m.fooledRate])),
      guidanceCount: r.analysis?.guidance?.length || 0,
    }));
  }

  showOverview() {
    if (this.phase !== PHASES.RESULTS || !this.planDone) {
      return { ok: false, error: `The overview comes after round ${this.plan.length}.` };
    }
    if (this.analysing) return { ok: false, error: 'Claude is still analysing the last round.' };
    this.phase = PHASES.OVERVIEW;
    this.emit('phase');
    if (!this.record.overview) this.runOverview();
    return { ok: true };
  }

  async runOverview() {
    if (this.overviewing) return;
    this.overviewing = true;
    this.record.overviewStatus = 'running';
    this.emit('roster');
    try {
      const series = this.series();
      const story = await buildOverview({ activity: this.record, series });
      this.record.overview = { series, ...story, createdAt: Date.now() };
      this.record.overviewStatus = 'done';
    } catch (err) {
      console.warn('[activity] overview failed:', err.message);
      this.record.overviewStatus = 'failed';
      this.record.overviewError = err.message;
    } finally {
      this.overviewing = false;
      await this.save();
      this.emit('roster');
    }
  }

  retryOverview() {
    if (this.phase !== PHASES.OVERVIEW || this.overviewing) return { ok: false, error: 'Nothing to retry.' };
    this.runOverview();
    return { ok: true };
  }

  async finish() {
    this.clearTimers();
    this.phase = PHASES.FINISHED;
    this.record.status = this.planDone && this.roundNumber > 0 ? 'finished' : 'ended early';
    this.record.finishedAt = Date.now();
    await this.save();
    this.emit('phase');
    return { ok: true };
  }

  // ---------------------------------------------------------------- views

  teacherView() {
    const round = this.round;
    const students = [...this.students.values()].sort((a, b) => a.n - b.n).map((s) => {
      const conv = this.convFor(s.n);
      const guess = round?.guesses?.[s.n] || null;
      return {
        n: s.n, label: s.label, connected: s.connected,
        inRound: Boolean(conv) && this.phase !== PHASES.LOBBY,
        partner: conv ? conv.record.type : null,
        model: conv?.record.modelLabel || null,
        persona: conv?.record.personaLabel || null,
        messages: conv ? conv.record.messages.filter((m) => m.from === s.n).length : 0,
        guessed: Boolean(guess),
        correct: guess && conv ? guess === conv.record.type : null,
      };
    });
    return {
      id: this.record.id,
      name: this.record.name,
      className: this.record.className,
      contextName: this.record.contextName,
      personaSet: personaSet(this.record.personaSet).label,
      phase: this.phase,
      roundNumber: this.roundNumber,
      roundCount: this.plan.length,
      plan: this.plan,
      mode: { id: this.mode.id, label: this.mode.label, learning: this.learning },
      blockSize: this.record.blockSize || null,
      maxRounds: MAX_ROUNDS,
      endsAt: this.endsAt,
      durationSec: this.record.durationSec,
      classSize: this.cls.students.length,
      maxStudents: MAX_ACTIVITY_STUDENTS,
      teacherName: this.record.teacherName || null,
      students,
      round: round ? {
        number: round.number,
        models: round.models,
        note: round.note,
        secret: Boolean(round.secret),
        stats: round.stats,
        analysis: round.analysis,
        analysisStatus: round.analysisStatus,
        analysisError: round.analysisError || null,
        guessed: Object.keys(round.guesses).length,
        paired: round.conversations.reduce((n, c) => n + c.members.length, 0),
        pairs: round.conversations.map((c) => ({
          type: c.type, members: c.members.map((n) => this.cls.students.find((s) => s.n === n)?.label || `Student ${n}`),
          model: c.modelLabel || null, persona: c.personaLabel || null,
          guesses: c.members.map((n) => round.guesses[n] || null),
        })),
      } : null,
      series: this.series(),
      overviewData: this.record.overview ? overviewData(this.record) : null,
      overviewStatus: this.record.overviewStatus || null,
    };
  }

  studentView(n) {
    const s = this.students.get(n);
    const round = this.round;
    const conv = this.convFor(n);
    const view = {
      phase: this.phase,
      label: s?.label,
      activityName: this.record.name,
      roundNumber: this.roundNumber,
      roundCount: this.plan.length,
      lastRound: this.planDone && this.mode.id !== 'open',
      endsAt: this.endsAt,
      inRound: Boolean(conv) && this.phase !== PHASES.LOBBY,
      guessed: Boolean(round?.guesses?.[n]),
    };
    if (conv && this.phase === PHASES.ACTIVE) {
      view.transcript = conv.record.messages.map((m) => ({ mine: m.from === n, text: m.text }));
    }
    if (conv && this.phase === PHASES.RESULTS) {
      const guess = round.guesses[n];
      view.result = { partner: conv.record.type, guess: guess || null, correct: guess ? guess === conv.record.type : null };
    }
    return view;
  }
}
