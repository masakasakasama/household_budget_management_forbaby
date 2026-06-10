(() => {
  "use strict";

  const APP_VERSION = "1.5.0";
  const KEY_DATA = "baby-budget-data-v2";
  const KEY_SYNC = "baby-budget-lastsync-v2";
  const POLL_MS = 15000;
  const FIREBASE_CONFIG = window.BABY_FIREBASE_CONFIG || {};
  const SPACE_ID = window.BABY_SPACE_ID || "household_budget_management_forbaby";
  const syncEnabled = () => Boolean(
    FIREBASE_CONFIG.apiKey &&
    FIREBASE_CONFIG.appId &&
    FIREBASE_CONFIG.projectId
  );

  const categoryOptions = [
    "groceries",
    "eating out",
    "transportation",
    "cosmetics",
    "subscriptions",
    "Rent + Utilities",
  ];

  function seedMonth() {
    return {
      budgets: [
        { name: "Rent + Utilities", amount: 80000 },
        { name: "groceries", amount: 30000 },
        { name: "eating out", amount: 15000 },
        { name: "transportation", amount: 5000 },
        { name: "cosmetics", amount: 10000 },
        { name: "subscriptions", amount: 10000 },
      ],
      expenses: [
        { day: 1, category: "groceries", amount: 901 },
        { day: 2, category: "groceries", amount: 250 },
        { day: 2, category: "groceries", amount: 928 },
        { day: 3, category: "groceries", amount: 0 },
        { day: 4, category: "groceries", amount: 581 },
        { day: 5, category: "eating out", amount: 1199 },
        { day: 6, category: "eating out", amount: 1900 },
        { day: 6, category: "transportation", amount: 2000 },
        { day: 7, category: "groceries", amount: 676 },
        { day: 8, category: "groceries", amount: 356 },
        { day: 8, category: "groceries", amount: 386 },
        { day: 8, category: "groceries", amount: 717 },
        { day: 9, category: "groceries", amount: 232 },
        { day: 10, category: "groceries", amount: 255 },
        { day: 10, category: "groceries", amount: 165 },
        { day: 10, category: "groceries", amount: 909 },
        { day: 10, category: "subscriptions", amount: 400 },
      ],
    };
  }

  function initialState() {
    return {
      version: APP_VERSION,
      updatedAt: 0,
      months: { "2026-06": seedMonth() },
    };
  }

  let state = load();
  let currentMonth = "2026-06";
  let pushTimer = null;
  let pushing = false;
  let firestore = null;
  let authUser = null;
  let remoteStateRef = null;
  let remoteApplying = false;

  function load() {
    try {
      const saved = JSON.parse(localStorage.getItem(KEY_DATA));
      if (saved?.months) {
        normalizeState(saved);
        return saved;
      }
    } catch {}
    const seeded = initialState();
    normalizeState(seeded);
    localStorage.setItem(KEY_DATA, JSON.stringify(seeded));
    return seeded;
  }

  function normalizeState(targetState = state) {
    let changed = false;
    Object.values(targetState.months || {}).forEach((month) => {
      if (Array.isArray(month.expenses)) {
        const before = month.expenses.length;
        month.expenses = month.expenses
          .filter((expense) => String(expense.amount ?? "").trim() !== "")
          .map((expense) => {
            if (!("memo" in expense)) return expense;
            const { memo, ...rest } = expense;
            changed = true;
            return rest;
          });
        if (month.expenses.length !== before) changed = true;
      }
      if ("limit" in month) {
        delete month.limit;
        changed = true;
      }
      if ("memo" in month) {
        delete month.memo;
        changed = true;
      }
    });
    return changed;
  }

  function monthData() {
    if (!state.months[currentMonth]) state.months[currentMonth] = seedMonth();
    return state.months[currentMonth];
  }

  function num(value) {
    const parsed = Number(String(value).replace(/[^0-9.-]/g, ""));
    return Number.isFinite(parsed) ? parsed : 0;
  }

  function yen(value) {
    return `¥${Math.round(value).toLocaleString("ja-JP")}`;
  }

  function sum(list) {
    return list.reduce((total, item) => total + num(item.amount), 0);
  }

  function monthLabel(value) {
    const [year, month] = value.split("-");
    return `${year}年${Number(month)}月`;
  }

  function touch() {
    state.version = APP_VERSION;
    state.updatedAt = Date.now();
    localStorage.setItem(KEY_DATA, JSON.stringify(state));
    flashSave("保存しました");
    if (syncEnabled()) schedulePush();
  }

  function persistAndRefreshTotals() {
    touch();
    updateTotals();
  }

  function flashSave(text) {
    const hint = document.getElementById("saveHint");
    hint.textContent = text;
    clearTimeout(flashSave.timer);
    flashSave.timer = setTimeout(() => {
      hint.textContent = "自動で保存されます";
    }, 1400);
  }

  function renderLineList(target, list, containerId, onChange) {
    const wrap = document.getElementById(containerId);
    wrap.innerHTML = "";
    list.forEach((item, index) => {
      const row = document.createElement("div");
      row.className = "line-row";

      const reorder = document.createElement("div");
      reorder.className = "reorder";
      reorder.append(
        smallButton("▲", () => move(list, index, -1, () => onChange())),
        smallButton("▼", () => move(list, index, 1, () => onChange()))
      );

      const name = document.createElement("input");
      name.className = "line-name";
      name.value = item.name || "";
      name.placeholder = "名前";
      name.addEventListener("input", () => {
        item.name = name.value;
        persistAndRefreshTotals();
      });

      const mark = document.createElement("span");
      mark.className = "line-yen";
      mark.textContent = "¥";

      const amount = document.createElement("input");
      amount.className = "line-amount";
      amount.inputMode = "numeric";
      amount.value = item.amount ?? "";
      amount.placeholder = "0";
      amount.addEventListener("input", () => {
        item.amount = amount.value;
        persistAndRefreshTotals();
      });

      const del = deleteButton(() => {
        list.splice(index, 1);
        onChange();
      });

      row.append(reorder, name, mark, amount, del);
      wrap.appendChild(row);
    });
  }

  function renderExpenses() {
    const body = document.getElementById("creditBody");
    const expenses = monthData().expenses;
    body.innerHTML = "";
    expenses.forEach((item, index) => {
      const row = document.createElement("div");
      row.className = "expense-row";

      const reorder = document.createElement("div");
      reorder.className = "expense-reorder";
      reorder.append(
        smallButton("▲", () => move(expenses, index, -1, renderAndTouch)),
        smallButton("▼", () => move(expenses, index, 1, renderAndTouch))
      );

      const day = labeledInput("日", item, "day", "1", "numeric");
      const category = labeledSelect("カテゴリ", item, "category");
      const amount = labeledInput("金額", item, "amount", "0", "numeric amount-cell");
      const del = deleteButton(() => {
        expenses.splice(index, 1);
        renderAndTouch();
      });

      row.append(reorder, day, category, amount, del);
      body.appendChild(row);
    });
  }

  function render() {
    const data = monthData();
    const budgetTotal = sum(data.budgets);
    const spent = sum(data.expenses);

    document.getElementById("monthLabel").textContent = monthLabel(currentMonth);
    document.getElementById("monthPicker").value = currentMonth;

    renderLineList("fixed", data.budgets, "fixedList", renderAndTouch);
    renderExpenses();
    renderCategoryChart();

    updateTotals();
    statusIdle();
  }

  function updateTotals() {
    const data = monthData();
    const budgetTotal = sum(data.budgets);
    const limit = budgetTotal;
    const spent = sum(data.expenses);
    const remaining = limit - spent;

    document.getElementById("fixedTotal").textContent = yen(budgetTotal);
    document.getElementById("creditTotal").textContent = yen(spent);
    document.getElementById("hlIncome").textContent = yen(limit);
    document.getElementById("hlExpense").textContent = yen(spent);
    const balance = document.getElementById("hlBalance");
    balance.textContent = yen(remaining);
    balance.style.color = remaining < 0 ? "#e5556e" : "var(--ink)";
    document.getElementById("balanceNote").textContent = "カテゴリ上限から自動計算";
    document.getElementById("savingTarget").textContent = yen(Math.max(0, remaining));
    renderPiggy(limit, spent, remaining);
  }

  function budgetFor(category) {
    return monthData().budgets.find((item) => item.name === category);
  }

  function spentFor(category) {
    return monthData().expenses
      .filter((expense) => expense.category === category)
      .reduce((total, expense) => total + num(expense.amount), 0);
  }

  function renderCategoryChart() {
    const wrap = document.getElementById("categoryChart");
    if (!wrap) return;
    wrap.innerHTML = "";
    monthData().budgets.forEach((budget) => {
      const limit = num(budget.amount);
      const spent = spentFor(budget.name);
      const remaining = limit - spent;
      const pct = limit > 0 ? Math.min(100, Math.round((spent / limit) * 100)) : 0;
      const row = document.createElement("div");
      row.className = "category-row";
      row.innerHTML = `
        <div class="category-top">
          <strong>${budget.name || "未設定"}</strong>
          <span>${yen(spent)} / ${yen(limit)}</span>
        </div>
        <div class="category-bar"><span style="width:${pct}%"></span></div>
        <div class="category-bottom">
          <span>${pct}%使用</span>
          <span>${remaining >= 0 ? "残り " + yen(remaining) : "オーバー " + yen(Math.abs(remaining))}</span>
        </div>
      `;
      wrap.appendChild(row);
    });
  }

  function renderAndTouch() {
    render();
    touch();
  }

  function renderPiggy(limit, spent, remaining) {
    const pct = limit > 0 ? Math.min(100, Math.max(0, Math.round((spent / limit) * 100))) : 0;
    document.getElementById("piggyFill").style.width = `${pct}%`;
    document.getElementById("piggyRate").textContent = `上限の${pct}%使用`;
    const msg = document.getElementById("piggyMsg");
    if (remaining < 0) msg.textContent = "上限を超えています。今日の追加支出を確認してね。";
    else if (pct < 25) msg.textContent = "かなりいいペース。残った分はそのまま貯金に回せそう。";
    else if (pct < 70) msg.textContent = "まだ大丈夫。カテゴリ別の残りを見ながら使おう。";
    else msg.textContent = "残りが少なめ。今週は必要な支出だけにしぼろう。";
  }

  function smallButton(label, onClick) {
    const button = document.createElement("button");
    button.className = "move-btn";
    button.type = "button";
    button.textContent = label;
    button.addEventListener("click", onClick);
    return button;
  }

  function deleteButton(onClick) {
    const button = document.createElement("button");
    button.className = "del-btn";
    button.type = "button";
    button.textContent = "×";
    button.title = "削除";
    button.addEventListener("click", onClick);
    return button;
  }

  function move(list, index, dir, after) {
    const next = index + dir;
    if (next < 0 || next >= list.length) return;
    [list[index], list[next]] = [list[next], list[index]];
    after();
  }

  function reorderCell(list, index, after) {
    const td = document.createElement("td");
    td.className = "reorder-cell";
    const box = document.createElement("div");
    box.className = "reorder reorder-v";
    box.append(
      smallButton("▲", () => move(list, index, -1, after)),
      smallButton("▼", () => move(list, index, 1, after))
    );
    td.appendChild(box);
    return td;
  }

  function cell(item, key, placeholder, mode = "") {
    const td = document.createElement("td");
    const input = document.createElement("input");
    if (mode.includes("numeric")) input.inputMode = "numeric";
    if (mode.includes("amount-cell")) input.className = "amount-cell";
    input.value = item[key] ?? "";
    input.placeholder = placeholder;
    input.addEventListener("input", () => {
      item[key] = input.value;
      persistAndRefreshTotals();
    });
    td.appendChild(input);
    return td;
  }

  function labeledInput(label, item, key, placeholder, mode = "") {
    const wrap = document.createElement("label");
    wrap.className = "expense-field";
    const caption = document.createElement("span");
    caption.textContent = label;
    const input = document.createElement("input");
    if (mode.includes("numeric")) input.inputMode = "numeric";
    if (mode.includes("amount-cell")) input.className = "amount-cell";
    input.value = item[key] ?? "";
    input.placeholder = placeholder;
    input.addEventListener("input", () => {
      item[key] = input.value;
      persistAndRefreshTotals();
    });
    wrap.append(caption, input);
    return wrap;
  }

  function selectCell(item, key) {
    const td = document.createElement("td");
    const select = document.createElement("select");
    categoryOptions.forEach((name) => {
      const option = document.createElement("option");
      option.value = name;
      option.textContent = name;
      select.appendChild(option);
    });
    select.value = item[key] || categoryOptions[0];
    select.addEventListener("change", () => {
      item[key] = select.value;
      renderAndTouch();
    });
    td.appendChild(select);
    return td;
  }

  function labeledSelect(label, item, key) {
    const wrap = document.createElement("label");
    wrap.className = "expense-field expense-category";
    const caption = document.createElement("span");
    caption.textContent = label;
    const select = document.createElement("select");
    categoryOptions.forEach((name) => {
      const option = document.createElement("option");
      option.value = name;
      option.textContent = name;
      select.appendChild(option);
    });
    select.value = item[key] || categoryOptions[0];
    select.addEventListener("change", () => {
      item[key] = select.value;
      renderAndTouch();
    });
    wrap.append(caption, select);
    return wrap;
  }

  function delCell(onClick) {
    const td = document.createElement("td");
    td.className = "del-cell";
    td.appendChild(deleteButton(onClick));
    return td;
  }

  function shiftMonth(delta) {
    const [year, month] = currentMonth.split("-").map(Number);
    const date = new Date(year, month - 1 + delta, 1);
    currentMonth = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
    render();
  }

  function statusIdle() {
    const status = document.getElementById("syncStatus");
    const time = document.getElementById("syncTime");
    if (!status || !time) return;
    if (!syncEnabled()) {
      status.textContent = "Firestore設定待ち";
      time.textContent = "FirebaseのapiKey/appIdをsync-config.jsに入れると彼女の端末と同期します";
      return;
    }
    status.textContent = authUser ? "Firestore同期ON" : "Firestore接続中";
    const last = Number(localStorage.getItem(KEY_SYNC));
    time.textContent = last ? `前回同期 ${formatTime(last)}` : "同期準備中";
  }

  function formatTime(ts) {
    if (!ts) return "--:--";
    const date = new Date(ts);
    return `${String(date.getMonth() + 1).padStart(2, "0")}/${String(date.getDate()).padStart(2, "0")} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  }

  async function pull() {
    if (!remoteStateRef) return statusIdle();
    document.getElementById("syncStatus").textContent = "更新確認中";
    statusIdle();
  }

  function schedulePush() {
    clearTimeout(pushTimer);
    pushTimer = setTimeout(push, 800);
  }

  async function push() {
    if (!remoteStateRef || pushing || remoteApplying) return;
    pushing = true;
    try {
      const { setDoc, serverTimestamp } = await firebaseFirestoreApi();
      await setDoc(remoteStateRef, {
        state,
        updatedAt: state.updatedAt || Date.now(),
        updatedBy: authUser?.uid || "",
        serverUpdatedAt: serverTimestamp(),
      }, { merge: true });
      localStorage.setItem(KEY_SYNC, String(Date.now()));
    } catch {
      document.getElementById("syncStatus").textContent = "Firestore同期失敗";
    } finally {
      pushing = false;
      statusIdle();
    }
  }

  function publicShareUrl() {
    return "https://masakasakasama.github.io/household_budget_management_forbaby/";
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      return false;
    }
  }

  async function createShareLink() {
    const link = publicShareUrl();
    const copied = await copyText(link);
    flashSave(copied ? "共有リンクをコピーしました" : link);
  }

  async function firebaseAppApi() {
    return import("https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js");
  }

  async function firebaseAuthApi() {
    return import("https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js");
  }

  async function firebaseFirestoreApi() {
    return import("https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js");
  }

  async function initFirestoreSync() {
    if (!syncEnabled()) {
      statusIdle();
      return;
    }

    document.getElementById("syncStatus").textContent = "Firestore接続中";
    try {
      const { initializeApp } = await firebaseAppApi();
      const { getAuth, signInAnonymously } = await firebaseAuthApi();
      const {
        getFirestore,
        doc,
        getDoc,
        setDoc,
        updateDoc,
        onSnapshot,
        arrayUnion,
        serverTimestamp,
      } = await firebaseFirestoreApi();

      const app = initializeApp(FIREBASE_CONFIG);
      const auth = getAuth(app);
      const credential = await signInAnonymously(auth);
      authUser = credential.user;
      firestore = getFirestore(app);

      const spaceRef = doc(firestore, "spaces", SPACE_ID);
      try {
        await updateDoc(spaceRef, {
          memberUids: arrayUnion(authUser.uid),
          updatedAt: serverTimestamp(),
        });
      } catch {
        await setDoc(spaceRef, {
          name: "Baby家計簿",
          memberUids: [authUser.uid],
          updatedAt: serverTimestamp(),
        }, { merge: true });
      }

      remoteStateRef = doc(firestore, "spaces", SPACE_ID, "budget", "state");
      const snap = await getDoc(remoteStateRef);
      if (!snap.exists()) {
        await setDoc(remoteStateRef, {
          state,
          updatedAt: state.updatedAt || Date.now(),
          updatedBy: authUser.uid,
          serverUpdatedAt: serverTimestamp(),
        }, { merge: true });
      }

      onSnapshot(remoteStateRef, (remoteSnap) => {
        const remote = remoteSnap.data()?.state;
        if (!remote?.months) return;
        if ((remote.updatedAt || 0) <= (state.updatedAt || 0)) {
          statusIdle();
          return;
        }
        remoteApplying = true;
        state = remote;
        const cleaned = normalizeState(state);
        localStorage.setItem(KEY_DATA, JSON.stringify(state));
        localStorage.setItem(KEY_SYNC, String(Date.now()));
        render();
        remoteApplying = false;
        if (cleaned) {
          state.updatedAt = Date.now();
          touch();
        }
      }, () => {
        document.getElementById("syncStatus").textContent = "Firestore接続失敗";
        document.getElementById("syncTime").textContent = "Firestoreルール、apiKey/appId、匿名ログイン設定を確認してください";
      });

      await push();
      statusIdle();
    } catch (error) {
      document.getElementById("syncStatus").textContent = "Firestore接続失敗";
      document.getElementById("syncTime").textContent =
        `Firestore接続失敗: ${error?.code || error?.message || "設定を確認してください"}`;
    }
  }

  async function checkAppUpdate() {
    try {
      const res = await fetch(`version.json?t=${Date.now()}`, { cache: "no-store" });
      if (!res.ok) return;
      const data = await res.json();
      if (data.version && data.version !== APP_VERSION) {
        document.getElementById("saveHint").textContent = "新しい版があります。再読み込みしてください。";
      }
    } catch {}
  }

  function init() {
    document.querySelectorAll(".add-line").forEach((button) => {
      button.addEventListener("click", () => {
        const data = monthData();
        if (button.dataset.target === "fixed") data.budgets.push({ name: "", amount: "" });
        if (button.dataset.target === "credit") {
          data.expenses.push({ day: 10, category: "groceries", amount: 0 });
        }
        renderAndTouch();
      });
    });

    document.getElementById("prevMonth").addEventListener("click", () => shiftMonth(-1));
    document.getElementById("nextMonth").addEventListener("click", () => shiftMonth(1));
    document.getElementById("monthPicker").addEventListener("change", (event) => {
      currentMonth = event.target.value || currentMonth;
      render();
    });
    document.getElementById("refreshBtn")?.addEventListener("click", pull);
    document.getElementById("shareBtn")?.addEventListener("click", createShareLink);

    render();
    initFirestoreSync();
    checkAppUpdate();
    setInterval(() => {
      if (document.visibilityState === "visible") pull();
    }, POLL_MS);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") pull();
    });
  }

  document.addEventListener("DOMContentLoaded", init);
})();
