/* Новые режимы в стиле ОТСКОК / ICE ARENA: ДРОП (plinko) и ПЕНАЛЬТИ.
   Загружается после app.js и использует его глобалы: socket, toast, setBalance,
   currentBalance, initData, handleNotTelegram. Вся математика — на сервере
   (plinko_spin / penalty_spin), клиент только рисует присланный результат. */
(function () {
  "use strict";
  if (typeof socket === "undefined") return;
  const host = document.getElementById("gamesView");
  const list = document.getElementById("gamesList");
  if (!host || !list) return;

  const W = 560, H = 540, DPR = Math.min(window.devicePixelRatio || 1, 2);
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const lerp = (a, b, u) => a + (b - a) * u;
  const easeOut = u => 1 - Math.pow(1 - u, 3);
  const fmtM = v => (Number(v) >= 100 ? Number(v).toFixed(0) : Number(v).toFixed(2).replace(/\.?0+$/, ""));
  const money = v => Number(v || 0).toFixed(2);

  // ---------- звук ----------
  let muted = false, actx = null;
  function audio() {
    const C = window.AudioContext || window.webkitAudioContext;
    if (!C) return null;
    if (!actx) actx = new C();
    if (actx.state === "suspended") actx.resume().catch(() => {});
    return actx;
  }
  function tone(freq, dur, type, vol) {
    if (muted) return;
    const c = audio(); if (!c) return;
    const t = c.currentTime, o = c.createOscillator(), g = c.createGain();
    o.type = type || "sine"; o.frequency.value = freq;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol || 0.1, t + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(c.destination); o.start(t); o.stop(t + dur + 0.02);
  }
  const sfx = {
    tick: i => tone(420 + i * 38, 0.07, "triangle", 0.09),
    kick: () => tone(95, 0.12, "square", 0.11),
    win: () => [523, 659, 784].forEach((f, i) => setTimeout(() => tone(f, 0.18, "sine", 0.12), i * 90)),
    lose: () => tone(160, 0.3, "sawtooth", 0.08)
  };

  // ---------- серверные настройки режимов ----------
  let cfg = null;
  function loadCfg(cb) {
    if (cfg) return cb(cfg);
    socket.emit("solo_modes", null, d => {
      if (d && d.plinko && d.penalty) { cfg = d; cb(cfg); }
      else toast("Не удалось загрузить режимы. Попробуйте ещё раз.");
    });
  }

  // ---------- общий каркас экрана (те же классы, что у ОТСКОКА) ----------
  function makeGame(o) {
    const root = document.createElement("div");
    root.id = o.id + "Game";
    root.className = "bounce-game solo-game hidden";
    root.innerHTML =
      `<div class="bounce-header">
        <button class="upgrade-back bounce-back" type="button">‹ Игры</button>
        <div class="bounce-title">${o.title}</div>
        <button class="bounce-sound" type="button" aria-label="Звук" title="Звук">🔊</button>
      </div>
      <div class="bounce-layout">
        <section class="bounce-stage">
          <canvas class="solo-canvas" aria-label="${o.title}"></canvas>
          <div class="bounce-tag"></div>
        </section>
        <section class="bounce-controls">
          <div class="bounce-tabs"></div>
          <div class="bounce-field-label"><span>Сумма</span><span>0.1 – 50 000</span></div>
          <div class="bounce-amount">
            <button class="sg-dec" type="button">−</button>
            <label class="bounce-input"><span>⭐</span><input class="sg-bet" inputmode="decimal" value="1" aria-label="Сумма ставки"></label>
            <button class="sg-inc" type="button">+</button>
          </div>
          <div class="bounce-quick"></div>
          <div class="sg-extra"></div>
          <button class="bet-button bounce-play" type="button">${o.playText}</button>
          <button class="bet-button bounce-repeat hidden" type="button"></button>
          <button class="bet-button bounce-cash hidden" type="button"></button>
          <div class="bounce-error"></div>
          <div class="bounce-history"></div>
        </section>
      </div>`;
    host.appendChild(root);

    const q = s => root.querySelector(s);
    const el = {
      cv: q("canvas"), tag: q(".bounce-tag"), tabs: q(".bounce-tabs"), quick: q(".bounce-quick"),
      bet: q(".sg-bet"), play: q(".bounce-play"), err: q(".bounce-error"), hist: q(".bounce-history"),
      snd: q(".bounce-sound"), back: q(".bounce-back"), extra: q(".sg-extra"), cash: q(".bounce-cash"), rep: q(".bounce-repeat")
    };
    el.cv.width = W * DPR; el.cv.height = H * DPR;
    const c = el.cv.getContext("2d");
    const g = { mode: 0, bet: 1, phase: "idle", res: null, t0: 0, sel: 2, memo: {}, open: false, count: 1, last: null };
    const hp = k => { if (window.ringHaptic) window.ringHaptic(k); };
    const prefs = window.ringPrefs;
    const savePrefs = () => { if (prefs) prefs.set(o.id, { bet: g.bet, mode: g.mode, count: g.count }); };
    {   // последняя ставка и режим (режим потом обрезается по числу режимов в open())
      const p = prefs && prefs.get(o.id, null);
      if (p) {
        if (Number.isInteger(p.mode) && p.mode >= 0) g.mode = p.mode;
        if (Number(p.bet) >= 0.1) g.bet = Math.min(50000, Math.round(Number(p.bet) * 100) / 100);
        if (Number.isInteger(p.count) && p.count >= 1 && p.count <= 20) g.count = p.count;
      }
    }
    let raf = 0;

    const modes = () => o.modes(cfg);
    const lock = d => {
      root.querySelectorAll(".bounce-controls button, .bounce-controls input").forEach(x => { x.disabled = d; });
      // пока идёт серия (пенальти) ставка и режим зафиксированы, но «бить дальше» / «забрать» доступны
      if (!d && g.open) root.querySelectorAll(".bounce-tabs button, .bounce-quick button, .sg-dec, .sg-inc, .sg-bet, .sg-extra button, .sg-extra input").forEach(x => { x.disabled = true; });
    };
    const shake = () => {
      root.classList.remove("solo-shake"); void root.offsetWidth; root.classList.add("solo-shake");
      setTimeout(() => root.classList.remove("solo-shake"), 520);
      try { window.Telegram?.WebApp?.HapticFeedback?.notificationOccurred("error"); } catch {}
    };

    function readBet() {
      let v = parseFloat(String(el.bet.value).replace(",", "."));
      if (!(v >= 0.1)) v = 0.1;
      return setBet(v);
    }
    function setBet(v) {
      v = Math.max(0.1, Math.min(50000, Math.round(Number(v) * 100) / 100));
      g.bet = v; el.bet.value = v;
      el.quick.querySelectorAll("button[data-v]").forEach(b => b.classList.toggle("on", Number(b.dataset.v) === v));
      return v;
    }
    function renderTabs() {
      el.tabs.innerHTML = modes().map((m, i) =>
        `<button type="button" class="${i === g.mode ? "on" : ""}" data-i="${i}"><b>${m.name}</b><small>${o.tabSub(m)}</small></button>`).join("");
      el.tabs.querySelectorAll("button").forEach(b => b.onclick = () => {
        if (g.phase === "waiting" || g.phase === "play" || g.open) return;
        g.mode = Number(b.dataset.i); g.memo = {}; if (g.phase === "result") { g.phase = "idle"; g.res = null; }
        renderTabs(); renderTag(); savePrefs();
      });
    }
    function renderTag() { el.tag.innerHTML = o.tag(modes()[g.mode], g); }

    // быстрые ставки — как в ОТСКОКЕ
    [["Мин", () => 0.1], ["÷2", () => readBet() / 2], ["×2", () => readBet() * 2], ["Макс", () => Math.min(currentBalance, 50000)]].forEach(([t, f]) => {
      const b = document.createElement("button"); b.type = "button"; b.textContent = t;
      b.onclick = () => setBet(f()); el.quick.append(b);
    });
    el.quick.append(document.createElement("i"));
    [1, 5, 25, 100].forEach(v => {
      const b = document.createElement("button"); b.type = "button"; b.textContent = v; b.dataset.v = v;
      b.onclick = () => setBet(v); el.quick.append(b);
    });
    el.bet.onchange = readBet;
    q(".sg-dec").onclick = () => { const v = readBet(); setBet(v > 1 ? v - 1 : v - 0.1); };
    q(".sg-inc").onclick = () => { const v = readBet(); setBet(v >= 1 ? v + 1 : v + 0.1); };
    el.snd.onclick = () => { muted = !muted; document.querySelectorAll(".solo-game .bounce-sound").forEach(b => { b.textContent = muted ? "🔇" : "🔊"; b.classList.toggle("muted", muted); }); if (!muted) audio(); };

    function syncOpenUI() {
      const open = g.open && o.nextEvt;
      el.cash.classList.toggle("hidden", !open);
      const si = g.streakInfo || g.res;
      if (open && si) {
        el.play.textContent = `Бить дальше ×${fmtM(si.nextMultiplier)}`;
        el.cash.textContent = `Забрать ${money(si.potential)} ⭐ (×${fmtM(si.multiplier)})`;
      } else el.play.textContent = o.playText;
      if (el.rep) {
        const L = g.last, m = L && modes()[L.mode];
        el.rep.classList.toggle("hidden", !m || !!open);
        if (m) el.rep.textContent = `↻ Повторить · ${fmtM(L.bet)}${L.count > 1 ? " × " + L.count : ""} ⭐ · ${m.name}`;
      }
    }
    function reset(msg) {
      g.phase = g.open ? "result" : "idle"; lock(false); syncOpenUI();
      if (el.cash) el.cash.disabled = false;
      if (msg) el.err.textContent = msg;
    }
    function start() {
      if (!initData) return handleNotTelegram();
      if (g.phase === "waiting" || g.phase === "play") return;
      if (g.open && o.nextEvt) {           // серия: следующий удар без новой ставки
        audio(); g.phase = "waiting"; g.res = null; g.memo = {}; el.err.textContent = "";
        lock(true); el.play.textContent = "Отправляем…";
        socket.emit(o.nextEvt, { pick: g.sel });
        return;
      }
      const bet = readBet();
      const total = o.totalBet ? o.totalBet(g, bet) : bet;
      if (total > currentBalance) return toast("Недостаточно Stars на балансе.");
      g.last = { bet, mode: g.mode, count: g.count }; savePrefs(); syncOpenUI();
      audio();
      g.phase = "waiting"; g.res = null; g.memo = {}; el.err.textContent = "";
      lock(true); el.play.textContent = "Отправляем…";
      socket.emit(o.evt, o.payload(g, bet));
    }
    function cashout() {
      if (!g.open || g.phase === "waiting" || g.phase === "play") return;
      g.phase = "waiting"; lock(true); el.cash.disabled = true; el.err.textContent = "";
      socket.emit(o.cashEvt);
    }
    el.cash.onclick = cashout;
    el.play.onclick = start;
    el.rep.onclick = () => {
      const L = g.last;
      if (!L || g.open || g.phase === "waiting" || g.phase === "play") return;
      g.mode = Math.min(L.mode, modes().length - 1); g.count = L.count || 1; g.memo = {};
      if (g.phase === "result") { g.phase = "idle"; g.res = null; }
      renderTabs(); setBet(L.bet); renderTag();
      root.querySelector(".bounce-controls").dispatchEvent(new Event("change", { bubbles: true }));   // обновить доп. блок (шары в ДРОПЕ)
      start();
    };

    socket.on(o.evt.replace("_spin", "_result"), res => {
      if (g.phase !== "waiting") return;
      if (res && res.kind === "cashout") {           // выигрыш забран — без анимации
        g.res = Object.assign({}, g.res || {}, res); g.open = false; g.phase = "result";
        renderTag(); finish(true); return;
      }
      g.res = res; g.t0 = performance.now() / 1000; g.phase = "play"; g.shook = false;
      el.play.textContent = "Идёт раунд…";
      if (o.onStart) o.onStart(g, res);
      startLoop();
    });
    socket.on("error_message", msg => {
      if (g.phase !== "waiting") return;
      if (g.open && /Нет активной серии|Нечего забирать/.test(String(msg || ""))) g.open = false; // серия уже выплачена сервером
      reset();
    });
    socket.on("disconnect", () => {
      if (g.open) { g.open = false; g.phase = "idle"; g.res = null; lock(false); syncOpenUI(); renderTag(); toast("Соединение потеряно — выигрыш серии выплачен автоматически."); return; }
      if (g.phase === "waiting") reset();
    });

    function finish(isCash) {
      const r = g.res;
      g.phase = "result";
      g.open = !!(o.nextEvt && r.canContinue && !r.over);
      g.streakInfo = g.open ? r : null;
      lock(false); syncOpenUI(); el.cash.disabled = false; renderTag();
      if (g.open) {                       // серия продолжается: чип в историю ещё не пишем
        sfx.win(); hp("win"); toast(o.toast(r)); return;
      }
      const chip = document.createElement("span");
      chip.className = "chip " + (r.win ? "w" : "l");
      chip.textContent = fmtM(r.multiplier) + "×";
      el.hist.prepend(chip);
      while (el.hist.children.length > 30) el.hist.lastElementChild.remove();
      if (r.balance != null) setBalance(r.balance);
      if (o.doneEvt) socket.emit(o.doneEvt.name, o.doneEvt.data);   // сообщаем серверу, что раунд закончился
      if (r.win) { sfx.win(); hp("win"); } else { sfx.lose(); if (o.shakeOnLose && !g.shook && !isCash) shake(); else if (!o.shakeOnLose) hp("lose"); }
      toast(o.toast(r));
    }

    function frame(now) {
      if (root.classList.contains("hidden")) { raf = 0; return; }
      const t = now / 1000;
      if (g.phase === "play" && o.shakeAt && o.shakeOnLose && !g.shook && g.res && g.res.over && !g.res.win && t - g.t0 >= o.shakeAt) { g.shook = true; shake(); }
      if (g.phase === "play" && t - g.t0 >= (o.totalFor ? o.totalFor(g.res) : o.total)) finish();
      c.setTransform(DPR, 0, 0, DPR, 0, 0);
      const bg = c.createRadialGradient(W / 2, H * 0.42, 20, W / 2, H * 0.42, 420);
      bg.addColorStop(0, "#220c10"); bg.addColorStop(1, "#070404");
      c.fillStyle = bg; c.fillRect(0, 0, W, H);
      o.draw(g, c, t, modes()[g.mode], cfg);
      raf = requestAnimationFrame(frame);
    }
    function startLoop() { if (!raf) raf = requestAnimationFrame(frame); }

    function open() {
      if (!initData) return handleNotTelegram();
      loadCfg(() => {
        g.phase = "idle"; g.res = null; g.memo = {}; g.mode = Math.min(g.mode, modes().length - 1);
        g.open = false; syncOpenUI();
        if (o.buildExtra && !el.extra.dataset.built) { el.extra.dataset.built = "1"; o.buildExtra(g, el.extra, { setBet, readBet, renderTag }); }
        renderTabs(); renderTag(); setBet(g.bet); lock(false); el.err.textContent = "";
        list.classList.add("hidden"); root.classList.remove("hidden");
        if (o.onOpen) o.onOpen(g, el, cfg);
        startLoop();
      });
    }
    el.back.onclick = () => {
      if (g.phase === "waiting" || g.phase === "play") return toast("Дождитесь окончания раунда.");
      if (g.open) return toast("Сначала заберите выигрыш или продолжайте серию.");
      root.classList.add("hidden"); list.classList.remove("hidden");
    };
    const card = document.getElementById(o.card);
    if (card) card.onclick = open;
    return { root, g, el, renderTag, setBet, readBet };
  }

  // ---------- ДРОП (plinko) ----------
  const PL = { dx: 46, top: 62, rh: 38, cx: W / 2, slotY: 452, slotH: 40, T0: 0.55, TR: 0.34, STAG: 0.18 };
  function slotColor(m) { return m < 1 ? "#ef4b4b" : m < 1.5 ? "#ff1635" : m < 5 ? "#ff1231" : "#3bd47c"; }
  function plinkoNodes(rows, path) {
    const n = []; let R = 0;
    for (let i = 0; i < rows; i++) {
      n.push({ x: PL.cx + (2 * R - i) * PL.dx / 2, y: PL.top + i * PL.rh - 12 });
      R += path[i];
    }
    n.push({ x: PL.cx + (2 * R - rows) * PL.dx / 2, y: PL.slotY + PL.slotH / 2 });
    return n;
  }
  const PL_MAX_BALLS = 20;
  makeGame({
    id: "plinko", title: "ДРОП", card: "openPlinko", evt: "plinko_spin", playText: "Играть",
    doneEvt: { name: "solo_done", data: { key: "plinko" } },
    totalFor: r => 4.7 + Math.max(0, ((r && r.count) || 1) - 1) * PL.STAG,
    total: 4.7,
    modes: cf => cf.plinko.modes,
    tabSub: m => "до " + fmtM(Math.max(...m.mults)) + "×",
    tag: (m, g) => `${m.name}<b>Слоты от ${fmtM(Math.min(...m.mults))}× до ${fmtM(Math.max(...m.mults))}×${g.count > 1 ? " · шаров: " + g.count : ""}</b>`,
    totalBet: (g, bet) => Number((bet * g.count).toFixed(2)),
    payload: (g, bet) => ({ bet, modeIndex: g.mode, count: g.count }),
    toast: r => {
      const n = r.count || 1;
      const head = n > 1 ? `ДРОП · ${n} шаров` : "ДРОП";
      return r.win ? `${head}: ${fmtM(r.multiplier)}× · +${money(r.payout)} ⭐` : `${head}: ${fmtM(r.multiplier)}× · ${money(r.payout)} ⭐`;
    },
    onStart: g => { g.memo = { segs: [], flashes: [] }; },
    buildExtra(g, box, api) {
      const max = Math.min(PL_MAX_BALLS, (cfg && cfg.plinko && cfg.plinko.maxBalls) || PL_MAX_BALLS);
      box.innerHTML = `<div class="bounce-field-label"><span>Шаров за раунд</span><span class="sg-total"></span></div><div class="bounce-quick sg-balls"></div>`;
      const row = box.querySelector(".sg-balls"), tot = box.querySelector(".sg-total");
      const label = box.parentElement.querySelector(".bounce-field-label span");
      if (label) label.textContent = "Ставка на шар";
      const upd = () => {
        row.querySelectorAll("button[data-n]").forEach(b => b.classList.toggle("on", Number(b.dataset.n) === g.count));
        tot.textContent = g.count > 1 ? `Итого: ${money(api.readBet() * g.count)} ⭐` : "";
      };
      const setN = n => { g.count = clamp(Math.round(n), 1, max); upd(); api.renderTag(); };
      const mk = (t, f, n) => { const b = document.createElement("button"); b.type = "button"; b.textContent = t; if (n) b.dataset.n = n; b.onclick = f; row.append(b); };
      mk("−", () => setN(g.count - 1));
      [1, 3, 5, 10, max].forEach(n => mk(String(n), () => setN(n), n));
      mk("+", () => setN(g.count + 1));
      const ctl = box.closest(".bounce-controls");
      ["click", "change", "input"].forEach(ev => ctl.addEventListener(ev, () => setTimeout(upd, 0)));
      upd();
    },
    draw(g, c, t, mode, cf) {
      const rows = cf.plinko.rows, mults = mode.mults;
      // колышки
      for (let i = 0; i < rows; i++) for (let j = 0; j <= i; j++) {
        const x = PL.cx + (2 * j - i) * PL.dx / 2, y = PL.top + i * PL.rh;
        c.fillStyle = "rgba(255,126,143,.55)"; c.beginPath(); c.arc(x, y, 4, 0, 6.2832); c.fill();
      }
      const r = g.res;
      const balls = r ? (r.balls && r.balls.length ? r.balls : [{ path: r.path, slot: r.slot }]) : [];
      const el = g.phase === "play" || g.phase === "result" ? t - g.t0 : -1;
      const fall = PL.T0 + rows * PL.TR;
      const counts = new Array(rows + 1).fill(0);
      if (r) balls.forEach((b, i) => { if (g.phase === "result" || el - i * PL.STAG >= fall) counts[b.slot]++; });
      const allLanded = r && (g.phase === "result" || el - (balls.length - 1) * PL.STAG >= fall);
      // слоты
      for (let k = 0; k <= rows; k++) {
        const x = PL.cx + (2 * k - rows) * PL.dx / 2, col = slotColor(mults[k]);
        const hit = counts[k] > 0;
        c.fillStyle = hit ? col : col + "33"; c.strokeStyle = col;
        c.lineWidth = hit ? 2.5 : 1.2;
        c.beginPath(); c.roundRect(x - 20, PL.slotY, 40, PL.slotH, 8); c.fill(); c.stroke();
        c.font = "800 12px 'Segoe UI',system-ui,sans-serif"; c.textAlign = "center"; c.textBaseline = "middle";
        c.fillStyle = hit ? "#120406" : col; c.fillText(fmtM(mults[k]), x, PL.slotY + PL.slotH / 2 + 1);
        if (counts[k] > 1) { c.fillStyle = "#f6ebed"; c.font = "800 13px 'Segoe UI',system-ui,sans-serif"; c.fillText("×" + counts[k], x, PL.slotY - 9); }
      }
      if (!r || el < 0) return;
      // шарики
      const R = balls.length > 10 ? 6.5 : balls.length > 1 ? 8 : 9;
      (g.memo.flashes || []).forEach(f => {
        const a = 1 - (t - f.at) / 0.4; if (a <= 0) return;
        const gr = c.createRadialGradient(f.x, f.y, 0, f.x, f.y, 16);
        gr.addColorStop(0, `rgba(255,170,60,${a * 0.8})`); gr.addColorStop(1, "rgba(255,51,78,0)");
        c.fillStyle = gr; c.beginPath(); c.arc(f.x, f.y, 16, 0, 6.2832); c.fill();
      });
      balls.forEach((b, i) => {
        const e = el - i * PL.STAG;
        if (e < 0) return;
        const nodes = plinkoNodes(rows, b.path);
        let bx, by;
        if (e < PL.T0) {
          const u = e / PL.T0; bx = PL.cx; by = lerp(16, nodes[0].y, u * u);
        } else {
          const rel = e - PL.T0, seg = clamp(Math.floor(rel / PL.TR), 0, rows - 1);
          const u = clamp((rel - seg * PL.TR) / PL.TR, 0, 1);
          if (rel >= rows * PL.TR) { bx = nodes[rows].x + (((i * 37) % 9) - 4) * 1.6; by = nodes[rows].y - (((i * 13) % 5) - 2) * 2; }
          else {
            bx = lerp(nodes[seg].x, nodes[seg + 1].x, u);
            by = lerp(nodes[seg].y, nodes[seg + 1].y, u) - (seg < rows - 1 ? 13 * Math.sin(Math.PI * u) : 0);
            if (g.memo.segs[i] !== seg) {
              g.memo.segs[i] = seg;
              g.memo.flashes.push({ x: nodes[seg].x, y: nodes[seg].y + 12, at: t });
              if (i === 0) sfx.tick(seg);
            }
          }
        }
        const hg = c.createRadialGradient(bx, by, R * 0.5, bx, by, R * 2.3);
        hg.addColorStop(0, "rgba(255,31,61,.5)"); hg.addColorStop(1, "rgba(255,31,61,0)");
        c.fillStyle = hg; c.beginPath(); c.arc(bx, by, R * 2.3, 0, 6.2832); c.fill();
        const sg = c.createRadialGradient(bx - 3, by - 4, 1, bx, by, R);
        sg.addColorStop(0, "#efdee1"); sg.addColorStop(0.35, "#ff5269"); sg.addColorStop(1, "#e7102d");
        c.fillStyle = sg; c.beginPath(); c.arc(bx, by, R, 0, 6.2832); c.fill();
      });
      if (g.memo.flashes.length > 120) g.memo.flashes.splice(0, g.memo.flashes.length - 120);
      // итог
      if (allLanded) {
        c.font = "800 26px 'Segoe UI',system-ui,sans-serif"; c.textAlign = "center";
        c.fillStyle = r.win ? "#3bd47c" : "#ef4b4b"; c.shadowColor = "#000"; c.shadowBlur = 10;
        const n = r.count || 1;
        c.fillText(`${n > 1 ? n + " шаров · " : ""}${fmtM(r.multiplier)}×  ·  ${money(r.payout)} ⭐`, PL.cx, H - 22); c.shadowBlur = 0;
      }
    }
  });

  // ---------- ПЕНАЛЬТИ ----------
  const puckImg = new Image(); let puckOK = false;
  puckImg.onload = () => { puckOK = true; }; puckImg.src = "/assets/puck.svg";
  const GL = { x0: 40, x1: 520, y0: 80, y1: 290, spotY: 460 };
  const zoneW = z => (GL.x1 - GL.x0) / z;
  const zoneCx = (i, z) => GL.x0 + zoneW(z) * (i + 0.5);
  function drawPuck(c, x, y, s, rot) {
    c.save(); c.translate(x, y); c.rotate(rot); c.scale(s, s);
    if (puckOK) c.drawImage(puckImg, -18, -18, 36, 36);
    else {
      const gr = c.createRadialGradient(-4, -5, 1, 0, 0, 18);
      gr.addColorStop(0, "#5a5a5a"); gr.addColorStop(1, "#111");
      c.fillStyle = gr; c.strokeStyle = "#ff1635"; c.lineWidth = 3;
      c.beginPath(); c.arc(0, 0, 16, 0, 6.2832); c.fill(); c.stroke();
    }
    c.restore();
  }
  makeGame({
    id: "penalty", title: "ПЕНАЛЬТИ", card: "openPenalty", evt: "penalty_spin", playText: "Бить!",
    total: 3.4,
    nextEvt: "penalty_next", cashEvt: "penalty_cashout",   // серия ударов, как в «Башне»
    shakeOnLose: true, shakeAt: 1.35,                      // лёгкая тряска экрана при проигрыше
    modes: cf => cf.penalty.modes,
    tabSub: m => `×${fmtM(m.mult)} · ${Math.round(m.chance * 100)}%`,
    tag: (m, g) => (g.open && g.streakInfo)
      ? `${m.name}<b>Серия: ${g.streakInfo.streak} · сейчас ×${fmtM(g.streakInfo.multiplier)} → дальше ×${fmtM(g.streakInfo.nextMultiplier)}</b>`
      : `${m.name}<b>Гол ×${fmtM(m.mult)} · защита закрывает ${m.covered} из 5 · можно бить дальше</b>`,
    payload: (g, bet) => ({ bet, modeIndex: g.mode, pick: g.sel }),
    toast: r => {
      if (r.kind === "cashout") return `ПЕНАЛЬТИ: забрал ${money(r.payout)} ⭐ (×${fmtM(r.multiplier)})`;
      if (r.saved) return "ПЕНАЛЬТИ: отбил — ставка проиграна";
      if (r.canContinue) return `ГОЛ! Серия ${r.streak} · ×${fmtM(r.multiplier)} — бить дальше или забрать`;
      return `ПЕНАЛЬТИ: серия ${r.streak} · +${money(r.payout)} ⭐`;
    },
    onStart: () => sfx.kick(),
    onOpen(g, el) {
      if (el.cv.dataset.bound) return;
      el.cv.dataset.bound = "1";
      el.cv.addEventListener("pointerdown", e => {
        if (g.phase === "waiting" || g.phase === "play") return;
        const r = el.cv.getBoundingClientRect();
        const x = (e.clientX - r.left) * W / r.width, y = (e.clientY - r.top) * H / r.height;
        if (x < GL.x0 || x > GL.x1 || y < GL.y0 - 20 || y > GL.y1 + 20) return;
        const z = cfg.penalty.zones;
        g.sel = clamp(Math.floor((x - GL.x0) / zoneW(z)), 0, z - 1);
        if (g.phase === "result") { g.phase = "idle"; g.res = null; }   // g.streakInfo хранит состояние серии
      });
    },
    draw(g, c, t, mode, cf) {
      const Z = cf.penalty.zones, zw = zoneW(Z);
      const el = g.res && (g.phase === "play" || g.phase === "result") ? (g.phase === "result" ? 99 : t - g.t0) : -1;
      const reveal = el >= 1.3, r = g.res;
      // сетка ворот
      c.strokeStyle = "rgba(255,255,255,.06)"; c.lineWidth = 1; c.beginPath();
      for (let x = GL.x0; x <= GL.x1; x += 24) { c.moveTo(x, GL.y0); c.lineTo(x, GL.y1); }
      for (let y = GL.y0; y <= GL.y1; y += 24) { c.moveTo(GL.x0, y); c.lineTo(GL.x1, y); }
      c.stroke();
      // зоны
      for (let i = 0; i < Z; i++) {
        const x = GL.x0 + i * zw, picked = (r ? r.pick : g.sel) === i, cov = reveal && r.covered.includes(i);
        let fill = "rgba(255,255,255,.03)";
        if (reveal) fill = cov ? "rgba(239,75,75,.28)" : (picked ? "rgba(59,212,124,.30)" : "rgba(255,255,255,.03)");
        else if (picked) fill = "rgba(255,22,53,.16)";
        c.fillStyle = fill; c.fillRect(x + 2, GL.y0 + 2, zw - 4, GL.y1 - GL.y0 - 2);
        if (picked && !reveal) { c.strokeStyle = "#ff1635"; c.lineWidth = 2.5; c.shadowColor = "#ff1635"; c.shadowBlur = 12; c.strokeRect(x + 3, GL.y0 + 3, zw - 6, GL.y1 - GL.y0 - 4); c.shadowBlur = 0; }
        if (cov) { c.font = "800 15px 'Segoe UI',system-ui,sans-serif"; c.textAlign = "center"; c.fillStyle = "#ef4b4b"; c.fillText("ЗАКРЫТО", x + zw / 2, (GL.y0 + GL.y1) / 2); }
      }
      // штанги
      c.strokeStyle = "#f2f2f2"; c.lineWidth = 6; c.lineCap = "round"; c.beginPath();
      c.moveTo(GL.x0, GL.y1); c.lineTo(GL.x0, GL.y0); c.lineTo(GL.x1, GL.y0); c.lineTo(GL.x1, GL.y1); c.stroke();
      // вратарь качается, пока не открыты зоны
      if (!reveal) {
        const gx = PL.cx + Math.sin(t * 1.7) * (GL.x1 - GL.x0) * 0.32, gy = GL.y0 + 78;
        c.fillStyle = "#171112"; c.strokeStyle = "#ff1635"; c.lineWidth = 3;
        c.beginPath(); c.roundRect(gx - 30, gy - 8, 60, 96, 16); c.fill(); c.stroke();
        c.beginPath(); c.arc(gx, gy - 24, 17, 0, 6.2832); c.fill(); c.stroke();
        c.fillStyle = "#ff1635"; c.fillRect(gx - 22, gy + 28, 44, 5);
      }
      // ледовая точка
      c.strokeStyle = "rgba(255,22,53,.25)"; c.lineWidth = 2; c.beginPath(); c.arc(PL.cx, GL.spotY, 30, 0, 6.2832); c.stroke();
      // шайба
      const pick = r ? r.pick : g.sel, tx = zoneCx(pick, Z), ty = (GL.y0 + GL.y1) / 2;
      if (el < 0.35) {
        const wob = el < 0 ? 0 : Math.sin(el * 60) * 2;
        drawPuck(c, PL.cx + wob, GL.spotY, 1, 0);
      } else if (el < 1.15) {
        const u = easeOut((el - 0.35) / 0.8);
        drawPuck(c, lerp(PL.cx, tx, u), lerp(GL.spotY, ty + 20, u), lerp(1, 0.6, u), u * 14);
      } else drawPuck(c, tx, ty + 20, 0.6, 14);
      // итог
      if (el >= 1.5 && r) {
        c.textAlign = "center"; c.shadowColor = "#000"; c.shadowBlur = 12;
        c.font = "800 34px 'Segoe UI',system-ui,sans-serif";
        let head, sub, col = "#3bd47c";
        if (r.kind === "cashout") { head = "ЗАБРАЛ!"; sub = `×${fmtM(r.multiplier)} · +${money(r.payout)} ⭐`; }
        else if (r.saved) { head = "ОТБИЛ!"; sub = r.streak > 0 ? "Серия прервана, ставка проиграна" : "Ставка проиграна"; col = "#ef4b4b"; }
        else if (r.canContinue) { head = `ГОЛ! Серия ${r.streak}`; sub = `×${fmtM(r.multiplier)} · бей дальше ×${fmtM(r.nextMultiplier)} или забирай`; }
        else { head = "ГОЛ!"; sub = `×${fmtM(r.multiplier)} · +${money(r.payout)} ⭐`; }
        c.fillStyle = col; c.fillText(head, PL.cx, 370);
        c.font = "700 19px 'Segoe UI',system-ui,sans-serif";
        c.fillText(sub, PL.cx, 402);
        c.shadowBlur = 0;
      } else if (el < 0 || g.phase === "idle") {
        c.textAlign = "center"; c.font = "600 13px 'Segoe UI',system-ui,sans-serif"; c.fillStyle = "#8f7d6a";
        c.fillText(g.open ? `Серия ${g.streakInfo ? g.streakInfo.streak : ""}: выбери зону и бей дальше или забери выигрыш` : "Нажмите на зону ворот, куда бить", PL.cx, 370);
      }
    }
  });
})();
