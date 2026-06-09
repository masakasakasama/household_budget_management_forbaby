/* おうちの家計簿 — かわいい家計簿アプリ
   依存ゼロ / localStorageキャッシュ / 複数デバイス同期（jsonblob, 認証・APIキー不要） */

(() => {
  "use strict";

  const APP_VERSION = "1.1.3";
  const KEY_DATA = "ouchi-kakeibo-data";
  const KEY_CODE = "ouchi-kakeibo-code";
  const KEY_SYNC = "ouchi-kakeibo-lastsync";
  const LEGACY_KEY = "ouchi-kakeibo-v1";
  const BLOB_BASE = "https://jsonblob.com/api/jsonBlob";
  const POLL_MS = 15000;

  // 各セクションのデフォルト項目（紙の家計簿をベースに）
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
  let ouchiCode = localStorage.getItem(KEY_CODE) || "";
  let lastSyncAt = Number(localStorage.getItem(KEY_SYNC)) || 0;
  let pushTimer = null;
  let pulling = false;
  let pushing = false;

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
    // 新フォーマット
    try {
      const raw = JSON.parse(localStorage.getItem(KEY_DATA));
      if (raw && raw.months) return raw;
    } catch {}
    // 旧フォーマットからの移行（{ "YYYY-MM": {...} }）
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
    hint.textContent = ouchiCode ? "保存して同期中… ✨" : "保存したよ ✨";
    clearTimeout(saveTimer);
    saveTimer = setTimeout(
      () => (hint.textContent = "じどうで保存されるよ 💾"),
      1200
    );
  }

  // ローカル変更があった時に呼ぶ（タイムスタンプ更新＋保存＋同期予約）
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
        moveBtn("▲", () => {
          if (move(data, i, -1)) { renderLineList(key); touch(); }
        }),
        moveBtn("▼", () => {
          if (move(data, i, 1)) { renderLineList(key); touch(); }
        })
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

  // ---------- セル・ボタン生成ヘルパー ----------
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

  // ---------- 貯金ぶたメーター ----------
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
  //  同期（複数デバイス・無料・APIキー不要 / jsonblob）
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
    if (ouchiCode && lastSyncAt) {
      t.textContent = `前回同期 ${fmtTime(lastSyncAt)} ・ おうちコード ${ouchiCode}`;
    } else if (ouchiCode) {
      t.textContent = `おうちコード ${ouchiCode}（まだ同期できていません）`;
    } else {
      t.textContent = "「おうちを共有」で家族と同じ家計簿を使えます";
    }
  }

  function refreshStatusIdle() {
    if (!ouchiCode) setStatus("", "📴 おうちコード未設定");
    else setStatus("ok", "🏠 同期中のおうち");
  }

  // 起動時・参加直後・手動更新・定期・タブ復帰でサーバの最新を取得
  async function pull(opts = {}) {
    if (!ouchiCode || pulling) return;
    pulling = true;
    if (!opts.quiet) setStatus("syncing", "🔄 最新を確認中…");
    try {
      const res = await fetch(`${BLOB_BASE}/${ouchiCode}`, {
        method: "GET",
        headers: { Accept: "application/json" },
        cache: "no-store",
      });
      if (!res.ok) throw new Error("GET " + res.status);
      const remote = await res.json();
      if (remote && remote.months && (remote.updatedAt || 0) > (state.updatedAt || 0)) {
        state = remote;
        saveLocal();
        renderAll();
      }
      lastSyncAt = Date.now();
      localStorage.setItem(KEY_SYNC, String(lastSyncAt));
      refreshStatusIdle();
    } catch (e) {
      // 通信失敗時は最後に成功したデータ（ローカル）を表示したまま
      setStatus("err", "⚠️ オフライン（保存データを表示中）");
    } finally {
      pulling = false;
    }
  }

  function schedulePush() {
    if (!ouchiCode) return;
    clearTimeout(pushTimer);
    pushTimer = setTimeout(push, 900);
  }

  async function push() {
    if (!ouchiCode || pushing) return;
    pushing = true;
    setStatus("syncing", "🔄 同期中…");
    try {
      const res = await fetch(`${BLOB_BASE}/${ouchiCode}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(state),
      });
      if (!res.ok) throw new Error("PUT " + res.status);
      lastSyncAt = Date.now();
      localStorage.setItem(KEY_SYNC, String(lastSyncAt));
      refreshStatusIdle();
    } catch (e) {
      setStatus("err", "⚠️ 同期できず（あとで自動リトライ）");
    } finally {
      pushing = false;
    }
  }

  // 新しいおうち（共有ブロブ）を作成
  async function createOuchi() {
    setStatus("syncing", "🏠 おうちを作成中…");
    try {
      const res = await fetch(BLOB_BASE, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(state),
      });
      if (!res.ok && res.status !== 201) throw new Error("POST " + res.status);
      const loc = res.headers.get("Location") || "";
      const id = loc.split("/").pop();
      if (!id) throw new Error("no-location");
      setOuchiCode(id);
      lastSyncAt = Date.now();
      localStorage.setItem(KEY_SYNC, String(lastSyncAt));
      refreshStatusIdle();
      return id;
    } catch (e) {
      setStatus("err", "⚠️ おうちの作成に失敗（通信を確認してね）");
      return null;
    }
  }

  function setOuchiCode(code) {
    ouchiCode = code;
    localStorage.setItem(KEY_CODE, code);
    const url = new URL(location.href);
    url.searchParams.set("ouchi", code);
    history.replaceState(null, "", url);
  }

  function shareUrl() {
    const url = new URL(location.href);
    url.searchParams.set("ouchi", ouchiCode);
    return url.toString();
  }

  // ---------- 共有モーダル ----------
  function openShareModal() {
    const modal = document.getElementById("shareModal");
    const note = document.getElementById("shareNote");
    const fill = () => {
      document.getElementById("shareLink").value = shareUrl();
      document.getElementById("shareCode").value = ouchiCode;
    };
    modal.hidden = false;
    if (!ouchiCode) {
      note.textContent = "おうちを作成しています…";
      createOuchi().then((id) => {
        if (id) { fill(); note.textContent = "このリンクを別の端末で開いてね 💌"; }
        else note.textContent = "通信エラーで作成できませんでした。少し待って再度お試しください。";
      });
    } else {
      fill();
      note.textContent = "このリンクを別の端末で開いてね 💌";
    }
  }

  async function joinOuchi() {
    const input = prompt("参加するおうちコードを入力してね\n（別の端末で発行した共有リンク／コードを使ってね）");
    if (!input) return;
    const code = input.trim().split("/").pop().split("?")[0];
    if (!code) return;
    setOuchiCode(code);
    setStatus("syncing", "🔄 おうちに参加中…");
    // 参加先のデータを優先して取り込む
    state.updatedAt = 0;
    await pull();
  }

  // ---------- コピー ----------
  async function copyText(text, btn) {
    try {
      await navigator.clipboard.writeText(text);
      const old = btn.textContent;
      btn.textContent = "コピー済 ✓";
      setTimeout(() => (btn.textContent = old), 1400);
    } catch {
      document.getElementById("shareNote").textContent =
        "コピーできませんでした。手動で選択してコピーしてね。";
    }
  }

  // ---------- アプリ更新チェック（Webキャッシュ対策） ----------
  async function checkAppUpdate() {
    try {
      const res = await fetch("version.json?t=" + Date.now(), { cache: "no-store" });
      if (!res.ok) return;
      const { version } = await res.json();
      if (version && version !== APP_VERSION) {
        const hint = document.getElementById("saveHint");
        hint.innerHTML =
          '✨ 新しいバージョンがあります → <a href="#" id="reloadApp">再読み込み</a>';
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
    // URLの ?ouchi= があれば参加扱い
    const urlCode = new URLSearchParams(location.search).get("ouchi");
    if (urlCode && urlCode !== ouchiCode) {
      setOuchiCode(urlCode);
      state.updatedAt = 0; // 参加先を優先
    }

    // 追加ボタン
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

    // 月ナビ
    document.getElementById("prevMonth").addEventListener("click", () => shiftMonth(-1));
    document.getElementById("nextMonth").addEventListener("click", () => shiftMonth(1));
    document.getElementById("monthPicker").addEventListener("change", (e) => {
      if (e.target.value) { currentMonth = e.target.value; renderAll(); }
    });

    // メモ
    document.getElementById("memo").addEventListener("input", (e) => {
      getMonth().memo = e.target.value;
      touch();
    });

    // リセット
    document.getElementById("resetMonth").addEventListener("click", () => {
      if (confirm(`${monthLabel(currentMonth)} の内容をリセットしますか？`)) {
        state.months[currentMonth] = blankMonth();
        renderAll();
        touch();
      }
    });

    // 同期系ボタン
    document.getElementById("refreshBtn").addEventListener("click", () => {
      if (ouchiCode) pull();
      else openShareModal();
    });
    document.getElementById("shareBtn").addEventListener("click", openShareModal);
    document.getElementById("joinBtn").addEventListener("click", joinOuchi);

    // モーダル
    document.getElementById("shareClose").addEventListener("click", () => {
      document.getElementById("shareModal").hidden = true;
    });
    document.getElementById("shareModal").addEventListener("click", (e) => {
      if (e.target.id === "shareModal") e.target.hidden = true;
    });
    document.getElementById("copyLink").addEventListener("click", (e) =>
      copyText(document.getElementById("shareLink").value, e.target)
    );
    document.getElementById("copyCode").addEventListener("click", (e) =>
      copyText(document.getElementById("shareCode").value, e.target)
    );

    renderAll();
    refreshStatusIdle();

    // 起動時にサーバ最新を取得（要件: 起動時更新）
    if (ouchiCode) pull();

    // 定期バックグラウンド更新＋タブ復帰時更新
    setInterval(() => {
      if (ouchiCode && document.visibilityState === "visible") pull({ quiet: true });
    }, POLL_MS);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible" && ouchiCode) pull({ quiet: true });
    });

    checkAppUpdate();
  }

  document.addEventListener("DOMContentLoaded", init);
})();
