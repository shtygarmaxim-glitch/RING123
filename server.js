const express = require('express'), http = require('http'), crypto = require('crypto');
const fs = require('fs'), path = require('path');
const { WebSocketServer } = require('ws');

const BOT_TOKEN = process.env.BOT_TOKEN || '';
const APP_URL = process.env.APP_URL || process.env.RENDER_EXTERNAL_URL || '';
const ADMIN_ID = String(process.env.ADMIN_ID || '618124780');
const DATA_FILE = path.join(process.env.DATA_DIR || __dirname, 'data.json');
// Шайба у клиента визуально останавливается через 500 (задержка старта) + 4100 (появление/прицел) + 7000 (полёт) = 11600мс
// после броадкаста 'running'. Начисляем баланс и обновляем историю ещё через ~2с после этого, чтобы не обгонять анимацию.
// Аномалия "redo" на клиенте играет два полных пролёта подряд (каждый — интро+7с полёта) — для неё отдельный, больший таймер.
const COUNTDOWN = 10000, CLOSE = 1000, RUN_MS = 13600, RUN_MS_REDO = 26000, RESULT_MS = 4500;
const COLORS = ['#ffc61a', '#ff8a1f', '#f4c430', '#e8720c', '#ffe066', '#d4a017', '#ff7f11', '#ffb347'];
const r3 = x => Math.round(x * 1000) / 1000;

let users = {};
const ensureDir = f => { try { fs.mkdirSync(path.dirname(f), { recursive: true }); } catch (e) {} };
ensureDir(DATA_FILE);
try { users = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch (e) {}
const HIST_FILE = path.join(process.env.DATA_DIR || __dirname, 'history.json');
let history = [];
try { history = JSON.parse(fs.readFileSync(HIST_FILE, 'utf8')); } catch (e) {}
let roundSeq = (history[0] && history[0].id ? history[0].id : 0) + 1;
console.log(`История: ${history.length} игр загружено из ${HIST_FILE} (DATA_DIR=${process.env.DATA_DIR || 'не задан — файлы сбросятся при следующем деплое/рестарте'})`);
function saveHistory() { try { fs.writeFileSync(HIST_FILE, JSON.stringify(history)); } catch (e) { console.error('saveHistory failed', e); } }
const histMsg = () => ({ t: 'history', last: history[0] || null, top: history.reduce((b, g) => (!b || g.pool > b.pool ? g : b), null), list: history.slice(0, 30) });
let saveT = null;
function save() {
  clearTimeout(saveT);
  saveT = setTimeout(() => { try { fs.writeFileSync(DATA_FILE, JSON.stringify(users)); } catch (e) { console.error(e); } }, 300);
}

function checkInit(initData) {
  if (!BOT_TOKEN || !initData) return null;
  const p = new URLSearchParams(initData), hash = p.get('hash');
  if (!hash) return null;
  p.delete('hash');
  const str = [...p.entries()].map(([k, v]) => k + '=' + v).sort().join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  const h = crypto.createHmac('sha256', secret).update(str).digest('hex');
  if (h !== hash) return null;
  if (Date.now() / 1000 - Number(p.get('auth_date')) > 86400) return null;
  try { return JSON.parse(p.get('user')); } catch (e) { return null; }
}

// ---------- Telegram-бот: ответ на /start ----------
// Отдельный от WebSocket-сервера цикл long polling: спрашивает у Telegram новые сообщения
// и на любое "/start" присылает кнопку "Зайти в игру", которая открывает Web App.
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function tgApi(method, body) {
  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {})
  });
  return res.json();
}
async function botLoop() {
  if (!BOT_TOKEN) return console.log('BOT_TOKEN не задан — команда /start не будет отвечать');
  if (!APP_URL) console.log('APP_URL не задан — кнопка "Зайти в игру" будет без ссылки, задай переменную окружения APP_URL');
  await tgApi('deleteWebhook', {}).catch(() => {}); // на случай, если раньше был включён webhook — иначе getUpdates не будет получать апдейты
  let offset = 0;
  while (true) {
    let upd;
    try { upd = await tgApi('getUpdates', { offset, timeout: 50 }); }
    catch (e) { console.error('getUpdates error', e); await sleep(3000); continue; }
    if (!upd || !upd.ok) { await sleep(3000); continue; }
    for (const u of upd.result) {
      offset = u.update_id + 1;
      const msg = u.message;
      if (msg && msg.text && msg.text.startsWith('/start')) {
        tgApi('sendMessage', {
          chat_id: msg.chat.id,
          text: '\u2063',
          reply_markup: { inline_keyboard: [[{ text: 'Зайти в игру', web_app: { url: APP_URL || 'https://example.com' } }]] }
        }).catch(e => console.error('sendMessage error', e));
      }
    }
  }
}
function startBot() { botLoop().catch(e => { console.error('bot loop crashed, restarting in 5s', e); setTimeout(startBot, 5000); }); }

