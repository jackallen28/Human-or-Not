(() => {
  const $ = (id) => document.getElementById(id);
  const esc = (v) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const pct = (v) => (v === null || v === undefined ? '—' : `${v}%`);
  const socket = io({ autoConnect: false });

  // Which teacher's console this is: /teacher/2 → "2".
  const teacherId = (/^\/teacher\/(\d+)/.exec(location.pathname) || [null, '1'])[1];
  const storageKey = `hon-teacher-${teacherId}`;
  let code = sessionStorage.getItem(storageKey) || '';
  let meta = null;
  let contexts = [];
  let classes = [];
  let activities = [];
  let live = null;
  let tab = 'home';
  let clockTimer = null;
  let renderedOverviewFor = null;
  let lastLiveId = null;

  // ------------------------------------------------------------------ api

  async function api(path, options = {}) {
    const res = await fetch(`/api${path}`, {
      ...options,
      headers: { 'content-type': 'application/json', 'x-teacher-id': teacherId, 'x-teacher-code': code, ...(options.headers || {}) },
      body: options.body && typeof options.body !== 'string' ? JSON.stringify(options.body) : options.body,
    });
    if (res.status === 401) { signOut('That password was not accepted.'); throw new Error('unauthorised'); }
    const data = res.headers.get('content-type')?.includes('json') ? await res.json() : null;
    if (!res.ok) throw new Error(data?.error || `Request failed (${res.status})`);
    return data;
  }

  /** Download something that needs the teacher code, which a plain link cannot send. */
  async function download(path, fallbackName) {
    const res = await fetch(`/api${path}`, { headers: { 'x-teacher-id': teacherId, 'x-teacher-code': code } });
    if (!res.ok) { flash((await res.json().catch(() => ({}))).error || 'Download failed.'); return; }
    const name = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') || '')?.[1] || fallbackName;
    const url = URL.createObjectURL(await res.blob());
    const a = Object.assign(document.createElement('a'), { href: url, download: name });
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  function flash(message) {
    $('flash').textContent = message || '';
    if (message) setTimeout(() => { if ($('flash').textContent === message) $('flash').textContent = ''; }, 7000);
  }

  function confirmBox(title, body, yes = 'Yes') {
    $('confirm-title').textContent = title;
    $('confirm-body').textContent = body;
    $('confirm-yes').textContent = yes;
    $('confirm').classList.remove('hidden');
    return new Promise((resolve) => {
      const done = (answer) => { $('confirm').classList.add('hidden'); $('confirm-yes').onclick = null; $('confirm-no').onclick = null; resolve(answer); };
      $('confirm-yes').onclick = () => done(true);
      $('confirm-no').onclick = () => done(false);
    });
  }

  // ----------------------------------------------------------------- auth

  async function signIn() {
    code = $('auth-code').value.trim() || code;
    try {
      meta = await api('/meta');
    } catch (err) {
      if (err.message !== 'unauthorised') $('auth-error').textContent = err.message;
      return;
    }
    sessionStorage.setItem(storageKey, code);
    $('teacher-name').textContent = meta.teacher.name;
    document.title = `${meta.teacher.name} — Human or Not?`;
    $('screen-auth').classList.add('hidden');
    $('screen-app').classList.remove('hidden');
    socket.connect();
    renderMeta();
    await refreshAll();
    if (meta.live) showTab('live');
  }

  function signOut(message) {
    sessionStorage.removeItem(storageKey);
    code = '';
    socket.disconnect();
    $('screen-app').classList.add('hidden');
    $('screen-auth').classList.remove('hidden');
    $('auth-error').textContent = message || '';
  }

  $('auth-btn').addEventListener('click', signIn);
  $('auth-code').addEventListener('keydown', (e) => { if (e.key === 'Enter') signIn(); });
  socket.on('connect', () => socket.emit('teacher:auth', { teacher: teacherId, code }, () => {}));
  $('sign-out').addEventListener('click', (e) => { e.preventDefault(); $('auth-code').value = ''; signOut(''); });
  fetch('/teachers.json').then((r) => r.json()).then((list) => {
    const me = list.find((t) => t.id === teacherId);
    if (!me) return;
    $('auth-title').textContent = me.name;
    document.title = `${me.name} — Human or Not?`;
    if (!me.ready) {
      $('auth-help').innerHTML = `This console is switched off: no password is set. Add <code>TEACHER_${teacherId}_CODE</code> in Render → your service → Environment.`;
      $('auth-btn').disabled = true;
    } else $('auth-help').textContent = 'Enter your password.';
  }).catch(() => {});
  if (code) signIn();

  // Keep a free Render instance awake while the console is open.
  setInterval(() => fetch('/healthz').catch(() => {}), 4 * 60 * 1000);

  // ------------------------------------------------------------------ nav

  function showTab(name) {
    tab = name;
    for (const el of document.querySelectorAll('[data-page]')) el.classList.toggle('hidden', el.dataset.page !== name);
    for (const b of document.querySelectorAll('#nav button')) b.classList.toggle('on', b.dataset.tab === name);
    if (name !== 'live') refreshAll();
  }
  for (const b of document.querySelectorAll('#nav button')) b.addEventListener('click', () => showTab(b.dataset.tab));
  for (const s of document.querySelectorAll('.step')) s.addEventListener('click', () => showTab(s.dataset.step === 'live' ? 'activities' : s.dataset.step));

  async function refreshAll() {
    try {
      [contexts, classes, activities] = await Promise.all([api('/contexts'), api('/classes'), api('/activities')]);
    } catch { return; }
    renderContexts();
    renderClasses();
    renderActivities();
    renderSteps();
  }

  function renderMeta() {
    const banners = [];
    if (!meta.hasApiKey) {
      banners.push('<div class="warnbox"><strong>No Claude API key.</strong> Add <code>ANTHROPIC_API_KEY</code> in Render → your service → Environment. Until then the AI sends filler lines and nothing is analysed.</div>');
    }
    if (!meta.storage.persistent) {
      banners.push('<div class="warnbox"><strong>Your data is not being kept.</strong> This free Render service has no database, and its disk is wiped whenever it goes to sleep. Add the free Render Postgres database (see the README), or use <em>Back up everything</em> on the Home page after each session.</div>');
    }
    $('banners').innerHTML = banners.join('');
    $('model-list').innerHTML = `<strong>Models in use</strong><br>${Object.values(meta.models).map((m) =>
      `${esc(m.label)} <span class="tiny">(${esc(m.id)} · effort ${esc(m.effort)})</span>`).join('<br>')}
      <br><span class="tiny">Picked automatically: the newest of each family your API key can use.</span>`;
    $('storage-line').textContent = meta.storage.persistent
      ? `Stored in ${meta.storage.description}. A backup file is still a good idea.`
      : 'Not persistent on this server — back up after every session and restore when you return.';
    for (const el of document.querySelectorAll('.join-url')) el.textContent = meta.joinUrl;
    $('live-url').textContent = meta.joinUrl;
    renderPersonaSets();
    renderModes();
  }

  function renderSteps() {
    const done = {
      train: contexts.some((c) => c.status === 'ready'),
      classes: classes.length > 0,
      activities: activities.length > 0,
      live: activities.some((a) => a.status === 'finished'),
    };
    for (const s of document.querySelectorAll('.step')) s.classList.toggle('done', Boolean(done[s.dataset.step]));
  }

  // ---------------------------------------------------------------- train

  const slots = { about: null, learned: null, voice: null };
  let pendingSlot = null;
  let updating = null; // context id being updated, or null for a new one

  function setUpdating(id) {
    updating = id;
    const c = contexts.find((x) => x.id === id);
    $('ctx-train').textContent = c ? `Retrain “${c.title || c.name}” →` : 'Train the AI →';
    $('ctx-name').value = c ? c.name : '';
    for (const drop of document.querySelectorAll('.drop')) {
      if (!drop.classList.contains('filled')) {
        drop.querySelector('.small').textContent = c ? 'Optional · leave empty to keep the current file'
          : drop.dataset.slot === 'voice' ? 'Optional, but powerful' : 'Required · click or drop .md';
      }
    }
  }

  for (const drop of document.querySelectorAll('.drop')) {
    drop.addEventListener('click', () => { pendingSlot = drop.dataset.slot; $('ctx-file').click(); });
    drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('drag'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('drag'));
    drop.addEventListener('drop', (e) => {
      e.preventDefault();
      drop.classList.remove('drag');
      const file = e.dataTransfer.files?.[0];
      if (file) readSlot(drop.dataset.slot, file);
    });
  }
  $('ctx-file').addEventListener('change', (e) => {
    const file = e.target.files?.[0];
    if (file && pendingSlot) readSlot(pendingSlot, file);
    e.target.value = '';
  });

  function readSlot(slot, file) {
    const reader = new FileReader();
    reader.onload = () => {
      slots[slot] = { name: file.name, text: String(reader.result || '') };
      const drop = document.querySelector(`.drop[data-slot="${slot}"]`);
      drop.classList.add('filled');
      drop.querySelector('.small').textContent = `✓ ${file.name}`;
    };
    reader.readAsText(file);
  }

  $('ctx-train').addEventListener('click', async () => {
    $('ctx-error').textContent = '';
    if (!updating && (!slots.about || !slots.learned)) { $('ctx-error').textContent = 'Upload files 01 and 02 at least.'; return; }
    try {
      $('ctx-train').disabled = true;
      const body = {
        name: $('ctx-name').value.trim() || 'My class',
        files: { about: slots.about?.text || '', learned: slots.learned?.text || '', voice: slots.voice?.text || '' },
      };
      if (updating) await api(`/contexts/${updating}`, { method: 'PUT', body });
      else await api('/contexts', { method: 'POST', body });
      for (const key of Object.keys(slots)) slots[key] = null;
      for (const drop of document.querySelectorAll('.drop')) {
        drop.classList.remove('filled');
        drop.querySelector('.small').textContent = drop.dataset.slot === 'voice' ? 'Optional, but powerful' : 'Required · click or drop .md';
      }
      setUpdating(null);
      await refreshAll();
    } catch (err) {
      $('ctx-error').textContent = err.message;
    } finally {
      $('ctx-train').disabled = false;
    }
  });

  let trainingPoll = null;
  function renderContexts() {
    const host = $('ctx-list');
    if (!contexts.length) { host.innerHTML = '<p class="muted small">None yet. Upload your files above.</p>'; }
    else host.innerHTML = contexts.map((c) => `
      <div class="list-item">
        <div style="flex:1 1 360px">
          <div class="title">${esc(c.title || c.name)} ${c.status === 'training' ? '<span class="pill warn"><span class="spinner"></span>Training</span>'
            : c.status === 'failed' ? '<span class="pill warn">Trained without Claude</span>' : '<span class="pill human">Ready</span>'}</div>
          <div class="small muted">${c.words} words of context · ${c.samples} example messages${c.learnings ? ` · learned from ${c.learnings} round(s) of past activities` : ''}</div>
          ${c.summary ? `<div class="small" style="margin-top:6px">${esc(c.summary)}</div>` : ''}
          ${c.status === 'failed' ? `<div class="small" style="color:var(--warn)">${esc(c.error || '')}</div>` : ''}
          ${c.gaps?.length ? `<div class="small" style="margin-top:6px;color:var(--warn)"><strong>To make it harder to catch, add:</strong><ul style="margin:4px 0 0">${c.gaps.map((g) => `<li>${esc(g)}</li>`).join('')}</ul></div>` : ''}
        </div>
        <div class="shrink row">
          <button class="ghost small" data-brief="${c.id}">View brief</button>
          <button class="ghost small" data-retrain="${c.id}">Update files</button>
          <button class="danger small" data-delctx="${c.id}">Delete</button>
        </div>
      </div>`).join('');

    for (const b of host.querySelectorAll('[data-brief]')) b.addEventListener('click', async () => {
      const c = await api(`/contexts/${b.dataset.brief}`);
      $('text-title').textContent = c.title || c.name;
      $('text-body').textContent = `${c.brief || '(not built yet)'}\n\n— Example messages —\n${(c.sampleMessages || []).map((m) => `• ${m}`).join('\n')}`;
      $('text-modal').classList.remove('hidden');
    });
    for (const b of host.querySelectorAll('[data-retrain]')) b.addEventListener('click', () => {
      setUpdating(b.dataset.retrain);
      flash('Drop in any files you want to replace, then click Retrain. Files you leave empty are kept.');
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
    for (const b of host.querySelectorAll('[data-delctx]')) b.addEventListener('click', async () => {
      if (!await confirmBox('Delete this context?', 'Classes using it will fall back to no context. Past activity downloads keep their copy.', 'Delete')) return;
      await api(`/contexts/${b.dataset.delctx}`, { method: 'DELETE' });
      refreshAll();
    });

    clearTimeout(trainingPoll);
    if (contexts.some((c) => c.status === 'training')) trainingPoll = setTimeout(refreshAll, 3000);

    const select = $('cls-context');
    const current = select.value;
    select.innerHTML = '<option value="">No context (the AI improvises — not recommended)</option>' +
      contexts.map((c) => `<option value="${c.id}">${esc(c.title || c.name)}${c.status === 'training' ? ' (training…)' : ''}</option>`).join('');
    select.value = current || contexts[0]?.id || '';
  }
  $('text-close').addEventListener('click', () => $('text-modal').classList.add('hidden'));

  // -------------------------------------------------------------- classes

  let chosenSet = 'secondary';
  const chosenPersonas = new Map();

  function renderPersonaSets() {
    $('set-pick').innerHTML = meta.personaSets.map((s) => `
      <label class="persona ${s.id === chosenSet ? '' : 'off'}" data-set="${s.id}" style="grid-template-columns:20px 1fr">
        <input type="radio" name="pset" value="${s.id}" ${s.id === chosenSet ? 'checked' : ''}>
        <div><div class="name">${esc(s.label)}</div><div class="tiny muted">${esc(s.blurb)}</div></div>
      </label>`).join('');
    for (const r of document.querySelectorAll('input[name="pset"]')) r.addEventListener('change', () => { chosenSet = r.value; renderPersonaSets(); });
    const set = meta.personaSets.find((s) => s.id === chosenSet);
    if (!chosenPersonas.has(chosenSet)) chosenPersonas.set(chosenSet, new Set(set.personas.map((p) => p.id)));
    const on = chosenPersonas.get(chosenSet);
    $('persona-pick').innerHTML = set.personas.map((p) => `
      <label class="persona ${on.has(p.id) ? '' : 'off'}">
        <input type="checkbox" data-persona="${p.id}" ${on.has(p.id) ? 'checked' : ''}>
        <div><div class="name">${esc(p.label)}</div><div class="tiny muted">${esc(p.summary)}</div></div>
      </label>`).join('');
    for (const box of document.querySelectorAll('[data-persona]')) box.addEventListener('change', () => {
      if (box.checked) on.add(box.dataset.persona); else on.delete(box.dataset.persona);
      box.closest('.persona').classList.toggle('off', !box.checked);
    });
  }

  $('cls-create').addEventListener('click', async () => {
    $('cls-error').textContent = '';
    try {
      const cls = await api('/classes', { method: 'POST', body: {
        name: $('cls-name').value.trim(),
        count: Number($('cls-count').value),
        personaSet: chosenSet,
        personas: [...(chosenPersonas.get(chosenSet) || [])],
        contextId: $('cls-context').value || null,
      } });
      $('cls-name').value = '';
      await refreshAll();
      flash(`Created “${cls.name}”. Downloading the login cards…`);
      download(`/classes/${cls.id}/cards.pdf`, 'login-cards.pdf');
    } catch (err) {
      $('cls-error').textContent = err.message;
    }
  });

  function renderClasses() {
    const host = $('cls-list');
    host.innerHTML = classes.length ? classes.map((c) => {
      const ctx = contexts.find((x) => x.id === c.contextId);
      return `<div class="list-item">
        <div style="flex:1 1 320px"><div class="title">${esc(c.name)}</div>
          <div class="small muted">${c.size} students · ${esc(c.personaSetLabel)} · ${c.personas.length} personas · context: ${ctx ? esc(ctx.title || ctx.name) : '<span style="color:var(--warn)">none</span>'}</div></div>
        <div class="shrink row">
          <button class="small" data-cards="${c.id}">⬇ Login cards (PDF)</button>
          <select class="small" data-ctx="${c.id}" style="width:auto;padding:6px 8px;font-size:.82rem">
            <option value="">No context</option>${contexts.map((x) => `<option value="${x.id}" ${x.id === c.contextId ? 'selected' : ''}>${esc(x.title || x.name)}</option>`).join('')}
          </select>
          <button class="ghost small" data-add="${c.id}">+ Students</button>
          <button class="danger small" data-delcls="${c.id}">Delete</button>
        </div></div>`;
    }).join('') : '<p class="muted small">None yet.</p>';

    for (const b of host.querySelectorAll('[data-cards]')) b.addEventListener('click', () => download(`/classes/${b.dataset.cards}/cards.pdf`, 'login-cards.pdf'));
    for (const s of host.querySelectorAll('[data-ctx]')) s.addEventListener('change', async () => {
      await api(`/classes/${s.dataset.ctx}`, { method: 'PUT', body: { contextId: s.value || null } });
      flash('Context updated for that class.');
      refreshAll();
    });
    for (const b of host.querySelectorAll('[data-add]')) b.addEventListener('click', async () => {
      const c = classes.find((x) => x.id === b.dataset.add);
      const more = Number(prompt(`How many students should ${c.name} have in total? (currently ${c.size})`, String(c.size + 1)));
      if (!(more > c.size)) return;
      await api(`/classes/${c.id}`, { method: 'PUT', body: { count: more } });
      flash('Added. Download the login cards again to get the new codes.');
      refreshAll();
    });
    for (const b of host.querySelectorAll('[data-delcls]')) b.addEventListener('click', async () => {
      if (!await confirmBox('Delete this class?', 'Its login codes stop working. Past activities stay downloadable.', 'Delete')) return;
      try { await api(`/classes/${b.dataset.delcls}`, { method: 'DELETE' }); } catch (err) { flash(err.message); }
      refreshAll();
    });

    const select = $('act-class');
    const current = select.value;
    select.innerHTML = classes.length
      ? classes.map((c) => `<option value="${c.id}">${esc(c.name)} (${c.size})</option>`).join('')
      : '<option value="">Create a class first</option>';
    if (current) select.value = current;
  }

  // ----------------------------------------------------------- activities

  const FAMILIES = ['haiku', 'sonnet', 'opus'];
  const famName = (f) => f[0].toUpperCase() + f.slice(1);
  const famList = (fams) => fams.map(famName).join(', ').replace(/, ([^,]*)$/, ' and $1');

  /** Three checkboxes, one per model. At least one stays ticked. */
  function modelPicker(host, selected, onChange) {
    const key = selected.join(',');
    if (host.dataset.key === key) return;
    host.dataset.key = key;
    host.innerHTML = FAMILIES.map((f) => `
      <label class="persona ${selected.includes(f) ? '' : 'off'}" style="flex:0 0 auto;min-width:120px">
        <input type="checkbox" data-fam="${f}" ${selected.includes(f) ? 'checked' : ''}>
        <div class="name">${famName(f)}</div></label>`).join('');
    for (const box of host.querySelectorAll('[data-fam]')) box.addEventListener('change', () => {
      const next = FAMILIES.filter((f) => host.querySelector(`[data-fam="${f}"]`).checked);
      if (!next.length) { box.checked = true; flash('Keep at least one model.'); return; }
      host.dataset.key = '';
      modelPicker(host, next, onChange);
      onChange(next);
    });
  }

  let chosenMode = 'learn4';
  let finalModels = ['haiku', 'sonnet'];
  let openModels = [...FAMILIES];

  function renderModes() {
    if (!meta?.modes) return;
    $('mode-pick').innerHTML = meta.modes.map((m) => `
      <label class="persona ${m.id === chosenMode ? '' : 'off'}">
        <input type="radio" name="mode" value="${m.id}" ${m.id === chosenMode ? 'checked' : ''}>
        <div><div class="name">${esc(m.label)}</div><div class="tiny muted">${esc(m.description)}</div></div>
      </label>`).join('');
    for (const r of document.querySelectorAll('input[name="mode"]')) r.addEventListener('change', () => { chosenMode = r.value; renderModes(); });
    const extra = $('mode-extra');
    if (chosenMode === 'learn4') {
      extra.innerHTML = `<div class="field"><label>Models in round 4 <span class="muted small">— students are not told</span></label>
        <div class="row" id="final-models" style="gap:8px"></div><p class="small muted" id="final-note" style="margin:6px 0 0"></p></div>`;
      const note = () => {
        const off = FAMILIES.filter((f) => !finalModels.includes(f));
        $('final-note').textContent = off.length ? `${famList(off)} quietly switched off in round 4. You can still change this before round 4 starts.` : 'All three models stay on: round 4 tests whether the learning holds.';
      };
      modelPicker($('final-models'), finalModels, (next) => { finalModels = next; note(); });
      note();
    } else if (chosenMode === 'open') {
      extra.innerHTML = `<div class="grid2">
        <div class="field"><label for="act-block">Rounds at a time</label>
          <select id="act-block">${[1, 2, 3, 4, 5, 6].map((n) => `<option value="${n}" ${n === 3 ? 'selected' : ''}>${n} round${n === 1 ? '' : 's'}</option>`).join('')}</select>
          <div class="tiny muted" style="margin-top:4px">After each block you can keep going (up to ${meta.maxRounds || 12} rounds) or show the overview.</div></div>
        <div class="field"><label>Models to start with</label><div class="row" id="open-models" style="gap:8px"></div>
          <div class="tiny muted" style="margin-top:4px">Change them between rounds.</div></div></div>`;
      modelPicker($('open-models'), openModels, (next) => { openModels = next; });
    } else extra.innerHTML = '';
  }

  $('act-ratio').addEventListener('input', () => { $('act-ratio-label').textContent = `${$('act-ratio').value}%`; });

  $('act-start').addEventListener('click', async () => {
    $('act-error').textContent = '';
    try {
      await api('/activities', { method: 'POST', body: {
        classId: $('act-class').value,
        name: $('act-name').value.trim(),
        durationSec: Number($('act-duration').value),
        aiRatio: Number($('act-ratio').value) / 100,
        mode: chosenMode,
        finalModels,
        models: openModels,
        blockSize: chosenMode === 'open' ? Number($('act-block').value) : undefined,
      } });
      $('act-name').value = '';
      showTab('live');
    } catch (err) {
      $('act-error').textContent = err.message;
    }
  });

  function renderActivities() {
    const host = $('act-list');
    host.innerHTML = activities.length ? activities.map((a) => `
      <div class="list-item">
        <div style="flex:1 1 320px"><div class="title">${esc(a.name)} <span class="pill ${a.status === 'finished' ? 'human' : a.status === 'live' ? 'on' : 'warn'}">${esc(a.status)}</span></div>
          <div class="small muted">${esc(a.className)} · ${new Date(a.createdAt).toLocaleString()} · ${esc(a.mode)} · ${a.rounds}/${a.planned} rounds
            ${a.fooled.length ? ` · AI passed as human: ${a.fooled.map((f, i) => `R${i + 1} ${pct(f)}`).join(', ')}` : ''}</div></div>
        <div class="shrink row">
          ${a.status === 'live' ? '<button class="small" data-golive="1">Open live view</button>' : ''}
          ${a.hasOverview ? `<button class="ghost small" data-ov="${a.id}">▶ Overview</button>` : ''}
          ${a.rounds ? `<button class="small" data-zip="${a.id}">⬇ ZIP</button>` : ''}
          ${a.status !== 'live' ? `<button class="danger small" data-delact="${a.id}">Delete</button>` : ''}
        </div></div>`).join('') : '<p class="muted small">None yet.</p>';
    for (const b of host.querySelectorAll('[data-golive]')) b.addEventListener('click', () => showTab('live'));
    for (const b of host.querySelectorAll('[data-zip]')) b.addEventListener('click', () => download(`/activities/${b.dataset.zip}/zip`, 'activity.zip'));
    for (const b of host.querySelectorAll('[data-ov]')) b.addEventListener('click', async () => {
      const data = await api(`/activities/${b.dataset.ov}/overview`);
      window.HumanOrNotOverview.render($('ov-modal-host'), data);
      $('ov-modal').classList.remove('hidden');
    });
    for (const b of host.querySelectorAll('[data-delact]')) b.addEventListener('click', async () => {
      if (!await confirmBox('Delete this activity?', 'Its transcripts, analysis and overview are deleted from the server. Download the ZIP first if you want them.', 'Delete')) return;
      await api(`/activities/${b.dataset.delact}`, { method: 'DELETE' });
      refreshAll();
    });
  }
  $('ov-modal-close').addEventListener('click', () => { $('ov-modal').classList.add('hidden'); $('ov-modal-host').innerHTML = ''; });

  // --------------------------------------------------------------- backup

  $('backup-btn').addEventListener('click', async () => {
    await download('/backup', 'human-or-not-backup.json');
    $('backup-note').textContent = 'Saved. Keep this file somewhere safe.';
  });
  $('restore-btn').addEventListener('click', () => $('restore-file').click());
  $('restore-file').addEventListener('change', (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const res = await api('/restore', { method: 'POST', body: String(reader.result || '') });
        $('backup-note').textContent = `Restored ${res.counts.contexts} contexts, ${res.counts.classes} classes, ${res.counts.activities} activities.`;
        refreshAll();
      } catch (err) { $('backup-note').textContent = err.message; }
    };
    reader.readAsText(file);
    e.target.value = '';
  });

  // ----------------------------------------------------------------- live

  function command(event, payload = {}) {
    return new Promise((resolve) => socket.emit(event, payload, (res) => {
      if (res && res.ok === false) flash(res.error);
      resolve(res);
    }));
  }

  $('btn-start-1').addEventListener('click', () => command('live:startRound'));
  $('btn-end').addEventListener('click', () => command('live:endRound'));
  $('btn-results').addEventListener('click', () => command('live:results'));
  $('btn-next').addEventListener('click', () => command(live && live.roundNumber >= live.roundCount ? 'live:overview' : 'live:startRound'));
  $('btn-more').addEventListener('click', () => command('live:moreRounds'));
  const nextPlan = () => (live && live.roundNumber < live.roundCount ? live.plan[live.roundNumber] : null);
  const setNextModels = (models) => command('live:setModels', { models });
  $('btn-zip-live').addEventListener('click', () => live && download(`/activities/${live.id}/zip`, 'activity.zip'));
  $('btn-zip-done').addEventListener('click', () => lastLiveId && download(`/activities/${lastLiveId}/zip`, 'activity.zip'));
  $('btn-finish').addEventListener('click', async () => {
    if (!await confirmBox('Finish this activity?', 'Students see a thank-you screen. Everything stays saved and downloadable under Activities.', 'Finish')) return;
    await command('live:finish');
    refreshAll();
  });

  socket.on('live', (view) => {
    live = view;
    if (view) lastLiveId = view.id;
    $('nav-live').classList.toggle('hidden', !view || view.phase === 'finished');
    renderLive();
  });

  function renderLive() {
    const stages = ['lobby', 'active', 'guess', 'results', 'overview', 'finished'];
    if (!live) {
      for (const s of stages) $(`live-${s}`).classList.add('hidden');
      $('live-name').textContent = 'No activity running';
      $('live-sub').textContent = 'Start one from Activities.';
      $('live-track').innerHTML = '';
      return;
    }
    for (const s of stages) $(`live-${s}`).classList.toggle('hidden', s !== live.phase);
    $('live-name').textContent = live.name;
    $('live-sub').textContent = `${live.className} · ${live.personaSet} · ${live.contextName || 'no class context'}`;
    $('live-track').innerHTML = live.plan.map((p) => {
      const state = p.number < live.roundNumber || (p.number === live.roundNumber && ['results', 'overview', 'finished'].includes(live.phase))
        ? 'done' : p.number === live.roundNumber ? 'now' : '';
      return `<div class="${state}"><strong>Round ${p.number}</strong><br>${esc(p.models.map((m) => m[0].toUpperCase() + m.slice(1)).join(' · '))}</div>`;
    }).join('');

    const students = live.students;
    if (live.phase === 'lobby') {
      $('lobby-count').textContent = students.filter((s) => s.connected).length;
      $('lobby-of').textContent = live.classSize;
      $('lobby-chips').innerHTML = students.map((s) => `<div class="chip ${s.connected ? '' : 'off'}">${esc(s.label)}</div>`).join('');
      $('btn-start-1').disabled = !students.some((s) => s.connected);
      const first = nextPlan();
      $('lobby-models').classList.toggle('hidden', !first?.editable);
      if (first?.editable) modelPicker($('lobby-models-pick'), first.models, setNextModels);
    }

    if (live.phase === 'active') {
      $('active-label').textContent = `Round ${live.roundNumber} of ${live.roundCount}`;
      const inRound = students.filter((s) => s.inRound);
      $('active-students').textContent = inRound.length;
      $('active-ai').textContent = inRound.filter((s) => s.partner === 'ai').length;
      $('active-messages').textContent = inRound.reduce((n, s) => n + s.messages, 0);
      const off = FAMILIES.filter((f) => !(live.round?.models || FAMILIES).includes(f));
      $('active-secret').textContent = live.round?.secret && off.length ? `${famList(off)} ${off.length === 1 ? 'is' : 'are'} switched off this round. Don't tell the students.` : '';
      startClock();
    } else stopClock();

    if (live.phase === 'guess') {
      $('guess-count').textContent = `${live.round.guessed}/${live.round.paired}`;
    }

    if (live.phase === 'results') renderResults();

    if (live.phase === 'overview') {
      const ready = live.overviewStatus === 'done' && live.overviewData;
      $('overview-wait').classList.toggle('hidden', ready || live.overviewStatus === 'failed');
      if (live.overviewStatus === 'failed') {
        $('overview-host').innerHTML = '<div class="card center"><p>The overview could not be written.</p><button id="retry-ov">Try again</button></div>';
        $('retry-ov').onclick = () => command('live:retryOverview');
        renderedOverviewFor = null;
      } else if (ready && renderedOverviewFor !== live.id) {
        renderedOverviewFor = live.id;
        window.HumanOrNotOverview.render($('overview-host'), live.overviewData);
      }
    }
  }

  function renderResults() {
    const r = live.round;
    const s = r.stats || {};
    $('results-title').textContent = `Round ${r.number} results`;
    $('res-fooled').textContent = pct(s.aiFooledRate);
    $('res-accuracy').textContent = pct(s.accuracy);
    $('res-human').textContent = pct(s.humanSpotRate);
    $('res-answered').textContent = `${s.answered ?? 0}/${s.students ?? 0}`;
    $('res-models').innerHTML = Object.values(s.byModel || {}).map((m) => `<tr><td><strong>${esc(m.label)}</strong></td>
      <td>${m.conversations}</td><td>${m.fooled}</td><td>${m.answered - m.fooled}</td><td><strong>${pct(m.fooledRate)}</strong></td></tr>`).join('')
      || '<tr><td colspan="5" class="muted">No AI conversations this round.</td></tr>';
    // Only redraw the pairs when they change, or every state push restarts the animation.
    const pairsKey = JSON.stringify([r.number, r.pairs]);
    if ($('res-pairs').dataset.key !== pairsKey) {
      $('res-pairs').dataset.key = pairsKey;
      $('res-pairs').innerHTML = r.pairs.map((p, i) => `<div class="pair ${p.type}" style="animation-delay:${Math.min(i * 70, 1000)}ms">
      ${p.type === 'ai'
        ? `<div>🧑 <strong>${esc(p.members[0])}</strong> ↔ 🤖 <strong>${esc(p.model)}</strong></div><div class="tiny muted">${esc(p.persona)} · guessed ${p.guesses[0] ? (p.guesses[0] === 'ai' ? 'AI ✓' : 'classmate ✕') : '—'}</div>`
        : `<div>🧑 <strong>${esc(p.members[0])}</strong> ↔ 🧑 <strong>${esc(p.members[1])}</strong></div><div class="tiny muted">guessed ${p.guesses.map((g) => (g ? (g === 'human' ? 'classmate ✓' : 'AI ✕') : '—')).join(' · ')}</div>`}
    </div>`).join('');
    }

    const body = $('analysis-body');
    if (r.analysisStatus === 'running' || r.analysisStatus === 'pending') {
      body.innerHTML = '<p class="muted"><span class="spinner"></span>Claude Opus is reading every conversation from this round…</p>';
    } else if (r.analysisStatus === 'failed') {
      body.innerHTML = `<p style="color:var(--warn)">The analysis did not finish: ${esc(r.analysisError || '')}</p><button id="retry-an" class="small">Try again</button>`;
      $('retry-an').onclick = () => command('live:retryAnalysis');
    } else if (r.analysis) {
      const a = r.analysis;
      const list = (items, fmt) => (items?.length ? `<ul class="findings small">${items.map(fmt).join('')}</ul>` : '<p class="small muted">—</p>');
      body.innerHTML = `
        <p><strong>${esc(a.headline)}</strong></p><p class="small">${esc(a.summary)}</p>
        <div class="grid2">
          <div><h3>What gave the AI away</h3>${list(a.aiTells, (x) => `<li>${esc(x.tell)} <span class="muted">“${esc(x.evidence)}”</span></li>`)}</div>
          <div><h3>How students tried to catch it</h3>${list(a.studentStrategies, (x) => `<li>${esc(x)}</li>`)}</div>
        </div>
        ${r.number < live.roundCount ? `<h3>What the AI will do differently next round</h3>${list(a.guidance, (x) => `<li>${esc(x)}</li>`)}` : ''}`;
    }
    $('analysis-card').classList.toggle('hidden', !live.mode.learning);
    const analysing = live.mode.learning && ['running', 'pending'].includes(r.analysisStatus);
    const done = live.roundNumber >= live.roundCount;
    const next = nextPlan();
    const canMore = live.mode.id === 'open' && done && live.roundCount < live.maxRounds;
    $('btn-next').disabled = analysing;
    $('btn-next').textContent = done ? `Show the overview of ${live.roundCount === 2 ? "both" : `all ${live.roundCount}`} rounds →` : `Start round ${r.number + 1} →`;
    $('btn-more').classList.toggle('hidden', !canMore);
    $('btn-more').textContent = `Play ${Math.min(live.blockSize || 1, live.maxRounds - live.roundCount)} more round${(live.blockSize || 1) === 1 ? '' : 's'}`;
    $('next-models-card').classList.toggle('hidden', !next?.editable);
    if (next?.editable) {
      $('next-models-title').textContent = `Models for round ${next.number}`;
      modelPicker($('next-models'), next.models, setNextModels);
      const off = FAMILIES.filter((f) => !next.models.includes(f));
      $('next-models-note').textContent = live.mode.id === 'open'
        ? 'No learning between rounds in open play — change the models to see what difference they make.'
        : off.length ? `${famList(off)} will be quietly switched off. Students are not told.` : 'All three models stay on.';
    }
    const offNext = next ? FAMILIES.filter((f) => !next.models.includes(f)) : [];
    $('next-note').textContent = analysing ? 'Ready as soon as Opus has finished — usually under a minute.'
      : next?.secret && offNext.length && live.mode.learning ? `Round ${next.number} quietly switches ${famList(offNext)} off.`
        : canMore ? 'Keep going, or show the overview to finish.' : '';
  }

  function startClock() {
    if (clockTimer) return;
    const tick = () => {
      if (!live?.endsAt) return;
      const left = Math.max(0, Math.ceil((live.endsAt - Date.now()) / 1000));
      $('clock').textContent = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
      $('clock').classList.toggle('warn', left <= 30 && left > 10);
      $('clock').classList.toggle('critical', left <= 10);
    };
    tick();
    clockTimer = setInterval(tick, 250);
  }
  function stopClock() { clearInterval(clockTimer); clockTimer = null; }
})();
