/* おうちの家計簿 — かわいい家計簿アプリ
   依存ゼロ・localStorage保存・月ごと管理 */

(() => {
  "use strict";

  const STORE_KEY = "ouchi-kakeibo-v1";

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
  let state = load();
  let currentMonth = todayMonth();

  // ---------- ユーティリティ ----------
  function todayMonth() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  }

  function load() {
    try {
      return JSON.parse(localStorage.getItem(STORE_KEY)) || {};
    } catch {
      return {};
    }
  }

  function save() {
    localStorage.setItem(STORE_KEY, JSON.stringify(state));
    flashSave();
  }

  let saveTimer = null;
  function flashSave() {
    const hint = document.getElementById("saveHint");
    hint.textContent = "保存したよ ✨";
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => (hint.textContent = "じどうで保存されるよ 💾"), 1200);
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

  function getMonth() {
    if (!state[currentMonth]) state[currentMonth] = blankMonth();
    return state[currentMonth];
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

  // ---------- 明細リスト（収入・固定費・生活費） ----------
  function renderLineList(key) {
    const data = getMonth()[key];
    const wrap = document.getElementById(
      key === "income" ? "incomeList" : key === "fixed" ? "fixedList" : "livingList"
    );
    wrap.innerHTML = "";

    data.forEach((item, i) => {
      const row = document.createElement("div");
      row.className = "line-row";

      const name = document.createElement("input");
      name.className = "line-name";
      name.value = item.name;
      name.placeholder = "項目名";
      name.addEventListener("input", () => {
        item.name = name.value;
        save();
      });

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
        save();
      });

      const del = document.createElement("button");
      del.className = "del-btn";
      del.textContent = "×";
      del.title = "削除";
      del.addEventListener("click", () => {
        data.splice(i, 1);
        renderLineList(key);
        recalc();
        save();
      });

      row.append(name, yenMark, amount, del);
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
        cell((v) => (item.date = v), item.date, "6/1"),
        cell((v) => (item.item = v), item.item, "品名"),
        cell((v) => (item.shop = v), item.shop, "購入先"),
        cell((v) => { item.amount = v; recalc(); }, item.amount, "0", "amount-cell"),
        cell((v) => (item.card = v), item.card, "カード"),
        checkCell((v) => (item.paid = v), item.paid),
        delCell(() => {
          data.splice(i, 1);
          renderCredit();
          recalc();
          save();
        })
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
        cell((v) => (item.date = v), item.date, "6/1"),
        cell((v) => (item.detail = v), item.detail, "内容"),
        cell((v) => { item.amount = v; recalc(); }, item.amount, "0", "amount-cell"),
        delCell(() => {
          data.splice(i, 1);
          renderSpecial();
          recalc();
          save();
        })
      );
      body.appendChild(tr);
    });
  }

  function cell(onChange, value, placeholder, extraClass) {
    const td = document.createElement("td");
    const input = document.createElement("input");
    if (extraClass) input.className = extraClass;
    if (extraClass === "amount-cell") input.inputMode = "numeric";
    input.value = value || "";
    input.placeholder = placeholder || "";
    input.addEventListener("input", () => {
      onChange(input.value);
      save();
    });
    td.appendChild(input);
    return td;
  }

  function checkCell(onChange, value) {
    const td = document.createElement("td");
    td.className = "check-cell";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = !!value;
    input.addEventListener("change", () => {
      onChange(input.checked);
      save();
    });
    td.appendChild(input);
    return td;
  }

  function delCell(onClick) {
    const td = document.createElement("td");
    td.className = "del-cell";
    const btn = document.createElement("button");
    btn.className = "del-btn";
    btn.textContent = "×";
    btn.title = "削除";
    btn.addEventListener("click", onClick);
    td.appendChild(btn);
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

    const ratio = Math.max(0, balance / income); // 貯蓄率
    const pct = Math.min(100, Math.round(ratio * 100));
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

  // ---------- 月の移動 ----------
  function shiftMonth(delta) {
    const [y, mo] = currentMonth.split("-").map(Number);
    const d = new Date(y, mo - 1 + delta, 1);
    currentMonth = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    renderAll();
  }

  // ---------- イベント登録 ----------
  function init() {
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
        save();
      });
    });

    // 月ナビ
    document.getElementById("prevMonth").addEventListener("click", () => shiftMonth(-1));
    document.getElementById("nextMonth").addEventListener("click", () => shiftMonth(1));
    document.getElementById("monthPicker").addEventListener("change", (e) => {
      if (e.target.value) {
        currentMonth = e.target.value;
        renderAll();
      }
    });

    // メモ
    document.getElementById("memo").addEventListener("input", (e) => {
      getMonth().memo = e.target.value;
      save();
    });

    // リセット
    document.getElementById("resetMonth").addEventListener("click", () => {
      if (confirm(`${monthLabel(currentMonth)} の内容をリセットしますか？`)) {
        state[currentMonth] = blankMonth();
        renderAll();
        save();
      }
    });

    renderAll();
  }

  document.addEventListener("DOMContentLoaded", init);
})();
