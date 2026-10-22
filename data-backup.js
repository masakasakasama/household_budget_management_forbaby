/* Encrypted complete local backup; credentials/other apps' storage are never read. */
(function (root) {
  "use strict";
  const MAX = 32 * 1024 * 1024;
  const encoder = new TextEncoder(), decoder = new TextDecoder("utf-8", { fatal: true });
  const b64 = bytes => { let s = ""; for (const n of bytes) s += String.fromCharCode(n); return btoa(s); };
  const un64 = value => Uint8Array.from(atob(value), c => c.charCodeAt(0));
  async function key(password, salt, usage) {
    if (password.length < 12) throw Error("パスフレーズは12文字以上必要です");
    const material = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveKey"]);
    return crypto.subtle.deriveKey({ name: "PBKDF2", salt, iterations: 210000, hash: "SHA-256" }, material,
      { name: "AES-GCM", length: 256 }, false, [usage]);
  }
  async function seal(app, entries, password) {
    const salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12));
    const raw = encoder.encode(JSON.stringify({ version: 1, app, entries }));
    if (raw.length > MAX) throw Error("バックアップ容量を超えています");
    const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: encoder.encode(app) },
      await key(password, salt, "encrypt"), raw);
    return JSON.stringify({ version: 1, salt: b64(salt), iv: b64(iv), ciphertext: b64(new Uint8Array(ciphertext)) });
  }
  async function open(app, text, password, keys) {
    if (text.length > MAX * 2) throw Error("ファイルが大きすぎます");
    const file = JSON.parse(text);
    if (file.version !== 1 || typeof file.ciphertext !== "string") throw Error("未対応のバックアップ");
    const salt = un64(file.salt), iv = un64(file.iv);
    if (salt.length !== 16 || iv.length !== 12) throw Error("破損したバックアップ");
    const raw = await crypto.subtle.decrypt({ name: "AES-GCM", iv, additionalData: encoder.encode(app) },
      await key(password, salt, "decrypt"), un64(file.ciphertext));
    const payload = JSON.parse(decoder.decode(raw));
    if (payload.app !== app || payload.version !== 1 || !payload.entries ||
        Object.keys(payload.entries).sort().join("\n") !== [...keys].sort().join("\n")) throw Error("別アプリまたは形式不一致");
    for (const value of Object.values(payload.entries)) if (value !== null && typeof value !== "string") throw Error("不正な保存データ");
    return payload.entries;
  }
  function snapshot(storage, keys) { return Object.fromEntries(keys.map(k => [k, storage.getItem(k)])); }
  function apply(storage, entries) {
    for (const [k, v] of Object.entries(entries)) { if (v === null) storage.removeItem(k); else storage.setItem(k, v); }
    for (const [k, v] of Object.entries(entries)) if (storage.getItem(k) !== v) throw Error("復元後の内容不一致");
  }
  function transaction(storage, keys, entries, prefix) {
    const before = snapshot(storage, keys);
    // A quota failure here prevents ANY change to app data.
    storage.setItem(prefix + ":rollback", JSON.stringify(before));
    storage.setItem(prefix + ":pending", JSON.stringify(before));
    try { apply(storage, entries); storage.removeItem(prefix + ":pending"); }
    catch (e) { apply(storage, before); storage.removeItem(prefix + ":pending"); throw e; }
    return before;
  }
  function recover(storage, prefix) {
    const raw = storage.getItem(prefix + ":pending");
    if (raw !== null) { apply(storage, JSON.parse(raw)); storage.removeItem(prefix + ":pending"); }
  }
  function validateLocalEntries(entries, shapes) {
    const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
    for (const [key, shape] of Object.entries(shapes)) {
      if (entries[key] === null) continue;
      const value = JSON.parse(entries[key]);
      if (shape === "array") { if (!Array.isArray(value)) throw Error("保存形式不一致"); continue; }
      if (!object(value)) throw Error("保存形式不一致");
      if (shape === "budget") {
        if (!object(value.months) || value.recurring !== undefined && !Array.isArray(value.recurring)) throw Error("家計簿の保存形式不一致");
        for (const month of Object.values(value.months)) {
          if (!object(month) || month.expenses !== undefined && !Array.isArray(month.expenses) || month.budgets !== undefined && !Array.isArray(month.budgets)) throw Error("月の保存形式不一致");
          if ((month.expenses || []).some(item => !object(item)) || (month.budgets || []).some(item => !object(item))) throw Error("記録の保存形式不一致");
        }
      }
      if (shape === "marriageLegacy" && value.checked !== undefined && !object(value.checked)) throw Error("旧チェックリストの保存形式不一致");
      if (shape === "marriageLegacy" && value.custom !== undefined && !Array.isArray(value.custom)) throw Error("旧タスクの保存形式不一致");
      if (shape === "marriage") {
        if (!object(value.checked) || value.custom !== undefined && !Array.isArray(value.custom) || value.dates !== undefined && !object(value.dates) || value.plan !== undefined && !object(value.plan)) throw Error("チェックリストの保存形式不一致");
      }
    }
    return "保存形式を確認しました";
  }
  function ensureReadable(options) {
    const { app, shapes } = options, keys = Object.keys(shapes);
    try { validateLocalEntries(snapshot(localStorage, keys), shapes); return true; }
    catch {
      const warning = document.createElement("p"); warning.id = "localDataRecovery"; warning.setAttribute("role", "alert");
      warning.style.cssText = "padding:16px;border:2px solid #c44";
      warning.textContent = "保存データを読み取れません。初期値で上書きせず、元データを保持しました。下の完全バックアップで元データを保存し、正常なバックアップを復元してください。";
      document.body.appendChild(warning);
      mount({ app, keys, validate: entries => validateLocalEntries(entries, shapes) });
      return false;
    }
  }
  function mount(options) {
    const { app, keys, validate, prepareRestore } = options;
    const prefix = app + ":backup";
    recover(localStorage, prefix);
    const panel = document.createElement("section"); panel.style.cssText = "padding:16px;margin:16px;border:1px solid #888;border-radius:12px";
    const title = document.createElement("h3"); title.textContent = "完全バックアップ・復元（暗号化）"; panel.appendChild(title);
    const note = document.createElement("p"); note.textContent = "全ローカルデータを保存します。クラウドの履歴・バックアップ全体は別途管理者バックアップが必要です。認証情報は移行せず再ログインします。"; panel.appendChild(note);
    const password = document.createElement("input"); password.type = "password"; password.autocomplete = "new-password"; password.placeholder = "12文字以上のパスフレーズ"; password.setAttribute("aria-label", password.placeholder); panel.appendChild(password);
    const status = document.createElement("p"); status.setAttribute("role", "status"); panel.appendChild(status);
    let busy = false;
    function button(label, action) {
      const b = document.createElement("button"); b.type = "button"; b.textContent = label;
      b.onclick = async () => { if (busy) return; busy = true; try { await action(); }
        catch { status.textContent = "処理失敗。パスフレーズ・ファイル・空き容量を確認してください。画面を閉じずに再試行してください。"; }
        finally { busy = false; } }; panel.appendChild(b);
    }
    button("完全バックアップを書き出す", async () => {
      // Capture in-memory edits before any asynchronous file operation.
      if (options.persist && !options.persist()) throw Error("ローカル保存に失敗");
      const entries = snapshot(localStorage, keys), pass = password.value;
      // File picker must be invoked within the user gesture, before awaiting encryption.
      const handlePromise = root.showSaveFilePicker ? root.showSaveFilePicker({ suggestedName: app + "-" + Date.now() + ".backup", types: [{ description: "暗号化バックアップ", accept: { "application/octet-stream": [".backup"] } }] }) : null;
      const handle = handlePromise ? await handlePromise : null;
      const text = await seal(app, entries, pass);
      if (handle) {
        const writable = await handle.createWritable(); await writable.write(text); await writable.close();
        const check = await open(app, await (await handle.getFile()).text(), pass, keys);
        if (JSON.stringify(check) !== JSON.stringify(entries)) throw Error("保存後不一致");
        status.textContent = "保存先ファイルを再読込し、全内容の一致を確認しました。別環境での復元検証も行ってください。";
      } else {
        const url = URL.createObjectURL(new Blob([text], { type: "application/octet-stream" })), a = document.createElement("a");
        a.href = url; a.download = app + "-" + Date.now() + ".backup"; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
        status.textContent = "ダウンロードを開始しました。ブラウザの保存先を確認し、復元画面でファイルを読み直して検証してください。";
      }
    });
    const input = document.createElement("input"); input.type = "file"; input.accept = ".backup"; input.hidden = true; panel.appendChild(input);
    button("バックアップを検証して復元", async () => { input.value = ""; input.click(); });
    input.onchange = async () => {
      if (!input.files[0] || busy) return;
      busy = true;
      try {
        if (input.files[0].size > MAX * 2) throw Error("容量超過");
        const entries = await open(app, await input.files[0].text(), password.value, keys);
        const summary = validate(entries);
        if (!confirm(summary + "\n既存ローカルデータを置換します。先に現在のバックアップを別ファイルへ保存してください。直前状態へのロールバックが可能です。復元後のクラウド同期は確認まで保留します。続行しますか？")) return;
        const prepared = prepareRestore ? prepareRestore(entries) : entries;
        if (options.pause) options.pause();
        localStorage.setItem(prefix + ":hold", "1");
        transaction(localStorage, keys, prepared, prefix);
        status.textContent = summary + " 全キーの内容一致を確認しました。再読込します。"; location.reload();
      } catch { status.textContent = "復元失敗。パスフレーズ・形式・容量を確認してください。復旧が完了するまで画面を閉じないでください。"; }
      finally { busy = false; }
    };
    button("復元直前へロールバック", async () => {
      const raw = localStorage.getItem(prefix + ":rollback"); if (!raw) { status.textContent = "復元前データがありません"; return; }
      if (!confirm("復元直前のローカルデータに戻しますか？クラウドにはまだ送信しません。")) return;
      const entries = JSON.parse(raw);
      if (Object.keys(entries).sort().join("\n") !== [...keys].sort().join("\n") || Object.values(entries).some(v => v !== null && typeof v !== "string")) throw Error("復元前データの形式不一致");
      // A fresh installation legitimately had null app keys before the first restore.
      if (options.pause) options.pause();
      localStorage.setItem(prefix + ":hold", "1"); transaction(localStorage, keys, entries, prefix); location.reload();
    });
    button("復元内容を確認して同期を再開", async () => {
      if (!confirm("バックアップと復元内容を確認しましたか？クラウドの現在のデータと同期します。共有相手も確認してから続行してください。")) return;
      if (localStorage.getItem(prefix + ":hold") && options.beforeResume) options.beforeResume();
      localStorage.removeItem(prefix + ":hold"); location.reload();
    });
    if (localStorage.getItem(prefix + ":hold")) status.textContent = "復元後のクラウド同期は確認待ちです。閲覧・ローカル編集は可能です。内容確認後に同期を再開できます。";
    document.body.appendChild(panel);
  }
  const api = { seal, open, snapshot, transaction, recover, mount, validateLocalEntries, ensureReadable };
  root.DataBackup = api;
  if (typeof module !== "undefined") module.exports = api;
})(typeof window === "undefined" ? globalThis : window);
