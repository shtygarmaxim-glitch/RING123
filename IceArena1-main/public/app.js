const tg = window.Telegram?.WebApp;
if (tg) {
  tg.ready();
  tg.expand();
  tg.setHeaderColor("#111315");
  tg.setBackgroundColor("#111315");
}

const socket = io({ transports: ["websocket", "polling"], reconnection: true, reconnectionAttempts: Infinity, timeout: 8000 });
const $ = (s) => document.querySelector(s);
const initData = tg?.initData || "";
const user = tg?.initDataUnsafe?.user || null;
const queryParams = new URLSearchParams(location.search);
const startParam = tg?.initDataUnsafe?.start_param || queryParams.get("ref") || "";

// Lightweight client fingerprint used only as an anti-abuse signal. The
// server stores only a keyed hash and never persists the raw device values.
async function buildClientFingerprint() {
  // A stable random browser/WebView key is the strongest local signal we can
  // get from a Telegram Mini App without accessing private device identifiers.
  // Unlike a plain User-Agent/screen fingerprint, this does not mark every
  // player on the same phone model as a multi-account.
  let deviceKey = '';
  try {
    deviceKey = localStorage.getItem('ring_device_key') || '';
    if (!deviceKey) {
      deviceKey = window.crypto?.randomUUID
        ? window.crypto.randomUUID()
        : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
      localStorage.setItem('ring_device_key', deviceKey);
    }
  } catch {}

  const parts = [
    deviceKey,
    tg?.platform || '',
    navigator.userAgent || '',
    navigator.language || '',
    Intl.DateTimeFormat().resolvedOptions().timeZone || '',
    String(screen?.width || ''), String(screen?.height || ''),
    String(window.devicePixelRatio || ''),
    String(navigator.maxTouchPoints || '')
  ];
  const raw = parts.join('|');
  try {
    if (window.crypto?.subtle) {
      const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw));
      return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2,'0')).join('');
    }
  } catch {}
  let h1 = 2166136261, h2 = 16777619;
  for (let i = 0; i < raw.length; i++) {
    h1 ^= raw.charCodeAt(i); h1 = Math.imul(h1, 16777619);
    h2 ^= raw.charCodeAt(i) + i; h2 = Math.imul(h2, 2246822519);
  }
  return (h1 >>> 0).toString(16).padStart(8,'0') + (h2 >>> 0).toString(16).padStart(8,'0');
}
const clientFingerprintPromise = buildClientFingerprint();
async function securityHeaders(extra = {}) {
  const fp = await clientFingerprintPromise;
  return { ...extra, 'X-Client-Fingerprint': fp, 'X-Telegram-Platform': String(tg?.platform || '') };
}
const raffleFromUrl = queryParams.get("raffle") || (startParam.match(/^rg_([0-9a-f-]{36})_\d+$/i)?.[1] || startParam.match(/^raffle_([0-9a-f-]{36})$/i)?.[1] || "");

let lastWinner = null;
let lastSpinTarget = null;
let currentState = null;
let previousStatus = null;
let currentBalance = 0;
let isAdmin = false;

const betModal = $("#betModal");
const topupModal = $("#topupModal");
const withdrawModal = $("#withdrawModal");
const freebetModal = $("#freebetModal");
const taskCreateModal = $("#taskCreateModal");
let clientMaintenance = false;
let withdrawCurrency = "STAR";
let topupCurrency = "STAR";
let GRAM_USD_PER_STAR = Number(window.__RING_GRAM_USD_PER_STAR || 0.015);
let tonConnectUI = null;
let tonWalletAddress = "";

const TOAST_ICONS = { success: "\u2713", error: "\u2715", warn: "!", info: "i" };
function toastKind(text) {
  const s = String(text || "").toLowerCase();
  if (/ошибк|не удалось|потеряно|заблокирован|отменена|недоступн|не подтвердил|проигрыш|отклонен/.test(s)) return "error";
  if (/недостаточно|введите|укажите|должн|дождитесь|сначала|откройте|только для|уже |закрыт|временно/.test(s)) return "warn";
  if (/принят|создан|скопир|отправлен|выполнен|зачисл|снят|запущен|победител|вошёл|выигр|\+\d/.test(s)) return "success";
  return "info";
}
// toast(message[, "success" | "error" | "warn" | "info"]) — тип определяется автоматически, если не указан.
function toast(message, type) {
  const el = $("#toast");
  if (!el) return;
  const text = String(message ?? "");
  if (!el._built) {
    el.innerHTML = '<span class="toast-ic"></span><span class="toast-msg"></span><i class="toast-bar"></i>';
    el.setAttribute("role", "status");
    el.setAttribute("aria-live", "polite");
    el.onclick = () => el.classList.remove("show");
    el._built = true;
  }
  const kind = TOAST_ICONS[type] ? type : toastKind(text);
  el.className = "toast t-" + kind;
  void el.offsetWidth; // перезапуск анимации при быстрой смене сообщений
  el.querySelector(".toast-ic").textContent = TOAST_ICONS[kind];
  el.querySelector(".toast-msg").textContent = text;
  const ms = Math.max(2400, Math.min(5200, 1400 + text.length * 45));
  el.style.setProperty("--dur", ms + "ms");
  el.classList.add("show");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove("show"), ms);
}
var lastPvpRoomState = null;
function openModal(el) { el.classList.remove("hidden"); }
function closeModal(el) { el.classList.add("hidden"); }

function showFreebetPopup(data) {
  const bonus = Number(data?.bonus || 0);
  const wager = Number(data?.wager || 0);
  $("#freebetAmount").textContent = `+${bonus.toFixed(0)} ⭐`;
  $("#freebetInfo").textContent = wager > 0
    ? `Фрибет зачислен на баланс. Вагер: x${wager}. Перед выводом нужно отыграть ${Math.round(bonus * wager)} ⭐.`
    : "Фрибет зачислен на баланс без обязательного вагера.";
  openModal(freebetModal);
}

let freebetClaimAttempted = false;
async function claimFreebetFromStartParam() {
  const token = String(startParam || "").trim();
  if (!/^fb_[0-9a-f-]{36}$/i.test(token) || freebetClaimAttempted || !initData) return;
  freebetClaimAttempted = true;
  try {
    const r = await fetch("/api/freebets/claim", {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ token })
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || "Не удалось активировать фрибет.");
    setBalance(data.balance);
    if (data.claimed) showFreebetPopup(data);
    else if (data.alreadyClaimed) toast("Ты уже активировал этот фрибет.");
  } catch (e) {
    // A claimed/expired link should not block opening the rest of the Mini App.
    toast(e.message || "Не удалось активировать фрибет.");
  }
}

function authHeaders(extra = {}) {
  return { ...extra, "X-Telegram-Init-Data": initData };
}

function setMaintenanceOverlay(enabled, message = "") {
  clientMaintenance = !!enabled;
  const overlay = $("#maintenanceOverlay");
  if (!overlay) return;
  overlay.classList.toggle("hidden", !clientMaintenance);
  if (message) $("#maintenanceOverlay .maintenance-text").textContent = message;
  ["topupBtn", "betBtn", "withdrawBtn", "openCreateRaffle", "openUpgrade", "openBounce", "openIceArena", "openPlinko", "openPenalty", "openCreateTask"].forEach(id => {
    const el = $("#" + id);
    if (el) el.disabled = clientMaintenance;
  });
}

async function loadMaintenanceStatus() {
  try {
    const r = await fetch("/api/system/status", { headers: authHeaders(), cache: "no-store" });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || "Не удалось получить статус приложения.");
    isAdmin = !!data.isAdmin;
    setMaintenanceOverlay(!!data.maintenance && !isAdmin, data.message || "");
    return data;
  } catch (e) {
    console.warn("Maintenance status failed:", e.message);
    return { maintenance: false, isAdmin };
  }
}

function setBalance(value) {
  currentBalance = Number(value || 0);
  $("#balance").textContent = currentBalance.toFixed(2);
  $("#modalBalance").textContent = currentBalance.toFixed(2) + " ⭐";
  const bounceBalance = $("#bounceBalance");
  if (bounceBalance) bounceBalance.textContent = currentBalance.toFixed(2);
}

function handleNotTelegram() {
  if (!tg || !initData) {
    toast("Откройте Mini App из Telegram.");
  }
}

let supportBotUrl = "";
async function loadSupportBotUrl() {
  try {
    const r = await fetch("/api/support/config", { cache: "no-store" });
    const data = await r.json().catch(() => ({}));
    if (r.ok && data?.url) supportBotUrl = String(data.url);
  } catch {}
}

function openSupportBot() {
  const url = supportBotUrl;
  if (!url) return toast("Поддержка пока недоступна.");
  try { tg?.openTelegramLink ? tg.openTelegramLink(url) : window.open(url, "_blank"); } catch { window.open(url, "_blank"); }
}

const supportBtn = $("#supportBtn");
if (supportBtn) supportBtn.onclick = openSupportBot;
loadSupportBotUrl();

$("#betBtn").onclick = () => {
  if (!initData) return handleNotTelegram();
  if (currentState?.status === "SPINNING" || currentState?.status === "RESULT") return toast("Ставки уже закрыты.");
  $("#betAmount").value = "";
  $("#modalBalance").textContent = currentBalance.toFixed(2) + " ⭐";
  openModal(betModal);
};

$("#modalClose").onclick = () => closeModal(betModal);
$("#topupBtn").onclick = () => {
  if (!initData) return handleNotTelegram();
  openModal(topupModal);
};
$("#topupClose").onclick = () => closeModal(topupModal);

function updateGramConversion(inputSelector, outputSelector) {
  const amount = Number($(inputSelector)?.value || 0);
  const dollars = Math.max(0, amount) * GRAM_USD_PER_STAR;
  $(outputSelector).textContent = `Эквивалент GRAM: ≈ $${dollars.toFixed(2)}`;
}

function setTopupCurrency(currency) {
  topupCurrency = String(currency).toUpperCase() === "GRAM" ? "GRAM" : "STAR";
  $("#topupCurrencyStar").classList.toggle("active", topupCurrency === "STAR");
  $("#topupCurrencyGram").classList.toggle("active", topupCurrency === "GRAM");
  $("#starsTopupPanel").classList.toggle("hidden", topupCurrency !== "STAR");
  $("#gramTopupPanel").classList.toggle("hidden", topupCurrency !== "GRAM");
  updateGramConversion("#gramTopupAmount", "#gramTopupConvert");
}

function setWithdrawCurrency(currency) {
  withdrawCurrency = String(currency).toUpperCase() === "GRAM" ? "GRAM" : "STAR";
  $("#withdrawCurrencyStar").classList.toggle("active", withdrawCurrency === "STAR");
  $("#withdrawCurrencyGram").classList.toggle("active", withdrawCurrency === "GRAM");
  $("#withdrawConvert").classList.toggle("hidden", withdrawCurrency !== "GRAM");
  $("#withdrawWalletRow").classList.toggle("hidden", withdrawCurrency !== "GRAM");
  $("#withdrawAmount").placeholder = "Сумма в Stars…";
  updateGramConversion("#withdrawAmount", "#withdrawConvert");
}

$("#gramTopupAmount").addEventListener("input", () => updateGramConversion("#gramTopupAmount", "#gramTopupConvert"));
$("#withdrawAmount").addEventListener("input", () => updateGramConversion("#withdrawAmount", "#withdrawConvert"));

async function initTonConnect() {
  const fallback = $("#tonConnectFallback");
  const status = $("#tonWalletStatus");
  const root = $("#tonConnectButton");
  if (fallback) fallback.onclick = async () => {
    try {
      if (!tonConnectUI) await initTonConnect(true);
      if (!tonConnectUI) throw new Error("TON Connect не инициализирован.");
      await tonConnectUI.openModal();
    } catch (e) {
      toast(e.message || "Не удалось открыть TON Connect.");
    }
  };

  if (!window.TON_CONNECT_UI) {
    if (status) status.textContent = "TON Connect не загрузился";
    return null;
  }

  try {
    const cfgRes = await fetch("/api/tonconnect/config", { headers: authHeaders() });
    const cfg = await cfgRes.json().catch(() => ({}));
    if (!cfgRes.ok) throw new Error(cfg.error || "TON Connect не настроен.");

    if (tonConnectUI) return tonConnectUI;
    tonConnectUI = new TON_CONNECT_UI.TonConnectUI({
      manifestUrl: cfg.manifestUrl,
      buttonRootId: "tonConnectButton",
      uiPreferences: {
        theme: "DARK",
        borderRadius: "m"
      }
    });

    if (fallback) fallback.textContent = "Подключить TON Connect";
    tonConnectUI.onStatusChange(wallet => {
      tonWalletAddress = wallet?.account?.address || "";
      if (status) status.textContent = tonWalletAddress
        ? `Подключён: ${tonWalletAddress.slice(0, 6)}…${tonWalletAddress.slice(-6)}`
        : "Кошелёк не подключён";
      if (fallback) fallback.classList.toggle("hidden", !!tonWalletAddress);
    });
    if (typeof tonConnectUI.connectionRestored === "object" && tonConnectUI.connectionRestored?.then) {
      await tonConnectUI.connectionRestored;
    }
    return tonConnectUI;
  } catch (e) {
    console.warn("TON Connect init failed:", e);
    if (status) status.textContent = `Ошибка TON Connect: ${e.message || "unknown"}`;
    return null;
  }
}

$("#topupCurrencyStar").onclick = () => setTopupCurrency("STAR");
$("#topupCurrencyGram").onclick = () => setTopupCurrency("GRAM");
$("#withdrawCurrencyStar").onclick = () => setWithdrawCurrency("STAR");
$("#withdrawCurrencyGram").onclick = () => setWithdrawCurrency("GRAM");

$("#withdrawBtn").onclick = () => {
  if (!initData) return handleNotTelegram();
  $("#withdrawAmount").value = "";
  $("#withdrawWallet").value = "";
  setWithdrawCurrency("STAR");
  $("#withdrawModalBalance").textContent = currentBalance.toFixed(2) + " ⭐";
  openModal(withdrawModal);
};
$("#withdrawClose").onclick = () => closeModal(withdrawModal);
$("#freebetClose").onclick = () => closeModal(freebetModal);
$("#freebetCloseBtn").onclick = () => closeModal(freebetModal);

$("#confirmWithdraw").onclick = async () => {
  const amount = Number($("#withdrawAmount").value);
  if (!Number.isInteger(amount) || amount <= 0) return toast("Введите целую сумму Stars больше 0.");
  if (amount > currentBalance) return toast("Недостаточно Stars на балансе.");
  const wallet = $("#withdrawWallet").value.trim();
  if (withdrawCurrency === "GRAM" && !wallet) return toast("Укажите GRAM / TON кошелёк.");
  try {
    const r = await fetch("/api/profile/withdraw", {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ amount, currency: withdrawCurrency, wallet })
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || "Не удалось отправить заявку.");
    setBalance(data.balance);
    closeModal(withdrawModal);
    toast("Заявка на вывод отправлена администратору.");
  } catch (e) { toast(e.message); }
};

$("#createGramTopup").onclick = async () => {
  const amount = Number($("#gramTopupAmount").value);
  if (!Number.isInteger(amount) || amount <= 0) return toast("Введите целую сумму Stars больше 0.");
  if (!tonConnectUI) await initTonConnect(true);
  if (!tonConnectUI || !tonWalletAddress) return toast("Сначала подключите TON Connect.");
  try {
    const cfgR = await fetch("/api/gram/topup-config", { headers: authHeaders() });
    const cfg = await cfgR.json().catch(() => ({}));
    if (!cfgR.ok) throw new Error(cfg.error || "GRAM пополнение не настроено.");
    const nanoTon = String(Math.round(amount * Number(cfg.tonPerStar || 0) * 1e9));
    if (!nanoTon || nanoTon === "0") throw new Error("Не задан курс TON/Star на Render.");
    const intentR = await fetch("/api/gram/topup-intent", {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ amount })
    });
    const intent = await intentR.json().catch(() => ({}));
    if (!intentR.ok) throw new Error(intent.error || "Не удалось подготовить TON-пополнение.");
    await tonConnectUI.sendTransaction({
      validUntil: Math.floor(Date.now() / 1000) + 600,
      messages: [{ address: cfg.recipient, amount: nanoTon, payload: intent.payload }]
    });
    closeModal(topupModal);
    toast("Транзакция отправлена. Баланс будет зачислен автоматически после подтверждения сети.");
  } catch (e) { toast(e.message || "Не удалось выполнить GRAM пополнение."); }
};

$("#topupBtn").onclick = () => {
  if (!initData) return handleNotTelegram();
  $("#topupAmount").value = "";
  $("#gramTopupAmount").value = "";
  setTopupCurrency("STAR");
  openModal(topupModal);
};
$("#topupClose").onclick = () => closeModal(topupModal);

$("#createInvoice").onclick = async () => {
  const amount = Number($("#topupAmount").value);
  if (!Number.isInteger(amount) || amount <= 0) return toast("Введите сумму Stars.");
  try {
    const r = await fetch("/api/stars/create-invoice", {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ amount })
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || "Ошибка создания счёта.");
    if (tg?.openInvoice) {
      tg.openInvoice(data.invoiceUrl, status => {
        if (status === "paid") toast("Платёж принят. Баланс обновится автоматически.");
        else if (status === "cancelled") toast("Оплата отменена.");
        else if (status === "failed") toast("Telegram не подтвердил оплату.");
      });
    } else toast("Счёт создан только для Telegram Mini App.");
  } catch (e) { toast(e.message); }
};

$("#confirmBet").onclick = () => {
  const amount = Number($("#betAmount").value);
  if (!Number.isInteger(amount) || amount <= 0) return toast("Введите целое число Stars.");
  if (amount > currentBalance) return toast("Недостаточно Stars на балансе.");
  socket.emit("place_bet", { amount });
};

$("#betAmount").addEventListener("keydown", e => {
  if (e.key === "Enter") $("#confirmBet").click();
});

$("#createInvoice").onclick = async () => {
  const amount = Number($("#topupAmount").value);
  if (!Number.isInteger(amount) || amount <= 0) return toast("Введите сумму Stars.");
  try {
    const r = await fetch("/api/stars/create-invoice", {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ amount })
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || "Ошибка создания счёта.");
    if (tg?.openInvoice) {
      tg.openInvoice(data.invoiceUrl, status => {
        if (status === "paid") toast("Платёж принят. Баланс обновится автоматически.");
        else if (status === "cancelled") toast("Оплата отменена.");
        else if (status === "failed") toast("Telegram не подтвердил оплату.");
      });
    } else {
      toast("Счёт создан только для Telegram Mini App.");
    }
  } catch (e) { toast(e.message); }
};

socket.on("connect", async () => {
  const system = await loadMaintenanceStatus();
  if (system.maintenance && !system.isAdmin) return;
  if (clientMaintenance && !isAdmin) return;
  clientFingerprintPromise.then(clientFingerprint => {
    socket.emit("join_room", { initData, referralCode: startParam, clientFingerprint, telegramPlatform: String(tg?.platform || '') });
  });
});

socket.on("joined", data => {
  setBalance(data.balance);
  isAdmin = !!data.isAdmin;
  updateTaskPrice();
  if (isAdmin) {
    $("#adminPanel").classList.remove("hidden");
    scheduleAdminRefresh();
  }
  claimFreebetFromStartParam();
  if (raffleFromUrl) { setView("raffles"); }
});

