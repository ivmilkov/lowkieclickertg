// Синхронизация прогресса с Telegram-аккаунтом.
// Грузится ПОСЛЕ script.js. Вне Telegram (обычный браузер) ничего не делает — игра работает локально как раньше.
(function () {
  const tg = window.Telegram && window.Telegram.WebApp;
  const initData = tg && tg.initData;
  if (!initData) { console.log('[cloud] вне Telegram — локальный режим'); return; }

  try { tg.ready(); tg.expand(); } catch (e) {}

  const API = '/.netlify/functions/game';
  const META_KEY = 'lowkie_cloud_meta';
  const EXTRA_KEYS = ['lowkie_little_last', 'lowkie_wheel_last'];
  const MAX_HISTORY = 200;

  const tgUser = (tg.initDataUnsafe && tg.initDataUnsafe.user) || {};
  const uid = tgUser.id;
  if (!uid) return;
  const nick = tgUser.username
    ? '@' + tgUser.username
    : ([tgUser.first_name, tgUser.last_name].filter(Boolean).join(' ') || 'player_' + uid);

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
    dirty = true;
  };

  async function api(payload, keepalive) {
    const res = await fetch(API, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(Object.assign({ initData }, payload)),
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
    } catch (e) { console.error('[cloud] adopt failed', e); }
    writeMeta({ uid, rev: record.rev });
    location.reload();
  }

  async function push(keepalive) {
    if (!ready || inflight || adopting || !dirty) return;
    inflight = true;
    dirty = false;
    try {
      const p = buildPayload();
      const r = await api({ action: 'save', baseRev: meta.rev, state: p.state, extra: p.extra }, keepalive);
      if (r.status === 409 && r.data && r.data.record) { adopt(r.data.record); return; }
      if (!r.ok) throw new Error('save ' + r.status);
      writeMeta({ uid, rev: r.data.rev });
    } catch (e) {
      dirty = true; // попробуем в следующий раз
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
      dirty = true;
    } else {
      const rec = r.data.record;
      if (meta.uid === uid) {
        if (meta.rev < rec.rev) { adopt(rec); return; }            // с другого устройства ушли вперёд
        if (meta.rev > rec.rev) writeMeta({ uid, rev: rec.rev });  // на всякий случай
        dirty = true;                                               // локальные несохранённые тапы дольём
      } else {
        // это устройство ещё не было привязано к аккаунту
        const serverTotal = Number(rec.state && rec.state.total) || 0;
        if (localTotal > serverTotal) {
          writeMeta({ uid, rev: rec.rev }); // локальный прогресс больше — он становится основным
          dirty = true;
        } else {
          adopt(rec);
          return;
        }
      }
    }

    ready = true;
    state.nickname = nick;
    save();
    try { updateUI(); } catch (e) {}
    push();
  }

  // периодическая отправка, отправка при сворачивании/закрытии
  setInterval(() => push(), 5000);
  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState === 'hidden') { push(true); return; }
    // вернулись в игру: проверим, не ушёл ли прогресс вперёд на другом устройстве
    if (!ready || inflight) return;
    try {
      await push();
      const r = await api({ action: 'load' });
      if (r.ok && r.data.exists && r.data.record.rev > meta.rev && !dirty) adopt(r.data.record);
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
