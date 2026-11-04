/*
 * The end-of-activity overview: an animated, self-running presentation of the
 * four rounds. The same template for every activity; the numbers come from the
 * app and the words from Claude Opus, so what it says and what it emphasises
 * changes with each class.
 *
 * Usage: HumanOrNotOverview.render(element, data)  — data from overviewData().
 * Works inside the teacher console and as a standalone, offline HTML file.
 */
(function () {
  const MODEL_COLOURS = { haiku: '#8fd0ff', sonnet: '#7c9cff', opus: '#f5b865' };
  const MODEL_NAMES = { haiku: 'Haiku', sonnet: 'Sonnet', opus: 'Opus' };
  const AUTOPLAY_MS = 9000;

  const esc = (v) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const pct = (v) => (v === null || v === undefined ? '—' : `${v}%`);
  const avg = (list) => {
    const xs = list.filter((x) => typeof x === 'number');
    return xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : null;
  };

  function bar(value, colour, label, delay) {
    const h = typeof value === 'number' ? Math.max(value, 2) : 0;
    return `<div class="ov-bar" style="--h:${h}%;--c:${colour};--d:${delay}ms">
      <div class="ov-bar-val">${pct(value)}</div><div class="ov-bar-fill"></div>
      <div class="ov-bar-label">${esc(label)}</div></div>`;
  }

  function slides(data) {
    const s = data.story || {};
    const rounds = data.rounds || [];
    const r3 = rounds.find((r) => r.number === 3);
    const r4 = rounds.find((r) => r.number === 4);
    const opusRates = rounds.map((r) => r.byModel?.opus?.rate);
    const logo = window.OVERVIEW_LOGO || '/img/allentronics-logo.png';
    const out = [];

    out.push(`<section class="ov-slide ov-title">
      <div class="ov-kicker">Human or Not? · ${esc(data.className)}</div>
      <h1 class="ov-rise">${esc(s.title || data.activity)}</h1>
      <p class="ov-rise ov-d2">${esc(s.subtitle || 'Four rounds. One AI, learning your class.')}</p>
    </section>`);

    out.push(`<section class="ov-slide">
      <div class="ov-kicker">The experiment</div>
      <h2>Four rounds, one AI learning as it went</h2>
      <div class="ov-plan">${[1, 2, 3, 4].map((n, i) => {
        const r = rounds.find((x) => x.number === n);
        const opusOff = n === 4;
        const text = n === 1 ? 'Started from the class brief alone.'
          : opusOff ? '<strong>Opus switched off.</strong> Nobody was told.'
            : `Plus everything Opus learned from ${n > 2 ? `rounds 1–${n - 1}` : 'round 1'}.`;
        return `<div class="ov-plan-card ov-rise" style="--d:${i * 350}ms">
          <div class="ov-plan-n">Round ${n}</div>
          <div class="ov-models">${['haiku', 'sonnet', 'opus'].map((m) => `<span class="ov-model ${opusOff && m === 'opus' ? 'off' : ''}" style="--c:${MODEL_COLOURS[m]}">${MODEL_NAMES[m]}</span>`).join('')}</div>
          <p>${text}</p>
          ${r && n < 4 ? `<div class="ov-small">${r.guidance.length} lessons learned after this round</div>` : ''}
        </div>`;
      }).join('')}</div>
    </section>`);

    out.push(`<section class="ov-slide">
      <div class="ov-kicker">How often the AI passed as human</div>
      <h2>Students who believed the AI was a classmate</h2>
      <div class="ov-chart">${rounds.map((r, i) => bar(r.aiFooledRate, i === 3 ? '#8fd0ff' : '#ee8a2a', `Round ${r.number}`, i * 450)).join('')}</div>
      <div class="ov-notes">${(s.roundNotes || []).map((note, i) => `<div class="ov-rise" style="--d:${1800 + i * 300}ms"><b>R${i + 1}</b>${esc(note)}</div>`).join('')}</div>
    </section>`);

    out.push(`<section class="ov-slide">
      <div class="ov-kicker">By model</div>
      <h2>Haiku, Sonnet and Opus, round by round</h2>
      <div class="ov-groups">${rounds.map((r, i) => `<div class="ov-group">
        <div class="ov-chart ov-chart-sm">${['haiku', 'sonnet', 'opus'].map((m, j) => (r.byModel?.[m]
          ? bar(r.byModel[m].rate, MODEL_COLOURS[m], MODEL_NAMES[m], i * 500 + j * 150)
          : `<div class="ov-bar ov-bar-off"><div class="ov-bar-val">${m === 'opus' && r.number === 4 ? 'off' : '—'}</div><div class="ov-bar-label">${MODEL_NAMES[m]}</div></div>`)).join('')}</div>
        <div class="ov-group-label">Round ${r.number}</div></div>`).join('')}</div>
      <p class="ov-small">Small classes mean small samples — each bar may be only a few students.</p>
    </section>`);

    const learned = rounds.filter((r) => r.guidance.length && r.number < 4);
    if (learned.length) {
      out.push(`<section class="ov-slide">
        <div class="ov-kicker">What the AI was taught</div>
        <h2>After each round, Opus read every chat and rewrote the rules</h2>
        <div class="ov-timeline">${learned.map((r, i) => `<div class="ov-step ov-rise" style="--d:${i * 700}ms">
          <div class="ov-plan-n">After round ${r.number}</div>
          <ul>${r.guidance.slice(0, 3).map((g) => `<li>${esc(g)}</li>`).join('')}</ul>
          ${r.guidance.length > 3 ? `<div class="ov-small">+ ${r.guidance.length - 3} more</div>` : ''}
        </div>`).join('')}</div>
      </section>`);
    }

    if (s.story?.length) {
      out.push(`<section class="ov-slide">
        <div class="ov-kicker">The story</div>
        <h2>How it learned your class</h2>
        <div class="ov-beats">${s.story.map((b, i) => `<div class="ov-beat ov-rise" style="--d:${i * 900}ms">
          <h3>${esc(b.heading)}</h3><p>${esc(b.body)}</p></div>`).join('')}</div>
      </section>`);
    }

    out.push(`<section class="ov-slide">
      <div class="ov-kicker">Round 4</div>
      <h2>${esc(s.opusImpact?.headline || 'What happened when Opus was switched off')}</h2>
      <div class="ov-versus">
        <div class="ov-big ov-rise"><div class="ov-big-n" data-count="${r3?.aiFooledRate ?? ''}">${pct(r3?.aiFooledRate)}</div><div>Round 3 · with Opus</div></div>
        <div class="ov-vs ov-rise ov-d2">→</div>
        <div class="ov-big ov-rise ov-d3"><div class="ov-big-n" data-count="${r4?.aiFooledRate ?? ''}">${pct(r4?.aiFooledRate)}</div><div>Round 4 · without Opus</div></div>
      </div>
      <p class="ov-rise ov-d4">${esc(s.opusImpact?.body || '')}</p>
      <p class="ov-small ov-rise ov-d4">Opus on its own, rounds 1–3: passed as human ${pct(avg(opusRates))} of the time.</p>
    </section>`);

    if (s.quotes?.length) {
      out.push(`<section class="ov-slide">
        <div class="ov-kicker">From the chats</div>
        <div class="ov-quotes">${s.quotes.map((q, i) => `<blockquote class="ov-rise" style="--d:${i * 900}ms">“${esc(q.text)}”<cite>${esc(q.context)}</cite></blockquote>`).join('')}</div>
      </section>`);
    }

    if (s.keyFindings?.length) {
      out.push(`<section class="ov-slide">
        <div class="ov-kicker">Findings</div>
        <h2>What this class showed</h2>
        <ol class="ov-list">${s.keyFindings.map((f, i) => `<li class="ov-rise" style="--d:${i * 600}ms">${esc(f)}</li>`).join('')}</ol>
      </section>`);
    }

    if (s.discussionQuestions?.length) {
      out.push(`<section class="ov-slide">
        <div class="ov-kicker">Let's talk</div>
        <h2>Questions for discussion</h2>
        <ol class="ov-list">${s.discussionQuestions.map((q, i) => `<li class="ov-rise" style="--d:${i * 700}ms">${esc(q)}</li>`).join('')}</ol>
      </section>`);
    }

    out.push(`<section class="ov-slide ov-title">
      <h1 class="ov-rise">${esc(s.closing || 'Thanks for playing.')}</h1>
      <p class="ov-rise ov-d2 ov-small">Human or Not? · ${esc(data.activity)}</p>
      <div class="ov-credit ov-rise ov-d3"><span>Powered and created by</span><img src="${esc(logo)}" alt="Allentronics Education Services"></div>
    </section>`);

    return out;
  }

  function countUp(el) {
    if (el.dataset.count === '') return;
    const target = Number(el.dataset.count);
    if (!Number.isFinite(target)) return;
    const start = performance.now();
    const step = (now) => {
      const t = Math.min(1, (now - start) / 1200);
      el.textContent = `${Math.round(target * (1 - Math.pow(1 - t, 3)))}%`;
      if (t < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  function render(root, data) {
    const deck = slides(data);
    root.classList.add('ov-root');
    root.innerHTML = `<div class="ov-stage">${deck.join('')}</div>
      <div class="ov-controls">
        <button class="ov-btn" data-act="prev" aria-label="Previous slide">‹</button>
        <div class="ov-dots">${deck.map((_, i) => `<span data-i="${i}"></span>`).join('')}</div>
        <button class="ov-btn" data-act="next" aria-label="Next slide">›</button>
        <button class="ov-btn ov-play" data-act="play" aria-label="Play or pause">❚❚</button>
        <button class="ov-btn" data-act="full" aria-label="Full screen">⤢</button>
      </div>`;
    const els = [...root.querySelectorAll('.ov-slide')];
    const dots = [...root.querySelectorAll('.ov-dots span')];
    const playBtn = root.querySelector('.ov-play');
    let index = 0;
    let playing = true;
    let timer = null;

    function go(i) {
      index = Math.max(0, Math.min(els.length - 1, i));
      els.forEach((el, j) => el.classList.toggle('on', j === index));
      dots.forEach((d, j) => d.classList.toggle('on', j === index));
      els[index].querySelectorAll('[data-count]').forEach(countUp);
      clearTimeout(timer);
      if (playing && index < els.length - 1) timer = setTimeout(() => go(index + 1), AUTOPLAY_MS);
    }
    function pause() { playing = false; playBtn.textContent = '▶'; clearTimeout(timer); }

    root.addEventListener('click', (e) => {
      const act = e.target.closest('[data-act]')?.dataset.act;
      const dot = e.target.closest('[data-i]');
      if (dot) { pause(); go(Number(dot.dataset.i)); return; }
      if (act === 'prev') { pause(); go(index - 1); }
      if (act === 'next') { pause(); go(index + 1); }
      if (act === 'play') {
        playing = !playing;
        playBtn.textContent = playing ? '❚❚' : '▶';
        go(playing && index === els.length - 1 ? 0 : index);
      }
      if (act === 'full') {
        if (document.fullscreenElement) document.exitFullscreen();
        else root.requestFullscreen?.();
      }
    });
    root.tabIndex = 0;
    root.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowRight' || e.key === ' ') { e.preventDefault(); pause(); go(index + 1); }
      if (e.key === 'ArrowLeft') { pause(); go(index - 1); }
    });
    go(0);
    return { go, count: els.length, stop: pause };
  }

  window.HumanOrNotOverview = { render };
})();