// Start loading the balance immediately, in parallel with Socket.IO.
// This removes the visible wait for a socket handshake before showing the balance.
(async function bootstrap() {
  if (!initData) return handleNotTelegram();
  try {
    const system = await loadMaintenanceStatus();
    if (system.maintenance && !system.isAdmin) return;
    const r = await fetch("/api/bootstrap", { headers: await securityHeaders(authHeaders()), cache: "no-store" });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || "Не удалось загрузить приложение.");
    setBalance(data.user?.balance);
    if (Number.isFinite(Number(data.gramUsdPerStar))) {
      GRAM_USD_PER_STAR = Number(data.gramUsdPerStar);
    }
    isAdmin = !!data.isAdmin;
    updateTaskPrice();
    if (isAdmin) {
      $("#adminPanel").classList.remove("hidden");
      scheduleAdminRefresh();
    }
    if (data.state) render(data.state);
    claimFreebetFromStartParam();
    if (raffleFromUrl) { setView("raffles"); }
  } catch (e) {
    // Socket join may still succeed; don't block the app on this request.
    console.warn("Bootstrap failed:", e.message);
  }
})();

socket.on("maintenance", data => setMaintenanceOverlay(true, data?.message || ""));
socket.on("maintenance_changed", data => {
  if (isAdmin) {
    refreshAdminSystem();
    return;
  }
  const enabled = !!data?.enabled;
  setMaintenanceOverlay(enabled, "Приложение временно закрыто на технические работы. Попробуйте зайти позже.");
  if (!enabled) {
    clientFingerprintPromise.then(fp => {
      if (socket.connected && tg?.initData) socket.emit("join_room", { initData: tg.initData, fingerprint: fp });
    }).catch(() => {});
  }
});
socket.on("balance_updated", data => setBalance(data.balance));
socket.on("force_banned", () => {
  toast("Ваш аккаунт заблокирован администратором.");
  $("#betBtn").disabled = true;
  $("#topupBtn").disabled = true;
  closeModal(betModal);
  closeModal(topupModal);
  closeModal(withdrawModal);
});
socket.on("unbanned", () => {
  toast("Блокировка снята.");
  $("#betBtn").disabled = false;
  $("#topupBtn").disabled = false;
});
socket.on("error_message", message => {
  // A failed request must unlock both solo-game controls because no result
  // event will arrive after a server-side validation/authorization error.
  if (upgradeSpinning) {
    upgradeSpinning = false;
    setUpgradeControlsDisabled(false);
    $("#upgradePointerOrbit").style.opacity = "0";
  }
  bounceResetRound(message || "Ошибка раунда.");
  toast(message, "error");
});
socket.on("bet_accepted", data => {
  setBalance(data.balance);
  closeModal(betModal);
  toast(`Ставка ${data.bet} ⭐ принята`);
});
socket.on("room_state", render);

socket.on("new_round", data => {
  pvpWinnerDismissed = null;
  lastWinner = null;
  previousStatus = null;
  closeModal($("#winnerOverlay"));
  clientFingerprintPromise.then(clientFingerprint => {
    socket.emit("join_room", { initData, referralCode: startParam, clientFingerprint, telegramPlatform: String(tg?.platform || '') });
  });
  toast("Новый раунд запущен.");
});

function formatTimer(endAt) {
  if (!endAt) return "—";
  const seconds = Math.max(0, Math.ceil((endAt - Date.now()) / 1000));
  return "00:" + String(seconds).padStart(2, "0");
}

function render(s) {
  currentState = s;
  $("#bank").innerHTML = `${Number(s.bank || 0).toFixed(2)} <span>⭐</span>`;

  if (s.status === "WAITING") {
    $("#statusLabel").textContent = s.players.length === 0 ? "ОЖИДАЕМ ИГРОКА" : "ОЖИДАЕМ СОПЕРНИКА";
    $("#timer").textContent = "—";
  } else if (s.status === "COUNTDOWN") {
    $("#statusLabel").textContent = "ВЫБИРАЕМ ПОБЕДИТЕЛЯ";
    $("#timer").textContent = formatTimer(s.countdownEndsAt);
  } else if (s.status === "SPINNING") {
    $("#statusLabel").textContent = "СТРЕЛКА ВРАЩАЕТСЯ";
    $("#timer").textContent = "•••";
  } else if (s.status === "RESULT") {
    $("#statusLabel").textContent = "РАУНД ЗАВЕРШЁН";
    $("#timer").textContent = "🏆";
  }

  renderPlayers(s.players || []);
  renderWinnerCard(s);
  renderWheel(s);

  if (previousStatus !== s.status && s.status === "COUNTDOWN") toast("Второй игрок вошёл — старт 20 секунд!");
  if (previousStatus !== s.status && s.status === "RESULT") toast("Стрелка остановилась — победитель определён!");
  previousStatus = s.status;
}

function avatarMarkup(avatar, name, className = "avatar-small") {
  if (avatar) {
    return `<img class="${className}" src="${escapeHtml(avatar)}" alt="" loading="lazy">`;
  }
  const letter = escapeHtml(String(name || "И").trim().charAt(0).toUpperCase() || "И");
  return `<div class="${className} avatar-fallback">${letter}</div>`;
}

function renderPlayers(players) {
  const root = $("#players");
  root.innerHTML = "";

  const fundedPlayers = players.filter(p => Number(p.bet || 0) > 0);
  $("#emptyPlayers").style.display = fundedPlayers.length ? "none" : "block";

  for (const p of fundedPlayers) {
    const el = document.createElement("div");
    el.className = "player";
    const status = p.status === "winner"
      ? `<div class="status-win">🏆 ПОБЕДИТЕЛЬ</div>`
      : p.status === "lost"
        ? `<div class="status-loss">ПРОИГРАЛ</div>`
        : `<div class="meta">Шанс: ${Number(p.percentage).toFixed(2)}%</div>`;

    el.innerHTML = `
      <div class="player-visual">
        ${avatarMarkup(p.avatar, p.name)}
        <span class="player-color" style="background:${p.color};box-shadow:0 0 12px ${p.color}"></span>
      </div>
      <div>
        <div class="pname">${escapeHtml(p.name)}</div>
        <div class="meta">Ставка: <b>${Number(p.bet || 0).toFixed(2)} ⭐</b></div>
      </div>
      <div style="text-align:right">${status}</div>
    `;
    root.appendChild(el);
  }
}
let pvpWinnerDismissed = null;   // roomId раунда, плашку которого игрок закрыл тапом
{
  const ov = document.getElementById("winnerOverlay");
  if (ov) ov.addEventListener("click", () => {
    pvpWinnerDismissed = lastPvpRoomState && lastPvpRoomState.roomId || "x";
    closeModal(ov);
  });
}
function renderWinnerCard(s) {
  const overlay = $("#winnerOverlay");
  lastPvpRoomState = s;
  const pvpVisible = !$("#pvpView").classList.contains("hidden");
  if (!pvpVisible) { closeModal(overlay); return; }
  if (s.status !== "RESULT") pvpWinnerDismissed = null;
  if (s.status === "RESULT" && s.winner) {
    if (pvpWinnerDismissed !== null && pvpWinnerDismissed === (s.roomId || "x")) { closeModal(overlay); return; }
    const w = s.winner;
    $("#winnerAvatar").innerHTML = w.avatar
      ? `<img src="${escapeHtml(w.avatar)}" alt="" loading="lazy">`
      : `<div class="winner-fallback">${escapeHtml(String(w.name || "И").trim().charAt(0).toUpperCase() || "И")}</div>`;
    $("#winnerName").textContent = w.name || "Игрок";
    $("#winnerPayout").textContent = `${Number(w.payout || 0).toFixed(2)} ⭐`;
    $("#winnerBetDetail").textContent = `Ставка: ${Number(w.bet || 0).toFixed(2)} ⭐`;
    openModal(overlay);
  } else {
    closeModal(overlay);
  }
}

function renderWheel(s) {
  const wheel = $("#wheel");
  const pointerOrbit = $("#pointerOrbit");
  const players = Array.isArray(s.players) ? s.players : [];
  const fundedPlayers = players.filter(p => Number(p.bet) > 0);

  if (!fundedPlayers.length || Number(s.bank) <= 0) {
    wheel.classList.add("empty");
    wheel.style.background = "#66686b";
    wheel.style.transform = "rotate(0deg)";
    wheel.style.transition = "transform .35s ease";
    if (pointerOrbit) {
      pointerOrbit.style.transition = "transform .35s ease";
      pointerOrbit.style.transform = "rotate(0deg)";
    }
    lastWinner = null;
    lastSpinTarget = null;
    return;
  }

  wheel.classList.remove("empty");

  const total = fundedPlayers.reduce((sum, p) => sum + Number(p.bet), 0);
  const segments = fundedPlayers.map(p => ({
    p,
    raw: Number(p.bet) / total * 100
  }));

  const stops = [];
  let cursor = 0;
  segments.forEach((segment, index) => {
    const start = cursor;
    const end = index === segments.length - 1 ? 100 : cursor + segment.raw;
    cursor = end;
    stops.push(`${segment.p.color} ${start}% ${end}%`);
  });

  // The wheel stays completely still. Only the pointer orbit rotates.
  wheel.style.background = `conic-gradient(${stops.join(",")})`;
  wheel.style.transform = "rotate(0deg)";

  if (s.status === "SPINNING" && s.spinTargetAngle != null) {
    const targetAngle = Number(s.spinTargetAngle);
    if (pointerOrbit && Number.isFinite(targetAngle) && lastSpinTarget !== targetAngle) {
      pointerOrbit.style.transition = "transform 6.2s cubic-bezier(.10,.72,.12,1)";
      pointerOrbit.style.transform = `rotate(${360 * 6 + targetAngle}deg)`;
      lastSpinTarget = targetAngle;
    }
  }

  if (s.status === "WAITING" || s.status === "COUNTDOWN") {
    lastWinner = null;
    lastSpinTarget = null;
    if (pointerOrbit) {
      pointerOrbit.style.transition = "transform .35s ease";
      pointerOrbit.style.transform = "rotate(0deg)";
    }
  }

  // RESULT intentionally leaves the pointer untouched, so it remains at the exact stop angle.
}

// Вкладка «Games» всегда открывается на списке игр, а не на последней открытой игре.
function resetGamesScreens() {
  ["upgradeGame", "bounceGame", "iceGame"].forEach(id => { const e = document.getElementById(id); if (e) e.classList.add("hidden"); });
  document.querySelectorAll("#gamesView .solo-game").forEach(e => e.classList.add("hidden"));
  ["histModal", "gameModal"].forEach(id => { const e = document.getElementById(id); if (e) e.classList.remove("show"); });
  const list = document.getElementById("gamesList");
  if (list) list.classList.remove("hidden");
  const gv = document.getElementById("gamesView");
  if (gv) gv.scrollTop = 0;
}

function setView(view) {
  const views = { pvp: $("#pvpView"), raffles: $("#rafflesView"), games: $("#gamesView"), profile: $("#profileView") };
  const activeKey = views[view] ? view : "pvp";

  Object.values(views).forEach(el => el.classList.add("hidden"));
  views[activeKey].classList.remove("hidden");

  if (activeKey === "profile") loadProfile();
  if (activeKey === "raffles") loadRaffles();
  if (activeKey === "games") resetGamesScreens();

  // Окно победителя PvP показываем только на вкладке PvP
  if (activeKey === "pvp") { if (lastPvpRoomState) renderWinnerCard(lastPvpRoomState); }
  else closeModal($("#winnerOverlay"));

  document.querySelectorAll(".nav-item").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.view === activeKey);
  });
  const topupBtn = $("#topupBtn");
  if (topupBtn) topupBtn.style.display = activeKey === "games" ? "none" : "";
}

document.querySelectorAll(".nav-item").forEach(btn => {
  btn.addEventListener("click", () => setView(btn.dataset.view));
});

async function loadProfile() {
  if (!initData) return handleNotTelegram();
  try {
    const r = await fetch("/api/profile", { headers: await securityHeaders(authHeaders()) });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || "Не удалось загрузить профиль.");

    const u = data.user || {};
    const st = data.stats || {};
    const ref = data.referral || {};
    if (isAdmin) refreshAdmin();
    loadTasks();

    $("#profileName").textContent = u.first_name || "Игрок";
    $("#profileUsername").textContent = u.username ? "@" + u.username.replace(/^@/, "") : "Без username";
    $("#profileId").textContent = u.id || "—";
    $("#profileBalance").textContent = `${Number(u.balance || 0).toFixed(2)} ⭐`;

    const avatar = $("#profileAvatar");
    avatar.innerHTML = u.avatar_url
      ? `<img src="${escapeHtml(u.avatar_url)}" alt="" loading="lazy">`
      : `<div class="avatar-fallback profile-fallback">${escapeHtml(String(u.first_name || "И").charAt(0).toUpperCase())}</div>`;

    $("#gamesPlayed").textContent = st.gamesPlayed || 0;
    $("#gamesWon").textContent = st.gamesWon || 0;
    $("#winrate").textContent = `${Number(st.winrate || 0).toFixed(2)}%`;
    $("#totalWagered").textContent = `${Number(st.totalWagered || 0).toFixed(2)} ⭐`;

    $("#refPending").textContent = `${Number(ref.pending || 0).toFixed(2)} ⭐`;
    $("#refTotal").textContent = `${Number(ref.totalEarned || 0).toFixed(2)} ⭐`;
    $("#refInvited").textContent = ref.invited || 0;
    $("#referralLink").value = ref.link || "Укажи TELEGRAM_BOT_USERNAME на Render";

    const claim = $("#claimReferral");
    claim.disabled = Number(ref.pending || 0) <= 0;
  } catch (e) {
    toast(e.message);
  }
}

async function loadTasks() {
  const root = $("#tasksList");
  if (!root || !initData) return;
  try {
    const response = await fetch("/api/tasks", { headers: authHeaders() });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "Не удалось загрузить задания.");
    const tasks = data.tasks || [];
    root.innerHTML = tasks.length ? "" : '<div class="tasks-empty">Сейчас нет активных заданий.</div>';
    for (const task of tasks) {
      const el = document.createElement("div");
      el.className = "task-item";
      const completed = !!task.completed;
      el.innerHTML = `<div><b>Подписка на ${escapeHtml(task.target_username)}</b><span>${Number(task.completions)}/${Number(task.max_activations)} активаций</span></div><div class="task-reward">+${Number(task.reward).toFixed(2)} ⭐</div><div class="task-actions"><a href="https://t.me/${escapeHtml(String(task.target_username).replace(/^@/, ""))}" target="_blank" rel="noopener">Открыть</a><button ${completed ? "disabled" : ""}>${completed ? "Выполнено" : "Проверить"}</button></div>`;
      const button = el.querySelector("button");
      button.onclick = async () => {
        try {
          const complete = await fetch(`/api/tasks/${encodeURIComponent(task.id)}/complete`, { method: "POST", headers: authHeaders() });
          const result = await complete.json().catch(() => ({}));
          if (!complete.ok) throw new Error(result.error || "Не удалось проверить задание.");
          setBalance(result.balance);
          toast("Задание выполнено: награда зачислена.");
          loadTasks();
        } catch (e) { toast(e.message); }
      };
      root.appendChild(el);
    }
  } catch (e) { root.innerHTML = `<div class="tasks-empty">${escapeHtml(e.message)}</div>`; }
}

$("#copyReferral").onclick = async () => {
  const value = $("#referralLink").value;
  if (!value || value.startsWith("Укажи")) return toast("Сначала укажи TELEGRAM_BOT_USERNAME на Render.");
  try {
    await navigator.clipboard.writeText(value);
    toast("Реферальная ссылка скопирована.");
  } catch {
    $("#referralLink").select();
    document.execCommand("copy");
    toast("Ссылка скопирована.");
  }
};

