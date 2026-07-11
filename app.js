(() => {
  "use strict";

  const APP_VERSION = "2.2.0";
  const SCHEMA_VERSION = 2;
  const KEY_DATA = "baby-budget-data-v2";
  const KEY_BACKUPS = "baby-budget-backups-v2";
  const KEY_PENDING = "baby-budget-pending-v2";
  const KEY_RECENT = "baby-budget-recent-categories";
  const FIREBASE_CONFIG = window.BABY_FIREBASE_CONFIG || {};
  const SPACE_ID = window.BABY_SPACE_ID || "household_budget_management_forbaby";
  const DEFAULT_CATEGORIES = [
    "groceries",
    "eating out",
    "transportation",
    "cosmetics",
    "subscriptions",
    "Rent + Utilities",
  ];

  const syncEnabled = () => Boolean(
    FIREBASE_CONFIG.apiKey &&
    FIREBASE_CONFIG.appId &&
    FIREBASE_CONFIG.projectId &&
    !window.location?.search?.includes("offline=1")
  );

  let loadedSchemaVersion = 0;
  let hasSavedLocalState = false;
  let state = loadState();
  let currentMonth = currentMonthKey();
  let firestore = null;
  let authUser = null;
  let fsApi = null;
  let spaceDocumentRef = null;
  let remoteReady = false;
  let remoteApplying = false;
  let editExpenseId = null;
  let lastDeletedId = null;
  let saveTimers = new Map();
  let unsubscribeRemote = [];
  let legacyBridgeRunning = false;

  function seedBudgets() {
    return [
      { id: "rent-utilities", name: "Rent + Utilities", amount: 80000 },
      { id: "groceries", name: "groceries", amount: 30000 },
      { id: "eating-out", name: "eating out", amount: 15000 },
      { id: "transportation", name: "transportation", amount: 5000 },
      { id: "cosmetics", name: "cosmetics", amount: 10000 },
      { id: "subscriptions", name: "subscriptions", amount: 10000 },
    ];
  }

  function seedMonth() {
    const expenses = [
      [1, "groceries", 901], [2, "groceries", 250], [2, "groceries", 928],
      [3, "groceries", 0], [4, "groceries", 581], [5, "eating out", 1199],
      [6, "eating out", 1900], [6, "transportation", 2000], [7, "groceries", 676],
      [8, "groceries", 356], [8, "groceries", 386], [8, "groceries", 717],
      [9, "groceries", 232], [10, "groceries", 255], [10, "groceries", 165],
      [10, "groceries", 909], [10, "subscriptions", 400],
    ].map(([day, category, amount], index) => ({
      id: `legacy-2026-06-${index}`,
      month: "2026-06",
      day,
      category,
      amount,
      note: "",
      source: "manual",
      createdAt: index + 1,
      updatedAtMs: index + 1,
      deletedAt: null,
    }));
    return monthTemplate("2026-06", seedBudgets(), expenses);
  }

  function monthTemplate(month, budgets, expenses = []) {
    return {
      month,
      budgets: budgets.map((budget, index) => ({
        id: budget.id || stableId("budget", `${month}-${index}-${budget.name || ""}`),
        name: budget.name || "",
        amount: num(budget.amount),
      })),
      expenses,
      savingGoal: 0,
      salary: 0,
      locked: false,
      inheritedFrom: "",
      createdAt: Date.now(),
    };
  }

  function initialState() {
    return {
      version: APP_VERSION,
      schemaVersion: SCHEMA_VERSION,
      updatedAt: 0,
      months: { "2026-06": seedMonth() },
      recurring: [],
    };
  }

  function clone(value) {
    if (typeof structuredClone === "function") return structuredClone(value);
    return JSON.parse(JSON.stringify(value));
  }

  function loadState() {
    try {
      const saved = JSON.parse(localStorage.getItem(KEY_DATA));
      if (saved?.months) {
        hasSavedLocalState = true;
        loadedSchemaVersion = num(saved.schemaVersion);
        return normalizeState(saved);
      }
    } catch {}
    const seeded = initialState();
    loadedSchemaVersion = SCHEMA_VERSION;
    localStorage.setItem(KEY_DATA, JSON.stringify(seeded));
    return seeded;
  }

  function normalizeState(target) {
    const normalized = target || initialState();
    normalized.version = APP_VERSION;
    normalized.schemaVersion = SCHEMA_VERSION;
    normalized.months ||= {};
    normalized.recurring = Array.isArray(normalized.recurring) ? normalized.recurring : [];

    Object.entries(normalized.months).forEach(([monthKey, month]) => {
      month.month = monthKey;
      month.budgets = (month.budgets || []).map((budget, index) => ({
        id: budget.id || stableId("budget", `${monthKey}-${index}-${budget.name || ""}`),
        name: budget.name || "",
        amount: num(budget.amount),
      }));
      month.expenses = (month.expenses || []).map((expense, index) => normalizeExpense(expense, monthKey, index));
      month.savingGoal = num(month.savingGoal);
      month.salary = num(month.salary);
      month.locked = Boolean(month.locked);
      month.inheritedFrom ||= "";
      month.createdAt ||= Date.now();
    });

    normalized.recurring = normalized.recurring.map((item, index) => ({
      id: item.id || stableId("recurring", `${index}-${item.day}-${item.category}-${item.amount}`),
      day: clampDay(item.day, 31),
      category: item.category || DEFAULT_CATEGORIES[0],
      amount: num(item.amount),
      note: item.note || "",
      active: item.active !== false,
      createdMonth: item.createdMonth || currentMonthKey(),
      createdAt: num(item.createdAt) || Date.now(),
      deletedAt: item.deletedAt || null,
    }));
    return normalized;
  }

  function normalizeExpense(expense, monthKey, index = 0) {
    const createdAt = num(expense.createdAt) || index + 1;
    return {
      id: expense.id || stableId("legacy", `${monthKey}-${index}`),
      month: expense.month || monthKey,
      day: clampDay(expense.day, daysInMonth(monthKey)),
      category: expense.category || DEFAULT_CATEGORIES[0],
      amount: num(expense.amount),
      note: expense.note || expense.memo || "",
      source: expense.source || "manual",
      status: expense.status === "planned" || (!expense.status && expense.source === "recurring") ? "planned" : "spent",
      recurringId: expense.recurringId || "",
      createdAt,
      updatedAtMs: num(expense.updatedAtMs) || createdAt,
      deletedAt: expense.deletedAt || null,
    };
  }

  function persistLocal(message = "保存しました") {
    state.version = APP_VERSION;
    state.schemaVersion = SCHEMA_VERSION;
    state.updatedAt = Date.now();
    localStorage.setItem(KEY_DATA, JSON.stringify(state));
    if (message) flashSave(message);
  }

  function currentMonthKey(date = new Date()) {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
  }

  function localDateKey(date = new Date()) {
    return `${currentMonthKey(date)}-${String(date.getDate()).padStart(2, "0")}`;
  }

  function monthLabel(value) {
    const [year, month] = value.split("-");
    return `${year}年${Number(month)}月`;
  }

  function daysInMonth(monthKey) {
    const [year, month] = monthKey.split("-").map(Number);
    return new Date(year, month, 0).getDate();
  }

  function clampDay(value, max) {
    return Math.min(Math.max(Math.round(num(value)) || 1, 1), max);
  }

  function previousMonthKey(monthKey) {
    const [year, month] = monthKey.split("-").map(Number);
    const date = new Date(year, month - 2, 1);
    return currentMonthKey(date);
  }

  function createMonthData(monthKey) {
    const previousKey = Object.keys(state.months)
      .filter((key) => key < monthKey)
      .sort()
      .pop();
    const source = state.months[previousKey]?.budgets || seedBudgets();
    const month = monthTemplate(monthKey, source);
    month.inheritedFrom = previousKey || "";
    state.months[monthKey] = month;
    persistLocal("");
    if (remoteReady) syncMonth(monthKey, "month-create");
    return month;
  }

  function monthData(monthKey = currentMonth) {
    return state.months[monthKey] || createMonthData(monthKey);
  }

  function num(value) {
    const parsed = Number(String(value ?? "").replace(/[^0-9.-]/g, ""));
    return Number.isFinite(parsed) ? parsed : 0;
  }

  function yen(value) {
    return `¥${Math.round(num(value)).toLocaleString("ja-JP")}`;
  }

  function sum(list) {
    return list.reduce((total, item) => total + num(item.amount), 0);
  }

  function stableId(prefix, input) {
    let hash = 2166136261;
    for (const char of String(input)) {
      hash ^= char.charCodeAt(0);
      hash = Math.imul(hash, 16777619);
    }
    return `${prefix}-${(hash >>> 0).toString(36)}`;
  }

  function newId(prefix) {
    const suffix = crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    return `${prefix}-${suffix}`;
  }

  function allExpenses(includeDeleted = true) {
    const result = [];
    Object.values(state.months).forEach((month) => {
      (month.expenses || []).forEach((expense) => {
        if (includeDeleted || !expense.deletedAt) result.push(expense);
      });
    });
    return result;
  }

  function activeExpenses(monthKey = currentMonth) {
    return (monthData(monthKey).expenses || []).filter((expense) => !expense.deletedAt);
  }

  function findExpense(id) {
    for (const month of Object.values(state.months)) {
      const expense = (month.expenses || []).find((item) => item.id === id);
      if (expense) return expense;
    }
    return null;
  }

  function removeExpenseFromLocal(id) {
    Object.values(state.months).forEach((month) => {
      month.expenses = (month.expenses || []).filter((expense) => expense.id !== id);
    });
  }

  function upsertExpenseLocal(expense) {
    removeExpenseFromLocal(expense.id);
    const target = monthData(expense.month);
    target.expenses.push(expense);
  }

  function categoryOptions() {
    const recent = loadJson(KEY_RECENT, []);
    const names = [
      ...recent,
      ...monthData().budgets.map((budget) => budget.name),
      ...DEFAULT_CATEGORIES,
      ...allExpenses(false).map((expense) => expense.category),
    ].filter(Boolean);
    return [...new Set(names)];
  }

  function rememberCategory(category) {
    const recent = loadJson(KEY_RECENT, []).filter((name) => name !== category);
    recent.unshift(category);
    localStorage.setItem(KEY_RECENT, JSON.stringify(recent.slice(0, 5)));
  }

  function loadJson(key, fallback) {
    try {
      return JSON.parse(localStorage.getItem(key)) ?? fallback;
    } catch {
      return fallback;
    }
  }

  function serializeMonth(month) {
    return {
      month: month.month,
      budgets: month.budgets.map((budget) => ({ id: budget.id, name: budget.name, amount: num(budget.amount) })),
      savingGoal: num(month.savingGoal),
      salary: num(month.salary),
      locked: Boolean(month.locked),
      inheritedFrom: month.inheritedFrom || "",
      createdAt: num(month.createdAt) || Date.now(),
    };
  }

  function serializeExpense(expense) {
    return {
      id: expense.id,
      month: expense.month,
      day: clampDay(expense.day, daysInMonth(expense.month)),
      category: expense.category || DEFAULT_CATEGORIES[0],
      amount: num(expense.amount),
      note: expense.note || "",
      source: expense.source || "manual",
      status: expense.status === "planned" ? "planned" : "spent",
      recurringId: expense.recurringId || "",
      createdAt: num(expense.createdAt) || Date.now(),
      updatedAtMs: num(expense.updatedAtMs) || Date.now(),
      deletedAt: expense.deletedAt || null,
    };
  }

  function serializeRecurring(item) {
    return {
      id: item.id,
      day: clampDay(item.day, 31),
      category: item.category,
      amount: num(item.amount),
      note: item.note || "",
      active: item.active !== false,
      createdMonth: item.createdMonth,
      createdAt: num(item.createdAt) || Date.now(),
      deletedAt: item.deletedAt || null,
    };
  }

  function cleanRemote(data) {
    const result = { ...data };
    delete result.serverUpdatedAt;
    delete result.updatedAt;
    delete result.updatedBy;
    return result;
  }

  function entityCollection(type) {
    return type === "month" ? "months" : type === "expense" ? "expenses" : "recurring";
  }

  function operationData(type, data) {
    if (type === "month") return serializeMonth(data);
    if (type === "expense") return serializeExpense(data);
    return serializeRecurring(data);
  }

  function queueOperation(type, id, data, action, before = null, operationId = newId("op")) {
    const operation = {
      operationId,
      type,
      id,
      data: operationData(type, data),
      action,
      before,
      queuedAt: Date.now(),
    };
    if (!remoteReady) {
      addPending(operation);
      return;
    }
    writeOperation(operation).catch(() => addPending(operation));
  }

  function addPending(operation) {
    const pending = loadJson(KEY_PENDING, []);
    const withoutSame = pending.filter((item) => item.operationId !== operation.operationId);
    withoutSame.push(operation);
    localStorage.setItem(KEY_PENDING, JSON.stringify(withoutSame.slice(-500)));
    setDataStatus("端末に保存済み・同期待ち");
  }

  async function writeOperation(operation) {
    if (!remoteReady || !firestore || !fsApi) throw new Error("offline");
    const { doc, writeBatch, serverTimestamp } = fsApi;
    const batch = writeBatch(firestore);
    const collectionName = entityCollection(operation.type);
    const entityRef = doc(firestore, "spaces", SPACE_ID, collectionName, operation.id);
    const historyRef = doc(firestore, "spaces", SPACE_ID, "history", operation.operationId);
    batch.set(entityRef, {
      ...operation.data,
      serverUpdatedAt: serverTimestamp(),
      updatedBy: authUser?.uid || "",
    }, { merge: true });
    batch.set(historyRef, {
      action: operation.action,
      entityType: operation.type,
      entityId: operation.id,
      before: operation.before || null,
      after: operation.data,
      createdAtMs: operation.queuedAt,
      createdAt: serverTimestamp(),
      updatedBy: authUser?.uid || "",
    });
    await batch.commit();
    setDataStatus("Firestoreに保存済み");
  }

  async function flushPending() {
    const pending = loadJson(KEY_PENDING, []);
    if (!pending.length || !remoteReady) return;
    const failed = [];
    for (const operation of pending) {
      try {
        await writeOperation(operation);
      } catch {
        failed.push(operation);
      }
    }
    localStorage.setItem(KEY_PENDING, JSON.stringify(failed));
  }

  function syncMonth(monthKey, action = "month-update", before = null) {
    const month = monthData(monthKey);
    queueOperation("month", monthKey, month, action, before);
  }

  function syncExpense(expense, action = "expense-update", before = null) {
    expense.updatedAtMs = Date.now();
    queueOperation("expense", expense.id, expense, action, before);
  }

  function syncRecurring(item, action = "recurring-update", before = null) {
    queueOperation("recurring", item.id, item, action, before);
  }

  function scheduleEntitySave(key, callback, delay = 500) {
    clearTimeout(saveTimers.get(key));
    const timer = setTimeout(() => {
      saveTimers.delete(key);
      callback();
    }, delay);
    saveTimers.set(key, timer);
  }

  function addExpense(input, action = "expense-create") {
    const monthKey = input.month || currentMonth;
    const targetMonth = monthData(monthKey);
    if (targetMonth.locked) {
      flashSave("締めた月には追加できません");
      return null;
    }
    const expense = normalizeExpense({
      id: input.id || newId("expense"),
      month: monthKey,
      day: input.day,
      category: input.category,
      amount: input.amount,
      note: input.note || "",
      source: input.source || "manual",
      status: input.status === "planned" ? "planned" : "spent",
      recurringId: input.recurringId || "",
      createdAt: input.createdAt || Date.now(),
      updatedAtMs: Date.now(),
      deletedAt: null,
    }, monthKey);
    if (findExpense(expense.id)) return findExpense(expense.id);
    targetMonth.expenses.push(expense);
    rememberCategory(expense.category);
    persistLocal();
    syncExpense(expense, action);
    render();
    return expense;
  }

  function updateExpense(id, changes, action = "expense-update") {
    const expense = findExpense(id);
    if (!expense) return;
    const before = serializeExpense(expense);
    const oldMonth = expense.month;
    const nextMonth = changes.month || expense.month;
    if (monthData(oldMonth).locked || monthData(nextMonth).locked) {
      flashSave("締めた月は編集できません");
      return;
    }
    Object.assign(expense, changes, { month: nextMonth, updatedAtMs: Date.now() });
    expense.day = clampDay(expense.day, daysInMonth(nextMonth));
    expense.amount = num(expense.amount);
    if (oldMonth !== nextMonth) upsertExpenseLocal(expense);
    rememberCategory(expense.category);
    persistLocal();
    syncExpense(expense, action, before);
    render();
  }

  function softDeleteExpense(id) {
    const expense = findExpense(id);
    if (!expense || monthData(expense.month).locked) {
      flashSave("締めた月は削除できません");
      return;
    }
    const before = serializeExpense(expense);
    expense.deletedAt = Date.now();
    expense.updatedAtMs = Date.now();
    lastDeletedId = id;
    persistLocal("ゴミ箱に移動しました");
    syncExpense(expense, "expense-delete", before);
    render();
    showUndoToast("支出をゴミ箱に移動しました");
  }

  function restoreExpense(id) {
    const expense = findExpense(id);
    if (!expense) return;
    const before = serializeExpense(expense);
    expense.deletedAt = null;
    expense.updatedAtMs = Date.now();
    persistLocal("支出を復元しました");
    syncExpense(expense, "expense-restore", before);
    render();
    renderTrashDialog();
  }

  function duplicateExpense(id) {
    const source = findExpense(id);
    if (!source) return;
    addExpense({
      month: source.month,
      day: source.day,
      category: source.category,
      amount: source.amount,
      note: source.note,
      source: "duplicate",
      status: source.status,
    }, "expense-duplicate");
  }

  function markExpenseSpent(id) {
    const expense = findExpense(id);
    if (!expense || expense.status !== "planned") return;
    const today = new Date();
    updateExpense(id, {
      status: "spent",
      day: expense.month === currentMonthKey(today) ? today.getDate() : expense.day,
    }, "expense-mark-spent");
  }

  function render() {
    const data = monthData();
    document.getElementById("monthLabel").textContent = monthLabel(currentMonth);
    document.getElementById("monthPicker").value = currentMonth;
    renderQuickAdd();
    renderBudgets();
    renderExpenses();
    renderCategoryChart();
    renderCalendar();
    renderAnalysis();
    renderRecurring();
    updateTotals();
    updateLockedState(data.locked);
    document.getElementById("trashCount").textContent = allExpenses(true).filter((item) => item.deletedAt).length;
  }

  function renderQuickAdd() {
    const day = document.getElementById("quickDay");
    const category = document.getElementById("quickCategory");
    const selectedDay = day.value || defaultExpenseDay();
    const selectedCategory = category.value || loadJson(KEY_RECENT, [])[0] || "groceries";
    fillDaySelect(day, currentMonth, selectedDay);
    fillCategorySelect(category, selectedCategory);
  }

  function defaultExpenseDay() {
    const now = new Date();
    if (currentMonth === currentMonthKey(now)) return now.getDate();
    return daysInMonth(currentMonth);
  }

  function fillDaySelect(select, monthKey, selectedValue) {
    const selected = clampDay(selectedValue, daysInMonth(monthKey));
    select.innerHTML = "";
    for (let day = 1; day <= daysInMonth(monthKey); day += 1) {
      const option = document.createElement("option");
      option.value = String(day);
      option.textContent = String(day);
      select.appendChild(option);
    }
    select.value = String(selected);
  }

  function fillCategorySelect(select, selectedValue, includeAll = false) {
    select.innerHTML = "";
    if (includeAll) {
      const all = document.createElement("option");
      all.value = "";
      all.textContent = "すべて";
      select.appendChild(all);
    }
    categoryOptions().forEach((name) => {
      const option = document.createElement("option");
      option.value = name;
      option.textContent = name;
      select.appendChild(option);
    });
    select.value = selectedValue || "";
  }

  function renderBudgets() {
    const wrap = document.getElementById("fixedList");
    const month = monthData();
    wrap.innerHTML = "";
    month.budgets.forEach((budget, index) => {
      const row = document.createElement("div");
      row.className = "line-row";

      const name = document.createElement("input");
      name.className = "line-name";
      name.value = budget.name;
      name.placeholder = "カテゴリ名";
      name.disabled = month.locked;
      name.addEventListener("input", () => {
        budget.name = name.value;
        persistLocal("");
        updateTotals();
        scheduleEntitySave(`month-${currentMonth}`, () => syncMonth(currentMonth, "budget-update"));
      });

      const mark = document.createElement("span");
      mark.className = "line-yen";
      mark.textContent = "¥";

      const amount = document.createElement("input");
      amount.className = "line-amount";
      amount.type = "number";
      amount.inputMode = "numeric";
      amount.min = "0";
      amount.value = budget.amount;
      amount.disabled = month.locked;
      amount.addEventListener("input", () => {
        budget.amount = num(amount.value);
        persistLocal("");
        updateTotals();
        renderCategoryChart();
        scheduleEntitySave(`month-${currentMonth}`, () => syncMonth(currentMonth, "budget-update"));
      });

      const up = iconButton("↑", "上へ", () => moveBudget(index, -1));
      const down = iconButton("↓", "下へ", () => moveBudget(index, 1));
      const reorder = document.createElement("div");
      reorder.className = "reorder horizontal-reorder";
      reorder.append(up, down);
      const del = iconButton("×", "削除", () => {
        if (month.locked) return;
        const before = serializeMonth(month);
        month.budgets.splice(index, 1);
        persistLocal();
        syncMonth(currentMonth, "budget-delete", before);
        render();
      });
      del.classList.add("del-btn");
      row.append(reorder, name, mark, amount, del);
      wrap.appendChild(row);
    });
  }

  function moveBudget(index, direction) {
    const month = monthData();
    if (month.locked) return;
    const next = index + direction;
    if (next < 0 || next >= month.budgets.length) return;
    [month.budgets[index], month.budgets[next]] = [month.budgets[next], month.budgets[index]];
    persistLocal();
    syncMonth(currentMonth, "budget-reorder");
    render();
  }

  function filteredExpenses() {
    const search = document.getElementById("expenseSearch").value.trim().toLowerCase();
    const category = document.getElementById("expenseCategoryFilter").value;
    const status = document.getElementById("expenseStatusFilter").value;
    const day = document.getElementById("expenseDayFilter").value;
    return activeExpenses()
      .filter((item) => !category || item.category === category)
      .filter((item) => !status || item.status === status)
      .filter((item) => !day || String(item.day) === day)
      .filter((item) => {
        if (!search) return true;
        return `${item.category} ${item.note} ${item.amount} ${item.day}`.toLowerCase().includes(search);
      })
      .sort((a, b) => num(b.day) - num(a.day) || num(b.createdAt) - num(a.createdAt));
  }

  function renderExpenses() {
    const body = document.getElementById("creditBody");
    const categoryFilter = document.getElementById("expenseCategoryFilter");
    const dayFilter = document.getElementById("expenseDayFilter");
    const selectedCategory = categoryFilter.value;
    const selectedDay = dayFilter.value;
    fillCategorySelect(categoryFilter, selectedCategory, true);
    dayFilter.innerHTML = '<option value="">全日</option>';
    for (let day = daysInMonth(currentMonth); day >= 1; day -= 1) {
      const option = document.createElement("option");
      option.value = String(day);
      option.textContent = `${day}日`;
      dayFilter.appendChild(option);
    }
    dayFilter.value = selectedDay;

    const expenses = filteredExpenses();
    body.innerHTML = "";
    expenses.forEach((item) => {
      const row = document.createElement("div");
      row.className = "expense-row expense-row-v2";
      row.classList.toggle("is-planned", item.status === "planned");

      const day = expenseField("日", "select");
      fillDaySelect(day.control, currentMonth, item.day);
      day.control.disabled = monthData().locked;
      day.control.addEventListener("change", () => updateExpense(item.id, { day: Number(day.control.value) }));

      const category = expenseField("カテゴリ", "select");
      fillCategorySelect(category.control, item.category);
      category.control.disabled = monthData().locked;
      category.control.addEventListener("change", () => updateExpense(item.id, { category: category.control.value }));

      const amount = expenseField("金額", "input");
      amount.control.type = "number";
      amount.control.inputMode = "numeric";
      amount.control.min = "0";
      amount.control.value = item.amount;
      amount.control.className = "amount-cell";
      amount.control.disabled = monthData().locked;
      amount.control.addEventListener("input", () => {
        const before = serializeExpense(item);
        item.amount = num(amount.control.value);
        item.updatedAtMs = Date.now();
        persistLocal("");
        updateTotals();
        renderCategoryChart();
        scheduleEntitySave(`expense-${item.id}`, () => syncExpense(item, "expense-update", before));
      });

      const actions = document.createElement("div");
      actions.className = "expense-actions";
      if (item.status === "planned") {
        actions.append(iconButton("✓", "使ったにする", () => markExpenseSpent(item.id)));
      }
      actions.append(
        iconButton("⧉", "複製", () => duplicateExpense(item.id)),
        iconButton("✎", "編集・月を移動", () => openExpenseDialog(item.id)),
        iconButton("×", "ゴミ箱へ", () => softDeleteExpense(item.id))
      );
      const meta = document.createElement("p");
      meta.className = "expense-note expense-meta";
      const status = document.createElement("span");
      status.className = `status-pill ${item.status}`;
      status.textContent = item.status === "planned" ? "使う予定" : "使った";
      meta.appendChild(status);
      if (item.note) meta.append(document.createTextNode(item.note));
      row.append(day.wrap, category.wrap, amount.wrap, actions, meta);
      body.appendChild(row);
    });
    document.getElementById("expenseEmpty").hidden = expenses.length > 0;
    document.getElementById("expenseCount").textContent = `${expenses.length}件`;
  }

  function expenseField(label, type) {
    const wrap = document.createElement("label");
    wrap.className = "expense-field";
    const caption = document.createElement("span");
    caption.textContent = label;
    const control = document.createElement(type);
    wrap.append(caption, control);
    return { wrap, control };
  }

  function iconButton(text, title, handler) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "icon-btn";
    button.textContent = text;
    button.title = title;
    button.setAttribute("aria-label", title);
    button.addEventListener("click", handler);
    return button;
  }

  function updateTotals() {
    const month = monthData();
    const budgetTotal = sum(month.budgets);
    const salary = num(month.salary);
    const spent = sum(spentExpenses());
    const registeredPlanned = sum(plannedExpenses());
    const budgetRemaining = remainingBudgetPlan();
    const projectedTotal = spent + budgetRemaining;
    const remaining = salary - projectedTotal;
    document.getElementById("fixedTotal").textContent = yen(budgetTotal);
    document.getElementById("creditTotal").textContent = yen(spent + registeredPlanned);
    document.getElementById("salaryInput").value = salary ? salary.toLocaleString("ja-JP") : "";
    document.getElementById("hlExpense").textContent = yen(spent);
    document.getElementById("hlPlanned").textContent = yen(budgetTotal);
    const balance = document.getElementById("hlBalance");
    balance.textContent = salary > 0 ? yen(remaining) : "未入力";
    balance.style.color = salary > 0 && remaining < 0 ? "#e5556e" : "var(--ink)";
    document.getElementById("balanceNote").textContent = month.locked ? "この月は締め済み" : "予算確保後";
    renderPiggy(salary, budgetTotal, spent, budgetRemaining, remaining);
    renderBudgetAlert();
  }

  function renderPiggy(salary, budgetTotal, spent, budgetRemaining, remaining) {
    const usedPct = budgetTotal > 0 ? Math.max(0, Math.round((spent / budgetTotal) * 100)) : 0;
    const projectedTotal = spent + budgetRemaining;
    const scale = Math.max(1, salary, projectedTotal);
    document.getElementById("piggySpent").style.width = `${Math.min(100, (spent / scale) * 100)}%`;
    document.getElementById("piggyBudgetLeft").style.width = `${Math.min(100, (budgetRemaining / scale) * 100)}%`;
    document.getElementById("piggySalaryLeft").style.width = `${Math.min(100, (Math.max(0, remaining) / scale) * 100)}%`;
    document.getElementById("piggySpentValue").textContent = yen(spent);
    document.getElementById("piggyBudgetValue").textContent = yen(budgetRemaining);
    document.getElementById("piggySalaryValue").textContent = salary > 0 ? yen(remaining) : "未入力";
    document.getElementById("piggyRate").textContent = budgetTotal > 0
      ? `使う予定 ${yen(budgetTotal)} のうち ${usedPct}%使用`
      : "カテゴリ上限を入力してください";
    const msg = document.getElementById("piggyMsg");
    if (salary <= 0) msg.textContent = "給料を入力すると、最終的に残る金額がわかります。";
    else if (remaining < 0) msg.textContent = "使う予定が給料を超えています。カテゴリ上限を確認しよう。";
    else if (usedPct < 25) msg.textContent = "予算にはまだ余裕があります。";
    else if (usedPct < 70) msg.textContent = "カテゴリ別の残りを見ながら使おう。";
    else msg.textContent = "残りが少なめ。必要な支出を優先しよう。";

    const today = new Date();
    const isCurrent = currentMonth === currentMonthKey(today);
    const remainingDays = isCurrent
      ? Math.max(1, daysInMonth(currentMonth) - today.getDate() + 1)
      : daysInMonth(currentMonth);
    document.getElementById("daysRemaining").textContent = `${remainingDays}日`;
    document.getElementById("dailyAllowance").textContent = budgetTotal > 0 ? yen(budgetRemaining / remainingDays) : "--";

    const goal = num(monthData().savingGoal);
    const saved = salary > 0 ? Math.max(0, remaining) : 0;
    const goalPct = goal > 0 ? Math.min(100, Math.round((saved / goal) * 100)) : 0;
    document.getElementById("savingGoalInput").value = goal || "";
    document.getElementById("goalProgressFill").style.width = `${goalPct}%`;
    document.getElementById("goalNote").textContent = goal
      ? `目標まで${yen(Math.max(0, goal - saved))}・達成率${goalPct}%`
      : "目標額を入れると達成率を表示します";
  }

  function spentExpenses(monthKey = currentMonth) {
    return activeExpenses(monthKey).filter((expense) => expense.status !== "planned");
  }

  function plannedExpenses(monthKey = currentMonth) {
    return activeExpenses(monthKey).filter((expense) => expense.status === "planned");
  }

  function remainingBudgetPlan(monthKey = currentMonth) {
    const expenses = spentExpenses(monthKey);
    return monthData(monthKey).budgets.reduce((total, budget) => {
      const categorySpent = expenses
        .filter((expense) => expense.category === budget.name)
        .reduce((categoryTotal, expense) => categoryTotal + num(expense.amount), 0);
      return total + Math.max(0, num(budget.amount) - categorySpent);
    }, 0);
  }

  function spentFor(category, monthKey = currentMonth) {
    return activeExpenses(monthKey)
      .filter((expense) => expense.category === category)
      .reduce((total, expense) => total + num(expense.amount), 0);
  }

  function renderCategoryChart() {
    const wrap = document.getElementById("categoryChart");
    wrap.innerHTML = "";
    monthData().budgets.forEach((budget) => {
      const limit = num(budget.amount);
      const spent = sum(spentExpenses().filter((expense) => expense.category === budget.name));
      const planned = sum(plannedExpenses().filter((expense) => expense.category === budget.name));
      const committed = spent + planned;
      const remaining = limit - committed;
      const pct = limit > 0 ? Math.round((committed / limit) * 100) : 0;
      const row = document.createElement("div");
      row.className = `category-row ${pct >= 100 ? "over" : pct >= 90 ? "danger" : pct >= 70 ? "warn" : ""}`;
      row.innerHTML = `
        <div class="category-top"><strong>${escapeHtml(budget.name || "未設定")}</strong><span>${yen(committed)} / ${yen(limit)}</span></div>
        <div class="category-bar"><span style="width:${Math.min(100, pct)}%"></span></div>
        <div class="category-bottom"><span>${yen(spent)}使用・${yen(planned)}予定</span><span>${remaining >= 0 ? `残り ${yen(remaining)}` : `オーバー ${yen(Math.abs(remaining))}`}</span></div>
      `;
      wrap.appendChild(row);
    });
  }

  function renderBudgetAlert() {
    const alerts = monthData().budgets
      .map((budget) => {
        const limit = num(budget.amount);
        const spent = spentFor(budget.name);
        const pct = limit > 0 ? Math.round((spent / limit) * 100) : 0;
        return { name: budget.name, pct };
      })
      .filter((item) => item.pct >= 70)
      .sort((a, b) => b.pct - a.pct);
    const banner = document.getElementById("budgetAlert");
    if (!alerts.length) {
      banner.hidden = true;
      return;
    }
    banner.hidden = false;
    banner.className = `budget-alert ${alerts[0].pct >= 100 ? "over" : alerts[0].pct >= 90 ? "danger" : "warn"}`;
    banner.textContent = alerts.slice(0, 3).map((item) => `${item.name} ${item.pct}%`).join("・");
  }

  function renderCalendar() {
    const wrap = document.getElementById("budgetCalendar");
    wrap.innerHTML = "";
    const [year, month] = currentMonth.split("-").map(Number);
    const firstWeekday = new Date(year, month - 1, 1).getDay();
    const dayTotals = new Map();
    activeExpenses().forEach((expense) => {
      const totals = dayTotals.get(expense.day) || { spent: 0, planned: 0 };
      totals[expense.status === "planned" ? "planned" : "spent"] += num(expense.amount);
      dayTotals.set(expense.day, totals);
    });
    for (let blank = 0; blank < firstWeekday; blank += 1) {
      const cell = document.createElement("span");
      cell.className = "calendar-day blank";
      wrap.appendChild(cell);
    }
    let noSpend = 0;
    for (let day = 1; day <= daysInMonth(currentMonth); day += 1) {
      const totals = dayTotals.get(day) || { spent: 0, planned: 0 };
      const total = totals.spent + totals.planned;
      if (!totals.spent) noSpend += 1;
      const button = document.createElement("button");
      button.type = "button";
      button.className = `calendar-day ${totals.spent ? "has-spend" : totals.planned ? "has-plan" : "no-spend"}`;
      button.innerHTML = `<span>${day}</span><strong>${total ? yen(total) : "○"}</strong>`;
      button.title = `${day}日 使用${yen(totals.spent)}・予定${yen(totals.planned)}`;
      button.addEventListener("click", () => {
        document.getElementById("quickDay").value = String(day);
        document.getElementById("quickAmount").focus();
        document.querySelector(".quick-add-card").scrollIntoView({ behavior: "smooth", block: "center" });
      });
      wrap.appendChild(button);
    }
    document.getElementById("noSpendDays").textContent = `${noSpend}日`;
    const elapsed = currentMonth === currentMonthKey()
      ? new Date().getDate()
      : daysInMonth(currentMonth);
    document.getElementById("dailyAverage").textContent = yen(sum(spentExpenses()) / Math.max(1, elapsed));
  }

  function renderAnalysis() {
    const yearSelect = document.getElementById("analysisYear");
    const years = [...new Set([...Object.keys(state.months).map((key) => key.slice(0, 4)), currentMonth.slice(0, 4)])].sort().reverse();
    const selectedYear = yearSelect.value || currentMonth.slice(0, 4);
    yearSelect.innerHTML = "";
    years.forEach((year) => {
      const option = document.createElement("option");
      option.value = year;
      option.textContent = `${year}年`;
      yearSelect.appendChild(option);
    });
    yearSelect.value = years.includes(selectedYear) ? selectedYear : years[0];
    const year = yearSelect.value;
    const monthly = Array.from({ length: 12 }, (_, index) => {
      const key = `${year}-${String(index + 1).padStart(2, "0")}`;
      return sum((state.months[key]?.expenses || []).filter((item) => !item.deletedAt && item.status !== "planned"));
    });
    const max = Math.max(...monthly, 1);
    const trend = document.getElementById("monthlyTrend");
    trend.innerHTML = "";
    monthly.forEach((amount, index) => {
      const item = document.createElement("div");
      item.className = "trend-item";
      item.title = `${index + 1}月 ${yen(amount)}`;
      item.innerHTML = `<span class="trend-value">${amount ? compactYen(amount) : ""}</span><div><i style="height:${Math.max(amount ? 8 : 2, Math.round((amount / max) * 100))}%"></i></div><b>${index + 1}</b>`;
      trend.appendChild(item);
    });

    const categoryTotals = new Map();
    Object.entries(state.months)
      .filter(([key]) => key.startsWith(`${year}-`))
      .forEach(([, month]) => {
        month.expenses.filter((item) => !item.deletedAt && item.status !== "planned").forEach((expense) => {
          categoryTotals.set(expense.category, (categoryTotals.get(expense.category) || 0) + num(expense.amount));
        });
      });
    const annual = document.getElementById("annualCategories");
    annual.innerHTML = "";
    const sorted = [...categoryTotals.entries()].sort((a, b) => b[1] - a[1]);
    const categoryMax = Math.max(...sorted.map(([, amount]) => amount), 1);
    sorted.forEach(([category, amount]) => {
      const row = document.createElement("div");
      row.className = "annual-row";
      row.innerHTML = `<span>${escapeHtml(category)}</span><div><i style="width:${Math.round((amount / categoryMax) * 100)}%"></i></div><strong>${yen(amount)}</strong>`;
      annual.appendChild(row);
    });
    if (!sorted.length) annual.innerHTML = '<p class="empty-state">年間データはまだありません</p>';
  }

  function compactYen(value) {
    if (value >= 10000) return `${Math.round(value / 1000) / 10}万`;
    return value.toLocaleString("ja-JP");
  }

  function renderRecurring() {
    const wrap = document.getElementById("recurringList");
    const items = state.recurring.filter((item) => !item.deletedAt);
    wrap.innerHTML = "";
    items.forEach((item) => {
      const row = document.createElement("div");
      row.className = "recurring-row";
      const text = document.createElement("div");
      text.innerHTML = `<strong>${item.day}日・${escapeHtml(item.category)}</strong><span>${item.note ? `${escapeHtml(item.note)}・` : ""}${yen(item.amount)}</span>`;
      const toggle = document.createElement("input");
      toggle.type = "checkbox";
      toggle.checked = item.active;
      toggle.title = "自動登録のオン・オフ";
      toggle.addEventListener("change", () => {
        const before = serializeRecurring(item);
        item.active = toggle.checked;
        persistLocal();
        syncRecurring(item, "recurring-toggle", before);
        renderRecurring();
      });
      const del = iconButton("×", "固定費を削除", () => {
        const before = serializeRecurring(item);
        item.deletedAt = Date.now();
        persistLocal();
        syncRecurring(item, "recurring-delete", before);
        renderRecurring();
      });
      row.append(text, toggle, del);
      wrap.appendChild(row);
    });
    document.getElementById("recurringEmpty").hidden = items.length > 0;
  }

  function materializeRecurring(monthKey) {
    if (monthData(monthKey).locked) return;
    state.recurring
      .filter((item) => item.active && !item.deletedAt && item.createdMonth <= monthKey)
      .forEach((item) => {
        const id = `recurring-${item.id}-${monthKey}`;
        if (findExpense(id)) return;
        addExpense({
          id,
          month: monthKey,
          day: Math.min(item.day, daysInMonth(monthKey)),
          category: item.category,
          amount: item.amount,
          note: item.note,
          source: "recurring",
          status: "planned",
          recurringId: item.id,
        }, "recurring-materialize");
      });
  }

  function updateLockedState(locked) {
    const button = document.getElementById("monthLockButton");
    button.textContent = locked ? "締めを解除" : "月を締める";
    button.classList.toggle("is-locked", locked);
    document.querySelectorAll("#quickAddForm input, #quickAddForm select, #quickAddForm button[type=submit], #salaryInput, #savingGoalInput, [data-target=fixed]")
      .forEach((control) => { control.disabled = locked; });
  }

  function openExpenseDialog(id) {
    const expense = findExpense(id);
    if (!expense) return;
    editExpenseId = id;
    document.getElementById("editMonth").value = expense.month;
    fillDaySelect(document.getElementById("editDay"), expense.month, expense.day);
    fillCategorySelect(document.getElementById("editCategory"), expense.category);
    document.getElementById("editStatus").value = expense.status;
    document.getElementById("editAmount").value = expense.amount;
    document.getElementById("editNote").value = expense.note || "";
    document.getElementById("expenseDialog").showModal();
  }

  function showUndoToast(message) {
    const toast = document.getElementById("undoToast");
    document.getElementById("undoMessage").textContent = message;
    toast.hidden = false;
    clearTimeout(showUndoToast.timer);
    showUndoToast.timer = setTimeout(() => { toast.hidden = true; }, 8000);
  }

  function renderTrashDialog() {
    const dialog = document.getElementById("listDialog");
    if (!dialog.open || document.getElementById("listDialogTitle").textContent !== "ゴミ箱") return;
    const wrap = document.getElementById("dialogList");
    const deleted = allExpenses(true).filter((item) => item.deletedAt).sort((a, b) => b.deletedAt - a.deletedAt);
    wrap.innerHTML = "";
    deleted.forEach((item) => {
      const row = document.createElement("div");
      row.className = "dialog-list-row";
      row.innerHTML = `<div><strong>${monthLabel(item.month)} ${item.day}日</strong><span>${escapeHtml(item.category)}・${yen(item.amount)}</span></div>`;
      const restore = document.createElement("button");
      restore.type = "button";
      restore.className = "primary-btn small";
      restore.textContent = "復元";
      restore.addEventListener("click", () => restoreExpense(item.id));
      row.appendChild(restore);
      wrap.appendChild(row);
    });
    if (!deleted.length) wrap.innerHTML = '<p class="empty-state">ゴミ箱は空です</p>';
  }

  function openTrashDialog() {
    document.getElementById("listDialogTitle").textContent = "ゴミ箱";
    const dialog = document.getElementById("listDialog");
    dialog.showModal();
    renderTrashDialog();
  }

  async function openHistoryDialog() {
    document.getElementById("listDialogTitle").textContent = "変更履歴";
    const dialog = document.getElementById("listDialog");
    const wrap = document.getElementById("dialogList");
    wrap.innerHTML = '<p class="empty-state">読み込み中...</p>';
    dialog.showModal();
    if (!remoteReady) {
      wrap.innerHTML = '<p class="empty-state">Firestore接続後に表示できます</p>';
      return;
    }
    try {
      const { collection, getDocs } = fsApi;
      const snapshot = await getDocs(collection(firestore, "spaces", SPACE_ID, "history"));
      const history = snapshot.docs.map((item) => item.data()).sort((a, b) => num(b.createdAtMs) - num(a.createdAtMs)).slice(0, 50);
      wrap.innerHTML = "";
      history.forEach((item) => {
        const row = document.createElement("div");
        row.className = "dialog-list-row history-row";
        row.innerHTML = `<div><strong>${historyLabel(item.action)}</strong><span>${new Date(item.createdAtMs).toLocaleString("ja-JP")}</span></div><small>${escapeHtml(item.after?.category || item.entityId || "")}${item.after?.amount != null ? `・${yen(item.after.amount)}` : ""}</small>`;
        wrap.appendChild(row);
      });
      if (!history.length) wrap.innerHTML = '<p class="empty-state">変更履歴はまだありません</p>';
    } catch {
      wrap.innerHTML = '<p class="empty-state">変更履歴を読み込めませんでした</p>';
    }
  }

  function historyLabel(action = "") {
    if (action.includes("delete")) return "削除";
    if (action.includes("restore")) return "復元";
    if (action.includes("create") || action.includes("duplicate") || action.includes("materialize")) return "追加";
    if (action.includes("backup")) return "バックアップ";
    return "更新";
  }

  function localBackups() {
    return loadJson(KEY_BACKUPS, []);
  }

  async function createBackup(label = "manual") {
    const snapshot = clone(state);
    const now = new Date();
    const time = `${String(now.getHours()).padStart(2, "0")}${String(now.getMinutes()).padStart(2, "0")}${String(now.getSeconds()).padStart(2, "0")}${String(now.getMilliseconds()).padStart(3, "0")}`;
    const id = label === "daily" ? `${localDateKey(now)}-daily` : `${localDateKey(now)}-${label}-${time}`;
    const backups = localBackups().filter((item) => item.id !== id);
    backups.unshift({ id, createdAt: Date.now(), label, snapshot });
    try {
      localStorage.setItem(KEY_BACKUPS, JSON.stringify(backups.slice(0, 14)));
    } catch {
      localStorage.setItem(KEY_BACKUPS, JSON.stringify(backups.slice(0, 2)));
    }
    if (remoteReady) {
      try {
        const { doc, setDoc, serverTimestamp } = fsApi;
        await setDoc(doc(firestore, "spaces", SPACE_ID, "backups", id), {
          id,
          label,
          snapshot,
          createdAtMs: Date.now(),
          createdAt: serverTimestamp(),
        }, { merge: true });
      } catch {
        setDataStatus("端末バックアップ済み・クラウド保存待ち");
      }
    }
    flashSave("バックアップしました");
    return id;
  }

  async function openBackupDialog() {
    document.getElementById("listDialogTitle").textContent = "バックアップ";
    const dialog = document.getElementById("listDialog");
    const wrap = document.getElementById("dialogList");
    dialog.showModal();
    wrap.innerHTML = "";
    const map = new Map(localBackups().map((item) => [item.id, item]));
    if (remoteReady) {
      try {
        const { collection, getDocs } = fsApi;
        const snapshot = await getDocs(collection(firestore, "spaces", SPACE_ID, "backups"));
        snapshot.docs.forEach((docItem) => {
          const data = cleanRemote(docItem.data());
          if (data.snapshot) map.set(docItem.id, data);
        });
      } catch {}
    }
    const backups = [...map.values()].sort((a, b) => num(b.createdAtMs) - num(a.createdAtMs));
    backups.forEach((backup) => {
      const row = document.createElement("div");
      row.className = "dialog-list-row";
      const date = new Date(backup.createdAtMs || backup.createdAt || Date.now());
      row.innerHTML = `<div><strong>${escapeHtml(backup.id)}</strong><span>${date.toLocaleString("ja-JP")}</span></div>`;
      const restore = document.createElement("button");
      restore.type = "button";
      restore.className = "primary-btn small";
      restore.textContent = "復元";
      restore.addEventListener("click", () => restoreBackup(backup.snapshot));
      row.appendChild(restore);
      wrap.appendChild(row);
    });
    if (!backups.length) wrap.innerHTML = '<p class="empty-state">バックアップはまだありません</p>';
  }

  async function restoreBackup(snapshot) {
    if (!snapshot?.months) return;
    if (!confirm("現在の状態を先にバックアップして、この時点へ復元します。続けますか？")) return;
    await createBackup("before-restore");
    const restored = normalizeState(clone(snapshot));
    const restoredIds = new Set(Object.values(restored.months).flatMap((month) => month.expenses.map((item) => item.id)));
    const now = Date.now();
    allExpenses(true).forEach((expense) => {
      if (!restoredIds.has(expense.id)) {
        expense.deletedAt = now;
        restored.months[expense.month] ||= monthTemplate(expense.month, seedBudgets());
        restored.months[expense.month].expenses.push(clone(expense));
      }
    });
    state = restored;
    persistLocal("バックアップから復元しました");
    render();
    Object.keys(state.months).forEach((key) => syncMonth(key, "backup-restore"));
    allExpenses(true).forEach((expense) => syncExpense(expense, "backup-restore"));
    state.recurring.forEach((item) => syncRecurring(item, "backup-restore"));
    document.getElementById("listDialog").close();
  }

  function exportCsv() {
    const header = ["id", "month", "day", "status", "category", "amount", "note", "source"];
    const rows = allExpenses(false)
      .sort((a, b) => a.month.localeCompare(b.month) || a.day - b.day)
      .map((item) => [item.id, item.month, item.day, item.status, item.category, item.amount, item.note, item.source]);
    const csv = "\uFEFF" + [header, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `baby-kakeibo-${currentMonthKey()}.csv`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
    flashSave("CSVを出力しました");
  }

  function csvCell(value) {
    const text = String(value ?? "");
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  }

  async function importCsv(file) {
    const text = await file.text();
    let rows;
    if (!window.Papa) {
      try {
        await loadExternalScript("https://cdn.jsdelivr.net/npm/papaparse@5.4.1/papaparse.min.js", "Papa");
      } catch {}
    }
    if (window.Papa) {
      const parsed = window.Papa.parse(text, { header: true, skipEmptyLines: true });
      if (parsed.errors?.length && !parsed.data?.length) throw new Error("CSVを読み取れませんでした");
      rows = parsed.data;
    } else {
      rows = fallbackCsv(text);
    }
    const existingIds = new Set(allExpenses(true).map((item) => item.id));
    const expenses = rows.map((row, index) => csvRowToExpense(row, index)).filter(Boolean).filter((item) => !existingIds.has(item.id));
    if (!expenses.length) {
      flashSave("追加できる支出がありません");
      return;
    }
    const total = sum(expenses);
    if (!confirm(`${expenses.length}件・合計${yen(total)}を取り込みますか？`)) return;
    expenses.forEach((expense) => {
      monthData(expense.month).expenses.push(expense);
      syncExpense(expense, "csv-import");
    });
    persistLocal(`${expenses.length}件取り込みました`);
    render();
  }

  function csvRowToExpense(row, index) {
    const get = (...keys) => {
      for (const key of keys) {
        if (row[key] != null && String(row[key]).trim() !== "") return String(row[key]).trim();
      }
      return "";
    };
    let month = get("month", "月");
    let day = get("day", "日");
    const dateText = get("date", "日付");
    const dateMatch = dateText.match(/(\d{4})[\/-](\d{1,2})[\/-](\d{1,2})/);
    if (dateMatch) {
      month = `${dateMatch[1]}-${dateMatch[2].padStart(2, "0")}`;
      day = dateMatch[3];
    }
    month = /^\d{4}-\d{2}$/.test(month) ? month : currentMonth;
    const amount = num(get("amount", "金額", "支出"));
    if (!get("amount", "金額", "支出") && amount === 0) return null;
    const category = get("category", "カテゴリ", "分類") || DEFAULT_CATEGORIES[0];
    const statusText = get("status", "状態");
    const status = statusText === "planned" || statusText === "使う予定" || statusText === "予定" ? "planned" : "spent";
    const note = get("note", "memo", "メモ", "内容", "店名");
    const rawId = get("id");
    return normalizeExpense({
      id: rawId || stableId("import", `${month}-${day}-${category}-${amount}-${note}-${index}`),
      month,
      day: num(day) || 1,
      category,
      status,
      amount,
      note,
      source: "csv",
      createdAt: Date.now() + index,
      updatedAtMs: Date.now(),
      deletedAt: null,
    }, month, index);
  }

  function fallbackCsv(text) {
    const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/).filter(Boolean);
    const headers = lines.shift().split(",").map((item) => item.trim());
    return lines.map((line) => Object.fromEntries(line.split(",").map((value, index) => [headers[index], value.trim()])));
  }

  async function readReceipt(file) {
    const status = document.getElementById("receiptStatus");
    status.hidden = false;
    status.textContent = "レシートを読み取り中 0%";
    if (!window.Tesseract) {
      try {
        await loadExternalScript("https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js", "Tesseract");
      } catch {}
    }
    if (!window.Tesseract) {
      status.textContent = "レシート読取を読み込めませんでした";
      return;
    }
    try {
      const result = await window.Tesseract.recognize(file, "jpn+eng", {
        logger: (progress) => {
          if (progress.status === "recognizing text") status.textContent = `レシートを読み取り中 ${Math.round(progress.progress * 100)}%`;
        },
      });
      const text = result.data.text || "";
      const amount = receiptAmount(text);
      const date = receiptDate(text);
      const category = guessReceiptCategory(text);
      if (amount) document.getElementById("quickAmount").value = amount;
      if (date?.month === currentMonth) document.getElementById("quickDay").value = String(date.day);
      if (category) document.getElementById("quickCategory").value = category;
      status.textContent = amount
        ? `${yen(amount)}を入力しました。内容を確認して追加してください`
        : "金額を特定できませんでした。手入力してください";
    } catch {
      status.textContent = "レシートを読み取れませんでした";
    }
  }

  function receiptAmount(text) {
    const lines = text.split(/\r?\n/);
    const keywordLines = lines.filter((line) => /(合計|総計|TOTAL|お買上|現計)/i.test(line));
    const candidates = (keywordLines.length ? keywordLines : lines)
      .flatMap((line) => [...line.matchAll(/[¥￥]?\s*([0-9]{1,3}(?:[,，][0-9]{3})+|[0-9]{2,7})/g)].map((match) => num(match[1])))
      .filter((value) => value > 0 && value < 10000000);
    return candidates.length ? Math.max(...candidates) : 0;
  }

  function receiptDate(text) {
    const full = text.match(/(20\d{2})[年\/.\-](\d{1,2})[月\/.\-](\d{1,2})/);
    if (full) return { month: `${full[1]}-${full[2].padStart(2, "0")}`, day: Number(full[3]) };
    const short = text.match(/(\d{1,2})[月\/.\-](\d{1,2})日?/);
    if (short) return { month: `${currentMonth.slice(0, 4)}-${short[1].padStart(2, "0")}`, day: Number(short[2]) };
    return null;
  }

  function guessReceiptCategory(text) {
    const rules = [
      [/(電車|鉄道|バス|タクシー|交通|駅)/i, "transportation"],
      [/(レストラン|カフェ|居酒屋|マクドナルド|外食)/i, "eating out"],
      [/(化粧|ドラッグ|コスメ|薬局)/i, "cosmetics"],
      [/(スーパー|食品|食料|コンビニ|マーケット)/i, "groceries"],
    ];
    return rules.find(([pattern]) => pattern.test(text))?.[1] || "";
  }

  function loadExternalScript(src, globalName) {
    if (window[globalName]) return Promise.resolve(window[globalName]);
    return new Promise((resolve, reject) => {
      const existing = document.querySelector(`script[data-library="${globalName}"]`);
      if (existing) {
        existing.addEventListener("load", () => resolve(window[globalName]), { once: true });
        existing.addEventListener("error", reject, { once: true });
        return;
      }
      const script = document.createElement("script");
      script.src = src;
      script.async = true;
      script.dataset.library = globalName;
      script.addEventListener("load", () => resolve(window[globalName]), { once: true });
      script.addEventListener("error", reject, { once: true });
      document.head.appendChild(script);
    });
  }

  function copyPreviousBudgets() {
    const previous = state.months[previousMonthKey(currentMonth)];
    if (!previous) {
      flashSave("前月の上限がありません");
      return;
    }
    if (!confirm(`${monthLabel(previous.month)}のカテゴリ上限をコピーしますか？`)) return;
    const month = monthData();
    const before = serializeMonth(month);
    month.budgets = previous.budgets.map((budget) => ({ ...budget, id: newId("budget") }));
    month.inheritedFrom = previous.month;
    persistLocal("前月の上限をコピーしました");
    syncMonth(currentMonth, "budget-copy", before);
    render();
  }

  function shiftMonth(delta) {
    const [year, month] = currentMonth.split("-").map(Number);
    currentMonth = currentMonthKey(new Date(year, month - 1 + delta, 1));
    monthData();
    materializeRecurring(currentMonth);
    render();
  }

  function flashSave(text) {
    const hint = document.getElementById("saveHint");
    if (!hint) return;
    hint.textContent = text;
    clearTimeout(flashSave.timer);
    flashSave.timer = setTimeout(() => { hint.textContent = "自動で保存されます"; }, 1800);
  }

  function setDataStatus(text) {
    const target = document.getElementById("dataStatus");
    if (target) target.textContent = text;
  }

  function escapeHtml(value) {
    const div = document.createElement("div");
    div.textContent = String(value ?? "");
    return div.innerHTML;
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

  function expenseSignature(expense) {
    const status = expense.status === "planned" ? "planned" : "spent";
    return [expense.day, status, expense.category, num(expense.amount), expense.note || expense.memo || ""].join("|");
  }

  function mergeLegacyStates(remoteState, localState) {
    const remote = normalizeState(clone(remoteState || initialState()));
    const local = normalizeState(clone(localState || initialState()));
    if (remoteState && num(local.updatedAt) <= num(remote.updatedAt)) return remote;
    if (!remoteState) return local;
    const merged = normalizeState(clone(num(remote.updatedAt) >= num(local.updatedAt) ? remote : local));
    const monthKeys = new Set([...Object.keys(remote.months), ...Object.keys(local.months)]);
    monthKeys.forEach((monthKey) => {
      const remoteMonth = remote.months[monthKey];
      const localMonth = local.months[monthKey];
      const base = clone((num(remote.updatedAt) >= num(local.updatedAt) ? remoteMonth : localMonth) || remoteMonth || localMonth);
      const lists = [remoteMonth?.expenses || [], localMonth?.expenses || []];
      const maxCounts = new Map();
      lists.forEach((list) => {
        const counts = new Map();
        list.forEach((item) => counts.set(expenseSignature(item), (counts.get(expenseSignature(item)) || 0) + 1));
        counts.forEach((count, signature) => maxCounts.set(signature, Math.max(maxCounts.get(signature) || 0, count)));
      });
      const pool = [...(remoteMonth?.expenses || []), ...(localMonth?.expenses || [])];
      const used = new Map();
      const expenses = [];
      pool.forEach((item) => {
        const signature = expenseSignature(item);
        const count = used.get(signature) || 0;
        if (count >= (maxCounts.get(signature) || 0)) return;
        used.set(signature, count + 1);
        expenses.push(item);
      });
      base.expenses = expenses.map((item, index) => normalizeExpense(item, monthKey, index));
      merged.months[monthKey] = base;
    });
    return normalizeState(merged);
  }

  async function migrateLegacyData(spaceRef) {
    const { doc, getDoc, writeBatch, serverTimestamp } = fsApi;
    const metaRef = doc(spaceRef, "budget", "schema-v2");
    const metaSnapshot = await getDoc(metaRef);
    const legacyRef = doc(spaceRef, "budget", "state");
    const legacySnapshot = await getDoc(legacyRef);
    const remoteLegacy = legacySnapshot.data()?.state || null;
    const localLegacy = clone(state);
    const alreadyMigrated = num(metaSnapshot.data()?.schemaVersion) >= SCHEMA_VERSION;
    const hasNewerLegacyLocal = loadedSchemaVersion < SCHEMA_VERSION &&
      num(localLegacy.updatedAt) > num(remoteLegacy?.updatedAt);
    if (alreadyMigrated && !hasNewerLegacyLocal) return;
    const source = mergeLegacyStates(remoteLegacy, localLegacy);
    const backupRef = doc(spaceRef, "backups", "legacy-before-v2");
    const writes = [];
    writes.push({
      ref: backupRef,
      data: {
        id: "legacy-before-v2",
        label: "migration",
        remoteState: remoteLegacy,
        localState: localLegacy,
        snapshot: source,
        createdAtMs: Date.now(),
        createdAt: serverTimestamp(),
      },
    });
    Object.entries(source.months).forEach(([monthKey, month]) => {
      writes.push({ ref: doc(spaceRef, "months", monthKey), data: serializeMonth(month) });
      month.expenses.forEach((expense, index) => {
        const normalized = normalizeExpense(expense, monthKey, index);
        normalized.id ||= `legacy-${monthKey}-${index}`;
        writes.push({ ref: doc(spaceRef, "expenses", normalized.id), data: serializeExpense(normalized) });
      });
    });
    source.recurring.forEach((item) => writes.push({ ref: doc(spaceRef, "recurring", item.id), data: serializeRecurring(item) }));

    for (let start = 0; start < writes.length; start += 400) {
      const batch = writeBatch(firestore);
      writes.slice(start, start + 400).forEach((write) => batch.set(write.ref, write.data, { merge: true }));
      await batch.commit();
    }
    const finalBatch = writeBatch(firestore);
    finalBatch.set(metaRef, {
      schemaVersion: SCHEMA_VERSION,
      migratedAt: serverTimestamp(),
      migratedAtMs: Date.now(),
      legacySeenUpdatedAt: num(source.updatedAt),
      expenseCount: Object.values(source.months).reduce((total, month) => total + month.expenses.length, 0),
    }, { merge: true });
    await finalBatch.commit();
    state = source;
    loadedSchemaVersion = SCHEMA_VERSION;
    persistLocal("データを安全な保存方式へ移行しました");
  }

  async function loadRemoteCollections() {
    const { collection, getDocs } = fsApi;
    const [monthsSnapshot, expensesSnapshot, recurringSnapshot] = await Promise.all([
      getDocs(collection(firestore, "spaces", SPACE_ID, "months")),
      getDocs(collection(firestore, "spaces", SPACE_ID, "expenses")),
      getDocs(collection(firestore, "spaces", SPACE_ID, "recurring")),
    ]);
    const pendingIds = new Set(loadJson(KEY_PENDING, []).map((item) => item.id));
    const remoteMonthIds = new Set(monthsSnapshot.docs.map((item) => item.id));
    const localMonthKeys = Object.keys(state.months);
    monthsSnapshot.docs.forEach((item) => {
      const data = cleanRemote(item.data());
      const localExpenses = state.months[item.id]?.expenses || [];
      state.months[item.id] = {
        ...monthTemplate(item.id, data.budgets || seedBudgets(), localExpenses),
        ...data,
        expenses: localExpenses,
      };
    });
    const remoteExpenses = expensesSnapshot.docs.map((item) => normalizeExpense(cleanRemote(item.data()), item.data().month || currentMonth));
    const remoteIds = new Set(remoteExpenses.map((item) => item.id));
    const canRecoverLocalOnly = hasSavedLocalState && loadedSchemaVersion >= SCHEMA_VERSION;
    const recoveredLocalExpenses = [];
    Object.values(state.months).forEach((month) => {
      month.expenses = month.expenses.filter((item) => {
        if (remoteIds.has(item.id)) return false;
        const keep = pendingIds.has(item.id) || canRecoverLocalOnly;
        if (keep) recoveredLocalExpenses.push(item);
        return keep;
      });
    });
    remoteExpenses.forEach((expense) => upsertExpenseLocal(expense));
    const remoteRecurring = recurringSnapshot.docs.map((item, index) => ({ ...normalizeState({ months: {}, recurring: [cleanRemote(item.data())] }).recurring[0], id: item.id, createdAt: num(item.data().createdAt) || index + 1 }));
    const remoteRecurringIds = new Set(remoteRecurring.map((item) => item.id));
    const recoveredRecurring = canRecoverLocalOnly
      ? state.recurring.filter((item) => !remoteRecurringIds.has(item.id))
      : [];
    state.recurring = [...remoteRecurring, ...recoveredRecurring];
    persistLocal("");
    localMonthKeys
      .filter((key) => !remoteMonthIds.has(key) && (canRecoverLocalOnly || key === currentMonth))
      .forEach((key) => syncMonth(key, "month-ensure"));
    if (canRecoverLocalOnly) {
      recoveredLocalExpenses.filter((item) => !pendingIds.has(item.id)).forEach((item) => syncExpense(item, "local-recovery"));
      recoveredRecurring.forEach((item) => syncRecurring(item, "local-recovery"));
    }
  }

  async function importLegacyAdditions() {
    if (!remoteReady || !spaceDocumentRef || legacyBridgeRunning) return;
    legacyBridgeRunning = true;
    try {
      const { doc, getDoc, setDoc, serverTimestamp } = fsApi;
      const legacyRef = doc(spaceDocumentRef, "budget", "state");
      const legacySnapshot = await getDoc(legacyRef);
      const legacyState = legacySnapshot.data()?.state;
      if (!legacyState?.months) return;

      const currentCounts = new Map();
      allExpenses(true).forEach((expense) => {
        const signature = `${expense.month}|${expenseSignature(expense)}`;
        currentCounts.set(signature, (currentCounts.get(signature) || 0) + 1);
      });
      const legacyCounts = new Map();
      const additions = [];
      Object.entries(legacyState.months).forEach(([monthKey, legacyMonth]) => {
        (legacyMonth.expenses || []).forEach((rawExpense, index) => {
          const signature = `${monthKey}|${expenseSignature(rawExpense)}`;
          const occurrence = (legacyCounts.get(signature) || 0) + 1;
          legacyCounts.set(signature, occurrence);
          if (occurrence <= (currentCounts.get(signature) || 0)) return;
          const expense = normalizeExpense(rawExpense, monthKey, index);
          if (findExpense(expense.id)) {
            expense.id = stableId("legacy-bridge", `${num(legacyState.updatedAt)}-${monthKey}-${index}-${signature}`);
          }
          expense.source = "legacy-bridge";
          additions.push(expense);
        });
      });

      for (const expense of additions) {
        upsertExpenseLocal(expense);
        await writeOperation({
          operationId: newId("op"),
          type: "expense",
          id: expense.id,
          data: serializeExpense(expense),
          action: "legacy-bridge-import",
          before: null,
          queuedAt: Date.now(),
        });
      }
      const metaRef = doc(spaceDocumentRef, "budget", "schema-v2");
      await setDoc(metaRef, {
        schemaVersion: SCHEMA_VERSION,
        legacySeenUpdatedAt: num(legacyState.updatedAt),
        legacyCheckedAt: serverTimestamp(),
      }, { merge: true });
      if (additions.length) {
        persistLocal(`${additions.length}件の旧画面入力を回収しました`);
        render();
      }
    } catch {
      setDataStatus("旧画面の追加データを次回確認します");
    } finally {
      legacyBridgeRunning = false;
    }
  }

  function subscribeRemoteCollections() {
    const { collection, onSnapshot } = fsApi;
    unsubscribeRemote.forEach((unsubscribe) => unsubscribe());
    unsubscribeRemote = [
      onSnapshot(collection(firestore, "spaces", SPACE_ID, "months"), (snapshot) => {
        if (!remoteReady) return;
        const pendingIds = new Set(loadJson(KEY_PENDING, []).filter((item) => item.type === "month").map((item) => item.id));
        remoteApplying = true;
        snapshot.docs.forEach((item) => {
          if (pendingIds.has(item.id)) return;
          const data = cleanRemote(item.data());
          const expenses = state.months[item.id]?.expenses || [];
          state.months[item.id] = { ...monthTemplate(item.id, data.budgets || seedBudgets(), expenses), ...data, expenses };
        });
        persistLocal("");
        render();
        remoteApplying = false;
      }),
      onSnapshot(collection(firestore, "spaces", SPACE_ID, "expenses"), (snapshot) => {
        if (!remoteReady) return;
        const pendingIds = new Set(loadJson(KEY_PENDING, []).filter((item) => item.type === "expense").map((item) => item.id));
        remoteApplying = true;
        snapshot.docChanges().forEach((change) => {
          if (change.type === "removed") return;
          if (pendingIds.has(change.doc.id)) return;
          const expense = normalizeExpense(cleanRemote(change.doc.data()), change.doc.data().month || currentMonth);
          upsertExpenseLocal(expense);
        });
        persistLocal("");
        render();
        remoteApplying = false;
      }),
      onSnapshot(collection(firestore, "spaces", SPACE_ID, "recurring"), (snapshot) => {
        if (!remoteReady) return;
        const pendingIds = new Set(loadJson(KEY_PENDING, []).filter((item) => item.type === "recurring").map((item) => item.id));
        const remoteItems = snapshot.docs.filter((item) => !pendingIds.has(item.id)).map((item) => ({ ...cleanRemote(item.data()), id: item.id }));
        const pendingItems = state.recurring.filter((item) => pendingIds.has(item.id));
        state.recurring = [...remoteItems, ...pendingItems];
        state = normalizeState(state);
        persistLocal("");
        renderRecurring();
      }),
    ];
  }

  async function initFirestoreSync() {
    if (!syncEnabled()) {
      setDataStatus("端末に保存中・Firestore未設定");
      return;
    }
    setDataStatus("Firestoreへ接続中");
    try {
      const { initializeApp } = await firebaseAppApi();
      const { getAuth, signInAnonymously } = await firebaseAuthApi();
      fsApi = await firebaseFirestoreApi();
      const { getFirestore, doc, setDoc, updateDoc, arrayUnion, serverTimestamp } = fsApi;
      const app = initializeApp(FIREBASE_CONFIG);
      authUser = (await signInAnonymously(getAuth(app))).user;
      firestore = getFirestore(app);
      const spaceRef = doc(firestore, "spaces", SPACE_ID);
      spaceDocumentRef = spaceRef;
      try {
        await updateDoc(spaceRef, { memberUids: arrayUnion(authUser.uid), updatedAt: serverTimestamp() });
      } catch {
        await setDoc(spaceRef, { name: "Baby家計簿", memberUids: [authUser.uid], updatedAt: serverTimestamp() }, { merge: true });
      }
      await migrateLegacyData(spaceRef);
      remoteReady = true;
      await flushPending();
      await loadRemoteCollections();
      await importLegacyAdditions();
      subscribeRemoteCollections();
      materializeRecurring(currentMonth);
      render();
      await ensureDailyBackup();
      setDataStatus("支出は1件ずつFirestoreに保存されています");
    } catch (error) {
      remoteReady = false;
      setDataStatus(`端末に保存中・Firestore接続失敗 ${error?.code || ""}`.trim());
    }
  }

  async function ensureDailyBackup() {
    const todayId = `${localDateKey()}-daily`;
    if (!localBackups().some((item) => item.id === todayId)) await createBackup("daily");
  }

  async function checkAppUpdate() {
    try {
      const response = await fetch(`version.json?t=${Date.now()}`, { cache: "no-store" });
      if (!response.ok) return;
      const data = await response.json();
      if (data.version && data.version !== APP_VERSION) flashSave("新しい版があります。再読み込みしてください");
    } catch {}
  }

  function bindEvents() {
    document.getElementById("quickAddForm").addEventListener("submit", (event) => {
      event.preventDefault();
      const amount = document.getElementById("quickAmount");
      if (!String(amount.value).trim()) return;
      addExpense({
        month: currentMonth,
        day: Number(document.getElementById("quickDay").value),
        category: document.getElementById("quickCategory").value,
        status: document.getElementById("quickStatus").value,
        amount: num(amount.value),
      });
      amount.value = "";
      amount.focus();
    });

    document.querySelector("[data-target=fixed]").addEventListener("click", () => {
      const month = monthData();
      if (month.locked) return;
      month.budgets.push({ id: newId("budget"), name: "", amount: 0 });
      persistLocal();
      syncMonth(currentMonth, "budget-create");
      render();
    });
    document.getElementById("prevMonth").addEventListener("click", () => shiftMonth(-1));
    document.getElementById("nextMonth").addEventListener("click", () => shiftMonth(1));
    document.getElementById("monthPicker").addEventListener("change", (event) => {
      currentMonth = event.target.value || currentMonth;
      monthData();
      materializeRecurring(currentMonth);
      render();
    });
    document.getElementById("expenseSearch").addEventListener("input", renderExpenses);
    document.getElementById("expenseCategoryFilter").addEventListener("change", renderExpenses);
    document.getElementById("expenseStatusFilter").addEventListener("change", renderExpenses);
    document.getElementById("expenseDayFilter").addEventListener("change", renderExpenses);
    document.getElementById("analysisYear").addEventListener("change", renderAnalysis);

    document.getElementById("savingGoalInput").addEventListener("change", (event) => {
      const month = monthData();
      const before = serializeMonth(month);
      month.savingGoal = num(event.target.value);
      persistLocal();
      syncMonth(currentMonth, "saving-goal-update", before);
      updateTotals();
    });
    document.getElementById("salaryInput").addEventListener("change", (event) => {
      const month = monthData();
      const before = serializeMonth(month);
      month.salary = num(event.target.value);
      persistLocal("給料を保存しました");
      syncMonth(currentMonth, "salary-update", before);
      updateTotals();
    });
    document.getElementById("salaryInput").addEventListener("focus", (event) => {
      event.target.value = num(event.target.value) || "";
    });
    document.getElementById("monthLockButton").addEventListener("click", () => {
      const month = monthData();
      if (!month.locked && !confirm(`${monthLabel(currentMonth)}を締めますか？締めた後も解除できます。`)) return;
      const before = serializeMonth(month);
      month.locked = !month.locked;
      persistLocal(month.locked ? "月を締めました" : "締めを解除しました");
      syncMonth(currentMonth, month.locked ? "month-lock" : "month-unlock", before);
      render();
    });
    document.getElementById("copyBudgetsButton").addEventListener("click", copyPreviousBudgets);

    fillDaySelect(document.getElementById("recurringDay"), currentMonth, defaultExpenseDay());
    fillCategorySelect(document.getElementById("recurringCategory"), categoryOptions()[0]);
    document.getElementById("recurringForm").addEventListener("submit", (event) => {
      event.preventDefault();
      const item = {
        id: newId("recurring"),
        day: Number(document.getElementById("recurringDay").value),
        category: document.getElementById("recurringCategory").value,
        amount: num(document.getElementById("recurringAmount").value),
        note: document.getElementById("recurringNote").value.trim(),
        active: true,
        createdMonth: currentMonth,
        createdAt: Date.now(),
        deletedAt: null,
      };
      state.recurring.push(item);
      persistLocal("固定費を登録しました");
      syncRecurring(item, "recurring-create");
      event.target.reset();
      fillDaySelect(document.getElementById("recurringDay"), currentMonth, defaultExpenseDay());
      fillCategorySelect(document.getElementById("recurringCategory"), item.category);
      materializeRecurring(currentMonth);
      renderRecurring();
    });

    document.getElementById("expenseEditForm").addEventListener("submit", (event) => {
      if (event.submitter?.value === "cancel") return;
      event.preventDefault();
      const month = document.getElementById("editMonth").value;
      updateExpense(editExpenseId, {
        month,
        day: Number(document.getElementById("editDay").value),
        category: document.getElementById("editCategory").value,
        status: document.getElementById("editStatus").value,
        amount: num(document.getElementById("editAmount").value),
        note: document.getElementById("editNote").value.trim(),
      }, "expense-edit");
      document.getElementById("expenseDialog").close();
    });
    document.getElementById("editMonth").addEventListener("change", (event) => {
      fillDaySelect(document.getElementById("editDay"), event.target.value, document.getElementById("editDay").value);
    });
    document.getElementById("undoButton").addEventListener("click", () => {
      if (lastDeletedId) restoreExpense(lastDeletedId);
      document.getElementById("undoToast").hidden = true;
    });

    document.getElementById("trashButton").addEventListener("click", openTrashDialog);
    document.getElementById("historyButton").addEventListener("click", openHistoryDialog);
    document.getElementById("backupButton").addEventListener("click", async () => {
      await createBackup("manual");
      await openBackupDialog();
    });
    document.getElementById("closeListDialog").addEventListener("click", () => document.getElementById("listDialog").close());
    document.getElementById("exportCsvButton").addEventListener("click", exportCsv);
    document.getElementById("importCsvButton").addEventListener("click", () => document.getElementById("csvInput").click());
    document.getElementById("csvInput").addEventListener("change", async (event) => {
      const file = event.target.files?.[0];
      if (!file) return;
      try {
        await importCsv(file);
      } catch (error) {
        flashSave(error.message || "CSVを読み取れませんでした");
      } finally {
        event.target.value = "";
      }
    });
    document.getElementById("receiptButton").addEventListener("click", () => document.getElementById("receiptInput").click());
    document.getElementById("receiptInput").addEventListener("change", async (event) => {
      const file = event.target.files?.[0];
      if (file) await readReceipt(file);
      event.target.value = "";
    });
  }

  function init() {
    bindEvents();
    materializeRecurring(currentMonth);
    render();
    initFirestoreSync();
    checkAppUpdate();
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") importLegacyAdditions();
    });
  }

  document.addEventListener("DOMContentLoaded", init);
})();
