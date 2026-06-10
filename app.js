(() => {
  "use strict";

  const APP_VERSION = "1.3.0";
  const KEY_DATA = "baby-budget-data-v2";
  const KEY_SYNC = "baby-budget-lastsync-v2";
  const POLL_MS = 15000;
  const SYNC_URL = String(window.OUCHI_SYNC_URL || "").replace(/\/+$/, "");
  const remoteUrl = () => `${SYNC_URL}/baby-budget.json`;

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
      limit: [{ name: "毎月使う上限", amount: 230000 }],
      budgets: [
        { name: "Rent + Utilities", amount: 80000 },
        { name: "groceries", amount: 30000 },
        { name: "eating out", amount: 15000 },
        { name: "transportation", amount: 5000 },
        { name: "cosmetics", amount: 10000 },
        { name: "subscriptions", amount: 10000 },
      ],
      expenses: [
        { day: 1, category: "groceries", memo: "901 (1)", amount: 901 },
        { day: 2, category: "groceries", memo: "250 + 928 (2)", amount: 250 },
        { day: 2, category: "groceries", memo: "250 + 928 (2)", amount: 928 },
        { day: 3, category: "groceries", memo: "0 (3)", amount: 0 },
        { day: 4, category: "groceries", memo: "581 (4)", amount: 581 },
        { day: 5, category: "eating out", memo: "1199 (5; 外食)", amount: 1199 },
        { day: 6, category: "eating out", memo: "1900 (6; 外食)", amount: 1900 },
        { day: 6, category: "transportation", memo: "2000 (交通費)", amount: 2000 },
        { day: 7, category: "groceries", memo: "676 (7)", amount: 676 },
        { day: 8, category: "groceries", memo: "356 + 386 + 717 (8)", amount: 356 },
        { day: 8, category: "groceries", memo: "356 + 386 + 717 (8)", amount: 386 },
        { day: 8, category: "groceries", memo: "356 + 386 + 717 (8)", amount: 717 },
        { day: 9, category: "groceries", memo: "232 (9)", amount: 232 },
        { day: 10, category: "groceries", memo: "255 + 165 + 909 (10)", amount: 255 },
        { day: 10, category: "groceries", memo: "255 + 165 + 909 (10)", amount: 165 },
        { day: 10, category: "groceries", memo: "255 + 165 + 909 (10)", amount: 909 },
        { day: 10, category: "subscriptions", memo: "Subscriptions 400+___", amount: 400 },
      ],
      memo: "画像1: 毎月使う上限 230,000。画像2: 6月1日から10日までの使用済み。",
    };
  }

  function initialState() {
    return {
      version: APP_VERSION,
      updatedAt: Date.now(),
      months: { "2026-06": seedMonth() },
    };
  }

  let state = load();
  let currentMonth = "2026-06";
  let pushTimer = null;
  let pushing = false;

  function load() {
    try {
      const saved = JSON.parse(localStorage.getItem(KEY_DATA));
      if (saved?.months) return saved;
    } catch {}
    const seeded = initialState();
    localStorage.setItem(KEY_DATA, JSON.stringify(seeded));
    return seeded;
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
    if (SYNC_URL) schedulePush();
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
      const tr = document.createElement("tr");
      tr.append(
        reorderCell(expenses, index, renderAndTouch),
        cell(item, "day", "1", "numeric"),
        selectCell(item, "category"),
        cell(item, "memo", "メモ"),
        cell(item, "amount", "0", "numeric amount-cell"),
        delCell(() => {
          expenses.splice(index, 1);
          renderAndTouch();
        })
      );
      body.appendChild(tr);
    });
  }

  function renderDaily() {
    const grouped = new Map();
    monthData().expenses.forEach((expense) => {
      const day = num(expense.day);
      if (!grouped.has(day)) grouped.set(day, []);
      grouped.get(day).push(expense);
    });

    const lines = [...grouped.entries()]
      .sort(([a], [b]) => a - b)
      .map(([day, items]) => {
        const amountText = items.map((item) => num(item.amount)).join(" + ");
        const labels = [...new Set(items.map((item) => item.category).filter(Boolean))];
        return {
          name: `${amountText} (${day}${labels.length ? `; ${labels.join(" / ")}` : ""})`,
          amount: sum(items),
        };
      });
    const wrap = document.getElementById("livingList");
    wrap.innerHTML = "";
    lines.forEach((item) => {
      const row = document.createElement("div");
      row.className = "line-row";
      const name = document.createElement("input");
      name.className = "line-name";
      name.value = item.name;
      name.readOnly = true;
      const mark = document.createElement("span");
      mark.className = "line-yen";
      mark.textContent = "¥";
      const amount = document.createElement("input");
      amount.className = "line-amount";
      amount.value = item.amount;
      amount.readOnly = true;
      row.append(name, mark, amount);
      wrap.appendChild(row);
    });
  }

  function render() {
    const data = monthData();
    const limit = sum(data.limit);
    const budgetTotal = sum(data.budgets);
    const spent = sum(data.expenses);
    const remaining = limit - spent;

    document.getElementById("monthLabel").textContent = monthLabel(currentMonth);
    document.getElementById("monthPicker").value = currentMonth;
    document.getElementById("memo").value = data.memo || "";

    renderLineList("income", data.limit, "incomeList", renderAndTouch);
    renderLineList("fixed", data.budgets, "fixedList", renderAndTouch);
    renderExpenses();
    renderDaily();

    updateTotals();
    statusIdle();
  }

  function updateTotals() {
    const data = monthData();
    const limit = sum(data.limit);
    const budgetTotal = sum(data.budgets);
    const spent = sum(data.expenses);
    const remaining = limit - spent;

    document.getElementById("incomeTotal").textContent = yen(limit);
    document.getElementById("fixedTotal").textContent = yen(budgetTotal);
    document.getElementById("livingTotal").textContent = yen(spent);
    document.getElementById("creditTotal").textContent = yen(spent);
    document.getElementById("hlIncome").textContent = yen(limit);
    document.getElementById("hlExpense").textContent = yen(spent);
    const balance = document.getElementById("hlBalance");
    balance.textContent = yen(remaining);
    balance.style.color = remaining < 0 ? "#e5556e" : "var(--ink)";
    document.getElementById("balanceNote").textContent = `カテゴリ上限合計 ${yen(budgetTotal)}`;
    renderPiggy(limit, spent, remaining);
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
    else if (pct < 25) msg.textContent = "まだ余裕あり。6月10日時点ではかなり安全ペースです。";
    else if (pct < 70) msg.textContent = "いいペース。外食と交通費だけ少し見ておこう。";
    else msg.textContent = "残りが少なめ。必要な支出だけにしぼろう。";
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
    if (!SYNC_URL) {
      status.textContent = "ローカル保存";
      time.textContent = `前回更新 ${formatTime(state.updatedAt)}`;
      return;
    }
    status.textContent = "同期ON";
    const last = Number(localStorage.getItem(KEY_SYNC));
    time.textContent = last ? `前回同期 ${formatTime(last)}` : "同期準備中";
  }

  function formatTime(ts) {
    if (!ts) return "--:--";
    const date = new Date(ts);
    return `${String(date.getMonth() + 1).padStart(2, "0")}/${String(date.getDate()).padStart(2, "0")} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  }

  async function pull() {
    if (!SYNC_URL) {
      statusIdle();
      return;
    }
    document.getElementById("syncStatus").textContent = "更新確認中";
    try {
      const res = await fetch(remoteUrl(), { cache: "no-store" });
      if (!res.ok) throw new Error(`GET ${res.status}`);
      const remote = await res.json();
      if (remote?.months && (remote.updatedAt || 0) > (state.updatedAt || 0)) {
        state = remote;
        localStorage.setItem(KEY_DATA, JSON.stringify(state));
      }
      localStorage.setItem(KEY_SYNC, String(Date.now()));
    } catch {
      document.getElementById("syncStatus").textContent = "オフライン";
      document.getElementById("syncTime").textContent = `最後に成功したデータを表示中 ${formatTime(state.updatedAt)}`;
      return;
    }
    render();
  }

  function schedulePush() {
    clearTimeout(pushTimer);
    pushTimer = setTimeout(push, 800);
  }

  async function push() {
    if (!SYNC_URL || pushing) return;
    pushing = true;
    try {
      const res = await fetch(remoteUrl(), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(state),
      });
      if (!res.ok) throw new Error(`PUT ${res.status}`);
      localStorage.setItem(KEY_SYNC, String(Date.now()));
    } catch {
      document.getElementById("syncStatus").textContent = "同期失敗";
    } finally {
      pushing = false;
      statusIdle();
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
        if (button.dataset.target === "income") data.limit.push({ name: "", amount: "" });
        if (button.dataset.target === "fixed") data.budgets.push({ name: "", amount: "" });
        if (button.dataset.target === "credit") {
          data.expenses.push({ day: 10, category: "groceries", memo: "", amount: "" });
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
    document.getElementById("memo").addEventListener("input", (event) => {
      monthData().memo = event.target.value;
      touch();
    });
    document.getElementById("resetMonth").addEventListener("click", () => {
      if (!confirm("6月の画像データに戻しますか？")) return;
      state.months["2026-06"] = seedMonth();
      currentMonth = "2026-06";
      renderAndTouch();
    });
    document.getElementById("refreshBtn").addEventListener("click", pull);

    render();
    pull();
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