$("#claimReferral").onclick = async () => {
  try {
    const r = await fetch("/api/profile/referrals/claim", {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" })
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || "Не удалось забрать начисления.");
    setBalance(data.balance);
    toast(`Зачислено ${Number(data.amount).toFixed(2)} ⭐`);
    loadProfile();
  } catch (e) {
    toast(e.message);
  }
};

// ---------- RAFFLES ----------
let raffleType = "free";
let rafflesLoaded = false;
let currentRaffleId = raffleFromUrl || "";

function formatRaffleCountdown(endAt) {
  const ms = Math.max(0, Number(endAt || 0) - Date.now());
  const total = Math.floor(ms / 1000);
  const d = Math.floor(total / 86400);
  const h = Math.floor((total % 86400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  if (d > 0) return `${d}д ${h}ч`;
  if (h > 0) return `${h}ч ${m}м`;
  return `${m}м ${total % 60}с`;
}

function formatRaffleDate(endAt) {
  if (!endAt) return "—";
  const d = new Date(endAt);
  if (Number.isNaN(d.getTime())) return "—";
  return `${String(d.getDate()).padStart(2, "0")}.${String(d.getMonth() + 1).padStart(2, "0")}.${d.getFullYear()}`;
}

function setDefaultRaffleEnd() {
  const dt = new Date(Date.now() + 24 * 60 * 60 * 1000);
  dt.setMinutes(dt.getMinutes() - dt.getTimezoneOffset());
  $("#raffleEndsAt").value = dt.toISOString().slice(0,16);
}

function updateRaffleType(type) {
  raffleType = type;
  document.querySelectorAll(".raffle-type-option").forEach(btn => btn.classList.toggle("active", btn.dataset.type === type));
  $("#paidTicketField").classList.toggle("hidden", type !== "paid");
}

document.querySelectorAll(".raffle-type-option").forEach(btn => btn.addEventListener("click", () => updateRaffleType(btn.dataset.type)));
$("#rafflePrizePool").addEventListener("input", updateEachPreview);
$("#raffleWinners").addEventListener("input", updateEachPreview);
function updateEachPreview() {
  const pool = Number($("#rafflePrizePool").value);
  const winners = Number($("#raffleWinners").value);
  $("#raffleEachPreview").textContent = Number.isFinite(pool) && winners > 0 ? `Каждому: ≈ ${(pool / winners).toFixed(2)} ⭐` : "Каждому: — ⭐";
}

$("#openCreateRaffle").onclick = () => {
  if (!initData) return handleNotTelegram();
  updateRaffleType("free");
  $("#rafflePrizeTitle").value = "";
  $("#rafflePrizePool").value = "";
  $("#raffleWinners").value = "";
  $("#raffleTicketPrice").value = "";
  $("#raffleChannel").value = "";
  setDefaultRaffleEnd();
  updateEachPreview();
  openModal($("#raffleCreateModal"));
};
$("#raffleCreateClose").onclick = () => closeModal($("#raffleCreateModal"));
$("#raffleDetailClose").onclick = () => closeModal($("#raffleDetailModal"));
// тап по пустому месту (тёмному фону вокруг карточки) тоже закрывает окно розыгрыша
$("#raffleDetailModal").addEventListener("click", e => { if (e.target === e.currentTarget) closeModal(e.currentTarget); });

function openTopupWithAmount(amount) {
  $("#topupAmount").value = String(Math.max(1, Math.ceil(Number(amount || 1))));
  closeModal($("#raffleCreateModal"));
  closeModal($("#raffleDetailModal"));
  openModal(topupModal);
}

async function loadRaffles() {
  if (!initData) return handleNotTelegram();
  try {
    const r = await fetch("/api/raffles", { headers: authHeaders(), cache: "no-store" });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || "Не удалось загрузить розыгрыши.");
    renderRaffles(data.raffles || []);
    rafflesLoaded = true;
    if (currentRaffleId) {
      const still = (data.raffles || []).some(x => String(x.id) === String(currentRaffleId));
      if (still || raffleFromUrl) openRaffleDetail(currentRaffleId);
    }
  } catch(e) { toast(e.message); }
}

function renderRaffles(items) {
  const root = $("#raffleCards");
  root.innerHTML = "";
  const active = items.filter(x => x.status === "active");
  const finished = items.filter(x => x.status !== "active");
  const ordered = [...active, ...finished];
  $("#raffleEmpty").classList.toggle("hidden", ordered.length > 0);
  for (const r of ordered) {
    const el = document.createElement("button");
    el.className = `raffle-card ${r.status !== "active" ? "finished" : ""}`;
    el.innerHTML = `
      <div class="raffle-card-glow"></div>
      <div class="raffle-card-top"><span>Winners: ${Number(r.winnersCount)}</span><span class="raffle-status">${r.status === "active" ? "Active" : "Inactive"}</span></div>
      <div class="raffle-card-top" style="margin-top:6px"><span>Name: ${escapeHtml(r.prizeTitle || "Stars")}</span><span>${r.status === "active" ? formatRaffleCountdown(r.endsAt) : "Results: " + formatRaffleDate(r.endsAt)}</span></div>
      <div class="raffle-card-prize">Prize:</div>
      <div class="raffle-card-amount">${Number(r.prizePool).toFixed(2)} ⭐</div>
      <div class="raffle-card-bottom"><span>👥 ${Number(r.participants || 0)} участников · 🎟 ${Number(r.totalTickets || 0)} билетов</span><span class="raffle-arrow">›</span></div>
    `;
    el.onclick = () => openRaffleDetail(r.id);
    root.appendChild(el);
  }
}

async function openRaffleDetail(id) {
  currentRaffleId = String(id);
  try {
    const r = await fetch(`/api/raffles/${encodeURIComponent(id)}`, { headers: authHeaders({"X-Raffle-Ref": startParam}), cache: "no-store" });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || "Не удалось открыть розыгрыш.");
    renderRaffleDetail(data);
    openModal($("#raffleDetailModal"));
  } catch(e) { toast(e.message); }
}

function renderRaffleDetail(data) {
  const r = data.raffle;
  const mine = data.mine;
  const each = r.winnersCount ? r.prizePool / r.winnersCount : 0;
  const ended = r.status !== "active";
  const root = $("#raffleDetailRoot");
  root.innerHTML = `
    <div class="raffle-detail-banner ${ended ? 'finished' : ''}">
      <div class="raffle-detail-prize">${escapeHtml(r.prizeTitle || 'Stars')}</div>
      <div class="raffle-detail-badge" style="margin-top:8px">${ended ? 'Inactive' : 'Active'}</div>
      <div class="raffle-detail-fund" style="margin-top:14px">Results: ${formatRaffleDate(r.endsAt)}</div>
    </div>
    <div class="raffle-detail-grid">
      <div><span>Prize</span><b>${Number(r.prizePool).toFixed(2)} ⭐</b></div>
      <div><span>Winners</span><b>${r.winnersCount}</b></div>
      <div><span>Participants</span><b>${Number(r.participants || 0)}</b></div>
      <div><span>Билет</span><b>${r.type === 'paid' ? Number(r.ticketPrice).toFixed(2) + ' ⭐' : 'Бесплатно'}</b></div>
    </div>
    <div class="raffle-detail-each">Каждому победителю ≈ ${each.toFixed(2)} ⭐ · ${ended ? '—' : formatRaffleCountdown(r.endsAt)}</div>
    <div class="raffle-channel-row"><a href="${escapeHtml(data.channelUrl)}" target="_blank" rel="noreferrer">📣 ${escapeHtml(r.channelTitle || r.channelUsername)}</a></div>
    ${mine ? `<div class="raffle-your-ticket"><b>Твои билеты: ${mine.tickets}</b><span>Оплачено: ${Number(mine.paidAmount).toFixed(2)} ⭐</span></div>` : ''}
    <div class="raffle-detail-actions">
      ${ended ? '' : (!data.subscribed ? `<button class="confirm" id="raffleSubscribeBtn">📣 ПОДПИСАТЬСЯ НА КАНАЛ</button><button class="raffle-secondary-btn" id="raffleCheckSubscription">✅ Я ПОДПИСАЛСЯ — ПРОВЕРИТЬ</button>` : `<button class="confirm" id="raffleJoinBtn" ${mine ? 'disabled' : ''}>${mine ? 'ТЫ УЖЕ УЧАСТВУЕШЬ' : (r.type === 'paid' ? `Join · ${Number(r.ticketPrice).toFixed(2)} ⭐` : 'Join')}</button>`)}
      ${ended ? '' : (Number(data.boostCount || 0) > 0 || localStorage.getItem(`raffle_boost_pending_${r.id}`) === '1'
        ? `<button class="raffle-secondary-btn" id="checkRaffleBoost">ПРОВЕРИТЬ БУСТ${data.boostCount ? ` · ${data.boostCount}` : ''}</button>`
        : `<a class="raffle-secondary-btn" id="giveRaffleBoost" href="${escapeHtml(data.boostUrl)}" target="_blank" rel="noreferrer">🚀 Дать буст каналу</a>`)}
      ${data.referralLink ? `<div class="raffle-ref-box"><input id="raffleRefLink" readonly value="${escapeHtml(data.referralLink)}"><button id="copyRaffleRef">ПРИГЛАСИТЬ</button></div><div class="raffle-ref-hint">Пригласи друга по своей ссылке — получишь +1 билет.</div>` : ''}
    </div>
    <div class="raffle-winners-list">${(data.winners || []).length ? '<div class="raffle-section-title">ПОБЕДИТЕЛИ</div>' + data.winners.map(w => `<div class="raffle-winner-row"><span>#${w.place} ${escapeHtml(w.name)}</span><b>${Number(w.payout).toFixed(2)} ⭐</b></div>`).join('') : ''}</div>
  `;
  const subscribe = $("#raffleSubscribeBtn");
  if (subscribe) subscribe.onclick = () => {
    if (tg?.openTelegramLink) tg.openTelegramLink(data.channelUrl);
    else window.open(data.channelUrl, '_blank', 'noopener,noreferrer');
  };
  const checkSubscription = $("#raffleCheckSubscription");
  if (checkSubscription) checkSubscription.onclick = () => checkRaffleSubscription(r.id);
  const join = $("#raffleJoinBtn");
  if (join && !mine) join.onclick = () => joinRaffle(r.id);
  const boost = $("#checkRaffleBoost");
  if (boost) boost.onclick = () => checkBoost(r.id);
  const giveBoost = $("#giveRaffleBoost");
  if (giveBoost) giveBoost.onclick = () => { localStorage.setItem(`raffle_boost_pending_${r.id}`, '1'); };
  const copy = $("#copyRaffleRef");
  if (copy) copy.onclick = async () => {
    const input = $("#raffleRefLink");
    try { await navigator.clipboard.writeText(input.value); toast("Личная ссылка скопирована."); } catch { input.select(); document.execCommand('copy'); toast("Ссылка скопирована."); }
  };
}

async function checkRaffleSubscription(id) {
  const btn = $("#raffleCheckSubscription");
  if (btn) { btn.disabled = true; btn.textContent = 'ПРОВЕРЯЕМ…'; }
  try {
    const r = await fetch(`/api/raffles/${encodeURIComponent(id)}/subscription`, { headers: authHeaders(), cache: 'no-store' });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || 'Не удалось проверить подписку.');
    if (!data.subscribed) {
      toast('Подпишись на канал и нажми проверку ещё раз.');
      if (btn) { btn.disabled = false; btn.textContent = '✅ Я ПОДПИСАЛСЯ — ПРОВЕРИТЬ'; }
      return;
    }
    toast('Подписка подтверждена!');
    await openRaffleDetail(id);
  } catch (e) {
    toast(e.message);
    if (btn) { btn.disabled = false; btn.textContent = '✅ Я ПОДПИСАЛСЯ — ПРОВЕРИТЬ'; }
  }
}

async function joinRaffle(id) {
  try {
    const r = await fetch(`/api/raffles/${encodeURIComponent(id)}/join`, { method:'POST', headers:authHeaders({'Content-Type':'application/json'}), body:JSON.stringify({startParam}) });
    const data = await r.json().catch(() => ({}));
    if (data.code === 'RAFFLE_SUBSCRIPTION_REQUIRED') {
      toast('Сначала подпишись на канал розыгрыша.');
      await openRaffleDetail(id);
      return;
    }
    if (r.status === 402 || data.code === 'INSUFFICIENT_FUNDS') {
      toast(`Не хватает ${Number(data.missing || 0).toFixed(2)} ⭐`);
      openTopupWithAmount(data.missing || 1);
      return;
    }
    if (!r.ok) throw new Error(data.error || 'Не удалось принять участие.');
    setBalance(data.balance);
    toast('Ты участвуешь в розыгрыше!');
    renderRaffleDetail(data.detail);
  } catch(e) { toast(e.message); }
}

async function checkBoost(id) {
  const btn = $("#checkRaffleBoost");
  if (btn) { btn.disabled = true; btn.textContent = 'ПРОВЕРЯЕМ…'; }
  try {
    const r = await fetch(`/api/raffles/${encodeURIComponent(id)}/check-boost`, {method:'POST',headers:authHeaders({'Content-Type':'application/json'})});
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || 'Не удалось проверить буст.');
    toast(data.newTickets > 0 ? `Начислено +${data.newTickets} билет${data.newTickets === 1 ? '' : 'а'}!` : `Бустов найдено: ${data.boosts}. Новых билетов нет.`);
    renderRaffleDetail(data.detail);
  } catch(e) { toast(e.message); if (btn) btn.disabled = false; }
}

$("#createRaffleBtn").onclick = async () => {
  const prizePool = Number($("#rafflePrizePool").value);
  const winnersCount = Number($("#raffleWinners").value);
  const ticketPrice = Number($("#raffleTicketPrice").value);
  const prizeTitle = $("#rafflePrizeTitle").value.trim() || 'Stars';
  const channel = $("#raffleChannel").value.trim();
  const endsAtValue = $("#raffleEndsAt").value;
  const endsAt = endsAtValue ? new Date(endsAtValue).toISOString() : '';
  if (!Number.isFinite(prizePool) || prizePool <= 0) return toast('Укажи сумму приза.');
  if (!Number.isInteger(winnersCount) || winnersCount <= 0) return toast('Укажи количество победителей.');
  if (raffleType === 'paid' && (!Number.isFinite(ticketPrice) || ticketPrice <= 0)) return toast('Укажи цену билета.');
  if (!channel) return toast('Укажи канал.');
  if (!endsAtValue) return toast('Укажи время окончания.');
  const btn = $("#createRaffleBtn");
  btn.disabled = true; btn.textContent = 'СОЗДАЁМ…';
  try {
    const r = await fetch('/api/raffles', {method:'POST',headers:authHeaders({'Content-Type':'application/json'}),body:JSON.stringify({type:raffleType,ticketPrice: raffleType==='paid'?ticketPrice:0,prizePool,winnersCount,prizeTitle,channel,endsAt})});
    const data = await r.json().catch(() => ({}));
    if (r.status === 402 || data.code === 'INSUFFICIENT_FUNDS') {
      toast(`Не хватает ${Number(data.missing || 0).toFixed(2)} ⭐ для создания.`);
      openTopupWithAmount(data.missing || 1);
      return;
    }
    if (!r.ok) throw new Error(data.error || 'Не удалось создать розыгрыш.');
    setBalance(data.balance);
    closeModal($("#raffleCreateModal"));
    toast('Розыгрыш создан и опубликован в канале.');
    setView('raffles');
    await loadRaffles();
    await openRaffleDetail(data.raffle.id);
  } catch(e) { toast(e.message); }
  finally { btn.disabled = false; btn.textContent = 'СОЗДАТЬ РОЗЫГРЫШ'; }
};

setInterval(() => {
  const cards = document.querySelectorAll('.raffle-card');
  if (!cards.length) return;
  // Refresh only the labels without hitting the API every second.
  document.querySelectorAll('.raffle-card').forEach((card, idx) => {
    const items = window.__rafflesCache || [];
    const r = items[idx];
    const meta = card.querySelector('.raffle-card-meta span:last-child');
    if (r && meta && r.status === 'active') meta.textContent = formatRaffleCountdown(r.endsAt);
  });
}, 1000);

const _renderRaffles = renderRaffles;
renderRaffles = function(items) { window.__rafflesCache = items; _renderRaffles(items); };

// ---------- ADMIN ----------
async function adminFetch(url, options = {}) {
  const r = await fetch(url, { ...options, headers: authHeaders(options.headers || {}) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || "Ошибка админ-панели");
  return data;
}

let adminRefreshTimer = null;
let adminRefreshInFlight = false;
function scheduleAdminRefresh(delay = 50) {
  if (!isAdmin) return;
  clearTimeout(adminRefreshTimer);
  adminRefreshTimer = setTimeout(() => refreshAdmin(), delay);
}

async function refreshAdmin() {
  if (adminRefreshInFlight) return;
  adminRefreshInFlight = true;
  if (!isAdmin) return;
  try {
    const [stats, users, promos, system] = await Promise.all([
      adminFetch("/api/admin/stats"),
      adminFetch("/api/admin/users?q=" + encodeURIComponent($("#adminSearch").value.trim())),
      adminFetch("/api/admin/promos"),
      adminFetch("/api/admin/system")
    ]);
    renderAdminStats(stats);
    renderAdminPromos(promos.promos || []);
    renderAdminUsers(users.users || []);
    const status = $('#maintenanceStatus');
    const button = $('#toggleMaintenance');
    if (status && button) {
      status.textContent = system.maintenance ? '🔴 Приложение закрыто на технические работы.' : '🟢 Приложение работает в обычном режиме.';
      button.textContent = system.maintenance ? 'ОТКРЫТЬ ПРИЛОЖЕНИЕ' : 'ЗАКРЫТЬ ПРИЛОЖЕНИЕ';
      button.classList.toggle('active', !!system.maintenance);
    }
  } catch (e) {
    toast(e.message);
  } finally {
    adminRefreshInFlight = false;
  }
}

const ADMIN_SUMMARY_TABS = { topups: "adminSummaryTopups", bets: "adminSummaryBets", withdrawals: "adminSummaryWithdrawals", referrals: "adminSummaryReferrals" };
const adminSummaryLoaded = new Set();

function renderAdminSummary(elId, data) {
  const unit = "⭐";
  const methods = (data.byMethod || []).map(m => `
    <div class="admin-summary-method">
      <div><b>${escapeHtml(m.method)}</b><span>${m.count} шт.</span></div>
      <div class="admin-summary-amount">${Number(m.amount).toFixed(2)} ${unit}</div>
    </div>`).join("") || `<div class="empty-players">Пока пусто</div>`;
  const recent = (data.recent || []).map(r => `
    <div class="admin-summary-row">
      <div><b>${escapeHtml(r.name || "Игрок")}${r.username ? " · @" + escapeHtml(r.username) : ""}</b><span>${escapeHtml(r.method)}${r.status ? " · " + escapeHtml(r.status) : ""} · ${formatHistoryDateTime(r.createdAt)}</span></div>
      <div class="admin-summary-amount">${Number(r.amount).toFixed(2)} ${unit}</div>
    </div>`).join("") || `<div class="empty-players">Пока пусто</div>`;
  $(elId).innerHTML = `
    <div class="admin-summary-total">За всё время: <b>${Number(data.totalAmount).toFixed(2)} ${unit}</b> · ${Number(data.count)} шт.</div>
    <div class="admin-summary-title">По способу</div>
    <div class="admin-summary-methods">${methods}</div>
    <div class="admin-summary-title">Последние</div>
    <div class="admin-summary-recent">${recent}</div>
  `;
}

async function loadAdminSummary(category, force = false) {
  if (!force && adminSummaryLoaded.has(category)) return;
  try {
    const data = await adminFetch(`/api/admin/summary/${encodeURIComponent(category)}`);
    renderAdminSummary("#" + ADMIN_SUMMARY_TABS[category], data);
    adminSummaryLoaded.add(category);
  } catch (e) {
    toast(e.message);
  }
}

document.querySelectorAll(".admin-tab").forEach(btn => {
  btn.onclick = () => {
    const tab = btn.dataset.adminTab;
    document.querySelectorAll(".admin-tab").forEach(b => b.classList.toggle("active", b === btn));
    document.querySelectorAll(".admin-tab-panel").forEach(p => p.classList.add("hidden"));
    const panelId = tab === "users" ? "adminTabUsers" : tab === "promos" ? "adminTabPromos" : "adminTab" + tab[0].toUpperCase() + tab.slice(1);
    $("#" + panelId).classList.remove("hidden");
    if (ADMIN_SUMMARY_TABS[tab]) loadAdminSummary(tab);
    if (tab === 'system') refreshAdminSystem();
  };
});

function updateTaskPrice() {
  const reward = Number($("#adminTaskReward")?.value || 0);
  const activations = Number($("#adminTaskActivations")?.value || 0);
  const price = reward > 0 && activations > 0 ? reward * activations * 1.5 : 0;
  const priceEl = $("#adminTaskPrice");
  const card = $(".task-create-public") || $(".task-create-modal-card");
  const button = $("#createTask");
  if (!priceEl || !button) return;

  if (isAdmin) {
    priceEl.textContent = "БЕСПЛАТНО";
    card?.classList.add("is-free");
    button.textContent = "СОЗДАТЬ БЕСПЛАТНО";
  } else {
    priceEl.textContent = `${Math.max(0, price).toFixed(2)} ⭐`;
    card?.classList.remove("is-free");
    button.textContent = "СОЗДАТЬ И ОПЛАТИТЬ";
  }
}

$("#openCreateTask")?.addEventListener("click", () => {
  if (clientMaintenance) return toast("Приложение временно закрыто на технические работы.");
  $("#adminTaskChannel").value = "";
  $("#adminTaskReward").value = "";
  $("#adminTaskActivations").value = "";
  updateTaskPrice();
  openModal(taskCreateModal);
});
$("#taskCreateClose")?.addEventListener("click", () => closeModal(taskCreateModal));
["adminTaskReward", "adminTaskActivations"].forEach(id => $("#" + id)?.addEventListener("input", updateTaskPrice));
$("#createTask")?.addEventListener("click", async () => {
  const channel = $("#adminTaskChannel").value.trim();
  const reward = Number($("#adminTaskReward").value);
  const activations = Number($("#adminTaskActivations").value);
  if (!channel) return toast("Укажите @username канала.");
  if (!Number.isFinite(reward) || reward <= 0) return toast("Укажите награду больше 0.");
  if (!Number.isInteger(activations) || activations <= 0) return toast("Укажите целое количество активаций.");
  try {
    const r = await fetch("/api/tasks", {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ channel, reward, activations })
    });
    const result = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(result.error || "Не удалось создать задание.");
    setBalance(result.balance);
    closeModal(taskCreateModal);
    $("#adminTaskChannel").value = "";
    $("#adminTaskReward").value = "";
    $("#adminTaskActivations").value = "";
    updateTaskPrice();
    toast(result.pending
      ? `Заявка отправлена администратору. Зарезервировано ${Number(result.price).toFixed(2)} ⭐.`
      : (result.free ? "Задание создано бесплатно для администратора." : `Задание создано. Списано ${Number(result.price).toFixed(2)} ⭐.`));
    loadTasks();
  } catch (e) { toast(e.message); }
});
updateTaskPrice();

function renderAdminStats(s) {
  $("#adminStats").innerHTML = `
    <div class="admin-stat"><b>${s.users}</b><span>Пользователи</span></div>
    <div class="admin-stat"><b>${s.banned}</b><span>В бане</span></div>
    <div class="admin-stat"><b>${Number(s.total_balance).toFixed(2)} ⭐</b><span>Баланс</span></div>
  `;
}

async function refreshAdminSystem() {
  try {
    const data = await adminFetch('/api/admin/system');
    const status = $('#maintenanceStatus');
    const button = $('#toggleMaintenance');
    if (!status || !button) return;
    status.textContent = data.maintenance ? '🔴 Приложение закрыто на технические работы.' : '🟢 Приложение работает в обычном режиме.';
    button.textContent = data.maintenance ? 'ОТКРЫТЬ ПРИЛОЖЕНИЕ' : 'ЗАКРЫТЬ ПРИЛОЖЕНИЕ';
    button.classList.toggle('active', !!data.maintenance);
  } catch (e) { toast(e.message); }
}

$('#toggleMaintenance')?.addEventListener('click', async () => {
  try {
    const current = await adminFetch('/api/admin/system');
    const next = !current.maintenance;
    await adminFetch('/api/admin/system/maintenance', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: next })
    });
    setMaintenanceOverlay(false);
    toast(next ? 'Приложение закрыто на технические работы.' : 'Приложение снова открыто.');
    await refreshAdminSystem();
  } catch (e) { toast(e.message); }
});

function renderAdminPromos(promos) {
  const root = $("#adminPromos");
  root.innerHTML = "";
  if (!promos.length) {
    root.innerHTML = `<div class="empty-players promo-empty">Промокодов пока нет</div>`;
    return;
  }
  for (const p of promos) {
    const el = document.createElement("div");
    el.className = "admin-promo";
    const active = !!p.active;
    el.innerHTML = `
      <div>
        <div class="admin-promo-code">${escapeHtml(p.code)}</div>
        <div class="admin-promo-meta">+${Number(p.bonus).toFixed(0)} ⭐ · ${Number(p.uses_count)}/${Number(p.max_uses)} активаций${Number(p.wager) > 0 ? ` · вагер x${Number(p.wager)}` : ""}${Number(p.required_deposit) > 0 ? ` · депозит от ${Number(p.required_deposit).toFixed(0)} ⭐` : ""}</div>
      </div>
      <button class="promo-toggle ${active ? "active" : ""}">${active ? "ВКЛ" : "ВЫКЛ"}</button>
    `;
    el.querySelector(".promo-toggle").onclick = async () => {
      try {
        await adminFetch(`/api/admin/promos/${encodeURIComponent(p.id)}/toggle`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ active: !active })
        });
        toast(active ? "Промокод отключён." : "Промокод включён.");
        refreshAdmin();
      } catch (e) { toast(e.message); }
    };
    root.appendChild(el);
  }
}

function renderAdminUsers(users) {
  const root = $("#adminUsers");
  root.innerHTML = "";
  if (!users.length) {
    root.innerHTML = `<div class="empty-players">Пользователи не найдены</div>`;
    return;
  }

  for (const u of users) {
    const el = document.createElement("div");
    el.className = "admin-user";
    const title = escapeHtml(u.username ? "@" + u.username : u.first_name);
    el.innerHTML = `
      <div class="admin-user-head">
        <div>
          <div class="admin-user-name">${title}</div>
          <div class="admin-user-id">ID: ${escapeHtml(u.telegram_id)}</div>
        </div>
        <div>${u.risk_score >= 70 ? `⚠️ МУЛЬТИ ×${Number(u.linked_accounts || 0)}` : (u.risk_score >= 20 ? `🟠 РИСК ${Number(u.risk_score)}` : (u.banned ? "🔴 БАН" : "🟢 ОК"))}</div>
      </div>
      <div class="admin-balance">${Number(u.balance).toFixed(2)} ⭐</div>
      <div class="admin-user-meta">Вагер: ${Number(u.wager_remaining || 0).toFixed(2)} ⭐ · Депозит: ${Number(u.total_deposited || 0).toFixed(2)} ⭐</div>
      <div class="admin-actions">
        <input class="admin-amount" type="number" step="1" min="1" placeholder="Stars">
        <input class="admin-wager" type="number" step="0.5" min="0" placeholder="Вагер x">
        <button class="add-btn">ВЫДАТЬ</button>
        <button class="remove-btn">ЗАБРАТЬ</button>
        <button class="ban-btn ${u.banned ? "unban" : ""}">${u.banned ? "РАЗБАНИТЬ" : "ЗАБАНИТЬ"}</button>
      </div>
    `;

    const amountInput = el.querySelector(".admin-amount");
    const wagerInput = el.querySelector(".admin-wager");
    el.querySelector(".add-btn").onclick = async () => {
      const amount = Number(amountInput.value);
      const wager = wagerInput.value.trim() === "" ? 0 : Number(wagerInput.value);
      if (!Number.isInteger(amount) || amount <= 0) return toast("Введите целое количество Stars.");
      if (!Number.isFinite(wager) || wager < 0) return toast("Вагер должен быть 0 или больше.");
      await adminAdjust(u.telegram_id, amount, wager);
    };
    el.querySelector(".remove-btn").onclick = async () => {
      const amount = Number(amountInput.value);
      if (!Number.isInteger(amount) || amount <= 0) return toast("Введите целое количество Stars.");
      await adminAdjust(u.telegram_id, -amount);
    };
    el.querySelector(".ban-btn").onclick = async () => {
      try {
        await adminFetch(`/api/admin/users/${encodeURIComponent(u.telegram_id)}/ban`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ banned: !u.banned })
        });
        toast(u.banned ? "Пользователь разбанен." : "Пользователь заблокирован.");
        refreshAdmin();
      } catch (e) { toast(e.message); }
    };
    root.appendChild(el);
  }
}

async function adminAdjust(id, delta, wager = 0) {
  try {
    await adminFetch(`/api/admin/users/${encodeURIComponent(id)}/adjust-balance`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ delta, wager, description: delta > 0 ? "Выдача Stars администратором" : "Списание Stars администратором" })
    });
    toast(delta > 0 ? "Stars выданы." : "Stars списаны.");
    refreshAdmin();
  } catch (e) { toast(e.message); }
}

$("#adminRefresh").onclick = refreshAdmin;
let searchTimer;
$("#adminSearch").addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(refreshAdmin, 250);
});

async function activatePromo() {
  const input = $("#promoCode");
  const code = input.value.trim();
  if (!code) return toast("Введите промокод.");
  try {
    const r = await fetch("/api/profile/promo/redeem", {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ code })
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || "Не удалось активировать промокод.");
    setBalance(data.balance);
    input.value = "";
    toast(data.wager > 0
      ? `Промокод активирован: +${Number(data.bonus).toFixed(0)} ⭐. Нужно поставить ${(Number(data.bonus) * Number(data.wager)).toFixed(0)} ⭐ перед выводом.`
      : `Промокод активирован: +${Number(data.bonus).toFixed(0)} ⭐`);
    loadProfile();
  } catch (e) { toast(e.message); }
}

$("#activatePromo").onclick = activatePromo;
$("#promoCode").addEventListener("keydown", e => {
  if (e.key === "Enter") activatePromo();
});

$("#createPromo").onclick = async () => {
  const code = $("#adminPromoCode").value.trim();
  const bonus = Number($("#adminPromoBonus").value);
  const maxUses = Number($("#adminPromoUses").value);
  const wagerInput = $("#adminPromoWager");
  const wager = wagerInput && wagerInput.value.trim() !== "" ? Number(wagerInput.value) : 0;
  const depositInput = $("#adminPromoDeposit");
  const requiredDeposit = depositInput && depositInput.value.trim() !== "" ? Number(depositInput.value) : 0;
  if (!code) return toast("Введите код промокода.");
  if (!Number.isInteger(bonus) || bonus <= 0) return toast("Введите целый бонус.");
  if (!Number.isInteger(maxUses) || maxUses <= 0) return toast("Введите лимит активаций.");
  if (!Number.isFinite(wager) || wager < 0) return toast("Вагер должен быть числом от 0 и выше.");
  if (!Number.isFinite(requiredDeposit) || requiredDeposit < 0) return toast("Минимальный депозит должен быть 0 или больше.");
  try {
    await adminFetch("/api/admin/promos", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code, bonus, maxUses, wager, requiredDeposit })
    });
    $("#adminPromoCode").value = "";
    $("#adminPromoBonus").value = "";
    $("#adminPromoUses").value = "";
    if (wagerInput) wagerInput.value = "";
    if (depositInput) depositInput.value = "";
    toast("Промокод создан.");
    refreshAdmin();
  } catch (e) { toast(e.message); }
};

// ---------- UPGRADE (solo game) ----------
let upgradeSpinning = false;
let upgradeAccumDeg = 0;

const SOLO_HOUSE_EDGE_CLIENT = 0.08;
function upgradeChance() {
  const bet = Number($("#upgradeBet").value);
  const target = Number($("#upgradeTarget").value);
  const valid = Number.isFinite(bet) && Number.isFinite(target) && bet > 0 && target > bet;
  const fairChance = valid ? (bet / target) * 100 : 0;
  const chance = fairChance * (1 - SOLO_HOUSE_EDGE_CLIENT);
  return { bet, target, valid, fairChance, chance };
}

function renderUpgradeWheel() {
  const { valid, chance } = upgradeChance();
  const pct = valid ? chance : 0;
  $("#upgradeWheel").style.background = `conic-gradient(from 0deg at 50% 50%, #ff0d2d 0%, #ff0d2d ${pct}%, #141517 ${pct}%, #141517 100%)`;
  $("#upgradeChanceValue").textContent = pct.toFixed(2) + "%";
  // The colored arc just changed shape (new bet/target), so a pointer left
  // over from a previous spin no longer points at anything meaningful for
  // THIS arc — hide it until the next spin actually resolves. Otherwise the
  // old arrow can visually sit on the "wrong" color for the newly-typed
  // numbers, even though that old spin's result was computed correctly.
  if (!upgradeSpinning) {
    $("#upgradePointerOrbit").style.opacity = "0";
  }
}

$("#upgradeBet").addEventListener("input", renderUpgradeWheel);
$("#upgradeTarget").addEventListener("input", renderUpgradeWheel);

function openUpgrade() {
  if (!initData) return handleNotTelegram();
  $("#gamesList").classList.add("hidden");
  $("#upgradeGame").classList.remove("hidden");
  renderUpgradeWheel();
}

function closeUpgrade() {
  if (upgradeSpinning) return toast("Дождитесь окончания прокрутки.");
  $("#upgradeGame").classList.add("hidden");
  $("#gamesList").classList.remove("hidden");
}

function openIce() {
  if (!initData) return handleNotTelegram();
  $("#gamesList").classList.add("hidden");
  $("#bounceGame").classList.add("hidden");
  $("#upgradeGame").classList.add("hidden");
  $("#iceGame").classList.remove("hidden");
  if (window.__iceOnOpen) window.__iceOnOpen();
}

function closeIce() {
  $("#iceGame").classList.add("hidden");
  $("#gamesList").classList.remove("hidden");
}

if ($("#openIceArena")) $("#openIceArena").onclick = openIce;
if ($("#iceBack")) $("#iceBack").onclick = closeIce;

$("#openUpgrade").onclick = openUpgrade;
$("#upgradeBack").onclick = closeUpgrade;

function setUpgradeControlsDisabled(disabled) {
  $("#upgradeSpinBtn").disabled = disabled;
  $("#upgradeBet").disabled = disabled;
  $("#upgradeTarget").disabled = disabled;
}

function spinUpgradePointer(data) {
  const pointerOrbit = $("#upgradePointerOrbit");
  const current = upgradeAccumDeg % 360;
  const chance = Math.max(0, Math.min(100, Number(data?.chance) || 0));

  // Redraw the wheel using the SERVER's own chance value right before we
  // animate, so the yellow/gray boundary the player sees can never drift out
  // of sync with the boundary the server used to judge the roll (e.g. if the
  // bet/target inputs changed between placing the bet and the result coming
  // back, a wheel drawn from stale local input values would no longer match
  // what the server actually rolled against).
  $("#upgradeWheel").style.background = `conic-gradient(from 0deg at 50% 50%, #ff0d2d 0%, #ff0d2d ${chance}%, #141517 ${chance}%, #141517 100%)`;

  // The result IS where the pointer lands — not the other way around. The
  // server rolls one real random number (0–100) and derives both the win
  // flag and this exact landing percentage from it, so the pointer must be
  // taken to this precise position, not nudged to the "safe" middle of
  // whichever zone the server says is correct. If it stops on yellow, that's
  // a win because it's on yellow; if it stops on gray, that's a loss because
  // it's on gray — the color under the pointer is the single source of truth.
  let landingPercent = Number(data?.rollPercent);
  if (!Number.isFinite(landingPercent)) landingPercent = data?.win ? chance / 2 : chance + (100 - chance) / 2;
  landingPercent = Math.max(0, Math.min(99.999999, landingPercent));

  const targetAngle = landingPercent * 3.6;
  pointerOrbit.style.opacity = "1";
  pointerOrbit.style.transition = "none";
  pointerOrbit.style.transform = `rotate(${current}deg)`;
  void pointerOrbit.offsetWidth;

  // `targetAngle` is an absolute point on the wheel. On later spins the
  // arrow begins at the previous point, so add only the clockwise distance
  // TO the new point. Adding both angles made later results land visibly in
  // the wrong sector even though the server had selected the correct one.
  const distanceToTarget = (targetAngle - current + 360) % 360;
  const next = current + 360 * 6 + distanceToTarget;
  pointerOrbit.style.transition = "transform 6.2s cubic-bezier(.10,.72,.12,1)";
  pointerOrbit.style.transform = `rotate(${next}deg)`;
  upgradeAccumDeg = next;
}

$("#upgradeSpinBtn").onclick = () => {
  if (!initData) return handleNotTelegram();
  if (upgradeSpinning) return;

  const { bet, target } = upgradeChance();
  if (!Number.isInteger(bet) || bet <= 0) return toast("Введите целую ставку в Stars.");
  if (!Number.isInteger(target) || target <= bet) return toast("Цель должна быть целым числом и больше ставки.");
  if (bet > currentBalance) return toast("Недостаточно Stars на балансе.");

  upgradeSpinning = true;
  setUpgradeControlsDisabled(true);
  socket.emit("upgrade_spin", { bet, target });
};

function showUpgradeBanner(data) {
  // The banner follows the exact sector under the arrow, rather than a
  // separate result flag. The server uses this same comparison to pay out.
  const isWin = Number(data?.rollPercent) < Number(data?.chance);
  const card = $("#upgradeBannerCard");
  card.classList.toggle("win", isWin);
  card.classList.toggle("lose", !isWin);
  $("#upgradeBannerIcon").textContent = isWin ? "👑" : "💥";
  $("#upgradeBannerTitle").textContent = isWin ? "УДАЧНЫЙ АПГРЕЙД!" : "АПГРЕЙД НЕ УДАЛСЯ";
  $("#upgradeBannerAmount").textContent = (isWin ? "+" : "-") + Number(isWin ? data.payout : data.bet).toFixed(2) + " ⭐";
  $("#upgradeBannerDetail").textContent = `Ставка ${Number(data.bet).toFixed(2)} ⭐ → Цель ${Number(data.target).toFixed(2)} ⭐ · Шанс ${Number(data.chance).toFixed(2)}%`;
  openModal($("#upgradeBanner"));
}
$("#upgradeBannerClose").onclick = () => {
  closeModal($("#upgradeBanner"));
  // Once the result is acknowledged, the arrow has done its job — hide it
  // so nothing is left resting in the background for the next round.
  $("#upgradePointerOrbit").style.opacity = "0";
};

$("#upgradeBannerX").onclick = () => $("#upgradeBannerClose").click();

socket.on("upgrade_result", data => {
  spinUpgradePointer(data);
  setTimeout(() => {
    upgradeSpinning = false;
    setUpgradeControlsDisabled(false);
    showUpgradeBanner(data);
  }, 6350);
});

socket.on("disconnect", () => {
  let changed = false;
  if (upgradeSpinning) {
    upgradeSpinning = false;
    setUpgradeControlsDisabled(false);
    $("#upgradePointerOrbit").style.opacity = "0";
    changed = true;
  }
  if (bounceResetRound()) changed = true;
  if (changed) toast("Соединение потеряно. Попробуйте ещё раз.", "error");
});


// ---------- ОТСКОК (solo game) ----------
// UI/animation is based on the supplied standalone wheel. The money source is
// the app's real PostgreSQL balance via the `bounce_spin` socket event.
const BOUNCE_MODES_CLIENT = [
  { n: "Лёгкий", s: 0.10, p: 0.65 },
  { n: "Средний", s: 0.15, p: 0.50 },
  { n: "Сложный", s: 0.20, p: 0.35 }
];
const BALL_SCALE=1.3,HOLE_SHRINK=1,RING_SPEED=1.5; // шар увеличен в 1.3× (BALL_SCALE), дырка как раньше; кольцо вращается в 1.5× быстрее
const BW=560,BH=600,BCX=BW/2,BCY=255,BRING=185,BBR=(18/1.3/1.5*1.3)*1.3*BALL_SCALE,BBAR=44,BFLOOR=BH-BBAR-BBR,BG=2190,BGAP=(.72/1.3*1.3)/HOLE_SHRINK,BGEFF=BGAP/2-Math.asin((BBR+4/1.3)/BRING),BOM=2.97*1.3*RING_SPEED,BRING0=2.2,BSPAWN=1.2,BVMIN=593,BVMAX=1061,BDT=1/240,BSLOW=.95,BSLOW_END=.75; // BSLOW: замедление всей игры (шар живёт дольше); BSLOW_END: слоу-мо на последних отскоках
const bounceRingAt=t=>BRING0+BOM*t;
const bounceCv=$("#bounceCanvas");
const bounceC=bounceCv?.getContext("2d");
function bounceQualityDpr(){const cap=window.graphicsQuality==="eco"?1:window.graphicsQuality==="high"?2:1.35;return Math.min(window.devicePixelRatio||1,cap)}
let bounceDpr=bounceQualityDpr();
function updateBounceCanvasQuality(){const next=bounceQualityDpr();if(next===bounceDpr)return;bounceDpr=next;if(bounceCv){bounceCv.width=BW*bounceDpr;bounceCv.height=BH*bounceDpr}}
if (bounceCv) { bounceCv.width=BW*bounceDpr; bounceCv.height=BH*bounceDpr; }
window.addEventListener("graphicsqualitychange",updateBounceCanvasQuality);
const bounceStars=Array.from({length:70},()=>[Math.random()*BW,Math.random()*(BH-BBAR),.2+Math.random()*.6]);
let bounceMode=0,bounceBetValue=1,bouncePhase="idle",bounceSpinResult=null,bounceS=null,bounceWin=false,bounceMult=0,bounceClk=0,bounceZoneW=BW*BOUNCE_MODES_CLIENT[0].p,bounceGlow=0,bounceFlash=0,bounceMsg=null,bounceTrail=[],bounceAcc=0,bounceLast=0,bounceSp=0,bouncePop=0,bounceT=4,bounceSpawn=0,bounceRenderStarted=false,bounceRate=1;
let bouncePlanToken=0,bounceFreezeClk=false,bounceMsgAge=0;

// ---- Общие мелочи для игр: вибрация и запоминание ставки/режима (localStorage, только на устройстве) ----
window.ringHaptic = window.ringHaptic || function (kind) {
  try {
    const h = window.Telegram && window.Telegram.WebApp && window.Telegram.WebApp.HapticFeedback;
    if (h) {
      if (kind === "win") h.notificationOccurred("success");
      else if (kind === "lose") h.notificationOccurred("error");
      else h.impactOccurred("light");
      return;
    }
    if (navigator.vibrate) navigator.vibrate(kind === "win" ? [30, 40, 30] : kind === "lose" ? [90] : 10);
  } catch (e) {}
};
window.ringPrefs = window.ringPrefs || {
  get(key, def) { try { const v = JSON.parse(localStorage.getItem("ring_pref_" + key)); return v == null ? def : v; } catch (e) { return def; } },
  set(key, val) { try { localStorage.setItem("ring_pref_" + key, JSON.stringify(val)); } catch (e) {} }
};
// восстановление последней ставки и режима ОТСКОКА
{
  const p = window.ringPrefs.get("bounce", null);
  if (p) {
    if (Number.isInteger(p.mode) && BOUNCE_MODES_CLIENT[p.mode]) { bounceMode = p.mode; bounceZoneW = BW * BOUNCE_MODES_CLIENT[bounceMode].p; }
    if (Number(p.bet) >= 0.1) bounceBetValue = Math.min(50000, Math.round(Number(p.bet) * 100) / 100);
  }
}
let bounceRepeatData = null;
function bounceSavePrefs(bet) { window.ringPrefs.set("bounce", { bet: bet == null ? bounceBetValue : bet, mode: bounceMode }); }
function bounceRenderRepeat() {
  const b = bounceUi("bounceRepeat"); if (!b) return;
  b.classList.toggle("hidden", !bounceRepeatData);
  if (bounceRepeatData) b.textContent = "↻ Повторить · " + bounceRepeatData.bet + " ⭐ · " + BOUNCE_MODES_CLIENT[bounceRepeatData.mode].n;
}
function bounceResetRound(errText){
  if(bouncePhase!=="waiting"&&bouncePhase!=="play")return false;
  bouncePlanToken++;bounceFreezeClk=false; // отменяем незавершённый расчёт траектории
  bouncePhase="idle";
  bounceSetControls(false);
  bounceUi("bouncePlay").textContent="Играть";
  if(errText!==undefined)bounceUi("bounceErr").textContent=errText;
  return true;
}
const bounceUi = id => $("#"+id);

const BounceAudioContext = window.AudioContext || window.webkitAudioContext;
let bounceActx = null;
let bounceSoundMuted = false;
function bounceActxGet(){
  if(!BounceAudioContext) return null;
  if(!bounceActx) bounceActx = new BounceAudioContext();
  if(bounceActx.state === "suspended") bounceActx.resume().catch(()=>{});
  return bounceActx;
}
function bounceEnvGain(ctx,t0,peak,atk,dec){
  const g=ctx.createGain();
  g.gain.setValueAtTime(0,t0);
  g.gain.linearRampToValueAtTime(peak,t0+atk);
  g.gain.exponentialRampToValueAtTime(.0001,t0+atk+dec);
  return g;
}
function bouncePlaySpawn(){
  if(bounceSoundMuted)return;
  const ctx=bounceActxGet(); if(!ctx)return;
  const t0=ctx.currentTime;
  const o=ctx.createOscillator();o.type='sine';
  o.frequency.setValueAtTime(260,t0);
  o.frequency.exponentialRampToValueAtTime(640,t0+.14);
  const g=bounceEnvGain(ctx,t0,.13,.01,.16);
  o.connect(g);g.connect(ctx.destination);o.start(t0);o.stop(t0+.18);
}
function bouncePlayBounceSound(n){
  if(bounceSoundMuted)return;
  const ctx=bounceActxGet(); if(!ctx)return;
  const t0=ctx.currentTime;
  const f=520+Math.min(n,14)*34;
  const o=ctx.createOscillator();o.type='triangle';
  o.frequency.setValueAtTime(f,t0);
  o.frequency.exponentialRampToValueAtTime(f*.6,t0+.08);
  const g=bounceEnvGain(ctx,t0,.2,.002,.1);
  o.connect(g);g.connect(ctx.destination);o.start(t0);o.stop(t0+.12);
  const bl=ctx.createBuffer(1,Math.floor(ctx.sampleRate*.018),ctx.sampleRate),d=bl.getChannelData(0);
  for(let i=0;i<d.length;i++)d[i]=(Math.random()*2-1)*(1-i/d.length);
  const ns=ctx.createBufferSource();ns.buffer=bl;
  const ng=bounceEnvGain(ctx,t0,.08,.001,.018);
  const hp=ctx.createBiquadFilter();hp.type='highpass';hp.frequency.value=1900;
  ns.connect(hp);hp.connect(ng);ng.connect(ctx.destination);ns.start(t0);
}
function bouncePlayWinSound(mult){
  if(bounceSoundMuted)return;
  const ctx=bounceActxGet(); if(!ctx)return;
  const t0=ctx.currentTime;
  const notes=mult>=2?[523.25,659.25,783.99,1046.5]:[523.25,659.25,783.99];
  notes.forEach((f,i)=>{
    const t=t0+i*.075,o=ctx.createOscillator();o.type='triangle';o.frequency.value=f;
    const g=bounceEnvGain(ctx,t,.16,.005,.22);o.connect(g);g.connect(ctx.destination);o.start(t);o.stop(t+.26);
  });
}
function bouncePlayLoseSound(){
  if(bounceSoundMuted)return;
  const ctx=bounceActxGet(); if(!ctx)return;
  const t0=ctx.currentTime;
  const o=ctx.createOscillator();o.type='sawtooth';
  o.frequency.setValueAtTime(220,t0);
  o.frequency.exponentialRampToValueAtTime(90,t0+.32);
  const lp=ctx.createBiquadFilter();lp.type='lowpass';lp.frequency.value=700;
  const g=bounceEnvGain(ctx,t0,.15,.008,.34);
  o.connect(lp);lp.connect(g);g.connect(ctx.destination);o.start(t0);o.stop(t0+.36);
}
function bounceSyncSoundButton(){
  const btn=bounceUi('bounceSound');
  if(btn) { btn.textContent=bounceSoundMuted?'🔇':'🔊'; btn.classList.toggle('muted',bounceSoundMuted); }
}

function bounceReadBet(){
  const el=bounceUi("bounceBet");
  let v=parseFloat(String(el?.value ?? bounceBetValue).replace(",","."));
  if (!(v>=0.1)) v=0.1;
  v=Math.min(v,50000);
  bounceBetValue=Math.round(v*100)/100;
  if (el) el.value=bounceBetValue;
  [...document.querySelectorAll("#bounceQuick button[data-v]")].forEach(b=>b.classList.toggle("on",Number(b.dataset.v)===bounceBetValue));
  return bounceBetValue;
}
function bounceSetBet(v){
  v=Math.max(.1,Math.min(50000,Math.round(Number(v)*100)/100));
  bounceBetValue=v;
  const el=bounceUi("bounceBet");
  if(el)el.value=v;
  [...document.querySelectorAll("#bounceQuick button[data-v]")].forEach(b=>b.classList.toggle("on",Number(b.dataset.v)===v));
  return v;
}
function bounceMk(a,v,g0){return{t:0,g0,x:BCX,y:BCY-30,px:BCX,py:BCY-30,vx:Math.cos(a)*v,vy:Math.sin(a)*v,b:0,ph:0,done:0,bad:0,hit:0,out:0}}
function bounceStep(q){
  q.t+=BDT;q.vy+=BG*BDT;q.x+=q.vx*BDT;q.y+=q.vy*BDT;
  const dx=q.x-BCX,dy=q.y-BCY,d=Math.hypot(dx,dy);
  // Кольцо — сплошная стенка толщиной 2·BBR по всей окружности, кроме реальной дырки.
  // Раньше после касания в зоне дырки стенка отключалась до полного вылета, и вращающееся
  // кольцо «проезжало» сквозь шар. Теперь дырка проверяется в каждом кадре.
  if(d>BRING-BBR&&d<BRING+BBR){
    let f=Math.atan2(dy,dx)-(q.g0+BOM*q.t);f=Math.atan2(Math.sin(f),Math.cos(f));
    if(Math.abs(f)>=BGEFF){
      const nx=dx/d,ny=dy/d,vn=q.vx*nx+q.vy*ny,inside=d<BRING;
      if(inside){
        if(vn>0){q.vx-=2*vn*nx;q.vy-=2*vn*ny;const sp=Math.hypot(q.vx,q.vy),k=Math.min(Math.max(sp,BVMIN),BVMAX)/sp;q.vx*=k;q.vy*=k;q.b++;q.hit=1}
        q.x=BCX+nx*(BRING-BBR);q.y=BCY+ny*(BRING-BBR);
      }else{
        if(vn<0){q.vx-=1.75*vn*nx;q.vy-=1.75*vn*ny;q.b++;q.hit=1}
        q.x=BCX+nx*(BRING+BBR);q.y=BCY+ny*(BRING+BBR);
      }
    }
  }
  if(q.x<BBR||q.x>BW-BBR){q.vx=-q.vx;q.x=Math.min(Math.max(q.x,BBR),BW-BBR)}
  if(q.y>=BFLOOR)q.done=1;
  if(q.t>bounceT+.6){q.bad=1;q.done=1}
}
// Подбор траектории идёт кусками по ~8 мс с отдачей управления браузеру — интерфейс не фризится.
// Симуляция обрывается, как только отскоков стало больше нужного (дальше считать бессмысленно).
async function bouncePlan(g0,winTarget,targetBounces){
  const px=BOUNCE_MODES_CLIENT[bounceMode].p*BW;
  const target=Math.max(1,Math.min(25,Number(targetBounces)||1));
  const token=++bouncePlanToken;
  // Сервер — источник истины по числу отскоков: ищем траекторию с точно таким же числом касаний стенки.
  const stages=[{gap:24,n:40000},{gap:-1,n:40000}]; // 2-й этап: без запаса у границы зон
  for(const st of stages){
    let i=0;
    while(i<st.n){
      const t0=performance.now();
      while(i<st.n&&performance.now()-t0<8){
        i++;
        const a=Math.random()*6.283,v=BVMIN+Math.random()*210,q=bounceMk(a,v,g0);
        while(!q.done&&q.b<=target)bounceStep(q);
        if(!q.done||q.bad||q.b!==target||Math.abs(q.x-px)<st.gap)continue;
        if((q.x<px)===winTarget)return {a,v};
      }
      await new Promise(r=>setTimeout(r,0));
      if(token!==bouncePlanToken)return null; // раунд отменён
    }
  }
  return {a:winTarget?Math.PI:0.2,v:520}; // крайний запасной вариант
}
function bounceSetControls(disabled){
  const ids=["bouncePlay","bounceBet","bounceDec","bounceInc","bounceRepeat"];
  ids.forEach(id=>{const el=bounceUi(id);if(el)el.disabled=disabled});
  [...document.querySelectorAll("#bounceTabs button,#bounceQuick button")].forEach(el=>el.disabled=disabled);
}
function renderBounceTabs(){
  const root=bounceUi("bounceTabs");if(!root)return;
  root.innerHTML=BOUNCE_MODES_CLIENT.map((m,i)=>`<button type="button" class="${i===bounceMode?'on':''}" data-mode="${i}"><b>${m.n}</b><small>+${m.s}× · ${Math.round(m.p*100)}% зелёной</small></button>`).join("");
  root.querySelectorAll("button").forEach(b=>b.onclick=()=>{if(bouncePhase!=="play"){bounceMode=Number(b.dataset.mode);renderBounceTabs();bounceRenderTag();bounceSavePrefs();}});
}
function bounceRenderTag(){
  const m=BOUNCE_MODES_CLIENT[bounceMode];
  const tag=bounceUi("bounceTag");
  if(tag)tag.innerHTML=`${m.n}<b>Каждый отскок +${m.s}×</b>`;
}
function bounceRenderStage(now){
  if(!bounceC)return;
  const graphicsQuality=window.graphicsQuality||"balanced";
  const gameEl=bounceUi("bounceGame");
  if(gameEl&&gameEl.classList.contains("hidden")&&bouncePhase!=="play"&&bouncePhase!=="waiting"){bounceRenderStarted=false;return;} // экран закрыт — не тратим батарею
  const raw=(now-bounceLast)/1000||0;bounceLast=now;
  // обычный кадр ≤50 мс; после сворачивания вкладки догоняем реальное время (до 4 с), чтобы раунд не «замирал»
  const rd=Math.min(raw,raw>.5?4:.05);
  if(!bounceFreezeClk)bounceClk+=rd;
  const dt=rd;
  let ga=bounceRingAt(bounceClk-BDT);
  if(bouncePhase==='play'){
    let go=bounceSp>=BSPAWN;
    const bounceTotal=Number(bounceSpinResult?.bounces)||0;
    const tgtRate=(bounceS&&bounceTotal>=2&&bounceS.b>=bounceTotal-1)?BSLOW_END:BSLOW;
    bounceRate+=(tgtRate-bounceRate)*Math.min(1,dt*6);
    if(!go){const n=bounceSp+dt;if(n>=BSPAWN){bounceAcc=(n-BSPAWN)*bounceRate;bounceSp=BSPAWN;go=true}else bounceSp=n}
    else bounceAcc+=dt*bounceRate;
    if(go&&bounceS){
      while(bounceAcc>=BDT&&!bounceS.done){bounceS.px=bounceS.x;bounceS.py=bounceS.y;bounceStep(bounceS);bounceAcc-=BDT;if(bounceS.hit){bounceS.hit=0;bounceGlow=1;bouncePop=1;bounceMult=Number((bounceS.b*BOUNCE_MODES_CLIENT[bounceMode].s).toFixed(2));if(dt<=.1)bouncePlayBounceSound(bounceS.b);}}
      // кольцо привязано ко времени симуляции, поэтому замедление не рассинхронизирует дырку и шар
      ga=bounceS.g0+BOM*(bounceS.t+bounceAcc);bounceClk=(ga-BRING0)/BOM;
      if(bounceS.done){
        bouncePhase='result';
        bounceMult=Number((bounceS.b*BOUNCE_MODES_CLIENT[bounceMode].s).toFixed(2));
        bounceMsg={win:bounceWin,t:bounceWin?'+'+Number(bounceSpinResult?.payout||0).toFixed(2)+' ⭐':'Проигрыш',s:bounceWin?(Number(bounceSpinResult?.multiplier||bounceMult).toFixed(2)+'×'):'Шар упал в красную зону'};bounceMsgAge=0;
        bounceFlash=1;
        const history=bounceUi("bounceHistory");
        if(history){
          const chip=document.createElement("span");
          chip.className=`chip ${bounceWin ? "w" : "l"}`;
          chip.textContent=`${Number(bounceSpinResult?.multiplier||0).toFixed(2)}×`;
          history.prepend(chip);
          while(history.children.length>30)history.lastElementChild.remove();
        }
        bounceSetControls(false);
        bounceUi("bouncePlay").textContent="Играть";
        // Раунд закончился в момент попадания в зону — сразу сообщаем серверу, чтобы можно было начать новый.
        socket.emit("bounce_done");
        setBalance(bounceSpinResult?.balance);
        if(bounceWin)bouncePlayWinSound(bounceMult);else bouncePlayLoseSound();window.ringHaptic(bounceWin?"win":"lose"); // результат показан плашкой на поле — отдельный toast не нужен
      }
    }
  }
  if(bouncePhase==='result'&&bounceS){/* keep the final ball frozen */}
  bounceGlow=Math.max(0,bounceGlow-dt*3);bouncePop=Math.max(0,bouncePop-dt*5);bounceFlash=Math.max(0,bounceFlash-dt*.8);
  bounceZoneW+=(BOUNCE_MODES_CLIENT[bounceMode].p*BW-bounceZoneW)*Math.min(1,dt*8);
  bounceC.setTransform(bounceDpr,0,0,bounceDpr,0,0);
  const bg=bounceC.createRadialGradient(BCX,BCY,20,BCX,BCY,420);bg.addColorStop(0,'#220c10');bg.addColorStop(1,'#070404');bounceC.fillStyle=bg;bounceC.fillRect(0,0,BW,BH);
  bounceC.strokeStyle='rgba(255,22,53,.05)';bounceC.lineWidth=1;bounceC.beginPath();for(let i=40;i<BW;i+=40){bounceC.moveTo(i,0);bounceC.lineTo(i,BH)}for(let j=40;j<BH;j+=40){bounceC.moveTo(0,j);bounceC.lineTo(BW,j)}bounceC.stroke();
  bounceC.fillStyle='#ff7e8f';const starStride=graphicsQuality==="eco"?4:graphicsQuality==="balanced"?2:1;for(let i=0;i<bounceStars.length;i+=starStride){const q=bounceStars[i];bounceC.globalAlpha=q[2];bounceC.fillRect(q[0],q[1],1.6,1.6)}bounceC.globalAlpha=1;
  bounceC.textAlign='center';bounceC.textBaseline='middle';bounceC.font='800 '+(64+bouncePop*12)+'px "Segoe UI",system-ui,sans-serif';bounceC.fillStyle='rgba(255,138,31,'+(.18+bouncePop*.22)+')';bounceC.fillText(bounceMult.toFixed(2)+'×',BCX,BCY);
  const a0=ga+BGAP/2,a1=ga+6.2832-BGAP/2;bounceC.lineCap='round';bounceC.strokeStyle='rgba(255,22,53,.14)';bounceC.lineWidth=18;bounceC.beginPath();bounceC.arc(BCX,BCY,BRING,a0,a1);bounceC.stroke();bounceC.shadowColor='#ff1635';bounceC.shadowBlur=graphicsQuality==="eco"?0:14+bounceGlow*24;bounceC.strokeStyle='#ff2542';bounceC.lineWidth=6;bounceC.beginPath();bounceC.arc(BCX,BCY,BRING,a0,a1);bounceC.stroke();bounceC.shadowBlur=0;bounceC.fillStyle='#f6ebed';[a0,a1].forEach(a=>{bounceC.beginPath();bounceC.arc(BCX+BRING*Math.cos(a),BCY+BRING*Math.sin(a),5,0,6.2832);bounceC.fill()});
  let ballX=null,ballY=null,alpha=1,scale=1;
  if(bounceS){
    if(bouncePhase==='idle'){alpha=0}
    const k=(bouncePhase==='play'&&bounceSp>=BSPAWN&&!bounceS.done)?bounceAcc/BDT:1;ballX=bounceS.px+(bounceS.x-bounceS.px)*k;ballY=bounceS.py+(bounceS.y-bounceS.py)*k;
    if(bouncePhase==='play'&&bounceSp<BSPAWN){const u=bounceSp/BSPAWN,e=Math.min(1,Math.max(0,(u-.2)/.7)),v=e-1;scale=.55+.45*(1+2.7*v*v*v+1.7*v*v);alpha=Math.min(1,Math.max(0,(u-.2)/.45));alpha=alpha*alpha*(3-2*alpha)}
  }
  if(ballX!=null){
    if(bouncePhase==='play'&&bounceSp>=BSPAWN){bounceTrail.push([ballX,ballY]);const trailLimit=graphicsQuality==="eco"?5:graphicsQuality==="balanced"?14:24;if(bounceTrail.length>trailLimit)bounceTrail.splice(0,bounceTrail.length-trailLimit)}
    for(let i=0;i<bounceTrail.length;i++){const u=(i+1)/bounceTrail.length,p=bounceTrail[i],tr=BBR*(.12+.8*u),gr=bounceC.createRadialGradient(p[0],p[1],0,p[0],p[1],tr);gr.addColorStop(0,'rgba(255,170,60,'+(u*u*.5)+')');gr.addColorStop(1,'rgba(255,12,44,0)');bounceC.fillStyle=gr;bounceC.beginPath();bounceC.arc(p[0],p[1],tr,0,6.2832);bounceC.fill()}
    const r=BBR*scale;bounceC.globalAlpha=alpha;const hg=bounceC.createRadialGradient(ballX,ballY,r*.6,ballX,ballY,r*2.1);hg.addColorStop(0,'rgba(255,31,61,.45)');hg.addColorStop(1,'rgba(255,31,61,0)');bounceC.fillStyle=hg;bounceC.beginPath();bounceC.arc(ballX,ballY,r*2.1,0,6.2832);bounceC.fill();const sg=bounceC.createRadialGradient(ballX-r*.35,ballY-r*.4,r*.1,ballX,ballY,r);sg.addColorStop(0,'#e5cace');sg.addColorStop(.35,'#ff3b55');sg.addColorStop(.75,'#ed0f2d');sg.addColorStop(1,'#b20a20');bounceC.fillStyle=sg;bounceC.beginPath();bounceC.arc(ballX,ballY,r,0,6.2832);bounceC.fill();bounceC.strokeStyle='rgba(255,118,137,.35)';bounceC.lineWidth=1.2;bounceC.stroke();bounceC.fillStyle='rgba(255,255,255,.5)';bounceC.beginPath();bounceC.ellipse(ballX-r*.3,ballY-r*.38,r*.28,r*.18,-.6,0,6.2832);bounceC.fill();bounceC.globalAlpha=1;
    if(bouncePhase==='play'){const tx=bounceMult.toFixed(2)+'×';bounceC.font='700 '+(14+bouncePop*4)+'px "Segoe UI",system-ui,sans-serif';const tw=bounceC.measureText(tx).width+16;bounceC.fillStyle='rgba(15,9,10,.8)';bounceC.beginPath();bounceC.roundRect(ballX-tw/2,ballY-BBR-28,tw,22,7);bounceC.fill();bounceC.fillStyle='#ff3d57';bounceC.fillText(tx,ballX,ballY-BBR-16)}
  }
  const y=BH-BBAR;bounceC.fillStyle='rgba(59,212,124,.2)';bounceC.fillRect(0,y,bounceZoneW,BBAR);bounceC.fillStyle='#3bd47c';bounceC.fillRect(0,y,bounceZoneW,2);bounceC.fillStyle='rgba(239,75,75,.18)';bounceC.fillRect(bounceZoneW,y,BW-bounceZoneW,BBAR);bounceC.fillStyle='#ef4b4b';bounceC.fillRect(bounceZoneW,y,BW-bounceZoneW,2);bounceC.save();bounceC.beginPath();bounceC.rect(bounceZoneW,y,BW-bounceZoneW,BBAR);bounceC.clip();bounceC.strokeStyle='rgba(239,75,75,.22)';bounceC.lineWidth=2;bounceC.beginPath();for(let x=bounceZoneW-BBAR;x<BW;x+=9){bounceC.moveTo(x,y+BBAR);bounceC.lineTo(x+BBAR,y)}bounceC.stroke();bounceC.restore();
  if(bounceFlash>0&&bounceMsg){bounceC.fillStyle='rgba(255,255,255,'+bounceFlash*.28+')';bounceMsg.win?bounceC.fillRect(0,y,bounceZoneW,BBAR):bounceC.fillRect(bounceZoneW,y,BW-bounceZoneW,BBAR)}
  bounceC.font='800 15px "Segoe UI",system-ui,sans-serif';bounceC.fillStyle='#3bd47c';bounceC.fillText('★ WIN',bounceZoneW/2,y+BBAR/2+2);bounceC.fillStyle='#ef4b4b';bounceC.fillText('0×',bounceZoneW+(BW-bounceZoneW)/2,y+BBAR/2+2);
  if(bounceMsg){
    bounceMsgAge+=dt;
    const k0=Math.min(1,bounceMsgAge/.38),e=1+2.70158*Math.pow(k0-1,3)+1.70158*Math.pow(k0-1,2);
    const col=bounceMsg.win?'59,212,124':'239,75,75';
    bounceC.save();bounceC.translate(BCX,BCY+82);bounceC.scale(e,e);bounceC.globalAlpha=Math.min(1,k0*1.6);
    bounceC.font='800 30px "Segoe UI",system-ui,sans-serif';
    const w=Math.max(bounceC.measureText(bounceMsg.t).width,170)+48,h=76;
    bounceC.shadowColor='rgba('+col+',.55)';bounceC.shadowBlur=graphicsQuality==="eco"?8:26;
    bounceC.fillStyle='rgba(15,9,10,.8)';bounceC.beginPath();bounceC.roundRect(-w/2,-h/2,w,h,20);bounceC.fill();
    bounceC.shadowBlur=0;bounceC.strokeStyle='rgba('+col+',.7)';bounceC.lineWidth=1.5;bounceC.stroke();
    bounceC.textAlign='center';bounceC.textBaseline='middle';
    bounceC.fillStyle='rgb('+col+')';bounceC.fillText(bounceMsg.t,0,-10);
    bounceC.font='600 13px "Segoe UI",system-ui,sans-serif';bounceC.fillStyle='rgba(231,204,209,.7)';bounceC.fillText(bounceMsg.s||'',0,20);
    bounceC.restore();
  }
  (window.requestGraphicsFrame||requestAnimationFrame)(bounceRenderStage);
}
function openBounce(){
  if(!initData)return handleNotTelegram();
  installBounceZoomLock();
  if(bounceRenderStarted===false){bounceRenderStarted=true;bounceLast=performance.now();(window.requestGraphicsFrame||requestAnimationFrame)(bounceRenderStage)}
  bouncePhase='idle';bounceMsg=null;bounceS=null;bounceSpinResult=null;bounceTrail=[];bounceMult=0;
  renderBounceTabs();
  bounceRenderTag();
  bounceUi("gamesList").classList.add("hidden");bounceUi("upgradeGame").classList.add("hidden");bounceUi("bounceGame").classList.remove("hidden");
  bounceSetBet(bounceBetValue);
  bounceUi("bounceBalance").textContent=currentBalance.toFixed(2);
}
function closeBounce(){
  if(bouncePhase==='play')return toast("Дождитесь окончания прокрутки.");
  bounceUi("bounceGame").classList.add("hidden");bounceUi("gamesList").classList.remove("hidden");
}
// ОТСКОК: предотвращаем системный pinch/gesture zoom внутри игрового экрана.
// Не меняет поведение остальных разделов приложения.
function installBounceZoomLock(){
  const root=bounceUi("bounceGame");
  if(!root || root.dataset.zoomLockInstalled) return;
  root.dataset.zoomLockInstalled="1";
  root.addEventListener("gesturestart",e=>e.preventDefault(),{passive:false});
  root.addEventListener("gesturechange",e=>e.preventDefault(),{passive:false});
  root.addEventListener("gestureend",e=>e.preventDefault(),{passive:false});
  root.addEventListener("touchstart",e=>{
    if(e.touches && e.touches.length>1) e.preventDefault();
  },{passive:false});
  root.addEventListener("touchmove",e=>{
    if(e.touches && e.touches.length>1) e.preventDefault();
  },{passive:false});
  root.addEventListener("wheel",e=>{
    if(e.ctrlKey) e.preventDefault();
  },{passive:false});
}

function bounceStart(){
  if(!initData)return handleNotTelegram();
  if(bouncePhase==='play')return;
  const bet=bounceReadBet();
  if(!Number.isFinite(bet)||bet<.1||bet>50000)return toast("Ставка должна быть от 0.1 до 50 000 Stars.");
  if(bet>currentBalance)return toast("Недостаточно Stars на балансе.");
  bounceSavePrefs(bet);bounceRepeatData={bet,mode:bounceMode};bounceRenderRepeat();bounceActxGet();bouncePhase='waiting';bounceMsg=null;bounceS=null;bounceTrail=[];bounceMult=0;bounceUi("bounceErr").textContent="";bounceSetControls(true);bounceUi("bouncePlay").textContent="Отправляем…";
  socket.emit("bounce_spin",{bet,modeIndex:bounceMode});
}
async function bouncePrepare(result){
  bounceSpinResult=result||{};bounceWin=!!result?.win;bounceT=60; /* запас: раунд заканчивается, когда шар сам упал в зону */bounceRate=BSLOW;
  bounceUi("bouncePlay").textContent="Готовим раунд…";
  bounceFreezeClk=true; // пока считаем траекторию, «время кольца» стоит — иначе дырка не совпадёт с расчётом
  const g0=bounceRingAt(bounceClk+BSPAWN);
  const p=await bouncePlan(g0,bounceWin,Number(result?.bounces)||1);
  bounceFreezeClk=false;
  if(!p||bouncePhase!=='waiting')return; // раунд отменён (ошибка/обрыв связи)
  bounceS=bounceMk(p.a,p.v,g0);bounceAcc=0;bounceSp=0;bouncePhase='play';bounceMult=0;bouncePlaySpawn();bounceMsg=null;bounceTrail=[];bounceFlash=0;bounceSetControls(true);bounceUi("bouncePlay").textContent="Идёт раунд…";
}
["openBounce"].forEach(id=>{const b=bounceUi(id);if(b)b.onclick=openBounce});
if(bounceUi("bounceBack"))bounceUi("bounceBack").onclick=closeBounce;
if(bounceUi("bouncePlay"))bounceUi("bouncePlay").onclick=bounceStart;
if(bounceUi("bounceSound"))bounceUi("bounceSound").onclick=()=>{ bounceSoundMuted=!bounceSoundMuted; bounceSyncSoundButton(); if(!bounceSoundMuted) bounceActxGet(); };
if(bounceUi("bounceBet"))bounceUi("bounceBet").onchange=bounceReadBet;
if(bounceUi("bounceDec"))bounceUi("bounceDec").onclick=()=>{const v=bounceReadBet();bounceSetBet(v>1?v-1:v-.1)};
if(bounceUi("bounceInc"))bounceUi("bounceInc").onclick=()=>{const v=bounceReadBet();bounceSetBet(v>=1?v+1:v+.1)};
if(bounceUi("bounceQuick")){
  [["Мин",()=>.1],["÷2",()=>bounceReadBet()/2],["×2",()=>Math.min(bounceReadBet()*2,50000)],["Макс",()=>Math.max(.1,Math.min(currentBalance,50000))]].forEach(([t,f])=>{const b=document.createElement("button");b.type="button";b.textContent=t;b.onclick=()=>bounceSetBet(Math.max(.1,f()));bounceUi("bounceQuick").append(b)});
  const sep=document.createElement("i");bounceUi("bounceQuick").append(sep);
  [1,5,25,100].forEach(v=>{const b=document.createElement("button");b.type="button";b.textContent=v;b.dataset.v=v;b.onclick=()=>bounceSetBet(v);bounceUi("bounceQuick").append(b)});
}
renderBounceTabs();bounceRenderTag();bounceSetBet(bounceBetValue);bounceSyncSoundButton();installBounceZoomLock();
if(bounceUi("bounceRepeat"))bounceUi("bounceRepeat").onclick=()=>{
  if(!bounceRepeatData||bouncePhase==="play"||bouncePhase==="waiting")return;
  bounceMode=bounceRepeatData.mode;renderBounceTabs();bounceRenderTag();bounceSetBet(bounceRepeatData.bet);bounceStart();
};

socket.on("bounce_result", result => { bouncePrepare(result).catch(() => bounceResetRound("Ошибка раунда.")); });
function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, ch => ({
    "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#039;"
  }[ch]));
}

