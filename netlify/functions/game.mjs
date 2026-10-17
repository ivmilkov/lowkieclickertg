import crypto from 'node:crypto';
import { getStore } from '@netlify/blobs';

const MAX_BODY = 600_000;           // символов в JSON сохранения
const MAX_AUTH_AGE = 3 * 24 * 3600; // initData старше 3 суток не принимаем
// Telegram id админов. Можно переопределить переменной ADMIN_IDS на Netlify (через запятую)
const ADMIN_IDS = (process.env.ADMIN_IDS || '8165411879').split(',').map(s => s.trim()).filter(Boolean);
const TOP_SIZE = 50;               // сколько игроков в таблице лидеров
const LB_UPDATE_EVERY = 30_000;     // не чаще раза в 30 сек на игрока обновляем таблицу

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }
  });

// Проверка подписи Telegram Mini App (initData)
function verifyInitData(initData, botToken) {
  if (!initData || typeof initData !== 'string') return null;
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return null;
  params.delete('hash');

  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');

  const secret = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const calc = crypto.createHmac('sha256', secret).update(dataCheckString).digest('hex');

  const a = Buffer.from(calc, 'hex');
  const b = Buffer.from(hash, 'hex');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  const authDate = Number(params.get('auth_date')) || 0;
  if (Date.now() / 1000 - authDate > MAX_AUTH_AGE) return null;

  try {
    const user = JSON.parse(params.get('user') || 'null');
    if (!user || !user.id) return null;
    return user;
  } catch (e) {
    return null;
  }
}

// Имя для таблицы лидеров: имя + фамилия из Telegram (не @username)
function displayName(user) {
  const name = [user.first_name, user.last_name].filter(Boolean).join(' ').trim() || user.username || 'Игрок';
  return name.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 40);
}

// ---------- админские действия над прогрессом игрока ----------
const MAX_VALUE = 1e15;

function ensureDiamonds(st) {
  if (!st.diamonds || typeof st.diamonds !== 'object') st.diamonds = { total: 0, lastTs: Date.now(), upgrades: {} };
  if (typeof st.diamonds.total !== 'number') st.diamonds.total = Number(st.diamonds.total) || 0;
  if (!st.diamonds.lastTs) st.diamonds.lastTs = Date.now();
  if (!st.diamonds.upgrades || typeof st.diamonds.upgrades !== 'object') st.diamonds.upgrades = {};
}

// возвращает строку с кодом ошибки или null, если всё применено
function applyAdminAction(st, act, value) {
  const intActs = ['setCoins', 'addCoins', 'burnCoins', 'setDiamonds', 'addDiamonds', 'setClickBonus', 'addClickBonus'];
  let n = 0;
  if (intActs.includes(act)) {
    n = Math.trunc(Number(value));
    if (!Number.isFinite(n) || Math.abs(n) > MAX_VALUE) return 'bad_value';
  }
  const coins = () => Number(st.total) || 0;
  const dia = () => Number(st.diamonds && st.diamonds.total) || 0;

  switch (act) {
    case 'setCoins': st.total = Math.max(0, n); return null;
    case 'addCoins': st.total = Math.min(MAX_VALUE, Math.max(0, coins() + n)); return null;
    case 'burnCoins':
      if (n <= 0) return 'bad_value';
      st.total = Math.max(0, coins() - n); return null;
    case 'setDiamonds': ensureDiamonds(st); st.diamonds.total = Math.max(0, n); return null;
    case 'addDiamonds': ensureDiamonds(st); st.diamonds.total = Math.min(MAX_VALUE, Math.max(0, dia() + n)); return null;
    case 'setClickBonus': st.bonus = n; return null;
    case 'addClickBonus': st.bonus = Math.max(-MAX_VALUE, Math.min(MAX_VALUE, (Number(st.bonus) || 0) + n)); return null;
    case 'maxBoost':
      if (!st.upgrades || typeof st.upgrades !== 'object') st.upgrades = {};
      st.upgrades.plus20 = true;
      st.upgrades.miniBoost = true;
      if (!st.multiclick || typeof st.multiclick !== 'object') st.multiclick = { totalBonus: 0, currentTier: 0, purchasesInTier: 0 };
      st.multiclick.totalBonus = Math.max(0, Number(st.multiclick.totalBonus) || 0) + 999999;
      if (!st.passive || typeof st.passive !== 'object') st.passive = { level: 0, lastTs: Date.now() };
      st.passive.level = Math.max(st.passive.level || 0, 15);
      return null;
    case 'setNickname': {
      const s = String(value || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 40);
      if (!s) return 'bad_value';
      st.nickname = s;
      st.nickOverride = true;
      return null;
    }
    case 'resetNickname': st.nickname = 'telegram_nik'; st.nickOverride = false; return null;
    case 'holdToTap': st.holdToTap = !!value; return null;
    case 'resetState': {
      const keepNick = st.nickname, keepOverride = st.nickOverride;
      for (const k of Object.keys(st)) delete st[k];
      Object.assign(st, {
        total: 0,
        bonus: 0,
        upgrades: { plus20: false, miniBoost: false },
        skins: { owned: {}, equipped: null },
        diamonds: { total: 0, lastTs: Date.now(), upgrades: {} },
        passive: { level: 0, lastTs: Date.now() },
        energyCurrent: 100,
        lastEnergyRegen: Date.now(),
        lastTapTs: 0,
        multiclick: { totalBonus: 0, currentTier: 0, purchasesInTier: 0 },
        holdToTap: false
      });
      if (keepNick) st.nickname = keepNick;
      if (keepOverride) st.nickOverride = keepOverride;
      return null;
    }
    default: return 'unknown_act';
  }
}

