(() => {
  const socket = io();
  const $ = (id) => document.getElementById(id);
  const screens = ['code', 'wait', 'chat', 'guess', 'result'];
  let myCode = sessionStorage.getItem('hon-code') || '';
  let joined = false;
  let retryTimer = null;
  let clockTimer = null;
  let endsAt = null;
  let shownRound = 0;
  let typingSent = false;
  let typingTimer = null;

  function show(name) {
    for (const s of screens) $(`screen-${s}`).classList.toggle('hidden', s !== name);
    document.querySelector('.credit').classList.toggle('hidden', name === 'chat');
  }

  function wait(pill, title, body) {
    $('wait-pill').textContent = pill;
    $('wait-title').textContent = title;
    $('wait-body').textContent = body;
    show('wait');
  }

  // ------------------------------------------------------------------ join

  $('code').addEventListener('input', () => {
    $('code').value = $('code').value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
  });
  $('code').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) join(); });
  $('join-btn').addEventListener('click', () => join());

  function join(code = $('code').value) {
    clearTimeout(retryTimer);
    if (!/^[A-Z]{4}\d{4}$/.test(code)) { $('code-error').textContent = 'Codes are four letters then four numbers.'; return; }
    $('code-error').textContent = '';
    socket.emit('student:join', { code }, (res) => {
      if (res?.ok) {
        joined = true;
        myCode = res.code;
        sessionStorage.setItem('hon-code', myCode);
        $('wait-who').textContent = `You are ${res.label} · ${res.activity}`;
        return;
      }
      if (res?.code === 'not_started') {
        // Hold on the waiting screen and try again until the teacher starts.
        myCode = code;
        sessionStorage.setItem('hon-code', code);
        wait('Waiting', 'Nearly there', 'Your teacher has not started the activity yet. This page will join by itself.');
        retryTimer = setTimeout(() => join(code), 4000);
        return;
      }
      sessionStorage.removeItem('hon-code');
      show('code');
      $('code-error').textContent = res?.error || 'Could not join.';
    });
  }

  socket.on('connect', () => { if (myCode) join(myCode); });
  socket.on('activity:started', () => { if (myCode && !joined) join(myCode); });
  socket.on('replaced', () => wait('Moved', 'Opened somewhere else', 'This code was opened on another device or tab.'));

  // ----------------------------------------------------------------- state

  socket.on('state', (s) => {
    endsAt = s.endsAt;
    switch (s.phase) {
      case 'lobby':
        wait('Waiting', "You're in", 'Waiting for your teacher to start the first round.');
        break;
      case 'active':
        if (!s.inRound) { wait(`Round ${s.roundNumber}`, 'Sitting this one out', 'You joined after the round started. You will be in the next one.'); break; }
        if (shownRound !== s.roundNumber || $('screen-chat').classList.contains('hidden')) {
          shownRound = s.roundNumber;
          renderTranscript(s.transcript || []);
        }
        $('chat-round').textContent = `Round ${s.roundNumber} of 4`;
        show('chat');
        startClock();
        $('msg').focus();
        break;
      case 'guess':
        stopClock();
        if (!s.inRound) { wait('Guessing', 'Hang tight', 'Everyone else is making their guess.'); break; }
        if (s.guessed) wait('Guessed', 'Locked in', 'Waiting for everyone else to guess.');
        else { $('guess-error').textContent = ''; show('guess'); }
        break;
      case 'results':
        stopClock();
        if (s.result) showResult(s.result, s.roundNumber);
        else wait(`Round ${s.roundNumber}`, 'Results are up', 'Look up at the screen.');
        break;
      case 'overview':
        wait('All done', 'Eyes on the screen', 'Your teacher is showing how the AI learned over the four rounds.');
        break;
      case 'finished':
        stopClock();
        sessionStorage.removeItem('hon-code');
        joined = false;
        wait('Finished', 'Thanks for playing', 'The activity is over. You can close this page.');
        break;
      default:
        break;
    }
  });

  function showResult(r, round) {
    const wasAi = r.partner === 'ai';
    if (!r.guess) {
      $('result-icon').textContent = wasAi ? '🤖' : '🧑';
      $('result-title').textContent = wasAi ? 'It was an AI' : 'It was a classmate';
      $('result-body').textContent = 'You did not lock in a guess this round.';
    } else if (r.correct) {
      $('result-icon').textContent = '🎉';
      $('result-title').textContent = 'You got it';
      $('result-body').textContent = wasAi ? 'That was an AI.' : 'That was a real classmate.';
    } else {
      $('result-icon').textContent = wasAi ? '🤖' : '😅';
      $('result-title').textContent = wasAi ? 'Fooled — it was an AI' : 'It was actually a classmate';
      $('result-body').textContent = wasAi ? 'You thought you were talking to a person.' : 'You thought they were an AI.';
    }
    $('result-body').textContent += round < 4 ? '' : ' That was the last round.';
    show('result');
  }

  // ------------------------------------------------------------------ chat

  function bubble({ mine, text }) {
    const el = document.createElement('div');
    el.className = `bubble ${mine ? 'mine' : 'them'}`;
    el.textContent = text;
    $('log').insertBefore(el, $('typing'));
    $('log').scrollTop = $('log').scrollHeight;
  }

  function renderTranscript(list) {
    $('log').querySelectorAll('.bubble').forEach((b) => b.remove());
    $('typing').classList.add('hidden');
    list.forEach(bubble);
  }

  socket.on('message', (m) => { bubble(m); if (!m.mine) $('typing').classList.add('hidden'); });
  socket.on('typing', (on) => {
    $('typing').classList.toggle('hidden', !on);
    $('log').scrollTop = $('log').scrollHeight;
  });

  $('composer').addEventListener('submit', (e) => {
    e.preventDefault();
    const text = $('msg').value.trim();
    if (!text) return;
    $('msg').value = '';
    stopTyping();
    socket.emit('chat:send', { text }, (res) => { if (res && !res.ok && res.error) console.warn(res.error); });
  });
  $('msg').addEventListener('input', () => {
    if (!typingSent) { socket.emit('chat:typing', true); typingSent = true; }
    clearTimeout(typingTimer);
    typingTimer = setTimeout(stopTyping, 1600);
  });
  function stopTyping() {
    clearTimeout(typingTimer);
    if (typingSent) { socket.emit('chat:typing', false); typingSent = false; }
  }

  // ----------------------------------------------------------------- guess

  for (const [id, guess] of [['guess-human', 'human'], ['guess-ai', 'ai']]) {
    $(id).addEventListener('click', () => socket.emit('guess', { guess }, (res) => {
      if (!res?.ok) $('guess-error').textContent = res?.error || 'Could not save that.';
    }));
  }

  // ----------------------------------------------------------------- clock

  function startClock() {
    stopClock();
    const tick = () => {
      if (!endsAt) return;
      const left = Math.max(0, Math.ceil((endsAt - Date.now()) / 1000));
      $('chat-clock').textContent = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
      $('chat-clock').style.color = left <= 15 ? 'var(--danger)' : '';
    };
    tick();
    clockTimer = setInterval(tick, 250);
  }
  function stopClock() { clearInterval(clockTimer); clockTimer = null; }

  if (myCode) { $('code').value = myCode; } else show('code');
})();