setInterval(() => {
  if (currentState?.status === "COUNTDOWN") $("#timer").textContent = formatTimer(currentState.countdownEndsAt);
}, 250);

// If the page is opened outside Telegram, the server will reject the session.
if (!initData) setTimeout(handleNotTelegram, 500);

// ---------- Design pass: profile shortcut + top-up/withdraw tab switching ----------
const profileTopupBtn = $("#profileTopupBtn");
if (profileTopupBtn) profileTopupBtn.onclick = () => $("#topupBtn").click();

function switchToTopup() { closeModal(withdrawModal); $("#topupBtn").click(); }
function switchToWithdraw() { closeModal(topupModal); $("#withdrawBtn").click(); }
["tabGoWithdraw1", "tabGoWithdraw2"].forEach(id => { const b = $("#" + id); if (b) b.onclick = switchToWithdraw; });
["tabGoTopup", "tabGoTopup2"].forEach(id => { const b = $("#" + id); if (b) b.onclick = switchToTopup; });

// PVP card inside the Games grid jumps back to the PVP wheel view.
document.querySelectorAll('.game-card[data-view]').forEach(btn => {
  btn.onclick = () => setView(btn.dataset.view);
});

setTopupCurrency("STAR");
setWithdrawCurrency("STAR");
window.addEventListener("load", () => initTonConnect());

