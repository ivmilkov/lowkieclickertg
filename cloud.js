// Синхронизация прогресса с Telegram-аккаунтом.
// Грузится ПОСЛЕ script.js. Вне Telegram (обычный браузер) ничего не делает — игра работает локально как раньше.
(function () {
  const tg = window.Telegram && window.Telegram.WebApp;
  const initData = tg && tg.initData;
  if (!initData) { console.log('[cloud] вне Telegram — локальный режим'); return; }

  try { tg.ready(); tg.expand(); } catch (e) {}

  const API = '/.netlify/functions/game';
  const META_KEY = 'lowkie_cloud_meta';
  const DIRTY_KEY = 'lowkie_cloud_dirty';
  const DEVICE_KEY = 'lowkie_cloud_device';
  const EXTRA_KEYS = ['lowkie_little_last', 'lowkie_wheel_last'];
  const MAX_HISTORY = 200;

  const tgUser = (tg.initDataUnsafe && tg.initDataUnsafe.user) || {};
  const uid = tgUser.id;
  if (!uid) return;
  const nick = tgUser.username
    ? '@' + tgUser.username
    : ([tgUser.first_name, tgUser.last_name].filter(Boolean).join(' ') || 'player_' + uid);

  // уникальный id этого устройства, чтобы сервер отличал «свои» записи от чужих
  let deviceId = null;
  try { deviceId = localStorage.getItem(DEVICE_KEY); } catch (e) {}
  if (!deviceId) {
    deviceId = 'd' + Math.random().toString(36).slice(2) + Date.now().toString(36);
    try { localStorage.setItem(DEVICE_KEY, deviceId); } catch (e) {}
  }

  let ready = false;
  let adopting = false;
  let dirty = false;
  let inflight = false;
  let meta = readMeta();

  function readMeta() {
    try { const m = JSON.parse(localStorage.getItem(META_KEY)); if (m && typeof m === 'object') return m; } catch (e) {}
    return { uid: null, rev: 0 };
  }
  function writeMeta(m) {
    meta = m;
    try { localStorage.setItem(META_KEY, JSON.stringify(m)); } catch (e) {}
  }
  // «есть несохранённые на сервер изменения» — помним даже после перезапуска игры
  function setDirty(v) {
    dirty = v;
    try { if (v) localStorage.setItem(DIRTY_KEY, '1'); else localStorage.removeItem(DIRTY_KEY); } catch (e) {}
  }
  function wasDirty() {
    try { return localStorage.getItem(DIRTY_KEY) === '1'; } catch (e) { return false; }
  }

  // --- экран загрузки, чтобы игрок не тапал до синхронизации ---
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;z-index:100000;background:#071226;color:#9aa6b2;display:flex;align-items:center;justify-content:center;font:700 16px system-ui,sans-serif';
  overlay.textContent = 'загрузка прогресса…';
  document.body.appendChild(overlay);
  function hideOverlay() { overlay.remove(); }

  // --- перехват save(): любое сохранение игры помечает данные как «надо отправить» ---
  const origSave = save;
  save = function () {
    if (adopting) return;
    origSave();
    setDirty(true);
  };

  async function api(payload, keepalive) {
    const res = await fetch(API, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(Object.assign({ initData, deviceId }, payload)),
      keepalive: !!keepalive
    });
    let data = null;
    try { data = await res.json(); } catch (e) {}
    return { status: res.status, ok: res.ok, data };
  }

  function buildPayload() {
    const s = JSON.parse(JSON.stringify(state));
    delete s.support; // обращения в поддержку (с файлами) остаются только на устройстве
    if (Array.isArray(s.history) && s.history.length > MAX_HISTORY) s.history = s.history.slice(0, MAX_HISTORY);
    s.nickname = nick;
    const extra = {};
    EXTRA_KEYS.forEach(k => { const v = Number(localStorage.getItem(k)); if (v > 0) extra[k] = v; });
    return { state: s, extra };
  }

  // применить серверную версию: пишем в localStorage и перезагружаем страницу
  function adopt(record) {
    adopting = true;
    ready = false;
    const st = Object.assign({}, record.state);
    st.support = (state && state.support) || { tickets: [] };
    st.nickname = nick;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(st));
      const extra = record.extra || {};
      EXTRA_KEYS.forEach(k => {
        const local = Number(localStorage.getItem(k)) || 0;
        const best = Math.max(local, Number(extra[k]) || 0);
        if (best > 0) localStorage.setItem(k, String(best));
      });
      localStorage.removeItem(DIRTY_KEY);
    } catch (e) { console.error('[cloud] adopt failed', e); }
    writeMeta({ uid, rev: record.rev });
    location.reload();
  }

  async function push(keepalive) {
    if (!ready || inflight || adopting || !dirty) return;
    inflight = true;
    dirty = false; // если за время отправки игрок ещё потапает, save() вернёт true
    try {
      const p = buildPayload();
      const r = await api({ action: 'save', baseRev: meta.rev, state: p.state, extra: p.extra }, keepalive);
      if (r.status === 409 && r.data && r.data.record) {
        const rec = r.data.record;
        if (rec.deviceId === deviceId) {
          // запись сделали мы сами (ответ потерялся / сервер отдал не самую свежую копию) —
          // свой прогресс не трогаем, просто сверяем номер версии и отправим снова
          writeMeta({ uid, rev: rec.rev });
          setDirty(true);
        } else {
          adopt(rec); // реально писали с другого устройства
        }
        return;
      }
      if (!r.ok) throw new Error('save ' + r.status);
      writeMeta({ uid, rev: r.data.rev });
      if (!dirty) { try { localStorage.removeItem(DIRTY_KEY); } catch (e) {} }
    } catch (e) {
      setDirty(true); // попробуем в следующий раз
    } finally {
      inflight = false;
    }
  }

  async function init() {
    const r = await api({ action: 'load' });
    if (!r.ok) throw new Error('load ' + r.status);

    const localTotal = Number(state.total) || 0;

    if (!r.data.exists) {
      // первый вход с этого аккаунта: заливаем текущий локальный прогресс на сервер
      writeMeta({ uid, rev: 0 });
      setDirty(true);
    } else {
      const rec = r.data.record;
      if (meta.uid === uid) {
        if (meta.rev < rec.rev) {
          if (rec.deviceId === deviceId) {
            writeMeta({ uid, rev: rec.rev }); // это наша же запись, прогресс на устройстве актуален
          } else {
            adopt(rec); return;               // с другого устройства ушли вперёд
          }
        } else if (meta.rev > rec.rev) {
          writeMeta({ uid, rev: rec.rev });   // сервер отдал более старую копию — доверяем себе
          setDirty(true);
        }
        if (wasDirty()) setDirty(true);       // дольём то, что не успело уйти в прошлый раз
      } else {
        // это устройство ещё не было привязано к аккаунту
        const serverTotal = Number(rec.state && rec.state.total) || 0;
        if (localTotal > serverTotal) {
          writeMeta({ uid, rev: rec.rev }); // локальный прогресс больше — он становится основным
          setDirty(true);
        } else {
          adopt(rec);
          return;
        }
      }
    }

    ready = true;
    if (state.nickname !== nick) {
      state.nickname = nick;
      save(); // ник поменялся — сохраняем и отправим
    } else {
      origSave(); // просто фиксируем локально, на сервер без лишней записи
    }
    try { updateUI(); } catch (e) {}
    push();
  }

  // ---------- лидеры ----------
  const leaders = { list: null, error: false, at: 0, drawnKey: '' };

  function renderLeadersCloud() {
    const box = document.getElementById('leadersList');
    const tab = document.getElementById('friends');
    if (!box || !tab || tab.style.display === 'none') return;

    const myTotal = Math.floor(Number(state.total) || 0);
    const key = leaders.at + '|' + leaders.error + '|' + myTotal;
    if (key === leaders.drawnKey) return;
    leaders.drawnKey = key;

    box.innerHTML = '';
    const note = (text) => {
      const d = document.createElement('div');
      d.style.cssText = 'color:var(--muted);text-align:center;padding:16px;font-size:13px;';
      d.textContent = text;
      box.appendChild(d);
    };

    if (!leaders.list) { note(leaders.error ? 'не удалось загрузить таблицу лидеров' : 'загрузка…'); return; }
    if (leaders.list.length === 0) { note('пока никого нет'); return; }

    const medals = ['🥇', '🥈', '🥉'];
    const addRow = (rank, name, total, isMe) => {
      const row = document.createElement('div');
      row.className = 'upgrade-card';
      if (isMe) row.style.border = '1px solid rgba(255,209,102,0.5)';

      const place = document.createElement('div');
      place.style.cssText = 'width:34px;text-align:center;font-weight:800;font-size:16px;flex-shrink:0;';
      place.textContent = rank && rank <= 3 ? medals[rank - 1] : (rank ? String(rank) : '—');

      const avatar = document.createElement('div');
      avatar.style.cssText = 'width:44px;height:44px;border-radius:50%;background:linear-gradient(135deg,#ff7e5f,#feb47b);display:flex;align-items:center;justify-content:center;font-weight:800;color:#fff;flex-shrink:0;';
      avatar.textContent = (Array.from(name)[0] || '?').toUpperCase();

      const info = document.createElement('div');
      info.style.cssText = 'flex:1;min-width:0;margin-left:4px;';
      const nm = document.createElement('strong');
      nm.style.cssText = 'display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
      nm.textContent = name + (isMe ? ' (вы)' : '');
      const bal = document.createElement('div');
      bal.style.cssText = 'color:var(--accent);font-weight:700;';
      bal.textContent = formatNum(total) + ' монет';
      info.appendChild(nm);
      info.appendChild(bal);

      row.appendChild(place);
      row.appendChild(avatar);
      row.appendChild(info);
      box.appendChild(row);
    };

    let meInList = false;
    leaders.list.forEach(p => {
      if (p.isMe) meInList = true;
      addRow(p.rank, p.name, p.isMe ? myTotal : p.total, p.isMe);
    });
    if (!meInList) {
      note('· · ·');
      addRow(null, nick, myTotal, true);
    }
  }

  // подменяем заглушку «один игрок» из script.js на настоящую таблицу
  renderLeaders = renderLeadersCloud;

  async function fetchLeaders() {
    if (!ready) return;
    try {
      const r = await api({ action: 'top' });
      if (!r.ok) throw new Error('top ' + r.status);
      leaders.list = r.data.top || [];
      leaders.error = false;
    } catch (e) {
      leaders.error = true;
    }
    leaders.at = Date.now();
    renderLeadersCloud();
  }

  const friendsTabBtn = document.getElementById('tab-friends');
  if (friendsTabBtn) friendsTabBtn.addEventListener('click', () => { renderLeadersCloud(); fetchLeaders(); });
  setInterval(() => {
    const tab = document.getElementById('friends');
    if (tab && tab.style.display !== 'none' && document.visibilityState === 'visible') fetchLeaders();
  }, 30000);

  // периодическая отправка, отправка при сворачивании/закрытии
  setInterval(() => push(), 5000);
  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState === 'hidden') { push(true); return; }
    // вернулись в игру: проверим, не ушёл ли прогресс вперёд на другом устройстве
    if (!ready || inflight) return;
    try {
      await push();
      const r = await api({ action: 'load' });
      if (r.ok && r.data.exists && !dirty && !inflight) {
        const rec = r.data.record;
        if (rec.rev > meta.rev && rec.deviceId !== deviceId) adopt(rec);
      }
    } catch (e) {}
  });
  window.addEventListener('pagehide', () => push(true));

  init().then(hideOverlay).catch(e => {
    console.warn('[cloud] нет связи, играем локально', e);
    overlay.textContent = 'нет связи с сервером, играем офлайн';
    setTimeout(hideOverlay, 1500);
    // повторная попытка подключения позже
    const retry = setInterval(async () => {
      try { await init(); clearInterval(retry); } catch (err) {}
    }, 20000);
  });
})();
