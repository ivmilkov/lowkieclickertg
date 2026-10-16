import crypto from 'node:crypto';
import { getStore } from '@netlify/blobs';

const MAX_BODY = 600_000;           // символов в JSON сохранения
const MAX_AUTH_AGE = 3 * 24 * 3600; // initData старше 3 суток не принимаем

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
  const key = `u_${user.id}`;
  const current = await store.get(key, { type: 'json' });

  if (body.action === 'load') {
    return json({ exists: !!current, record: current || null });
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

    const record = {
      rev: curRev + 1,
      state: st,
      extra,
      deviceId: typeof body.deviceId === 'string' ? body.deviceId.slice(0, 64) : null,
      tgId: user.id,
      username: user.username || null,
      firstName: user.first_name || null,
      updatedAt: Date.now()
    };
    await store.setJSON(key, record);
    return json({ ok: true, rev: record.rev });
  }

  return json({ error: 'unknown_action' }, 400);
};