// ---------- PVP round history ----------
const historyModal = $("#historyModal");
const historyDetailModal = $("#historyDetailModal");
let historySearchTimer = null;

function formatHistoryDateTime(value) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  const date = `${String(d.getDate()).padStart(2, "0")}.${String(d.getMonth() + 1).padStart(2, "0")}.${d.getFullYear()}`;
  const time = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  return `${date} • ${time}`;
}

function shortenMiddle(value, head = 6, tail = 6) {
  const s = String(value || "");
  return s.length > head + tail + 3 ? `${s.slice(0, head)}...${s.slice(-tail)}` : s;
}

async function loadHistory(q = "") {
  const list = $("#historyList");
  const empty = $("#historyEmpty");
  try {
    const r = await fetch(`/api/pvp/history?q=${encodeURIComponent(q)}`, { cache: "no-store" });
    const data = await r.json();
    const rounds = Array.isArray(data.rounds) ? data.rounds : [];
    empty.classList.toggle("hidden", rounds.length > 0);
    list.innerHTML = rounds.map(round => {
      const w = round.winner;
      return `
        <button class="history-round" data-round="${round.roundNumber}">
          <div class="history-round-top">
            <span class="history-round-tag">
              <svg viewBox="0 0 23 23" fill="currentColor"><path d="M0.463147 0.087302C0.22178 0.205418 0.0317684 0.472461 0.00609109 0.73437C-0.0144507 0.924382 0.124207 1.30954 1.17184 3.9543C1.82918 5.60278 2.39921 7.00476 2.43516 7.06125C2.47111 7.11774 3.64713 8.18078 5.04397 9.42356C6.44082 10.6663 7.58089 11.6986 7.57575 11.7191C7.57062 11.7397 7.32412 12.0221 7.0314 12.3508L6.50244 12.9465L6.15837 12.6127C5.93241 12.397 5.7424 12.2635 5.60374 12.2224C5.07479 12.0632 4.56124 12.4432 4.56124 12.9927C4.56124 13.27 4.64854 13.4189 5.0183 13.7887C5.1929 13.9582 5.33156 14.1174 5.33156 14.143C5.33156 14.1739 4.22744 15.3088 2.87168 16.6646C0.155019 19.3915 0.16529 19.3761 0.0317684 20.1669C-0.235275 21.7743 1.22319 23.2328 2.83059 22.9658C3.62145 22.8322 3.60605 22.8425 6.33297 20.1259C7.68873 18.7701 8.82367 17.666 8.85448 17.666C8.88016 17.666 9.03936 17.8046 9.20883 17.9792C9.60939 18.3798 9.74805 18.4517 10.0819 18.426C10.4003 18.4003 10.5851 18.2771 10.7238 17.9946C10.9189 17.5992 10.8265 17.2859 10.3592 16.8135L10.051 16.5002L10.7443 15.8788C11.1244 15.5348 11.4633 15.2523 11.4941 15.2523C11.5249 15.2523 11.8639 15.5348 12.2439 15.8788L12.9372 16.5002L12.629 16.8135C12.1617 17.2859 12.0693 17.5992 12.2644 17.9946C12.4031 18.2771 12.588 18.4003 12.9064 18.426C13.2402 18.4517 13.3788 18.3798 13.7794 17.9792C13.9489 17.8046 14.1081 17.666 14.1337 17.666C14.1645 17.666 15.2995 18.7701 16.6552 20.1259C19.3822 22.8425 19.3668 22.8322 20.1576 22.9658C21.7753 23.2379 23.2389 21.7589 22.9513 20.1413C22.8127 19.3555 22.8332 19.3812 20.1165 16.6646C18.7659 15.3088 17.6567 14.1739 17.6567 14.143C17.6567 14.1174 17.7953 13.9582 17.9699 13.7887C18.3705 13.3881 18.4424 13.2495 18.4167 12.9157C18.391 12.5973 18.2678 12.4124 17.9853 12.2737C17.5745 12.0683 17.3023 12.1556 16.8042 12.6435L16.4909 12.9465L16.0903 12.4946C15.8695 12.2481 15.6179 11.9707 15.5357 11.8834L15.3868 11.7191L17.8723 9.50573C19.2384 8.28349 20.4144 7.21532 20.4863 7.12288C20.6558 6.91746 22.9975 1.03736 22.9975 0.816537C22.9975 0.605983 22.8229 0.287585 22.6329 0.154063C22.2734 -0.10271 22.3196 -0.118116 19.0432 1.18115C17.3896 1.83849 15.9774 2.42393 15.9003 2.48556C15.8233 2.54205 14.8116 3.65644 13.651 4.95572C12.4904 6.25499 11.5198 7.31803 11.4941 7.31803C11.4684 7.31803 10.5132 6.26526 9.36289 4.98139C8.21769 3.69753 7.206 2.58313 7.11356 2.5061C6.90301 2.3315 1.02805 -7.3352e-07 0.796951 -7.3352e-07C0.704513 -7.3352e-07 0.555585 0.0410829 0.463147 0.087302Z"/></svg>
              Ролл
            </span>
            <span>#${round.roundNumber} • ${formatHistoryDateTime(round.createdAt)}</span>
          </div>
          <div class="history-round-body">
            <div class="history-round-winner">
              ${avatarMarkup(w?.avatar, w?.name)}
              <div class="history-round-winner-info">
                <div class="history-round-name">${escapeHtml(w?.name || "Игрок")}</div>
                <div class="history-round-pct">${Number(w?.percentage || 0).toFixed(2)}%</div>
              </div>
            </div>
            <div class="history-round-right">
              <div class="history-round-amount">+${Number(round.payout).toFixed(2)} ⭐</div>
              <div class="history-round-mult">${round.multiplier}x</div>
            </div>
          </div>
        </button>`;
    }).join("");
    list.querySelectorAll(".history-round").forEach(btn => {
      btn.onclick = () => openHistoryDetail(btn.dataset.round);
    });
  } catch {
    empty.classList.remove("hidden");
    list.innerHTML = "";
  }
}

