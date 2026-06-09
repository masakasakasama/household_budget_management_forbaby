/* おうちの家計簿 — かわいい家計簿アプリ
   依存ゼロ / localStorageキャッシュ / 同じリンクで全端末・常時同期
   （同期先: Firebase Realtime Database。URLは sync-config.js に設定） */

(() => {
  "use strict";

  const APP_VERSION = "1.2.0";
  const KEY_DATA = "ouchi-kakeibo-data";
  const KEY_SYNC = "ouchi-kakeibo-lastsync";
  const LEGACY_KEY = "ouchi-kakeibo-v1";
  const POLL_MS = 12000;

  // 同期先（sync-config.js の window.OUCHI_SYNC_URL）。空なら同期なし。
  const SYNC_URL = String(window.OUCHI_SYNC_URL || "").replace(/\/+$/, "");
  const SYNC_PATH = "kakeibo"; // 全端末で共有する固定の保存先
  const remoteUrl = () => `${SYNC_URL}/${SYNC_PATH}.json`;
  const syncEnabled = () => SYNC_URL.length > 0;

  const DEFAULTS = {
    income: [
      { name: "くりこし", amount: "" },
      { name: "給与", amount: "" },
    ],
    fixed: [
      { name: "電気", amount: "" },
      { name: "ガス", amount: "" },
      { name: "水道", amount: "" },
      { name: "電話", amount: "" },
      { name: "携帯電話", amount: "" },
      { name: "インターネット", amount: "" },
      { name: "住居", amount: "" },
      { name: "貯蓄", amount: "" },
      { name: "保険", amount: "" },
    ],
    living: [
      { name: "食費", amount: "" },
      { name: "日用品", amount: "" },
      { name: "交通費", amount: "" },
      { name: "娯楽・レジャー", amount: "" },
    ],
  };

  // ---------- 状態 ----------
  let state = loadLocal();
  let currentMonth = todayMonth();
  let lastSyncAt = Number(localStorage.getItem(KEY_SYNC)) || 0;
  let pushTimer = null;
  let pulling = false;
  let pushing = false;
  let pendingPush = false;

  // ---------- ユーティリティ ----------
  function todayMonth() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  }

  function blankMonth() {
    return {
      income: DEFAULTS.income.map((x) => ({ ...x })),
      fixed: DEFAULTS.fixed.map((x) => ({ ...x })),
      living: DEFAULTS.living.map((x) => ({ ...x })),
      credit: [],
      special: [],
      memo: "",
    };
  }

  function loadLocal() {
    try {
      const raw = JSON.parse(localStorage.getItem(KEY_DATA));
      if (raw && raw.months) return raw;
    } catch {}
    try {
      const legacy = JSON.parse(localStorage.getItem(LEGACY_KEY));
      if (legacy && typeof legacy === "object") {
        return { version: 1, updatedAt: Date.now(), months: legacy };
      }
    } catch {}
    return { version: 1, updatedAt: 0, months: {} };
  }

  function saveLocal() {
    localStorage.setItem(KEY_DATA, JSON.stringify(state));
  }

  let saveTimer = null;
  function flashSave() {
    const hint = document.getElementById("saveHint");
    hint.textContent = syncEnabled() ? "保存して同期中… ✨" : "保存したよ ✨";
    clearTimeout(saveTimer);
    saveTimer = setTimeout(
      () => (hint.textContent = "じどうで保存されるよ 💾"),
      1200
    );
  }

  // ローカル変更時に呼ぶ（タイムスタンプ更新＋保存＋同期予約）
  function touch() {
    state.updatedAt = Date.now();
    saveLocal();
    flashSave();
    schedulePush();
  }

  function getMonth() {
    if (!state.months[currentMonth]) state.months[currentMonth] = blankMonth();
    return state.months[currentMonth];
  }

  function num(v) {
    const n = parseFloat(String(v).replace(/[^0-9.\-]/g, ""));
    return isNaN(n) ? 0 : n;
  }
  function yen(n) {
    return "¥" + Math.round(n).toLocaleString("ja-JP");
  }
  function monthLabel(m) {
    const [y, mo] = m.split("-");
    return `${y}年${parseInt(mo, 10)}月`;
  }
  function move(arr, i, dir) {
    const j = i + dir;
    if (j < 0 || j >= arr.length) return false;
    [arr[i], arr[j]] = [arr[j], arr[i]];
    return true;
  }

  // ---------- 明細リスト（収入・固定費・生活費） ----------
  function listEl(key) {
    return document.getElementById(
      key === "income" ? "incomeList" : key === "fixed" ? "fixedList" : "livingList"
    );
  }

  function renderLineList(key) {
    const data = getMonth()[key];
    const wrap = listEl(key);
    wrap.innerHTML = "";

    data.forEach((item, i) => {
      const row = document.createElement("div");
      row.className = "line-row";

      const reorder = document.createElement("div");
      reorder.className = "reorder";
      reorder.append(
        moveBtn("▲", () => { if (move(data, i, -1)) { renderLineList(key); touch(); } }),
        moveBtn("▼", () => { if (move(data, i, 1)) { renderLineList(key); touch(); } })
      );

      const name = document.createElement("input");
      name.className = "line-name";
      name.value = item.name;
      name.placeholder = "項目名";
      name.addEventListener("input", () => { item.name = name.value; touch(); });

      const yenMark = document.createElement("span");
      yenMark.className = "line-yen";
      yenMark.textContent = "¥";

      const amount = document.createElement("input");
      amount.className = "line-amount";
      amount.inputMode = "numeric";
      amount.value = item.amount;
      amount.placeholder = "0";
      amount.addEventListener("input", () => {
        item.amount = amount.value;
        recalc();
        touch();
      });

      const del = delBtn(() => {
        data.splice(i, 1);
        renderLineList(key);
        recalc();
        touch();
      });

      row.append(reorder, name, yenMark, amount, del);
      wrap.appendChild(row);
    });
  }

  // ---------- テーブル（クレカ・特別支出） ----------
  function renderCredit() {
    const data = getMonth().credit;
    const body = document.getElementById("creditBody");
    body.innerHTML = "";
    data.forEach((item, i) => {
      const tr = document.createElement("tr");
      tr.append(
        reorderCell(data, i, renderCredit),
        cell((v) => (item.date = v), item.date, "6/1"),
        cell((v) => (item.item = v), item.item, "品名"),
        cell((v) => (item.shop = v), item.shop, "購入先"),
        cell((v) => { item.amount = v; recalc(); }, item.amount, "0", "amount-cell"),
        cell((v) => (item.card = v), item.card, "カード"),
        checkCell((v) => (item.paid = v), item.paid),
        delCell(() => { data.splice(i, 1); renderCredit(); recalc(); touch(); })
      );
      body.appendChild(tr);
    });
  }

  function renderSpecial() {
    const data = getMonth().special;
    const body = document.getElementById("specialBody");
    body.innerHTML = "";
    data.forEach((item, i) => {
      const tr = document.createElement("tr");
      tr.append(
        reorderCell(data, i, renderSpecial),
        cell((v) => (item.date = v), item.date, "6/1"),
        cell((v) => (item.detail = v), item.detail, "内容"),
        cell((v) => { item.amount = v; recalc(); }, item.amount, "0", "amount-cell"),
        delCell(() => { data.splice(i, 1); renderSpecial(); recalc(); touch(); })
      );
      body.appendChild(tr);
    });
  }

  // ---------- セル・ボタン生成 ----------
  function moveBtn(label, onClick) {
    const b = document.createElement("button");
    b.className = "move-btn";
    b.textContent = label;
    b.tabIndex = -1;
    b.addEventListener("click", onClick);
    return b;
  }
  function delBtn(onClick) {
    const b = document.createElement("button");
    b.className = "del-btn";
    b.textContent = "×";
    b.title = "削除";
    b.addEventListener("click", onClick);
    return b;
  }
  function cell(onChange, value, placeholder, extraClass) {
    const td = document.createElement("td");
    const input = document.createElement("input");
    if (extraClass) input.className = extraClass;
    if (extraClass === "amount-cell") input.inputMode = "numeric";
    input.value = value || "";
    input.placeholder = placeholder || "";
    input.addEventListener("input", () => { onChange(input.value); touch(); });
    td.appendChild(input);
    return td;
  }
  function checkCell(onChange, value) {
    const td = document.createElement("td");
    td.className = "check-cell";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = !!value;
    input.addEventListener("change", () => { onChange(input.checked); touch(); });
    td.appendChild(input);
    return td;
  }
  function delCell(onClick) {
    const td = document.createElement("td");
    td.className = "del-cell";
    td.appendChild(delBtn(onClick));
    return td;
  }
  function reorderCell(data, i, rerender) {
    const td = document.createElement("td");
    td.className = "reorder-cell";
    const box = document.createElement("div");
    box.className = "reorder reorder-v";
    box.append(
      moveBtn("▲", () => { if (move(data, i, -1)) { rerender(); touch(); } }),
      moveBtn("▼", () => { if (move(data, i, 1)) { rerender(); touch(); } })
    );
    td.appendChild(box);
    return td;
  }

  // ---------- 合計計算 ----------
  function sumLines(arr) {
    return arr.reduce((t, x) => t + num(x.amount), 0);
  }

  function recalc() {
    const m = getMonth();
    const income = sumLines(m.income);
    const fixed = sumLines(m.fixed);
    const living = sumLines(m.living);
    const credit = sumLines(m.credit);
    const special = sumLines(m.special);

    const totalExpense = fixed + living + special;
    const balance = income - totalExpense;

    document.getElementById("incomeTotal").textContent = yen(income);
    document.getElementById("fixedTotal").textContent = yen(fixed);
    document.getElementById("livingTotal").textContent = yen(living);
    document.getElementById("creditTotal").textContent = yen(credit);
    document.getElementById("specialTotal").textContent = yen(special);

    document.getElementById("hlIncome").textContent = yen(income);
    document.getElementById("hlExpense").textContent = yen(totalExpense);
    const balEl = document.getElementById("hlBalance");
    balEl.textContent = yen(balance);
    balEl.style.color = balance < 0 ? "#e5556e" : "var(--ink)";

    renderPiggy(income, balance);
  }

  function renderPiggy(income, balance) {
    const fill = document.getElementById("piggyFill");
    const msg = document.getElementById("piggyMsg");
    const rate = document.getElementById("piggyRate");
    if (income <= 0) {
      fill.style.width = "0%";
      msg.textContent = "数字を入力すると、ぶたさんがコメントするよ！";
      rate.textContent = "";
      return;
    }
    const pct = Math.min(100, Math.max(0, Math.round((balance / income) * 100)));
    fill.style.width = pct + "%";
    rate.textContent = `貯蓄率 ${Math.round((balance / income) * 100)}%`;
    if (balance < 0) {
      msg.textContent = "🐽💦 今月はちょっぴり使いすぎ…来月いっしょにがんばろ！";
    } else if (pct >= 30) {
      msg.textContent = "🐽✨ すごい！しっかり貯金できてるよ、えらい〜！";
    } else if (pct >= 10) {
      msg.textContent = "🐽💕 いいかんじ！この調子でコツコツいこうね。";
    } else {
      msg.textContent = "🐽🌱 ちょっとずつでも貯金できてえらい！";
    }
  }

  // ---------- 全体描画 ----------
  function renderAll() {
    document.getElementById("monthLabel").textContent = monthLabel(currentMonth);
    document.getElementById("monthPicker").value = currentMonth;
    document.getElementById("memo").value = getMonth().memo || "";
    renderLineList("income");
    renderLineList("fixed");
    renderLineList("living");
    renderCredit();
    renderSpecial();
    recalc();
  }

  function shiftMonth(delta) {
    const [y, mo] = currentMonth.split("-").map(Number);
    const d = new Date(y, mo - 1 + delta, 1);
    currentMonth = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    renderAll();
  }

  // ====================================================================
  //  同期（同じリンクで全端末・常時同期 / Firebase Realtime Database）
  // ====================================================================
  function fmtTime(ts) {
    if (!ts) return "";
    const d = new Date(ts);
    const now = new Date();
    const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    const sameDay =
      d.getFullYear() === now.getFullYear() &&
      d.getMonth() === now.getMonth() &&
      d.getDate() === now.getDate();
    return sameDay ? hm : `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
  }

  function setStatus(kind, text) {
    const el = document.getElementById("syncStatus");
    el.className = "sync-status" + (kind ? " " + kind : "");
    el.textContent = text;
    const t = document.getElementById("syncTime");
    if (!syncEnabled()) {
      t.textContent = "この端末だけに保存中（全端末同期は設定待ち）";
    } else if (lastSyncAt) {
      t.textContent = `前回同期 ${fmtTime(lastSyncAt)}・どの端末で開いても自動同期`;
    } else {
      t.textContent = "同期の準備中…";
    }
  }

  function statusIdle() {
    if (!syncEnabled()) setStatus("", "📴 同期OFF");
    else setStatus("ok", "🔄 全端末で同期中");
  }

  async function pull(opts = {}) {
    if (!syncEnabled() || pulling) return;
    pulling = true;
    if (!opts.quiet) setStatus("syncing", "🔄 最新を確認中…");
    try {
      const res = await fetch(remoteUrl(), { method: "GET", cache: "no-store" });
      if (!res.ok) throw new Error("GET " + res.status);
      const remote = await res.json();
      if (remote && remote.months && (remote.updatedAt || 0) > (state.updatedAt || 0)) {
        state = remote;
        saveLocal();
        renderAll();
      }
      lastSyncAt = Date.now();
      localStorage.setItem(KEY_SYNC, String(lastSyncAt));
      statusIdle();
    } catch (e) {
      // 通信失敗時は最後に成功したデータ（ローカル）を表示したまま
      setStatus("err", "⚠️ オフライン（保存データを表示中）");
    } finally {
      pulling = false;
    }
  }

  function schedulePush() {
    if (!syncEnabled()) return;
    clearTimeout(pushTimer);
    pushTimer = setTimeout(push, 800);
  }

  async function push() {
    if (!syncEnabled()) return;
    if (pushing) { pendingPush = true; return; }
    pushing = true;
    setStatus("syncing", "🔄 同期中…");
    try {
      const res = await fetch(remoteUrl(), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(state),
      });
      if (!res.ok) throw new Error("PUT " + res.status);
      lastSyncAt = Date.now();
      localStorage.setItem(KEY_SYNC, String(lastSyncAt));
      statusIdle();
    } catch (e) {
      setStatus("err", "⚠️ 同期できず（あとで自動リトライ）");
    } finally {
      pushing = false;
      if (pendingPush) { pendingPush = false; schedulePush(); }
    }
  }

  // ---------- アプリ更新チェック ----------
  async function checkAppUpdate() {
    try {
      const res = await fetch("version.json?t=" + Date.now(), { cache: "no-store" });
      if (!res.ok) return;
      const { version } = await res.json();
      if (version && version !== APP_VERSION) {
        const hint = document.getElementById("saveHint");
        hint.innerHTML = '✨ 新しいバージョンがあります → <a href="#" id="reloadApp">再読み込み</a>';
        document.getElementById("reloadApp")?.addEventListener("click", (e) => {
          e.preventDefault();
          location.reload();
        });
      }
    } catch {}
  }

  // ====================================================================
  //  初期化
  // ====================================================================
  function init() {
    document.querySelectorAll(".add-line").forEach((btn) => {
      btn.addEventListener("click", () => {
        const target = btn.dataset.target;
        const m = getMonth();
        if (target === "credit") {
          m.credit.push({ date: "", item: "", shop: "", amount: "", card: "", paid: false });
          renderCredit();
        } else if (target === "special") {
          m.special.push({ date: "", detail: "", amount: "" });
          renderSpecial();
        } else {
          m[target].push({ name: "", amount: "" });
          renderLineList(target);
        }
        recalc();
        touch();
      });
    });

    document.getElementById("prevMonth").addEventListener("click", () => shiftMonth(-1));
    document.getElementById("nextMonth").addEventListener("click", () => shiftMonth(1));
    document.getElementById("monthPicker").addEventListener("change", (e) => {
      if (e.target.value) { currentMonth = e.target.value; renderAll(); }
    });

    document.getElementById("memo").addEventListener("input", (e) => {
      getMonth().memo = e.target.value;
      touch();
    });

    document.getElementById("resetMonth").addEventListener("click", () => {
      if (confirm(`${monthLabel(currentMonth)} の内容をリセットしますか？`)) {
        state.months[currentMonth] = blankMonth();
        renderAll();
        touch();
      }
    });

    document.getElementById("refreshBtn").addEventListener("click", () => pull());

    renderAll();
    statusIdle();

    // 起動時にサーバ最新を取得
    if (syncEnabled()) pull();

    // 定期バックグラウンド更新＋タブ復帰時更新
    setInterval(() => {
      if (syncEnabled() && document.visibilityState === "visible") pull({ quiet: true });
    }, POLL_MS);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible" && syncEnabled()) pull({ quiet: true });
    });

    checkAppUpdate();
  }

  document.addEventListener("DOMContentLoaded", init);
})();