// краткая сводка по игроку для списка
function summary(rec) {
  const st = rec.state || {};
  return {
    id: String(rec.tgId),
    username: rec.username || null,
    name: rec.name || rec.firstName || null,
    nickname: st.nickname || null,
    total: Math.floor(Number(st.total) || 0),
    diamonds: Math.floor(Number(st.diamonds && st.diamonds.total) || 0),
    updatedAt: rec.updatedAt || 0,
    rev: rec.rev
  };
}

// Аватарка из Telegram: принимаем только ссылки вида https://t.me/i/userpic/...
function safePhoto(url) {
  if (typeof url !== 'string' || url.length > 300) return null;
  return /^https:\/\/t\.me\/i\/userpic\/[\w\-\/\.]+$/.test(url) ? url : null;
}

// Обновить общий список топ-игроков
async function updateTop(lb, id, name, total, photo) {
  const top = (await lb.get('top', { type: 'json' })) || { entries: {} };
  const entries = top.entries || {};

  // 0 монет (например, сбросил прогресс) — убираем игрока из таблицы
  if (!(total > 0)) {
    if (entries[id]) {
      delete entries[id];
      top.entries = entries;
      top.updatedAt = Date.now();
      await lb.setJSON('top', top);
    }
    return;
  }

  const ids = Object.keys(entries);

  // не попадаем в топ и не было в нём — ничего не пишем
  if (!entries[id] && ids.length >= TOP_SIZE) {
    const min = Math.min(...ids.map(k => entries[k].t));
    if (total <= min) return;
  }

  entries[id] = { n: name, t: total, p: photo || null };
  const sorted = Object.entries(entries).sort((a, b) => b[1].t - a[1].t).slice(0, TOP_SIZE);
  top.entries = Object.fromEntries(sorted);
  top.updatedAt = Date.now();
  await lb.setJSON('top', top);
}