async function openHistoryDetail(roundNumber) {
  try {
    const r = await fetch(`/api/pvp/history/${encodeURIComponent(roundNumber)}`, { cache: "no-store" });
    if (!r.ok) throw new Error();
    const data = await r.json();
    $("#historyDetailTitle").textContent = `Ролл #${data.roundNumber}`;
    $("#historyDetailDate").textContent = formatHistoryDateTime(data.createdAt);
    $("#historyHashValue").textContent = shortenMiddle(data.hash);
    $("#historyHashRow").dataset.copy = data.hash || "";
    $("#historySeedValue").textContent = shortenMiddle(data.seed);
    $("#historySeedRow").dataset.copy = data.seed || "";
    $("#historyDetailPlayers").innerHTML = (data.players || []).map(p => `
      <div class="history-player-row">
        ${avatarMarkup(p.avatar, p.name)}
        <div>
          <div class="history-player-name">${escapeHtml(p.name || "Игрок")}</div>
          <div class="history-player-pct">${Number(p.percentage || 0).toFixed(2)}%</div>
        </div>
        <div class="history-player-bet">${Number(p.bet).toFixed(2)} ⭐</div>
      </div>`).join("");
    openModal(historyDetailModal);
  } catch {
    toast("Не удалось загрузить игру.");
  }
}

const openHistoryBtn = $("#openHistoryBtn");
if (openHistoryBtn) openHistoryBtn.onclick = () => { openModal(historyModal); loadHistory($("#historySearch").value.trim()); };
const historyCloseBtn = $("#historyClose");
if (historyCloseBtn) historyCloseBtn.onclick = () => closeModal(historyModal);
const historyDetailCloseBtn = $("#historyDetailClose");
if (historyDetailCloseBtn) historyDetailCloseBtn.onclick = () => closeModal(historyDetailModal);

const historySearchInput = $("#historySearch");
if (historySearchInput) {
  historySearchInput.addEventListener("input", () => {
    clearTimeout(historySearchTimer);
    historySearchTimer = setTimeout(() => loadHistory(historySearchInput.value.trim()), 250);
  });
}

[$("#historyHashRow"), $("#historySeedRow")].forEach(btn => {
  if (!btn) return;
  btn.onclick = () => {
    const value = btn.dataset.copy;
    if (!value || !navigator.clipboard) return;
    navigator.clipboard.writeText(value).then(() => toast("Скопировано"));
  };
});


