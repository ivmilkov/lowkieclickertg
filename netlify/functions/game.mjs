import crypto from 'node:crypto';
import { getStore } from '@netlify/blobs';

const MAX_BODY = 600_000;           // символов в JSON сохранения
const MAX_AUTH_AGE = 3 * 24 * 3600; // initData старше 3 суток не принимаем
const TOP_SIZE = 50;                // сколько игроков в таблице лидеров
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

// Обновить общий список топ-игроков
async function updateTop(lb, id, name, total) {
  const top = (await lb.get('top', { type: 'json' })) || { entries: {} };
  const entries = top.entries || {};
  const ids = Object.keys(entries);

  // не попадаем в топ и не было в нём — ничего не пишем
  if (!entries[id] && ids.length >= TOP_SIZE) {
    const min = Math.min(...ids.map(k => entries[k].t));
    if (total <= min) return;
  }

  entries[id] = { n: name, t: total };
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

  // strong: читаем всегда свежую запись, а не устаревшую копию
  const store = getStore({ name: 'players', consistency: 'strong' });
  const lb = getStore({ name: 'leaderboard', consistency: 'strong' });
  const key = `u_${user.id}`;
  const current = await store.get(key, { type: 'json' });

  if (body.action === 'load') {
    return json({ exists: !!current, record: current || null });
  }

  if (body.action === 'top') {
    const top = (await lb.get('top', { type: 'json' })) || { entries: {} };
    const list = Object.entries(top.entries || {})
      .sort((a, b) => b[1].t - a[1].t)
      .slice(0, TOP_SIZE)
      .map(([id, e], i) => ({
        rank: i + 1,
        name: e.n,
        total: e.t,
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
    const lbDue = !current || now - (current.lbAt || 0) > LB_UPDATE_EVERY;

    const record = {
      rev: curRev + 1,
      state: st,
      extra,
      deviceId: typeof body.deviceId === 'string' ? body.deviceId.slice(0, 64) : null,
      tgId: user.id,
      username: user.username || null,
      name,
      lbAt: lbDue ? now : (current.lbAt || 0),
      updatedAt: now
    };
    await store.setJSON(key, record);

    if (lbDue) {
      try {
        await updateTop(lb, String(user.id), name, Math.floor(Number(st.total)));
      } catch (e) {
        console.error('leaderboard update failed', e);
      }
    }
    return json({ ok: true, rev: record.rev });
  }

  return json({ error: 'unknown_action' }, 400);
};