export default async (req) => {
  if (req.method !== 'POST') return json({ error: 'method' }, 405);

  const botToken = process.env.BOT_TOKEN;
  if (!botToken) return json({ error: 'server_not_configured' }, 500);

  let body;
  try {
    const text = await req.text();
    if (text.length > MAX_BODY) return json({ error: 'too_big' }, 413);
    body = JSON.parse(text);
  } catch (e) {
    return json({ error: 'bad_json' }, 400);
  }

  const user = verifyInitData(body.initData, botToken);
  if (!user) return json({ error: 'unauthorized' }, 401);

  // проверка прав админа (по подписанному Telegram id, подделать нельзя)
  if (body.action === 'whoami') {
    return json({ isAdmin: ADMIN_IDS.includes(String(user.id)) });
  }

  // strong: читаем всегда свежую запись, а не устаревшую копию
  const store = getStore({ name: 'players', consistency: 'strong' });
  const lb = getStore({ name: 'leaderboard', consistency: 'strong' });
  // ---------- админские запросы (только для ADMIN_IDS) ----------
  if (typeof body.action === 'string' && body.action.startsWith('admin_')) {
    if (!ADMIN_IDS.includes(String(user.id))) return json({ error: 'forbidden' }, 403);

    if (body.action === 'admin_list') {
      const { blobs } = await store.list({ prefix: 'u_' });
      const rows = [];
      for (let i = 0; i < blobs.length; i += 20) {
        const chunk = blobs.slice(i, i + 20);
        const recs = await Promise.all(chunk.map(b => store.get(b.key, { type: 'json' }).catch(() => null)));
        recs.forEach(r => { if (r && r.state) rows.push(summary(r)); });
      }
      rows.sort((a, b) => b.total - a.total);
      return json({ players: rows });
    }

    const tid = String(body.targetId || '').replace(/\D/g, '');
    if (!tid) return json({ error: 'bad_target' }, 400);
    const tkey = `u_${tid}`;
    const rec = await store.get(tkey, { type: 'json' });
    if (!rec || !rec.state) return json({ error: 'no_player' }, 404);

    if (body.action === 'admin_get') {
      return json({ summary: summary(rec), state: rec.state });
    }

    if (body.action === 'admin_update') {
      const err = applyAdminAction(rec.state, body.act, body.value);
      if (err) return json({ error: err }, 400);
      rec.rev = (rec.rev || 0) + 1;
      rec.deviceId = 'admin';
      rec.updatedAt = Date.now();
      await store.setJSON(tkey, rec);
      try {
        await updateTop(lb, tid, rec.name || rec.firstName || 'Игрок', Math.floor(Number(rec.state.total) || 0), safePhoto(rec.photoUrl));
      } catch (e) {
        console.error('leaderboard update failed', e);
      }
      return json({ ok: true, summary: summary(rec), state: rec.state });
    }

    return json({ error: 'unknown_action' }, 400);
  }

  const key = `u_${user.id}`;
  const current = await store.get(key, { type: 'json' });

  if (body.action === 'load') {
    return json({ exists: !!current, record: current || null });
  }

  if (body.action === 'top') {
    let top = (await lb.get('top', { type: 'json' })) || { entries: {} };

    // игрок уже есть на сервере, но ещё не в таблице (например, не сохранялся после обновления) — добавим его
    if (current && current.state && !(top.entries && top.entries[String(user.id)])) {
      const t = Math.floor(Number(current.state.total));
      if (Number.isFinite(t) && t > 0) {
        try {
          await updateTop(lb, String(user.id), displayName(user), t, safePhoto(user.photo_url));
          top = (await lb.get('top', { type: 'json' })) || { entries: {} };
        } catch (e) {
          console.error('leaderboard self-heal failed', e);
        }
      }
    }

    const list = Object.entries(top.entries || {})
      .filter(([, e]) => e.t > 0)
      .sort((a, b) => b[1].t - a[1].t)
      .slice(0, TOP_SIZE)
      .map(([id, e], i) => ({
        rank: i + 1,
        name: e.n,
        total: e.t,
        photo: safePhoto(e.p),
        isMe: id === String(user.id)
      }));
    return json({ top: list, updatedAt: top.updatedAt || 0 });
  }

  if (body.action === 'save') {
    const st = body.state;
    if (!st || typeof st !== 'object' || !Number.isFinite(Number(st.total)) || Number(st.total) < 0) {
      return json({ error: 'bad_state' }, 400);
    }
    const baseRev = Number(body.baseRev) || 0;
    const curRev = current ? current.rev : 0;

    // другое устройство уже записало более новую версию
    if (current && baseRev !== curRev) {
      return json({ error: 'conflict', record: current }, 409);
    }

    const extra = {};
    if (body.extra && typeof body.extra === 'object') {
      for (const k of ['lowkie_little_last', 'lowkie_wheel_last']) {
        const v = Number(body.extra[k]);
        if (Number.isFinite(v) && v > 0) extra[k] = v;
      }
    }

    const now = Date.now();
    const name = displayName(user);
    // обнуление (сброс прогресса) отражаем в таблице сразу, не дожидаясь паузы
    const lbDue = !current || now - (current.lbAt || 0) > LB_UPDATE_EVERY || !(Number(st.total) > 0);

    const record = {
      rev: curRev + 1,
      state: st,
      extra,
      deviceId: typeof body.deviceId === 'string' ? body.deviceId.slice(0, 64) : null,
      tgId: user.id,
      username: user.username || null,
      name,
      photoUrl: safePhoto(user.photo_url),
      lbAt: lbDue ? now : (current.lbAt || 0),
      updatedAt: now
    };
    await store.setJSON(key, record);

    if (lbDue) {
      try {
        await updateTop(lb, String(user.id), name, Math.floor(Number(st.total)), safePhoto(user.photo_url));
      } catch (e) {
        console.error('leaderboard update failed', e);
      }
    }
    return json({ ok: true, rev: record.rev });
  }

  return json({ error: 'unknown_action' }, 400);
};