// ---------- честная игра (commit-reveal) ----------
// seed выбирается и хешируется ДО того, как известны ставки; хеш публикуется сразу,
// сам seed раскрывается только когда приём ставок уже закрыт. Победитель выбирается
// детерминированно по seed, так что каждый может пересчитать результат — это и есть "Legit check".
function rng(a) { return function () { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
const sha256 = s => crypto.createHash('sha256').update(String(s)).digest('hex');

// ---------- раунд ----------
// Аномалии (все чисто визуальные — на выбор победителя и выплаты не влияют, он всегда решается pickWinner()):
// "race" — зоны едут вверх конвейером; "mirage" — весь экран "плывёт" (жидкое искажение через SVG-фильтр);
// "redo" — шайба долетает до случайной точки и как будто замирает, победитель ещё не объявлен, затем
// с этого же места запускается заново (повтор прицеливания) и уже второй раз останавливается в зоне победителя.
// Суммарный шанс аномалии на раунд — 20%, распределён по весам ниже. Админ может форсировать
// конкретную аномалию на следующий раунд — тогда рандом не кидается.
const ANOMALY_WEIGHTS = { race: 0.08, mirage: 0.06, redo: 0.06 };
const ANOMALY_KEYS = Object.keys(ANOMALY_WEIGHTS);
const ANOMALY_NAMES = { race: 'Гонка', mirage: 'Мираж', redo: 'Дубль' };
function rollAnomaly() {
  const r = Math.random(); let acc = 0;
  for (const k of ANOMALY_KEYS) { acc += ANOMALY_WEIGHTS[k]; if (r < acc) return k; }
  return null;
}
let pendingAnomaly = null; // форс от админа на СЛЕДУЮЩИЙ вызов newRound()
let round, timer;
function newRound() {
  const seed = crypto.randomInt(0, 2 ** 31);
  const anomaly = pendingAnomaly || rollAnomaly();
  pendingAnomaly = null;
  return { id: roundSeq++, status: 'waiting', players: [], endsAt: 0, startAt: 0, seed, hash: sha256(seed), winnerId: null, anomaly };
}
round = newRound();

function spot() {
  let best = [50, 50], bd = -1;
  for (let k = 0; k < 40; k++) {
    const x = 10 + Math.random() * 80, y = 10 + Math.random() * 80;
    const d = round.players.reduce((m, o) => Math.min(m, (o.sx - x) ** 2 + (o.sy - y) ** 2), 1e9);
    if (d > bd) { bd = d; best = [x, y]; }
  }
  return best;
}

function bet(u, amt) {
  amt = Number(amt);
  if (!Number.isInteger(amt) || amt < 1) return 'Ставка — целое число от 1 ⭐ (1, 2, 3…)';
  if (amt > u.balance) return 'Недостаточно средств на балансе';
  if (round.status === 'running' || round.status === 'result') return 'Раунд уже идёт';
  if (round.status === 'countdown' && Date.now() > round.endsAt - CLOSE) return 'Приём ставок закрыт';
  u.balance = r3(u.balance - amt);
  let p = round.players.find(x => x.id === u.id);
  if (!p) {
    const [sx, sy] = spot();
    p = { id: u.id, name: u.name, photo: u.photo, stake: 0, color: COLORS[round.players.length % COLORS.length], sx, sy };
    round.players.push(p);
  }
  p.stake = r3(p.stake + amt);
  if (round.status === 'waiting' && round.players.length >= 2) {
    round.status = 'countdown';
    round.endsAt = Date.now() + COUNTDOWN;
    timer = setTimeout(startRun, COUNTDOWN);
  }
  save(); sendMe(u.id); broadcast();
  return null;
}

function pickWinner() {
  // Тот же алгоритм должен быть пересчитан клиентом при проверке (Legit check).
  const pool = r3(round.players.reduce((s, p) => s + p.stake, 0));
  let x = rng(round.seed)() * pool, w = round.players[0];
  for (const p of round.players) { if (x < p.stake) { w = p; break; } x -= p.stake; }
  return w;
}

function startRun() {
  const w = pickWinner();
  round.status = 'running';
  round.winnerId = w.id;
  round.startAt = Date.now() + 500;
  broadcast();
  timer = setTimeout(finish, round.anomaly === 'redo' ? RUN_MS_REDO : RUN_MS);
}

function finish() {
  const pool = r3(round.players.reduce((s, p) => s + p.stake, 0));
  const w = users[round.winnerId];
  if (w) w.balance = r3(w.balance + pool);
  const wp = round.players.find(p => p.id === round.winnerId) || {};
  history.unshift({
    id: round.id, ts: Date.now(), pool, winnerId: round.winnerId, name: wp.name || '', photo: wp.photo || '', color: wp.color || '#ffc61a',
    seed: round.seed, hash: round.hash, anomaly: round.anomaly || null,
    players: round.players.map(p => ({ id: p.id, name: p.name, photo: p.photo, color: p.color, stake: p.stake }))
  });
  if (history.length > 200) history.length = 200;
  saveHistory(); broadcastHistory();
  round.status = 'result';
  save(); broadcast();
  round.players.forEach(p => sendMe(p.id));
  timer = setTimeout(() => { round = newRound(); broadcast(); }, RESULT_MS);
}

// ---------- сеть ----------
const app = express();
app.use(express.static(path.join(__dirname, 'public'), { etag: false, lastModified: false, setHeaders: r => r.setHeader('Cache-Control', 'no-store') }));
app.get('/health', (_, res) => res.send('ok'));
const server = http.createServer(app);
const wss = new WebSocketServer({ server });
const clients = new Map(); // ws -> userId

const send = (ws, m) => { if (ws.readyState === 1) ws.send(JSON.stringify(m)); };
function stateMsg() {
  const revealed = round.status === 'running' || round.status === 'result';
  // anomaly скрыт от клиента, пока раунд не перешёл в running (т.е. пока приём ставок не закрыт) —
  // иначе он был бы виден заранее и спойлерил бы, какая аномалия сейчас выпадет.
  return { t: 'state', now: Date.now(), online: clients.size, id: round.id, status: round.status, endsAt: round.endsAt,
    startAt: round.startAt, hash: round.hash, seed: revealed ? round.seed : null, winnerId: round.winnerId, anomaly: revealed ? (round.anomaly || null) : null,
    players: round.players.map(p => ({ id: p.id, name: p.name, photo: p.photo, stake: p.stake, color: p.color, sx: p.sx, sy: p.sy })) };
}
function broadcastHistory() { const m = histMsg(); for (const ws of clients.keys()) send(ws, m); }
function broadcast() { const m = stateMsg(); for (const ws of clients.keys()) send(ws, m); }
function meMsg(id) { const u = users[id]; return { t: 'me', admin: id === ADMIN_ID, user: { id: u.id, name: u.name, photo: u.photo, balance: u.balance } }; }
function sendMe(id) { for (const [ws, uid] of clients) if (uid === id) send(ws, meMsg(id)); }
const userList = () => Object.values(users).map(u => ({ id: u.id, name: u.name, balance: u.balance }));

wss.on('connection', ws => {
  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw); } catch (e) { return; }
    if (m.t === 'auth') {
      const tu = checkInit(m.initData);
      if (!tu) return send(ws, { t: 'err', fatal: true, msg: 'Откройте приложение через Telegram' });
      const id = String(tu.id);
      const name = [tu.first_name, tu.last_name].filter(Boolean).join(' ') || tu.username || id;
      const u = users[id] || (users[id] = { id, balance: 0 });
      u.name = name; u.photo = tu.photo_url || ''; save();
      clients.set(ws, id);
      send(ws, meMsg(id)); send(ws, histMsg()); broadcast();
      return;
    }
    const id = clients.get(ws); if (!id) return;
    const u = users[id];
    if (m.t === 'bet') { const e = bet(u, m.amount); if (e) send(ws, { t: 'err', msg: e }); }
    else if (id === ADMIN_ID && m.t === 'admin_users') send(ws, { t: 'users', list: userList() });
    else if (id === ADMIN_ID && m.t === 'admin_give') {
      const target = users[String(m.userId).trim()], amt = r3(Number(m.amount));
      if (!target) return send(ws, { t: 'err', msg: 'Пользователь не найден (он должен хотя бы раз открыть приложение)' });
      if (!Number.isFinite(amt) || amt === 0) return send(ws, { t: 'err', msg: 'Неверная сумма' });
      target.balance = Math.max(0, r3(target.balance + amt));
      save(); sendMe(target.id);
      send(ws, { t: 'ok', msg: `${target.name}: баланс ${target.balance} ⭐` });
      send(ws, { t: 'users', list: userList() });
    }
    else if (id === ADMIN_ID && m.t === 'admin_force_anomaly') {
      const key = ANOMALY_KEYS.includes(m.anomaly) ? m.anomaly : null;
      if (round.status === 'waiting' || round.status === 'countdown') { round.anomaly = key; broadcast(); }
      else pendingAnomaly = key;
      const when = (round.status === 'waiting' || round.status === 'countdown') ? 'в этом раунде' : 'в следующем раунде';
      send(ws, { t: 'ok', msg: key ? `Аномалия «${ANOMALY_NAMES[key]}» будет ${when}` : 'Форс аномалии снят' });
    }
  });
  ws.on('close', () => { clients.delete(ws); broadcast(); });
});

server.listen(process.env.PORT || 3000, () => console.log('Ice Arena on', process.env.PORT || 3000));
startBot();
