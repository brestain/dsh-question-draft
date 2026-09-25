/**
 * DSH 提问草稿保全（内容脚本 v0.2）
 * 1) 卡片在屏幕上时，每 500ms 把「已选选项 + 自定义文字」按对话（标签页）存到浏览器本地；
 * 2) 卡片消失（超时/被顶掉）且作答未提交 → 自动把「未提交的问题+已答内容」写进聊天输入框；
 * 3) 你把这段发出去（输入框被清空）→ 清除本对话的草稿；
 * 4) 输入框已有你打的字时不覆盖，只在右下角浮一个小条提示可插入。
 */
(() => {
  "use strict";
  if (window.__dshQuestionDraftLoaded === true) return;
  window.__dshQuestionDraftLoaded = true;

  const VERSION = "1.0.0";
  /** 正式版默认关闭诊断日志；排查时改成 true 即可恢复 [diag#N] 与逐题落盘日志。 */
  const DEBUG = false;
  const DIAG_INTERVAL_MS = 5000;
  const TTL_MS = 24 * 60 * 60 * 1000;
  const SAVE_DEBOUNCE_MS = 500;
  const CARD_GONE_GRACE_MS = 2000;
  const COMPOSER_SELECTOR = "[data-composer-input='true'], .lexical__paragraph, [data-lexical-editor='true'][contenteditable='true']";
  const CARD_SELECTOR = "[data-question-key]";
  const OPTION_SELECTOR = "[role='radiogroup'] button, [role='group'] button";
  /** 卡片导航按钮：只是翻页，绝不能当作提交（旧版把「下一题」误判为提交，导致草稿被清空）。 */
  const NAV_LABELS = ["下一题", "Next", "上一题", "Previous", "Back"];
  /** 结束本组作答的按钮：这些才算提交、才清草稿。 */
  const FINAL_LABELS = ["提交", "Submit", "跳过本题", "Skip this question"];
  const CARD_ACTION_LABELS = NAV_LABELS.concat(FINAL_LABELS);

  const store = typeof chrome !== "undefined" && chrome !== null ? chrome.storage : undefined;
  const cards = new WeakMap();
  let tabKey = null;
  let queue = Promise.resolve();
  let pendingGone = null;
  let draftCache = null;
  let insertedThisRound = false;
  let suppressSave = false;
  let writeCount = 0;

  /** 去掉所有空白后比较，兼容富文本编辑器对换行的处理。 */
  function normalize(text) {
    return String(text ?? "").replace(/\s+/g, "");
  }

  /** 异步轮询等待条件成立。 */
  function waitFor(check, timeoutMs) {
    return new Promise((resolve) => {
      const started = Date.now();
      const tick = () => {
        if (check()) { resolve(true); return; }
        if (Date.now() - started >= timeoutMs) { resolve(false); return; }
        window.setTimeout(tick, 100);
      };
      tick();
    });
  }

  /**
   * 写入输入框：一次只试一种手段，确认没进去才试下一种。
   * 上一版把"粘贴 + execCommand"全部无条件执行，导致同一份文本被插两遍
   * （一份保留换行、一份被编辑器挤掉换行），这是重复的真正来源。
   */
  async function insertTextVerified(element, text) {
    const want = normalize(text);
    const landed = () => normalize(composerText()).includes(want);
    focusComposer(element);
    try { element.textContent = ""; } catch (error) { warn("清空输入框失败:", error); }
    try {
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(element);
      range.collapse(false);
      if (selection !== null) { selection.removeAllRanges(); selection.addRange(range); }
    } catch (error) { warn("选区设置失败:", error); }

    // 手段 1：粘贴事件（Lexical 等富文本编辑器的主路径）
    try {
      const data = new DataTransfer();
      data.setData("text/plain", text);
      element.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: data }));
    } catch (error) { warn("paste 事件失败:", error); }
    if (await waitFor(landed, 800)) { log("写入手段：粘贴事件生效"); return true; }

    // 手段 2：浏览器输入命令（仅在上一种没生效时才执行）
    try { document.execCommand("insertText", false, text); } catch (error) { warn("execCommand 失败:", error); }
    if (await waitFor(landed, 600)) { log("写入手段：execCommand 生效"); return true; }

    // 手段 3：直接写节点 + 合成输入事件
    try {
      element.textContent = text;
      element.dispatchEvent(new InputEvent("input", { bubbles: true, data: text, inputType: "insertText" }));
    } catch (error) { warn("直接写入失败:", error); }
    const ok = await waitFor(landed, 400);
    log("写入手段：直接写入" + (ok ? "生效" : "未生效"));
    return ok;
  }

  /** 该按钮是否属于卡片动作按钮（导航或提交），而不是选项/取消等按钮。 */
  function isCardAction(button, state) {
    const label = textOf(button);
    if (label === "" || !CARD_ACTION_LABELS.includes(label)) return false;
    const aria = button.getAttribute("aria-label");
    if (aria !== null && NAV_LABELS.concat(FINAL_LABELS, ["放弃整组问题", "Dismiss all questions", "收起问题卡片", "展开问题卡片"]).includes(aria)) return false;
    for (const item of state.items) {
      if (item.options.includes(label)) return false;
      if (item.selected.includes(label)) return false;
    }
    return true;
  }

  /** 诊断用：把正文压成单行，换行显示为 \n。 */
  function bodyOf(text) {
    return JSON.stringify(String(text ?? "").replace(/\n/g, "\\n"));
  }
  let chip = null;
  let lastComposerLen = -1;

  function log(...args) {
    try { console.log("[dsh-question-draft]", ...args); } catch { /* 控制台不可用时忽略 */ }
  }
  function warn(...args) {
    try { console.warn("[dsh-question-draft]", ...args); } catch { /* 忽略 */ }
  }
  /** 仅在 DEBUG 打开时打印的排查日志。 */
  function logDebug(...args) {
    if (DEBUG !== true) return;
    log(...args);
  }

  function enqueue(job) {
    queue = queue.then(job).catch((error) => warn("操作失败:", error));
    return queue;
  }
  function textOf(node) {
    if (node === null || node === undefined) return "";
    const text = typeof node.innerText === "string" && node.innerText !== "" ? node.innerText : node.textContent;
    return typeof text === "string" ? text.replace(/\s+/g, " ").trim() : "";
  }

  /** 本对话的标识：标签页内不变，刷新保留，关闭标签页即失效。 */
  function conversationKey() {
    if (tabKey !== null) return tabKey;
    try {
      let value = sessionStorage.getItem("dsh-qd-tab");
      if (value === null || value === "") {
        value = "t" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
        sessionStorage.setItem("dsh-qd-tab", value);
      }
      tabKey = "qd:" + value;
    } catch {
      tabKey = "qd:volatile";
    }
    return tabKey;
  }

  function storageSet(key, value) {
    return new Promise((resolve) => {
      try {
        store.local.set({ [key]: value }, () => resolve(undefined));
      } catch (error) { warn("写入异常:", error); resolve(undefined); }
    });
  }
  function storageGet(key) {
    return new Promise((resolve) => {
      try {
        store.local.get(key, (items) => resolve(items === null || items === undefined ? undefined : items[key]));
      } catch (error) { warn("读取异常:", error); resolve(undefined); }
    });
  }
  function storageRemove(key) {
    return new Promise((resolve) => {
      try { store.local.remove(key, () => resolve(undefined)); } catch { resolve(undefined); }
    });
  }

  function readCard(card) {
    const textarea = card.querySelector("textarea");
    const custom = textarea === null ? "" : String(textarea.value ?? "");
    const options = [];
    const selected = [];
    for (const button of card.querySelectorAll(OPTION_SELECTOR)) {
      const label = button.getAttribute("aria-label") !== null && button.getAttribute("aria-label") !== "" ? button.getAttribute("aria-label") : textOf(button);
      options.push(label);
      if (button.getAttribute("aria-checked") === "true") selected.push(label);
    }
    return { eyebrow: textOf(card.querySelector("header div")), question: textOf(card.querySelector("h2")), options, selected, custom };
  }

  function hasAnswer(item) {
    if (item === null || item === undefined) return false;
    const selected = Array.isArray(item.selected) ? item.selected : [];
    return (typeof item.custom === "string" && item.custom !== "") || selected.length > 0;
  }
  function hasAnyAnswer(state) {
    return state.items.some(hasAnswer);
  }

  /**
   * 把当前渲染的那道题并入草稿：
   * 卡片是"一题一渲染"，翻到下一题时标题变了，所以按题面合并，
   * 已答的题保留，未答的同题面会被新渲染覆盖（避免留下重复的空条目）。
   */
  function mergeCurrent(state) {
    const current = readCard(state.card);
    const signature = current.question + "\u0000" + current.options.join("\u0001");
    const existing = state.items.findIndex((item) => item.question === current.question && item.options.join("\u0001") === current.options.join("\u0001"));
    if (existing >= 0) {
      state.items[existing] = current;
      return;
    }
    const stale = state.items.findIndex((item) => !hasAnswer(item));
    if (stale >= 0 && state.items.length > 0 && state.items.length >= (state.answered ?? 0) + 1) state.items.splice(stale, 1);
    state.items.push(current);
    logDebug("卡片题目并入草稿：" + signature.split("\u0000")[0]);
  }

  function persist(state) {
    if (suppressSave) return;
    const previous = draftCache !== null && draftCache !== undefined && draftCache.conversation === state.key ? draftCache : null;
    const draft = {
      conversation: state.key,
      cardKey: state.cardKey,
      updatedAt: Date.now(),
      inserted: insertedThisRound,
      recovered: previous !== null && previous.recovered === true,
      insertedText: previous !== null && typeof previous.insertedText === "string" ? previous.insertedText : "",
      items: state.items.slice(),
    };
    draftCache = draft;
    logDebug("草稿落盘：" + draft.items.map((item) => item.question + (hasAnswer(item) ? "(已答)" : "(未答)")).join(" / "));
    return enqueue(() => storageSet(state.key, draft));
  }

  function readDraft() {
    if (draftCache !== null) return Promise.resolve(draftCache);
    return enqueue(async () => {
      const value = await storageGet(conversationKey());
      draftCache = value ?? null;
      return draftCache;
    });
  }

  // ---------------- 写入聊天输入框 ----------------
  function composerElement() {
    const input = document.querySelector("[data-composer-input='true']");
    if (input !== null) return input;
    const lexical = document.querySelector("[data-lexical-editor='true'][contenteditable='true']");
    if (lexical !== null) return lexical;
    for (const element of document.querySelectorAll("[contenteditable='true']")) {
      if (typeof element.closest === "function" && element.closest("[data-composer-seat]") !== null) return element;
    }
    const editable = document.querySelector("[contenteditable='true']");
    if (editable !== null) return editable;
    return document.querySelector("textarea");
  }

  function composerText() {
    const element = composerElement();
    if (element === null) return "";
    return typeof element.innerText === "string" ? element.innerText : String(element.textContent ?? "");
  }

  function focusComposer(element) {
    try { element.focus(); } catch { /* 忽略 */ }
  }

  function insertText(element, text) {
    focusComposer(element);
    // 关键：先清空输入框，再写入草稿全文 —— 这样无论触发几次，结果都是同一份，不会叠加
    try { element.textContent = ""; } catch (error) { warn("清空输入框失败:", error); }
    try {
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(element);
      range.collapse(false);
      if (selection !== null) { selection.removeAllRanges(); selection.addRange(range); }
    } catch (error) { warn("选区设置失败:", error); }
    const before = "";
    // 1) 剪贴板粘贴事件：Lexical 等富文本编辑器把它当作真实粘贴
    try {
      const data = new DataTransfer();
      data.setData("text/plain", text);
      element.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: data }));
    } catch (error) { warn("paste 事件失败:", error); }
    if (composerText() !== before) return true;
    // 2) 浏览器输入命令
    try {
      if (document.execCommand("insertText", false, text) && composerText() !== before) return true;
    } catch (error) { warn("execCommand 失败:", error); }
    // 3) 直接写入 + 合成输入事件
    try {
      element.textContent = text;
      element.dispatchEvent(new InputEvent("input", { bubbles: true, data: text, inputType: "insertText" }));
      return composerText() !== before;
    } catch (error) { warn("直接写入失败:", error); return false; }
  }

  /** 对方视角的回复文本：问题序号. 问题? 换行 我的回答: 回答 */
  function renderDraftText(draft) {
    const blocks = [];
    let index = 1;
    for (const item of draft.items) {
      const question = item.question === "" ? "(无题面)" : item.question;
      const parts = [];
      if (item.selected.length > 0) parts.push(item.selected.join("、"));
      if (item.custom !== "") parts.push(item.custom);
      const answer = parts.length > 0 ? parts.join("；") : "未回答";
      blocks.push(index + ". " + question + "?\n我的回答：" + answer);
      index += 1;
    }
    return blocks.join("\n\n");
  }

  function showChip(text, onClick) {
    try {
      if (chip === null || !chip.host.isConnected) {
        const host = document.createElement("div");
        host.style.cssText = "position:fixed;right:18px;bottom:96px;z-index:2147483000;";
        const root = host.attachShadow({ mode: "open" });
        const box = document.createElement("button");
        box.type = "button";
        box.style.cssText = "all:unset;cursor:pointer;padding:8px 12px;border-radius:10px;font:12px/1.4 system-ui;color:#fff;background:rgba(30,30,32,.92);box-shadow:0 4px 16px rgba(0,0,0,.28);";
        root.appendChild(box);
        document.body.appendChild(host);
        chip = { host, box };
      }
      chip.box.textContent = text;
      chip.box.onclick = onClick;
      chip.host.style.display = "";
    } catch (error) { warn("浮条渲染失败:", error); }
  }
  function hideChip() {
    try { if (chip !== null) chip.host.style.display = "none"; } catch { /* 忽略 */ }
  }

  /** 卡片消失后：把未提交作答写进输入框（输入框非空则只提示）。 */
  async function recover(draft, reason) {
    const existingText = composerText();
    const renderedText = renderDraftText(draft);
    log("恢复进入：原因=" + reason + " 输入框长度=" + existingText.trim().length + " 已恢复过=" + (draft.recovered === true) + " 输入框存在=" + (composerElement() !== null));
    if (existingText.includes(renderedText)) {
      draft.recovered = true; draft.inserted = true; draft.insertedText = renderedText; insertedThisRound = true; draftCache = draft;
      enqueue(() => storageSet(draft.conversation, draft));
      log("输入框已含该草稿全文，跳过写入");
      return;
    }
    if (typeof draft.insertedText === "string" && draft.insertedText !== "" && normalize(existingText).includes(normalize(draft.insertedText))) {
      draft.recovered = true; insertedThisRound = true; draftCache = draft;
      log("输入框已含该草稿全文，跳过写入");
      return;
    }
    if (draft.recovered === true) { log("该草稿已恢复过，跳过重复写入"); return; }
    const element = composerElement();
    if (element === null) {
      log("恢复：此刻找不到输入框，1 秒后自动重试");
      showChip("有未提交的作答，点击插入输入框", () => recover(draft, reason));
      window.setTimeout(() => {
        if (draft.recovered === true) return;
        if (composerElement() === null) {
          log("恢复重试：仍然没有输入框，继续等下一次触发");
          showChip("有未提交的作答，点击插入输入框", () => recover(draft, reason));
          return;
        }
        log("恢复重试：输入框已就绪，重新尝试写入");
        recover(draft, reason + "/重试");
      }, 1000);
      return;
    }
    const existing = composerText().trim();
    if (existing !== "") {
      log("恢复：输入框已有你打的字，不覆盖，仅提示（原因：" + reason + "）");
      showChip("有未提交的作答，点击插入输入框", async () => {
        const renderedNow = renderDraftText(draft);
        if (normalize(composerText()).includes(normalize(renderedNow))) {
          draft.recovered = true; draft.inserted = true; draft.insertedText = renderedNow; insertedThisRound = true; draftCache = draft;
          enqueue(() => storageSet(draft.conversation, draft));
          log("手动插入：输入框已含该草稿，跳过");
          return;
        }
        suppressSave = true;
        let wrote = false;
        try {
          wrote = await insertTextVerified(element, (composerText().trim() === "" ? "" : "\n\n") + renderedNow);
        } finally {
          suppressSave = false;
        }
        if (!wrote) { log("手动插入：写入未生效，保留草稿"); return; }
        writeCount += 1;
        draft.recovered = true; draft.inserted = true; draft.insertedText = renderedNow; insertedThisRound = true; draftCache = draft;
        enqueue(() => storageSet(draft.conversation, draft));
        showChip("已插入，发送后自动清除草稿", () => hideChip());
        log("write# 第 " + writeCount + " 次写入（手动插入），写入后输入框=" + bodyOf(composerText()));
      });
      return;
    }
    const rendered = renderDraftText(draft);
    if (normalize(composerText()).includes(normalize(rendered))) {
      draft.recovered = true;
      draft.inserted = true; draft.insertedText = rendered; insertedThisRound = true; draftCache = draft;
      enqueue(() => storageSet(draft.conversation, draft));
      log("恢复：输入框里已存在该草稿，跳过");
      return;
    }
    // 乐观标记：先记下这份文本已由我写入，防止后续重复触发再插一份
    draft.recovered = true;
    draft.inserted = true; draft.insertedText = rendered; insertedThisRound = true; draftCache = draft;
    enqueue(() => storageSet(draft.conversation, draft));
    suppressSave = true;
    let ok = false;
    try {
      ok = await insertTextVerified(element, rendered);
    } finally {
      suppressSave = false;
    }
    if (!ok) {
      draft.recovered = false; draft.insertedText = ""; draftCache = draft;
      enqueue(() => storageSet(draft.conversation, draft));
      log("恢复：写入未生效，已撤销标记（下次仍可尝试）");
      return;
    }
    writeCount += 1;
    lastComposerLen = composerText().trim().length;
    showChip("已把上次未提交的作答填入输入框；发送后自动清除草稿", () => hideChip());
    log("write# 第 " + writeCount + " 次写入（原因：" + reason + "），本次写入=" + bodyOf(rendered) + " 写入后输入框=" + bodyOf(composerText()));
  }

  function cardGone(state, reason) {
    const draft = { conversation: state.key, cardKey: state.cardKey, updatedAt: Date.now(), inserted: false, recovered: false, items: state.items.slice() };
    draftCache = draft;
    log("卡片已从 DOM 消失，进入恢复流程");
    enqueue(() => storageSet(state.key, draft)).then(() => recover(draft, reason));
  }

  // ---------------- 卡片生命周期 ----------------
  function arm(card) {
    if (cards.has(card)) return;
    if (card.querySelector("textarea") === null && card.querySelector(OPTION_SELECTOR) === null) return;
    const state = { card, cardKey: card.getAttribute("data-question-key") ?? "", key: conversationKey(), items: [], submitted: false, saveTimer: null, goneTimer: null, renderedSignature: "" };
    cards.set(card, state);
    const refresh = () => {
      const current = readCard(card);
      const signature = current.question + "\u0000" + current.options.join("\u0001");
      if (signature !== state.renderedSignature) {
        state.renderedSignature = signature;
        mergeCurrent(state);
      } else {
        const index = state.items.findIndex((item) => item.question === current.question && item.options.join("\u0001") === current.options.join("\u0001"));
        if (index >= 0) state.items[index] = current;
        else state.items.push(current);
      }
      state.answered = state.items.filter(hasAnswer).length;
    };
    refresh();
    const save = () => {
      if (state.submitted || suppressSave) return;
      refresh();
      if (state.saveTimer !== null) return;
      state.saveTimer = window.setTimeout(() => {
        state.saveTimer = null;
        if (state.submitted || !hasAnyAnswer(state)) return;
        persist(state);
      }, SAVE_DEBOUNCE_MS);
    };
    card.addEventListener("input", save, true);
    card.addEventListener("change", save, true);
    card.addEventListener("click", (event) => {
      const target = event.target;
      const button = target instanceof Element ? target.closest("button") : null;
      if (button !== null && isCardAction(button, state)) {
        const label = textOf(button);
        if (FINAL_LABELS.includes(label)) {
          state.submitted = true;
          enqueue(() => storageRemove(state.key));
          draftCache = null;
          hideChip();
          log("检测到结束按钮「" + label + "」，已清除本对话草稿");
        } else {
          log("检测到翻页按钮「" + label + "」，保留草稿");
        }
      }
      window.setTimeout(save, 0);
    }, true);
    logDebug("卡片已接入（" + state.cardKey + "）");
    // 轮询卡片是否消失（超时/取消/被顶掉）
    state.goneTimer = window.setInterval(() => {
      if (card.isConnected) return;
      window.clearInterval(state.goneTimer);
      state.goneTimer = null;
      window.setTimeout(() => {
        if (state.submitted) return;
        refresh();
        if (!hasAnyAnswer(state)) { log("卡片消失但没有作答，无需恢复"); return; }
        cardGone(state, "卡片消失");
      }, CARD_GONE_GRACE_MS);
    }, 1000);
  }

  function scan(root) {
    const scope = root instanceof Element || root instanceof Document ? root : document;
    if (scope instanceof Element && scope.matches(CARD_SELECTOR)) arm(scope);
    for (const card of scope.querySelectorAll(CARD_SELECTOR)) arm(card);
  }

  /** 输入框被清空 = 你发出去了 → 清除本对话草稿。 */
  let diagTick = 0;
  let lastDiagLen = -1;
  /** 诊断：每 5 秒打印一次现场，用来判断"卡片是否真的从 DOM 消失""输入框是谁写的"。 */
  function startDiagnostics() {
    window.setInterval(() => {
      diagTick += 1;
      let cardsInDom = -1;
      let draftSummary = "无";
      try {
        cardsInDom = document.querySelectorAll(CARD_SELECTOR).length;
        const draft = draftCache;
        draftSummary = draft === null || draft === undefined ? "无" : draft.items.map((item) => (hasAnswer(item) ? "已答" : "未答")).join("/") + (draft.recovered === true ? " 已恢复" : "") + (draft.insertedText ? " 有写入文本" : "");
      } catch (error) { warn("诊断失败:", error); }
      const length = composerText().trim().length;
      const marker = length !== lastDiagLen ? "（输入框字数变了）" : "";
      lastDiagLen = length;
      log("[diag#" + diagTick + "] 页面卡片数=" + cardsInDom + " 草稿=" + draftSummary + " 输入框字数=" + length + marker + " 写入次数=" + writeCount);
    }, DIAG_INTERVAL_MS);
  }

  function watchComposer() {
    window.setInterval(() => {
      const length = composerText().trim().length;
      if (length === lastComposerLen) return;
      const previous = lastComposerLen;
      lastComposerLen = length;
      if (previous > 0 && length === 0 && insertedThisRound) {
        insertedThisRound = false;
        draftCache = null;
        hideChip();
        enqueue(() => storageRemove(conversationKey()));
        log("输入框已发出并清空，草稿已删除");
      }
    }, 800);
  }

  function pruneExpired() {
    enqueue(() => new Promise((resolve) => {
      try {
        store.local.get(null, (items) => {
          const cutoff = Date.now() - TTL_MS;
          const stale = [];
          for (const [key, value] of Object.entries(items ?? {})) {
            if (!key.startsWith("qd:")) continue;
            if (Number(value?.updatedAt ?? 0) < cutoff) stale.push(key);
          }
          if (stale.length === 0) { resolve(undefined); return; }
          store.local.remove(stale, () => resolve(undefined));
        });
      } catch (error) { warn("清理过期草稿失败:", error); resolve(undefined); }
    }));
  }

  function start() {
    if (store === undefined || store.local === undefined) { warn("缺少 storage 权限，插件不生效"); return; }
    scan(document);
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) if (node instanceof Element) scan(node);
      }
    });
    observer.observe(document.documentElement === null ? document : document.documentElement, { childList: true, subtree: true });
    watchComposer();
    if (DEBUG === true) startDiagnostics();
    pruneExpired();
    readDraft().then((draft) => {
      if (draft === null || draft === undefined) return;
      if (Date.now() - Number(draft.updatedAt ?? 0) > TTL_MS) return;
      if (draft.inserted !== true) return;
      showChip("上次填入的作答若未发送，点击重新插入", () => recover(draft, "手动插入"));
    });
    log("已启动 v" + VERSION + "，对话标识 " + conversationKey());
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true });
  else start();
})();