// ===================== ICE ARENA (ported from RING123) =====================
(function () {
  // Ice Arena tab: reuses the host app's shared `socket` (socket.io client), `user`,
  // `currentBalance`, `isAdmin`, `toast`, `initData` and `handleNotTelegram` — all
  // already declared earlier in this same file. Nothing Telegram-specific is redone here.
  const $ = id => document.getElementById(id);
  const arena = $('iceArena'), puck = $('icePuck'), puckImg = puck.querySelector('.puck-img'), arrow = puck.querySelector('.ice-arrow'), ripple = puck.querySelector('.puck-ripple'), zoneMap = $('iceZoneMap'), legend = $('iceLegend'), winnerEl = $('iceWinner');
  const APPEAR = 2000, SPIN = 3400, HOLD = 700, INTRO = SPIN + HOLD, BASE_FLIGHT = 7000, CLOSE = 1000, PUCK = 24, S = 100, STILL_HOLD = 400;
  let W = arena.clientWidth || 358, skew = 0;
  let st = { status: 'waiting', players: [], online: 0 }, L = [];
  let plan = null, planFor = null, finished = false, phase = '', cam = null;
  // Аномалия "race": конвейер зон и шайба должны двигаться в одной системе координат —
  // раньше конвейер крутился по CSS-анимации сам по себе, а шайба ставилась по "статическим"
  // физическим координатам, из-за чего в момент остановки видимая под шайбой зона и реальный
  // победитель расходились (казалось, что результат "скачком" меняется). Теперь сдвиг конвейера
  // считается в JS от того же таймера, что и полёт шайбы, и шайба смещается на ту же величину —
  // они гарантированно совпадают на каждом кадре и одновременно замирают.
  const RACE_MS = 3600;
  let raceTrackEl = null, raceOffset = 0;

  const fmt = v => String(+Number(v).toFixed(3));
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  function place(x, y) { puck.style.transform = `translate3d(${(x * W / 100 - PUCK / 2).toFixed(2)}px,${(y * W / 100 - PUCK / 2).toFixed(2)}px,0)`; }
  window.addEventListener('resize', () => { W = arena.clientWidth || W; });
  place(50, 50); puck.style.visibility = 'hidden';

  // ---------- аватарка ----------
  function avatar(p, cls, size) {
    const el = document.createElement(p.photo ? 'img' : 'div');
    el.className = cls; el.style.width = el.style.height = size + 'px';
    const initial = () => { const d = document.createElement('div'); d.className = cls; d.style.cssText = `width:${size}px;height:${size}px;background:${p.color};font-size:${size * .45}px`; d.textContent = (p.name || '?')[0].toUpperCase(); return d; };
    if (p.photo) { el.src = p.photo; el.referrerPolicy = 'no-referrer'; el.onerror = () => el.replaceWith(initial()); return el; }
    return initial();
  }

  // ---------- геометрия зон ----------
  function clip(poly, a, b, c) { const out = []; for (let i = 0; i < poly.length; i++) { const p = poly[i], q = poly[(i + 1) % poly.length], dp = a * p[0] + b * p[1] - c, dq = a * q[0] + b * q[1] - c; if (dp <= 0) out.push(p); if (dp * dq < 0) { const t = dp / (dp - dq); out.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]); } } return out; }
  function cells() { return L.map(p => { let poly = [[0, 0], [S, 0], [S, S], [0, S]]; for (const o of L) { if (o === p || !poly.length) continue; poly = clip(poly, 2 * (o.sx - p.sx), 2 * (o.sy - p.sy), o.sx * o.sx + o.sy * o.sy - p.sx * p.sx - p.sy * p.sy + p.w - o.w); } return poly; }); }
  function info(poly) { let A = 0, cx = 0, cy = 0; for (let i = 0; i < poly.length; i++) { const p = poly[i], q = poly[(i + 1) % poly.length], f = p[0] * q[1] - q[0] * p[1]; A += f; cx += (p[0] + q[0]) * f; cy += (p[1] + q[1]) * f; } A /= 2; return A > 1e-9 ? { A, cx: cx / (6 * A), cy: cy / (6 * A) } : { A: 0, cx: 50, cy: 50 }; }
  function inr(poly, cx, cy) { let m = 1e9; for (let i = 0; i < poly.length; i++) { const p = poly[i], q = poly[(i + 1) % poly.length], dx = q[0] - p[0], dy = q[1] - p[1], l = Math.hypot(dx, dy); if (l > 1e-6) m = Math.min(m, Math.abs(dx * (cy - p[1]) - dy * (cx - p[0])) / l); } return m; }
  function solve() {
    const sum = L.reduce((s, p) => s + p.stake, 0);
    for (let it = 0; it < 400; it++) {
      const inf = cells().map(info);
      L.forEach((p, i) => { const e = p.stake / sum * S * S - inf[i].A, d = Math.sign(e); p.step = Math.min(3000, Math.max(.02, p.step * (d === p.dir ? 1.25 : .5))); p.dir = d; p.w += d * Math.min(p.step, Math.abs(e) * 3); if (it < 25 && inf[i].A > 0) { p.sx += (inf[i].cx - p.sx) * .3; p.sy += (inf[i].cy - p.sy) * .3; } });
      const m = L.reduce((s, p) => s + p.w, 0) / L.length; L.forEach(p => p.w -= m);
    }
  }
  function layout() { L = st.players.map(p => ({ id: p.id, stake: p.stake, sx: p.sx, sy: p.sy, w: 0, step: 200, dir: 0 })); if (L.length) solve(); }
  function getWinner(x, y) { let best = L[0], bv = Infinity; for (const p of L) { const v = (x - p.sx) ** 2 + (y - p.sy) ** 2 - p.w; if (v < bv) { bv = v; best = p; } } return best; }

  // ---------- отрисовка ----------
  // Строит мозаику зон один раз; для аномалии "race" вставляем её ДВУМЯ одинаковыми копиями
  // друг под другом и бесконечно сдвигаем весь блок ровно на одну свою высоту — при таком
  // сдвиге кадр в конце цикла пиксель-в-пиксель совпадает с начальным, поэтому шов незаметен
  // (раньше двигалась только заливка внутри одной копии — на границе цикла было видно скачок).
  function buildMosaic() {
    const frag = document.createDocumentFragment(), cs = L.length ? cells() : [], zones = [];
    st.players.map((p, i) => i).sort((a, b) => (st.players[a].id === (user && user.id) ? 1 : 0) - (st.players[b].id === (user && user.id) ? 1 : 0)).forEach(i => {
      const p = st.players[i], poly = cs[i], inf = info(poly), r = inr(poly, inf.cx, inf.cy);
      const el = document.createElement('div'); el.className = 'zone-item' + (user && p.id === user.id ? ' mine' : '');
      el.innerHTML = `<svg viewBox="0 0 100 100" preserveAspectRatio="none"><polygon points="${poly.map(v => v[0].toFixed(2) + ',' + v[1].toFixed(2)).join(' ')}" fill="${p.color}"/></svg>`;
      const d = Math.min(46, r * W / 100 * 1.4);
      if (d >= 14) { const a = avatar(p, 'zone-av', Math.round(d)); a.style.left = inf.cx + '%'; a.style.top = inf.cy + '%'; el.append(a); }
      frag.append(el); zones.push({ p, el });
    });
    return { frag, zones };
  }
  function render() {
    zoneMap.innerHTML = ''; legend.innerHTML = '';
    const sum = L.reduce((s, p) => s + p.stake, 0);
    // 'result' держим в том же "конвейерном" режиме, что и 'running' — иначе в момент, когда
    // сервер шлёт финальный статус, эта проверка резко становится false, зона-мозаика пересобирается
    // уже БЕЗ сдвига raceOffset (который к этому моменту заморожен на правильном значении в
    // updateRaceScroll) — и весь фон под шайбой визуально "прыгает" на нулевой сдвиг конвейера.
    const racing = st.anomaly === 'race' && (st.status === 'running' || st.status === 'result');
    const { frag, zones } = buildMosaic();
    zones.forEach(({ p, el }) => { p.zone = el; });
    if (racing) {
      const track = document.createElement('div'); track.className = 'race-track';
      const f1 = document.createElement('div'); f1.className = 'race-frame'; f1.append(frag);
      const f2 = document.createElement('div'); f2.className = 'race-frame'; f2.innerHTML = f1.innerHTML;
      track.append(f1, f2); zoneMap.append(track);
      raceTrackEl = track; track.style.transform = `translateY(${(-raceOffset / 100 * W).toFixed(2)}px)`; // если DOM зон пересобрался посреди гонки (напр. state-рассылка от захода/выхода игрока), не сбрасываем сдвиг конвейера в 0 — берём текущий, следующий кадр его тут же уточнит по таймеру
    } else { zoneMap.append(frag); raceTrackEl = null; }
    st.players.forEach(p => {
      const it = document.createElement('div'); it.className = 'ice-player';
      it.append(avatar(p, 'lg-av', 20));
      it.insertAdjacentHTML('beforeend', `<span>${esc(p.name)}</span><b>${fmt(p.stake)} · ${(p.stake / sum * 100).toFixed(1)}%</b>`);
      legend.append(it);
    });
    $('icePool').textContent = fmt(sum);
    if (finished) applyResult();
    ui();
  }
  let iceWinnerShownFor = null;
  {
    const ov = document.getElementById('iceWinnerOverlay');
    if (ov) ov.addEventListener('click', () => closeModal(ov));
  }
  function applyResult() {
    st.players.forEach(p => p.zone && p.zone.classList.add(p.id === st.winnerId ? 'winner-zone' : 'loser'));
    const w = st.players.find(p => p.id === st.winnerId); if (!w) return;
    const pool = st.players.reduce((s, p) => s + p.stake, 0);
    const payout = Number(st.payout || Math.max(Number(w.stake || 0), Number((pool * 0.92).toFixed(2))));
    const commission = Number(st.commission || Math.max(0, Number((pool - payout).toFixed(2))));
    // Плашка победителя — та же, что в PVP (#iceWinnerOverlay), закрывается тапом; один раз за раунд.
    if (iceWinnerShownFor === st.id) return;
    iceWinnerShownFor = st.id;
    const meIn = user && st.players.some(p => String(p.id) === String(user.id));
    if (meIn && window.ringHaptic) window.ringHaptic(String(st.winnerId) === String(user.id) ? 'win' : 'lose');
    if (document.getElementById('iceGame').classList.contains('hidden')) return;   // игрок сейчас не на экране Ice Arena
    $('iceWinnerAvatar').innerHTML = w.photo
      ? `<img src="${esc(w.photo)}" alt="" loading="lazy">`
      : `<div class="winner-fallback">${esc(String(w.name || "И").trim().charAt(0).toUpperCase() || "И")}</div>`;
    $('iceWinnerName').textContent = w.name || "Игрок";
    $('iceWinnerPayout').textContent = `${Number(payout).toFixed(2)} ⭐`;
    $('iceWinnerBetDetail').textContent = `Ставка: ${Number(w.stake || 0).toFixed(2)} ⭐`;
    openModal($('iceWinnerOverlay'));
  }
  function ui() {
    const now = Date.now() + skew; let txt = '', can = false;
    if (st.status === 'waiting') { txt = st.players.length ? 'Ждём 2-го игрока' : 'Набор игроков'; can = true; }
    else if (st.status === 'countdown') { const left = st.endsAt - now; if (left > CLOSE) { txt = 'Начало через 00:' + String(Math.ceil(left / 1000)).padStart(2, '0'); can = true; } else txt = 'Ставки закрыты'; }
    else if (st.status === 'running') txt = phase === 'rushing' ? 'Шайба на льду' : 'Раунд начинается';
    else txt = 'Раунд завершён';
    $('iceStatus').textContent = txt;
    $('iceJoinBtn').disabled = !can || !user;
    const mine = user && st.players.find(p => p.id === user.id);
    $('stakeInfo').textContent = mine ? 'Ваша: ' + fmt(mine.stake) : '';
  }
  setInterval(ui, 200);

  // ---------- детерминированная физика шайбы ----------
  function rng(a) { return function () { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
  function sim(x, y, ang, spd, flightMs, n) {
    let vx = Math.cos(ang) * spd, vy = Math.sin(ang) * spd; const dt = 1 / 60, decay = 4.5 / (flightMs / 1000), pts = [[x, y]];
    for (let i = 1; i <= n; i++) {
      const boost = 1 + 3 * Math.exp(-((i - 1) * dt) / .4); x += vx * dt * boost; y += vy * dt * boost;
      let bx = false, by = false;
      if (x < 0) { x = 0; if (vx < 0) { vx = Math.abs(vx) * .78; bx = true; } } else if (x > 100) { x = 100; if (vx > 0) { vx = -Math.abs(vx) * .78; bx = true; } }
      if (y < 0) { y = 0; if (vy < 0) { vy = Math.abs(vy) * .78; by = true; } } else if (y > 100) { y = 100; if (vy > 0) { vy = -Math.abs(vy) * .78; by = true; } }
      if (bx || by) {
        const s = Math.hypot(vx, vy) || 1, m = .37 * s, ax = bx ? (x < 50 ? 1 : -1) : 0, ay = by ? (y < 50 ? 1 : -1) : 0; let nx = vx, ny = vy;
        if (ax && ax * nx < m) { nx = ax * m; ny = (Math.sign(ny) || 1) * Math.sqrt(Math.max(0, s * s - nx * nx)); }
        if (ay && ay * ny < m) { ny = ay * m; nx = (Math.sign(nx) || 1) * Math.sqrt(Math.max(0, s * s - ny * ny)); }
        vx = nx; vy = ny;
      }
      if ((x < 12 || x > 88) && (y < 12 || y > 88)) { const s0 = Math.hypot(vx, vy); vx += (50 - x) * .02 * s0 * dt; vy += (50 - y) * .02 * s0 * dt; const s1 = Math.hypot(vx, vy) || 1; vx *= s0 / s1; vy *= s0 / s1; }
      const f = Math.exp(-decay * dt); vx *= f; vy *= f; pts.push([x, y]);
    }
    return pts;
  }
  // Победитель определён сервером; подбираем траекторию (по общему seed), которая приводит шайбу в его зону.
  function buildPlan() {
    if (st.anomaly === 'redo') return buildRedoPlan();
    const flightMs = BASE_FLIGHT, n = Math.round(flightMs / 1000 * 60);
    let best = null;
    for (let k = 0; k < 4000; k++) {
      const r = rng((st.seed + k * 7919) >>> 0);
      const sx = 12 + r() * 76, sy = 14 + r() * 72, q = Math.floor(r() * 4), ang = (q * 90 + 24 + r() * 42) * Math.PI / 180, spd = 750 + r() * 160, sa = r() * 360;
      const pts = sim(sx, sy, ang, spd, flightMs, n); best = { sp: [sx, sy], pts, ang, sa, flightMs, n };
      const e = pts[n]; if (getWinner(e[0], e[1]).id === st.winnerId) break;
    }
    const fa = best.ang * 180 / Math.PI + 90;
    best.fa = fa; best.ea = best.sa + 720 + ((((fa - best.sa) % 360) + 360) % 360); // 2 оборота и остановка ровно по направлению полёта
    return best;
  }
  // Аномалия "redo": первый пролёт выглядит ровно как обычный (та же длительность 7с) и заканчивается
  // в случайной точке — шайба тормозит, но победитель ещё не объявляется. С этого же места разыгрывается
  // второй пролёт (со своим повторным прицеливанием), который уже по-настоящему приводит шайбу в зону победителя.
  function buildRedoPlan() {
    const r1 = rng((st.seed ^ 0x1a2b3c4d) >>> 0);
    const flight1Ms = BASE_FLIGHT, n1 = Math.round(flight1Ms / 1000 * 60);
    const sx1 = 12 + r1() * 76, sy1 = 14 + r1() * 72, q1 = Math.floor(r1() * 4), ang1 = (q1 * 90 + 24 + r1() * 42) * Math.PI / 180, spd1 = 750 + r1() * 160, sa1 = r1() * 360;
    const pts1 = sim(sx1, sy1, ang1, spd1, flight1Ms, n1);
    const fa1 = ang1 * 180 / Math.PI + 90, ea1 = sa1 + 720 + ((((fa1 - sa1) % 360) + 360) % 360);
    const stop = pts1[n1];
    const flight2Ms = BASE_FLIGHT, n2 = Math.round(flight2Ms / 1000 * 60);
    let best2 = null;
    for (let k = 0; k < 4000; k++) {
      const r = rng((st.seed + 1 + k * 7919) >>> 0);
      const ang = r() * Math.PI * 2, spd = 750 + r() * 160, sa = r() * 360;
      const pts = sim(stop[0], stop[1], ang, spd, flight2Ms, n2);
      best2 = { sp: stop, pts, ang, sa, flightMs: flight2Ms, n: n2 };
      const e = pts[n2]; if (getWinner(e[0], e[1]).id === st.winnerId) break;
    }
    const fa2 = best2.ang * 180 / Math.PI + 90;
    best2.ea = best2.sa + 720 + ((((fa2 - best2.sa) % 360) + 360) % 360);
    return { mode: 'redo', phase1: { sp: [sx1, sy1], pts: pts1, sa: sa1, ea: ea1, flightMs: flight1Ms, n: n1 }, stop, phase2: best2 };
  }
  function setPhase(p) {
    if (p === phase) return; phase = p;
    puck.classList.toggle('choosing', p === 'choosing'); puck.classList.toggle('aiming', p === 'aiming'); puck.classList.toggle('rushing', p === 'rushing');
  }
  const clamp01 = x => Math.max(0, Math.min(1, x));
  const easeOut = x => 1 - Math.pow(1 - x, 3);
  // появление шайбы: плавный рост без затемнения, расходящееся кольцо, стрелка крутится вокруг шайбы и замирает по направлению броска
  function fx(t, sa, ea) {
    const e = easeOut(clamp01(t / APPEAR)), s = .45 + .55 * e;
    puckImg.style.opacity = e.toFixed(3);
    puckImg.style.transform = `scale(${s.toFixed(3)})`;
    const r = clamp01(t / 800);
    ripple.style.opacity = (.7 * (1 - r) * (1 - r)).toFixed(3);
    ripple.style.transform = `translate(-50%,-50%) scale(${(.7 + 1.6 * easeOut(r)).toFixed(3)})`;
    const ang = sa + (ea - sa) * easeOut(clamp01(t / SPIN));
    const pop = 1 + .25 * Math.sin(Math.PI * clamp01((t - SPIN) / 350));
    arrow.style.opacity = (clamp01(t / 150) * (1 - clamp01((t - INTRO) / 250))).toFixed(3);
    arrow.style.transform = `rotate(${ang.toFixed(2)}deg) scale(${(s * pop).toFixed(3)})`;
  }
  // Общий для обычного полёта и второй фазы "redo": в последние 3с плавно наезжаем камерой на шайбу.
  function applyCamZoom(ft, flightMs, x, y) {
    const zt = Math.max(0, Math.min(1, (ft - (flightMs - 3000)) / 3000));
    if (zt > 0) {
      if (!cam) { cam = { x, y }; arena.style.transition = 'none'; }
      cam.x += (x - cam.x) * .12; cam.y += (y - cam.y) * .12;
      const e = zt * zt * (3 - 2 * zt), sc = 1 + .32 * e, lim = (sc - 1) * 50;
      const tx = Math.max(-lim, Math.min(lim, (50 - cam.x) * sc)), ty = Math.max(-lim, Math.min(lim, (50 - cam.y) * sc));
      arena.style.transform = `translate(${tx}%,${ty}%) scale(${sc})`;
    }
  }
  // Сдвигает конвейер зон (0-100, % высоты арены). Пока раунд не завершён — считаем от общего
  // таймера полёта; как только победитель определён (finished), просто перестаём его обновлять.
  // Шайба на конвейер никак не завязана — она всегда едет по своей обычной физической траектории,
  // конвейер под ней — чисто фоновая декорация.
  // ИСПРАВЛЕНИЕ «Гонки»: победитель считается по неподвижной раскладке зон, поэтому конвейер обязан
  // остановиться ровно на целом числе оборотов (сдвиг 0) — тогда зона под замершей шайбой и есть зона
  // победителя. Едет с постоянной скоростью, в последние RACE_STOP_MS плавно тормозит вместе с шайбой
  // и приходит в целый оборот K (скорость чуть подстраивается под K, скачка скорости нет).
  const RACE_STOP_MS = 2500;
  function raceCycles(t, tEnd) {
    const D = Math.min(RACE_STOP_MS, tEnd * .5), K = Math.max(1, Math.round((tEnd - 2 * D / 3) / RACE_MS));
    const v = K / (tEnd - 2 * D / 3), tDec = tEnd - D;
    if (t <= tDec) return v * t;
    const u = Math.min(1, (t - tDec) / D);
    return v * tDec + (D * v / 3) * (1 - Math.pow(1 - u, 3));
  }
  function updateRaceScroll(t) {
    if (!raceTrackEl || finished) return;
    const tEnd = INTRO + (plan ? plan.flightMs : BASE_FLIGHT);
    if (t >= tEnd) raceOffset = 0;
    else { const c = raceCycles(Math.max(0, t), tEnd); raceOffset = (c - Math.floor(c)) * 100; }
    raceTrackEl.style.transform = `translateY(${(-raceOffset / 100 * W).toFixed(2)}px)`;
  }
  function frame(t) {
    if (plan.mode === 'redo') { frameRedo(t); return; }
    updateRaceScroll(t);
    // Шайба уже долетела и замерла — дальше НИЧЕГО не трогаем. Без этой защиты каждое новое
    // 'state' от сервера (чужая ставка, чей-то коннект/дисконнект и т.п.) пересчитывает
    // skew = m.now - Date.now(), а t = Date.now()+skew-startAt считается заново каждый кадр —
    // при обычном сетевом джиттере skew может на миг "качнуться" назад, t тоже уменьшится,
    // ft перестаёт быть прижатым к plan.flightMs, и шайба на мгновение отматывается на более
    // раннюю точку своего полёта — это и был видимый скачок в конце раунда.
    if (finished) return;
    if (t < 0) { puck.style.visibility = 'hidden'; place(plan.sp[0], plan.sp[1]); fx(0, plan.sa, plan.ea); return; }
    puck.style.visibility = 'visible';
    fx(t, plan.sa, plan.ea);
    if (t < INTRO) { setPhase(t < SPIN ? 'choosing' : 'aiming'); place(plan.sp[0], plan.sp[1]); return; }
    setPhase('rushing');
    const ft = Math.min(t - INTRO, plan.flightMs), idx = ft / 1000 * 60, i = Math.min(plan.n - 1, Math.floor(idx)), f = idx - i;
    const a = plan.pts[i], b = plan.pts[i + 1], x = a[0] + (b[0] - a[0]) * f, y = a[1] + (b[1] - a[1]) * f;
    place(x, y);
    applyCamZoom(ft, plan.flightMs, x, y);
    if (ft >= plan.flightMs && !finished) { finished = true; applyResult(); }
  }
  // Аномалия "redo": интро1 → пролёт1 → короткая замершая пауза (без победителя) → интро2 → пролёт2 → победитель.
  function frameRedo(t) {
    const p1 = plan.phase1, p2 = plan.phase2;
    const T1 = INTRO, T2 = T1 + p1.flightMs, T3 = T2 + STILL_HOLD, T4 = T3 + INTRO;
    if (finished) return; // та же защита от "перемотки" из-за дрожания skew, что и в frame()
    if (t < 0) { puck.style.visibility = 'hidden'; place(p1.sp[0], p1.sp[1]); fx(0, p1.sa, p1.ea); return; }
    puck.style.visibility = 'visible';
    if (t < T1) { fx(t, p1.sa, p1.ea); setPhase(t < SPIN ? 'choosing' : 'aiming'); place(p1.sp[0], p1.sp[1]); return; }
    if (t < T2) {
      setPhase('rushing');
      const ft = t - T1, idx = ft / 1000 * 60, i = Math.min(p1.n - 1, Math.floor(idx)), f = idx - i;
      const a = p1.pts[i], b = p1.pts[i + 1], x = a[0] + (b[0] - a[0]) * f, y = a[1] + (b[1] - a[1]) * f;
      place(x, y);
      arrow.style.opacity = 0; ripple.style.opacity = 0;
      applyCamZoom(ft, p1.flightMs, x, y);
      return;
    }
    if (t < T3) { // шайба замерла, победитель ещё не выбран
      if (cam) { cam = null; arena.style.transition = ''; arena.style.transform = 'scale(1)'; }
      setPhase(''); place(plan.stop[0], plan.stop[1]); arrow.style.opacity = 0; ripple.style.opacity = 0;
      return;
    }
    if (t < T4) {
      // Второй пролёт "дубля": шайба уже видна (только что остановилась), поэтому без
      // повторной анимации появления (без роста/прозрачности/кольца) — просто тихо
      // "прицеливается" (со стрелкой, крутящейся к направлению второго броска) и сразу летит дальше.
      const lt = t - T3;
      setPhase(lt < SPIN ? 'choosing' : 'aiming');
      puckImg.style.opacity = '1'; puckImg.style.transform = 'scale(1)';
      const ang2 = p2.sa + (p2.ea - p2.sa) * easeOut(clamp01(lt / SPIN));
      const pop2 = 1 + .25 * Math.sin(Math.PI * clamp01((lt - SPIN) / 350));
      arrow.style.opacity = (clamp01(lt / 150) * (1 - clamp01((lt - INTRO) / 250))).toFixed(3);
      arrow.style.transform = `rotate(${ang2.toFixed(2)}deg) scale(${pop2.toFixed(3)})`;
      ripple.style.opacity = '0';
      place(p2.sp[0], p2.sp[1]);
      return;
    }
    setPhase('rushing');
    const ft = Math.min(t - T4, p2.flightMs), idx = ft / 1000 * 60, i = Math.min(p2.n - 1, Math.floor(idx)), f = idx - i;
    const a = p2.pts[i], b = p2.pts[i + 1], x = a[0] + (b[0] - a[0]) * f, y = a[1] + (b[1] - a[1]) * f;
    place(x, y);
    arrow.style.opacity = 0; ripple.style.opacity = 0;
    applyCamZoom(ft, p2.flightMs, x, y);
    if (ft >= p2.flightMs && !finished) finished = true, applyResult();
  }
  let iceFramePending = false;
  function iceNeedsFrame() {
    const active = (st.status === 'running' || st.status === 'result') && st.startAt && L.length;
    return Boolean(active && !document.hidden && (!finished || planFor !== st.id));
  }
  function scheduleIceFrame() {
    if (iceFramePending || !iceNeedsFrame()) return;
    iceFramePending = true;
    (window.requestGraphicsFrame || requestAnimationFrame)(() => {
      iceFramePending = false;
      if (!iceNeedsFrame()) return;
      if (planFor !== st.id) { plan = buildPlan(); planFor = st.id; finished = false; cam = null; }
      frame(Date.now() + skew - st.startAt);
      scheduleIceFrame();
    });
  }
  window.addEventListener("graphicsqualitychange", scheduleIceFrame);
  document.addEventListener("visibilitychange", scheduleIceFrame);
  function resetVisual() {
    if (!plan && !finished) return;
    plan = null; planFor = null; finished = false; cam = null; phase = '';
    arena.style.transition = ''; arena.style.transform = 'scale(1)';
    puck.classList.remove('choosing', 'aiming', 'rushing'); winnerEl.classList.remove('show'); winnerEl.innerHTML = ''; closeModal($('iceWinnerOverlay'));
    W = arena.clientWidth || W; place(50, 50); puck.style.visibility = 'hidden';
  }

  // ---------- сеть (общий socket.io хоста, события с префиксом ice_) ----------
  function syncBal() { $('bal').textContent = fmt(currentBalance); }
  syncBal();
  socket.on('ice_state', m => {
    skew = m.now - Date.now(); st = m;
    if (st.status === 'waiting' || st.status === 'countdown') resetVisual();
    updateAnomalyUI();
    layout(); render();
    scheduleIceFrame();
  });
  socket.on('ice_history', renderHistory);
  socket.on('ice_admin_ok', d => toast(d.msg));
  socket.on('balance_updated', () => syncBal());
  socket.on('joined', () => { syncBal(); updateAdminAnomalyVisibility(); });

  // ---------- аномалии ----------
  // Сервер отдаёт st.anomaly = null, пока раунд не перешёл в running (ставки уже закрыты),
  // так что до этого момента бейдж вообще не появляется и не спойлерит исход.
  // Как только раунд стартует, бейдж выскакивает в углу арены и "крутит" иконки между
  // вариантами анoмалий примерно 0.7с, затем останавливается на реальной аномалии этого раунда.
  const ANOMALY_NAMES = { race: 'Гонка', mirage: 'H̷̢̨̹̞͚̫̖͓̳͇̰̹͕̝̘̘͂͛͒̈́͌̈́̈́̕̕͝͝͝͝i̸̟̮͙͕͎͇̱̯̪̤̺̯̩̗̘̐̅̿͌͛̈́̾̓́̓̿̿̕͘͝d̶͉̤̤͕̬̱̻̥͎͙͎̹̰̲̩̈́͐͌̿̓͆̈́̄̈́̄̾͐̚͘͝e̸̬̥̫͙̜̫͕̙̩̳͙̰͚͖̠̍̾̾͛̇͋͊̇̕͝͝͝͝͝', redo: 'Вторая жизнь!' };
  const ANOMALY_ICON = { race: 'ic-race', mirage: 'ic-mirage', redo: 'ic-redo' };
  const ANOMALY_CYCLE = ['ic-race', 'ic-mirage', 'ic-redo'];
  let shownAnomalyFor = null, anomalySpin = null, anomalyRollT = null;
  function updateAnomalyUI() {
  const badge = $('anomalyBadge'), icon = badge.querySelector('.ab-icon');
  const active = st.status === 'running' || st.status === 'result';
  const kind = active && Object.prototype.hasOwnProperty.call(ANOMALY_ICON, st.anomaly) ? st.anomaly : null;
  $('iceGame').classList.toggle('mirage-active', kind === 'mirage' && st.status === 'running');
  const key = kind ? String(st.id) + ':' + kind : null;
  if (key === shownAnomalyFor && (key === null || badge.classList.contains('show'))) return;
  shownAnomalyFor = key;
  clearInterval(anomalySpin); clearTimeout(anomalyRollT);
  anomalySpin = null; anomalyRollT = null;
  badge.classList.remove('show', 'rolling', 'settled');
  icon.classList.remove(...ANOMALY_CYCLE, 'flip-out');
  icon.style.backgroundImage = '';
  badge.removeAttribute('title');
  if (!kind) return;
  const paint = value => {
    icon.classList.remove(...ANOMALY_CYCLE, 'flip-out');
    icon.classList.add(ANOMALY_ICON[value]);
    icon.style.backgroundImage = 'url("/icons/icon-' + value + '.jpg")';
  };
  badge.title = ANOMALY_NAMES[kind];
  badge.classList.add('show');
  if (st.status === 'result') { paint(kind); badge.classList.add('settled'); return; }
  badge.classList.add('rolling');
  const cycle = ['race', 'mirage', 'redo']; let i = 0;
  paint(cycle[0]);
  // No nested timeout: nothing can overwrite the final icon after settling.
  anomalySpin = setInterval(() => {
    if (shownAnomalyFor !== key) return;
    paint(cycle[++i % cycle.length]);
  }, 170);
  anomalyRollT = setTimeout(() => {
    clearInterval(anomalySpin); anomalySpin = null;
    if (shownAnomalyFor !== key) return;
    paint(kind);
    badge.classList.remove('rolling'); badge.classList.add('settled');
    toast('Аномалия! ' + ANOMALY_NAMES[kind]);
  }, 850);
}

// ---------- ставки ----------
  $('iceJoinBtn').addEventListener('click', () => socket.emit('ice_bet', { amount: Math.round(Number($('betAmt').value)) }));
  document.querySelectorAll('.ice-stakes button, .ice-step').forEach(b => b.addEventListener('click', () => {
    const cur = Math.round(Number($('betAmt').value)) || 1;
    const max = user ? Math.max(1, Math.floor(currentBalance)) : cur;
    const act = b.dataset.a;
    let v = act === 'min' ? 1 : act === 'max' ? max : cur + Number(act);
    $('betAmt').value = Math.max(1, Math.min(max, v));
  }));
  $('betAmt').addEventListener('input', () => { $('betAmt').value = $('betAmt').value.replace(/[^0-9]/g, ''); });

  // ---------- история игр ----------
  const ANOMALY_ICON_URL = { race: '/icons/icon-race.svg', mirage: '/icons/icon-mirage.svg', redo: '/icons/icon-redo.svg' };
  let hData = { top: null, last: null, list: [] }, curGame = null;
  const GEM = '<span class="gem">⭐</span>';
  const gp = g => ({ name: g.name || '?', photo: g.photo, color: g.color || '#ff1231' });
  function fillCard(el, g) {
    if (!g) { el.innerHTML = '<span class="hd-empty">Пока нет игр</span>'; return; }
    el.innerHTML = ''; el.append(avatar(gp(g), 'lg-av', 22));
    const tag = g.anomaly && ANOMALY_ICON_URL[g.anomaly] ? ` <img class="hd-anomaly" src="${ANOMALY_ICON_URL[g.anomaly]}" alt="">` : '';
    el.insertAdjacentHTML('beforeend', `<span class="hd-name">${esc(g.name)}${tag}</span><b class="hd-win">+${fmt(g.payout || g.pool)}${GEM}</b>`);
  }
  function renderHistory(h) {
    hData = h;
    fillCard($('topGame'), h.top); fillCard($('lastGame'), h.last);
    const list = $('histList'); list.innerHTML = '';
    if (!h.list.length) { list.innerHTML = '<p class="ice-hint">Игр пока не было</p>'; return; }
    h.list.forEach(g => {
      const row = document.createElement('div'); row.className = 'hist-row'; row.append(avatar(gp(g), 'lg-av', 30));
      const when = new Date(g.ts).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
      const tag = g.anomaly && ANOMALY_ICON_URL[g.anomaly] ? ` <img class="hd-anomaly" src="${ANOMALY_ICON_URL[g.anomaly]}" alt="">` : '';
      row.insertAdjacentHTML('beforeend', `<span style="flex:1;min-width:0"><span class="hd-name">${esc(g.name)}${tag}</span><small>${g.players.length} игр. · ${when}</small></span><b class="hd-win">+${fmt(g.payout || g.pool)}${GEM}</b>`);
      row.addEventListener('click', () => openGame(g));
      list.append(row);
    });
  }
  $('topGame').addEventListener('click', () => hData.top && openGame(hData.top));
  $('lastGame').addEventListener('click', () => hData.last && openGame(hData.last));

  // ---------- детали игры + legit check ----------
  const shortHex = s => s.length > 10 ? s.slice(0, 4) + '…' + s.slice(-4) : s;
  function openGame(g) {
    curGame = g;
    $('gmId').textContent = g.id;
    const d = new Date(g.ts);
    $('gmDate').textContent = d.toLocaleDateString('ru-RU') + ' · ' + d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }) + (g.anomaly && ANOMALY_NAMES[g.anomaly] ? ' · ' + ANOMALY_NAMES[g.anomaly] : '');
    $('gmHash').textContent = shortHex(g.hash);
    $('gmSeed').textContent = shortHex(String(g.seed));
    const pool = g.players.reduce((s, p) => s + p.stake, 0);
    // Older Ice Arena history rows predate the commission fields, so their
    // actual historical payout is the stored pool. New rows have payout set.
    const payout = Number(g.payout || g.pool || 0);
    const commission = Number(g.commission || Math.max(0, Number((pool - payout).toFixed(2))));
    $('gmSummary').innerHTML = `<div><span>Выплата</span><b>+${fmt(payout)}${GEM}</b></div><div><span>Комиссия</span><b>${fmt(commission)}${GEM}</b></div><div><span>Банк</span><b>${fmt(pool)}${GEM}</b></div>`;
    const ordered = [...g.players].sort((a, b) => b.stake - a.stake);
    $('gmPlayers').innerHTML = '';
    ordered.forEach(p => {
      const isWin = p.id === g.winnerId;
      const row = document.createElement('div'); row.className = 'gm-p' + (isWin ? ' win' : '');
      row.append(avatar(p, 'lg-av', 32));
      row.insertAdjacentHTML('beforeend', `<span class="gm-p-name"><b>${esc(p.name)}${isWin ? '<span class="gm-win-badge">Победитель</span>' : ''}</b><small>${(p.stake / pool * 100).toFixed(2)}%</small></span><b class="gm-p-amt">${isWin ? '+' : ''}${fmt(isWin ? payout : p.stake)}${GEM}</b>`);
      $('gmPlayers').append(row);
    });
    $('gmVerdict').textContent = ''; $('gmVerdict').className = 'gm-verdict';
    $('gameModal').classList.add('show');
  }
  $('gmClose').addEventListener('click', () => $('gameModal').classList.remove('show'));
  $('gameModal').addEventListener('click', e => { if (e.target === $('gameModal')) $('gameModal').classList.remove('show'); });
  document.querySelectorAll('.gm-copy').forEach(b => b.addEventListener('click', () => {
    if (!curGame) return;
    const v = b.dataset.t === 'hash' ? curGame.hash : String(curGame.seed);
    (navigator.clipboard ? navigator.clipboard.writeText(v) : Promise.reject()).then(() => toast('Скопировано')).catch(() => toast('Не удалось скопировать'));
  }));
  $('gmCheckBtn').addEventListener('click', async () => {
    if (!curGame) return;
    const v = $('gmVerdict');
    v.textContent = 'Проверяем…'; v.className = 'gm-verdict';
    try {
      const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(curGame.seed)));
      const hex = [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
      const hashOk = hex === curGame.hash;
      const pool = curGame.players.reduce((s, p) => s + p.stake, 0);
      let x = rng(curGame.seed)() * pool, w = curGame.players[0];
      for (const p of curGame.players) { if (x < p.stake) { w = p; break; } x -= p.stake; }
      const pickOk = w.id === curGame.winnerId;
      if (hashOk && pickOk) { v.textContent = '✅ Проверено — сид совпадает с хешем, победитель посчитан честно'; v.className = 'gm-verdict ok'; }
      else { v.textContent = '❌ Проверка не пройдена'; v.className = 'gm-verdict bad'; }
    } catch (e) { v.textContent = 'Не удалось проверить в этом браузере'; v.className = 'gm-verdict bad'; }
  });
  $('histBtn').addEventListener('click', () => $('histModal').classList.add('show'));
  $('histClose').addEventListener('click', () => $('histModal').classList.remove('show'));
  $('histModal').addEventListener('click', e => { if (e.target === $('histModal')) $('histModal').classList.remove('show'); });

  // ---------- админка ----------
  // Баланс игроков выдаётся/списывается через админ-панель основного приложения (Профиль →
  // Админка); тут остаётся только форс аномалии на следующий раунд, доступный лишь isAdmin.
  function updateAdminAnomalyVisibility() {
    $('iceAdminAnomaly').classList.toggle('hidden', !isAdmin);
  }
  document.querySelectorAll('#iceAdminAnomaly button').forEach(b => b.addEventListener('click', () => socket.emit('ice_admin_force_anomaly', { anomaly: b.dataset.an || null })));

  // ---------- пасхалка: 3 тапа по подсказке "Бла-Бла-Бла" — звук мяуканья ----------
  let hintTaps = 0, hintTapT = null;
  const hintEl = $('iceHint');
  const meowSound = new Audio('/meow.mp3');
  if (hintEl) hintEl.addEventListener('click', () => {
    hintTaps++; clearTimeout(hintTapT); hintTapT = setTimeout(() => hintTaps = 0, 900);
    if (hintTaps >= 3) { hintTaps = 0; meowEasterEgg(); }
  });
  function meowEasterEgg() {
    try { meowSound.currentTime = 0; meowSound.play(); } catch (e) {}
  }

  // ---------- открытие вкладки из games-view ----------
  // Вызывается host-приложением (см. openIce() в основном коде) при каждом заходе на вкладку:
  // на момент первой загрузки скрипта арена ещё display:none, поэтому её реальную ширину и
  // актуальное состояние раунда подтягиваем именно в момент открытия.
  window.__iceOnOpen = function () {
    W = arena.clientWidth || W;
    syncBal();
    updateAdminAnomalyVisibility();
    socket.emit('ice_request_state');
  };
})();
