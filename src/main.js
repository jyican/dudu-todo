const { invoke } = window.__TAURI__.core;
const { getCurrentWindow, currentMonitor } = window.__TAURI__.window;
const { LogicalSize, PhysicalSize, PhysicalPosition } = window.__TAURI__.dpi;
const notification = window.__TAURI__.notification;
const dialog = window.__TAURI__.dialog;

const win = getCurrentWindow();

// Window sizes (logical px) — ball size must match tauri.conf.json default.
const BALL = 120;
const PANEL_W = 340;
const PANEL_H = 560;

let todos = [];
let expanded = false;
let ballPos = null; // physical position of the ball, saved before expanding
const expandedIds = new Set(); // todo ids whose description is expanded
const subExpandedIds = new Set(); // sub-todo ids whose content is expanded
let descSaveTimer = null;

function scheduleSave() {
  clearTimeout(descSaveTimer);
  descSaveTimer = setTimeout(persist, 400);
}

// ---- Persistence (delegated to Rust, stored as JSON on disk) ----
async function load() {
  try {
    todos = JSON.parse((await invoke("load_todos")) || "[]");
  } catch (e) {
    console.error("load failed", e);
    todos = [];
  }
}

async function persist() {
  try {
    await invoke("save_todos", { data: JSON.stringify(todos) });
  } catch (e) {
    console.error("save failed", e);
  }
}

// ---- Helpers ----
function todayStr() {
  const d = new Date();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

// Refresh both views (badge always; list only matters when panel is open).
function refresh() {
  render();
  updateBadge();
}

function updateBadge() {
  const n = todos.filter((t) => !t.done).length;
  const b = document.querySelector("#ball-badge");
  b.textContent = n > 99 ? "99+" : String(n);
  b.style.display = n > 0 ? "grid" : "none";
}

// ---- Rendering (panel) ----
function render() {
  const pendingList = document.querySelector("#pending-list");
  const doneList = document.querySelector("#done-list");
  pendingList.innerHTML = "";
  doneList.innerHTML = "";

  const pending = todos
    .filter((t) => !t.done)
    .sort((a, b) => {
      if (!a.due && !b.due) return a.createdAt - b.createdAt;
      if (!a.due) return 1;
      if (!b.due) return -1;
      return a.due.localeCompare(b.due);
    });
  const done = todos.filter((t) => t.done).sort((a, b) => b.createdAt - a.createdAt);

  document.querySelector("#pending-count").textContent = pending.length;
  document.querySelector("#done-count").textContent = done.length;

  if (pending.length === 0) {
    pendingList.innerHTML = '<li class="empty">没有待办,享受片刻 🎉</li>';
  } else {
    pending.forEach((t) => pendingList.appendChild(itemEl(t)));
  }
  done.forEach((t) => doneList.appendChild(itemEl(t)));
}

function itemEl(t) {
  const li = document.createElement("li");
  li.className =
    "item" + (t.done ? " done" : "") + (expandedIds.has(t.id) ? " open" : "");

  // ---- Top row: checkbox · title/due · chevron · delete ----
  const row = document.createElement("div");
  row.className = "item-row";

  const check = document.createElement("div");
  check.className = "check";
  check.textContent = "✓";
  check.title = t.done ? "标记为未完成" : "标记为完成";
  check.addEventListener("click", () => toggle(t.id));

  const body = document.createElement("div");
  body.className = "body" + (t.desc && t.desc.trim() ? " has-desc" : "");
  const text = document.createElement("div");
  text.className = "text";
  text.textContent = t.text;
  body.appendChild(text);
  if (t.due) {
    const due = document.createElement("div");
    const overdue = !t.done && t.due < todayStr();
    due.className = "due" + (overdue ? " overdue" : "");
    due.textContent = (overdue ? "⚠ 已逾期 " : "截止 ") + t.due;
    body.appendChild(due);
  }

  const chevron = document.createElement("span");
  chevron.className = "chevron";
  chevron.textContent = "›";
  chevron.title = "展开/收起描述";

  const edit = document.createElement("button");
  edit.className = "edit";
  edit.textContent = "✎";
  edit.title = "编辑标题";
  edit.addEventListener("click", (e) => {
    e.stopPropagation();
    startTitleEdit(t, text, body);
  });

  const del = document.createElement("button");
  del.className = "del";
  del.textContent = "🗑";
  del.title = "删除";
  del.addEventListener("click", () => remove(t.id));

  const toggleDesc = () => {
    if (expandedIds.has(t.id)) expandedIds.delete(t.id);
    else expandedIds.add(t.id);
    li.classList.toggle("open");
    if (li.classList.contains("open")) li.querySelector(".desc-editor").focus();
  };
  body.addEventListener("click", toggleDesc);
  chevron.addEventListener("click", toggleDesc);

  row.append(check, body, chevron, edit, del);

  // ---- Expandable rich-text description ----
  const area = document.createElement("div");
  area.className = "desc-area";

  const toolbar = document.createElement("div");
  toolbar.className = "desc-toolbar";
  toolbar.innerHTML =
    '<button data-cmd="bold" title="加粗"><b>B</b></button>' +
    '<button data-cmd="italic" title="斜体"><i>I</i></button>' +
    '<button data-cmd="insertUnorderedList" title="项目符号">•</button>' +
    '<span class="tb-hint">可直接粘贴图片 / 文档内容</span>';

  const editor = document.createElement("div");
  editor.className = "desc-editor";
  editor.contentEditable = "true";
  editor.dataset.id = t.id;
  editor.dataset.placeholder = "补充描述、贴文档或图片…";
  editor.innerHTML = t.desc || "";

  toolbar.querySelectorAll("button").forEach((b) => {
    // mousedown (not click) so the editor keeps focus/selection
    b.addEventListener("mousedown", (e) => {
      e.preventDefault();
      document.execCommand(b.dataset.cmd, false, null);
      editor.focus();
      t.desc = editor.innerHTML;
      scheduleSave();
    });
  });

  editor.addEventListener("input", () => {
    t.desc = editor.innerHTML;
    body.classList.toggle("has-desc", !!editor.textContent.trim() || editor.querySelector("img"));
    scheduleSave();
  });
  editor.addEventListener("blur", () => {
    t.desc = editor.innerHTML;
    persist();
  });
  editor.addEventListener("paste", (e) => onPasteIntoEditor(e, editor, t));

  const subsWrap = document.createElement("div");
  subsWrap.className = "subs";
  renderSubs(subsWrap, t);

  area.append(toolbar, editor, subsWrap);
  li.append(row, area);
  return li;
}

// Inline-edit a todo's title. Swaps the title text for an input; commits on
// Enter / blur, cancels on Esc.
function startTitleEdit(t, textEl, body) {
  if (body.querySelector(".title-edit")) return; // already editing
  const input = document.createElement("input");
  input.className = "title-edit";
  input.value = t.text;
  textEl.replaceWith(input);
  input.focus();
  input.select();

  let closed = false;
  const close = (save) => {
    if (closed) return;
    closed = true;
    if (save) {
      const v = input.value.trim();
      if (v && v !== t.text) {
        t.text = v;
        persist();
      }
    }
    refresh(); // rebuild — expand state is preserved via expandedIds
  };
  input.addEventListener("click", (e) => e.stopPropagation());
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      close(true);
    } else if (e.key === "Escape") {
      e.preventDefault();
      close(false);
    }
  });
  input.addEventListener("blur", () => close(true));
}

// ---- Sub-todos (each has an editable title + content) ----
function renderSubs(wrap, t) {
  if (!Array.isArray(t.subs)) t.subs = [];
  wrap.innerHTML = "";

  const head = document.createElement("div");
  head.className = "subs-head";
  const open = t.subs.filter((s) => !s.done).length;
  head.innerHTML =
    '<span class="subs-label">子待办</span>' +
    `<span class="badge">${open}/${t.subs.length}</span>`;

  const ul = document.createElement("ul");
  ul.className = "sub-list";
  t.subs.forEach((s) => ul.appendChild(subEl(t, s, wrap)));

  const addBtn = document.createElement("button");
  addBtn.className = "add-sub";
  addBtn.textContent = "＋ 添加子待办";
  addBtn.addEventListener("click", () => {
    const s = { id: uid(), text: "", desc: "", done: false };
    t.subs.push(s);
    subExpandedIds.add(s.id);
    persist();
    renderSubs(wrap, t);
    const inp = wrap.querySelector(`[data-sub="${s.id}"] .sub-title`);
    if (inp) inp.focus();
  });

  wrap.append(head, ul, addBtn);
}

function subEl(t, s, wrap) {
  const li = document.createElement("li");
  li.className = "sub-item" + (s.done ? " done" : "") + (subExpandedIds.has(s.id) ? " open" : "");
  li.dataset.sub = s.id;

  const row = document.createElement("div");
  row.className = "sub-row";

  const check = document.createElement("div");
  check.className = "check sub-check";
  check.textContent = "✓";
  check.title = s.done ? "标记为未完成" : "标记为完成";
  check.addEventListener("click", () => {
    s.done = !s.done;
    li.classList.toggle("done", s.done);
    check.title = s.done ? "标记为未完成" : "标记为完成";
    // Refresh the "open/total" badge without a full rebuild.
    const badge = wrap.querySelector(".subs-head .badge");
    if (badge) badge.textContent = `${t.subs.filter((x) => !x.done).length}/${t.subs.length}`;
    persist();
  });

  const title = document.createElement("input");
  title.className = "sub-title";
  title.value = s.text;
  title.placeholder = "子待办标题…";
  title.addEventListener("input", () => {
    s.text = title.value;
    scheduleSave();
  });
  title.addEventListener("blur", () => {
    s.text = title.value;
    persist();
  });

  const chevron = document.createElement("span");
  chevron.className = "chevron sub-chevron";
  chevron.textContent = "›";
  chevron.title = "展开/收起内容";

  const del = document.createElement("button");
  del.className = "del sub-del";
  del.textContent = "🗑";
  del.title = "删除子待办";
  del.addEventListener("click", () => {
    t.subs = t.subs.filter((x) => x.id !== s.id);
    subExpandedIds.delete(s.id);
    persist();
    renderSubs(wrap, t);
  });

  const toggleSub = () => {
    if (subExpandedIds.has(s.id)) subExpandedIds.delete(s.id);
    else subExpandedIds.add(s.id);
    li.classList.toggle("open");
    if (li.classList.contains("open")) li.querySelector(".sub-desc").focus();
  };
  chevron.addEventListener("click", toggleSub);

  row.append(check, title, chevron, del);

  const desc = document.createElement("textarea");
  desc.className = "sub-desc";
  desc.value = s.desc || "";
  desc.placeholder = "子待办内容…";
  desc.addEventListener("input", () => {
    s.desc = desc.value;
    scheduleSave();
  });
  desc.addEventListener("blur", () => {
    s.desc = desc.value;
    persist();
  });

  li.append(row, desc);
  return li;
}

// Paste handler: embed pasted images as data URLs, let rich text paste natively.
function onPasteIntoEditor(e, editor, t) {
  const items = (e.clipboardData && e.clipboardData.items) || [];
  for (const it of items) {
    if (it.type && it.type.startsWith("image/")) {
      e.preventDefault();
      const file = it.getAsFile();
      if (!file) continue;
      const reader = new FileReader();
      reader.onload = () => {
        document.execCommand(
          "insertHTML",
          false,
          `<img src="${reader.result}" draggable="false" title="单击选中可拖拽缩放,双击预览大图" style="max-width:100%;border-radius:8px;margin:6px 0;display:block;" />`
        );
        t.desc = editor.innerHTML;
        persist();
      };
      reader.readAsDataURL(file);
      return;
    }
  }
  // Plain/rich text paste: let it happen, then save.
  setTimeout(() => {
    t.desc = editor.innerHTML;
    scheduleSave();
  }, 0);
}

// ---- Mutations ----
async function add(text, due) {
  todos.push({ id: uid(), text, due: due || "", desc: "", done: false, createdAt: Date.now(), subs: [] });
  await persist();
  refresh();
}
async function toggle(id) {
  const t = todos.find((x) => x.id === id);
  if (t) {
    t.done = !t.done;
    t.doneAt = t.done ? Date.now() : null; // record completion time for the log
  }
  await persist();
  refresh();
}
async function remove(id) {
  todos = todos.filter((x) => x.id !== id);
  await persist();
  refresh();
}
async function clearDone() {
  todos = todos.filter((x) => !x.done);
  await persist();
  refresh();
}

// ---- Ball <-> Panel ----
async function expand() {
  if (expanded) return;
  expanded = true;
  // Remember where the ball is so we can return to it on collapse.
  try {
    ballPos = await win.outerPosition();
  } catch (e) {
    ballPos = null;
  }
  document.body.classList.replace("mode-ball", "mode-panel");
  await win.setSize(new LogicalSize(PANEL_W, PANEL_H));
  // Open the panel anchored to the ball (top-right aligned), then clamp.
  if (ballPos) {
    try {
      const factor = await win.scaleFactor();
      const x = ballPos.x + BALL * factor - PANEL_W * factor;
      const y = ballPos.y;
      await win.setPosition(new PhysicalPosition(Math.round(x), Math.round(y)));
    } catch (e) {
      console.error("anchor failed", e);
    }
  }
  await clampIntoScreen();
  render();
  win.setFocus();
  warmUpAgent(); // preload the agent in the background (best-effort, once)
}

async function collapse() {
  if (!expanded) return;
  expanded = false;
  document.body.classList.replace("mode-panel", "mode-ball");
  await win.setSize(new LogicalSize(BALL, BALL));
  // Return the ball to exactly where it was before expanding.
  if (ballPos) {
    try {
      await win.setPosition(new PhysicalPosition(ballPos.x, ballPos.y));
    } catch (e) {
      console.error("restore failed", e);
    }
  }
}

// Keep the expanded panel fully on the current monitor.
async function clampIntoScreen() {
  try {
    const factor = await win.scaleFactor();
    const pos = await win.outerPosition(); // physical px
    const mon = await currentMonitor();
    if (!mon) return;
    const pw = PANEL_W * factor;
    const ph = PANEL_H * factor;
    const { x: mx, y: my } = mon.position;
    const { width: mw, height: mh } = mon.size;
    const pad = 8 * factor;
    let x = pos.x;
    let y = pos.y;
    if (x + pw > mx + mw) x = mx + mw - pw - pad;
    if (y + ph > my + mh) y = my + mh - ph - pad;
    if (x < mx + pad) x = mx + pad;
    if (y < my + pad) y = my + pad;
    await win.setPosition(new PhysicalPosition(Math.round(x), Math.round(y)));
  } catch (e) {
    console.error("clamp failed", e);
  }
}

// ---- Export work log to Markdown ----
function pad2(n) {
  return String(n).padStart(2, "0");
}
function fmtDate(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}
function fmtDateTime(ms) {
  const d = new Date(ms);
  return `${fmtDate(ms)} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

// Convert the rich-text description (HTML) into reasonable Markdown.
function htmlToMarkdown(html) {
  if (!html) return "";
  const tmp = document.createElement("div");
  tmp.innerHTML = html;
  const walk = (node) => {
    let out = "";
    node.childNodes.forEach((n) => {
      if (n.nodeType === 3) {
        out += n.nodeValue;
        return;
      }
      if (n.nodeType !== 1) return;
      const tag = n.tagName.toLowerCase();
      const inner = walk(n);
      switch (tag) {
        case "br":
          out += "\n";
          break;
        case "div":
        case "p":
          out += inner + "\n";
          break;
        case "li":
          out += "- " + inner + "\n";
          break;
        case "b":
        case "strong":
          out += "**" + inner + "**";
          break;
        case "i":
        case "em":
          out += "*" + inner + "*";
          break;
        case "a":
          out += `[${inner}](${n.getAttribute("href") || ""})`;
          break;
        case "img":
          out += `\n![图片](${n.getAttribute("src") || ""})\n`;
          break;
        default:
          out += inner;
      }
    });
    return out;
  };
  return walk(tmp).replace(/\n{3,}/g, "\n\n").trim();
}

function rangeFor(type, fromStr, toStr) {
  const now = new Date();
  if (type === "month") {
    const start = new Date(now.getFullYear(), now.getMonth(), 1);
    const end = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);
    return { start, end, label: `${start.getFullYear()}年${start.getMonth() + 1}月` };
  }
  if (type === "year") {
    const start = new Date(now.getFullYear(), 0, 1);
    const end = new Date(now.getFullYear(), 11, 31, 23, 59, 59, 999);
    return { start, end, label: `${now.getFullYear()}年` };
  }
  const start = fromStr ? new Date(fromStr + "T00:00:00") : new Date(0);
  const end = toStr ? new Date(toStr + "T23:59:59.999") : new Date(8640000000000000);
  return { start, end, label: `${fromStr || "最早"} ~ ${toStr || "至今"}` };
}

// An item belongs to the range if any of its dates fall within it.
function inRange(t, start, end) {
  const s = start.getTime();
  const e = end.getTime();
  const tsIn = (ms) => typeof ms === "number" && ms >= s && ms <= e;
  const dueIn = t.due ? (() => {
    const d = new Date(t.due + "T12:00:00").getTime();
    return d >= s && d <= e;
  })() : false;
  return tsIn(t.createdAt) || tsIn(t.doneAt) || dueIn;
}

function buildMarkdown(items, label, start, end) {
  const done = items
    .filter((t) => t.done)
    .sort((a, b) => (a.doneAt || a.createdAt) - (b.doneAt || b.createdAt));
  const pending = items.filter((t) => !t.done).sort((a, b) => {
    if (!a.due && !b.due) return a.createdAt - b.createdAt;
    if (!a.due) return 1;
    if (!b.due) return -1;
    return a.due.localeCompare(b.due);
  });

  const L = [];
  L.push(`# 工作日志 · ${label}`, "");
  L.push(`> 区间:${fmtDate(start.getTime())} ~ ${fmtDate(end.getTime())}　导出于 ${fmtDateTime(Date.now())}`);
  L.push(`> 共 ${items.length} 条 · ✅ 已完成 ${done.length} · ⏳ 待办 ${pending.length}`, "");

  const block = (t, metaLine) => {
    L.push(`### ${t.text}`);
    L.push(`- ${metaLine}`);
    const md = htmlToMarkdown(t.desc);
    if (md) {
      L.push("");
      md.split("\n").forEach((l) => L.push(l ? `> ${l}` : ">"));
    }
    if (Array.isArray(t.subs) && t.subs.length) {
      L.push("");
      t.subs.forEach((s) => {
        L.push(`- [${s.done ? "x" : " "}] ${s.text || "(无标题)"}`);
        if (s.desc && s.desc.trim()) {
          s.desc.split("\n").forEach((l) => L.push(l ? `  > ${l}` : "  >"));
        }
      });
    }
    L.push("");
  };

  if (done.length) {
    L.push(`## ✅ 已完成 (${done.length})`, "");
    done.forEach((t) => {
      const meta = [];
      if (t.doneAt) meta.push(`完成于 ${fmtDate(t.doneAt)}`);
      if (t.due) meta.push(`截止 ${t.due}`);
      block(t, meta.join(" · ") || "—");
    });
  }
  if (pending.length) {
    L.push(`## ⏳ 待办 (${pending.length})`, "");
    pending.forEach((t) => {
      const overdue = t.due && t.due < todayStr();
      const meta = [t.due ? `截止 ${t.due}${overdue ? " ⚠ 已逾期" : ""}` : "无截止日期"];
      meta.push(`创建于 ${fmtDate(t.createdAt)}`);
      block(t, meta.join(" · "));
    });
  }
  if (!items.length) L.push("_该区间没有记录_");
  return L.join("\n");
}

async function doExport(type, fromStr, toStr, useAi) {
  const { start, end, label } = rangeFor(type, fromStr, toStr);
  const items = todos.filter((t) => inRange(t, start, end));
  let md = buildMarkdown(items, label, start, end);
  const safe = label.replace(/\s*~\s*/g, "_至_").replace(/[\s/:]+/g, "-");

  // Optional: let the local agent polish the raw log into a finished document.
  if (useAi) {
    try {
      const reply = await invoke("ask_agent", {
        engine: chatCfg.engine,
        prompt: polishPrompt(md),
        cwd: chatCfg.cwd,
        sessionId: uuidv4(),
        resume: false,
        permissionMode: "default",
      });
      if (reply && reply.text) md = reply.text;
    } catch (e) {
      alert("AI 润色失败,将导出原始日志:\n" + e);
    }
  }

  let path;
  try {
    path = await dialog.save({
      defaultPath: `工作日志-${safe}.md`,
      filters: [{ name: "Markdown", extensions: ["md"] }],
    });
  } catch (e) {
    console.error("save dialog", e);
  }
  if (!path) return; // cancelled

  try {
    await invoke("save_text", { path, data: md });
    if (await ensureNotifyPermission()) {
      notification.sendNotification({
        title: "工作日志已导出",
        body: `${items.length} 条记录 → ${path}`,
      });
    }
  } catch (e) {
    alert("导出失败:" + e);
  }
}

// ---- Image tools: select + drag-resize + preview (shared overlay) ----
function setupImageTools() {
  const selBox = document.querySelector("#img-select");
  const handle = selBox.querySelector(".img-handle");
  const preview = document.querySelector("#img-preview");
  const previewImg = preview.querySelector("img");
  let selImg = null;
  let rs = null; // active resize session

  function positionBox() {
    if (!selImg || !selImg.isConnected) {
      selBox.hidden = true;
      selImg = null;
      return;
    }
    const r = selImg.getBoundingClientRect();
    selBox.style.left = `${r.left}px`;
    selBox.style.top = `${r.top}px`;
    selBox.style.width = `${r.width}px`;
    selBox.style.height = `${r.height}px`;
    selBox.hidden = false;
  }
  function deselect() {
    selImg = null;
    selBox.hidden = true;
  }

  // Single click: select an image (or deselect when clicking elsewhere).
  document.addEventListener("click", (e) => {
    const img = e.target.closest ? e.target.closest(".desc-editor img") : null;
    if (img) {
      selImg = img;
      positionBox();
    } else if (!e.target.closest(".img-select")) {
      deselect();
    }
  });

  // ---- Preview lightbox: fullscreen window + zoom / rotate ----
  const stage = preview.querySelector(".preview-stage");
  let zoom = 1;
  let rot = 0;
  let winRestore = null; // window size/pos to restore after preview

  function applyTransform() {
    previewImg.style.transform = `scale(${zoom}) rotate(${rot}deg)`;
  }

  async function openPreview(src) {
    previewImg.src = src;
    zoom = 1;
    rot = 0;
    applyTransform();
    // Grow the window to cover the whole monitor → true fullscreen preview.
    try {
      const mon = await currentMonitor();
      winRestore = { size: await win.outerSize(), pos: await win.outerPosition() };
      if (mon) {
        await win.setSize(new PhysicalSize(mon.size.width, mon.size.height));
        await win.setPosition(new PhysicalPosition(mon.position.x, mon.position.y));
      }
    } catch (e) {
      console.error("preview resize", e);
    }
    preview.hidden = false;
    win.setFocus();
  }

  async function closePreview() {
    preview.hidden = true;
    previewImg.src = "";
    if (winRestore) {
      try {
        await win.setSize(winRestore.size);
        await win.setPosition(winRestore.pos);
      } catch (e) {
        console.error("preview restore", e);
      }
      winRestore = null;
    }
  }

  // Double click an image → open preview.
  document.addEventListener("dblclick", (e) => {
    const img = e.target.closest ? e.target.closest(".desc-editor img") : null;
    if (img) {
      e.preventDefault();
      openPreview(img.src);
    }
  });

  // Toolbar actions.
  preview.querySelector(".preview-toolbar").addEventListener("click", (e) => {
    const btn = e.target.closest("button");
    if (!btn) return;
    e.stopPropagation();
    switch (btn.dataset.act) {
      case "zoomin":
        zoom = Math.min(8, zoom * 1.25);
        applyTransform();
        break;
      case "zoomout":
        zoom = Math.max(0.2, zoom / 1.25);
        applyTransform();
        break;
      case "rotate":
        rot = (rot + 90) % 360;
        applyTransform();
        break;
      case "reset":
        zoom = 1;
        rot = 0;
        applyTransform();
        break;
      case "close":
        closePreview();
        break;
    }
  });

  // Click the dark backdrop (not the image) to close.
  stage.addEventListener("click", (e) => {
    if (e.target === stage) closePreview();
  });

  // Wheel to zoom.
  stage.addEventListener("wheel", (e) => {
    e.preventDefault();
    zoom = Math.max(0.2, Math.min(8, zoom * (e.deltaY < 0 ? 1.12 : 1 / 1.12)));
    applyTransform();
  });

  // Esc to close.
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !preview.hidden) closePreview();
  });

  // Keep the selection box glued to the image while scrolling/resizing.
  window.addEventListener("scroll", positionBox, true);
  window.addEventListener("resize", positionBox);

  // Drag the corner handle to resize.
  handle.addEventListener("mousedown", (e) => {
    if (!selImg) return;
    e.preventDefault();
    const editor = selImg.closest(".desc-editor");
    rs = { startX: e.clientX, startW: selImg.getBoundingClientRect().width, editor };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  });
  function onMove(e) {
    if (!rs || !selImg) return;
    const max = rs.editor ? rs.editor.clientWidth - 20 : 600;
    const w = Math.max(40, Math.min(max, rs.startW + (e.clientX - rs.startX)));
    selImg.style.width = `${Math.round(w)}px`;
    selImg.style.height = "auto";
    positionBox();
  }
  function onUp() {
    document.removeEventListener("mousemove", onMove);
    document.removeEventListener("mouseup", onUp);
    if (rs && rs.editor) {
      const t = todos.find((x) => x.id === rs.editor.dataset.id);
      if (t) {
        t.desc = rs.editor.innerHTML;
        persist();
      }
    }
    rs = null;
  }
}

// ---- Notifications (permission + manual test) ----
async function ensureNotifyPermission() {
  try {
    let granted = await notification.isPermissionGranted();
    if (!granted) granted = (await notification.requestPermission()) === "granted";
    return granted;
  } catch (e) {
    console.error("notify permission", e);
    return false;
  }
}
async function testNotify() {
  if (!(await ensureNotifyPermission())) {
    alert("通知权限被拒绝,请在 系统设置 → 通知 中允许「dudu tools」。");
    return;
  }
  const pending = todos.filter((t) => !t.done).length;
  notification.sendNotification({
    title: "Dudu 提醒你",
    body: pending ? `当前有 ${pending} 项待办未完成` : "目前没有待办 🎉",
  });
}

// ---- AI chat (local Claude Code / Codex CLI) ----
function uuidv4() {
  if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}

const chatCfg = {
  get engine() {
    return localStorage.getItem("ft.engine") || "claude";
  },
  set engine(v) {
    localStorage.setItem("ft.engine", v);
  },
  get cwd() {
    return localStorage.getItem("ft.cwd") || "";
  },
  set cwd(v) {
    localStorage.setItem("ft.cwd", v);
  },
  get full() {
    return localStorage.getItem("ft.full") === "1";
  },
  set full(v) {
    localStorage.setItem("ft.full", v ? "1" : "0");
  },
  get context() {
    return localStorage.getItem("ft.context") !== "0";
  },
  set context(v) {
    localStorage.setItem("ft.context", v ? "1" : "0");
  },
};

let chatSession = null; // { id, started }
let chatBusy = false;
let chatMsgs = []; // persisted conversation [{ role, text }]
const agentAvail = { claude: null, codex: null }; // cached availability
let warming = false; // a background warm-up is in progress
let warmTried = false; // warm-up attempted this app run

function contextMarkdown() {
  const { start, end } = rangeFor("custom", "", "");
  return buildMarkdown(todos, "我的待办", start, end);
}

// Persist / restore chat across app restarts (localStorage survives restarts).
function saveChat() {
  localStorage.setItem("ft.chat.msgs", JSON.stringify(chatMsgs));
  localStorage.setItem("ft.chat.session", JSON.stringify(chatSession));
}
function loadChat() {
  try {
    chatMsgs = JSON.parse(localStorage.getItem("ft.chat.msgs") || "[]");
    chatSession = JSON.parse(localStorage.getItem("ft.chat.session") || "null");
  } catch (e) {
    chatMsgs = [];
    chatSession = null;
  }
}
function renderChatMsgs() {
  const box = document.querySelector("#chat-msgs");
  box.innerHTML = "";
  chatMsgs.forEach((m) => {
    const el = document.createElement("div");
    el.className = "msg " + m.role;
    el.textContent = m.text;
    box.appendChild(el);
  });
  box.scrollTop = box.scrollHeight;
}
function newChatSession() {
  chatMsgs = [];
  chatSession = null;
  saveChat();
  renderChatMsgs();
}

// A persisted message (user / ai / err).
function chatAppend(role, text) {
  chatMsgs.push({ role, text });
  saveChat();
  renderChatMsgs();
}
// A transient bubble (e.g. "thinking…") — not persisted.
function chatTransient(text) {
  const box = document.querySelector("#chat-msgs");
  const el = document.createElement("div");
  el.className = "msg ai thinking";
  el.textContent = text;
  box.appendChild(el);
  box.scrollTop = box.scrollHeight;
  return el;
}

function renderAvail() {
  const eng = chatCfg.engine;
  const tip = document.querySelector("#chat-avail");
  if (!tip) return;
  const ok = agentAvail[eng];
  if (ok === null) {
    tip.textContent = "检测中…";
    tip.className = "chat-tip";
  } else {
    tip.textContent = ok
      ? `✓ 已检测到 ${eng === "codex" ? "Codex" : "Claude Code"}`
      : `✗ 未找到 ${eng} CLI,请先安装并登录`;
    tip.className = "chat-tip " + (ok ? "ok" : "bad");
  }
}

// Availability is cached per engine (the login-shell probe is slow), so
// reopening chat never re-runs it.
async function chatCheckAvail(force) {
  const eng = chatCfg.engine;
  if (!force && agentAvail[eng] !== null) {
    renderAvail();
    return agentAvail[eng];
  }
  renderAvail(); // 检测中…
  try {
    agentAvail[eng] = await invoke("agent_available", { engine: eng });
  } catch (e) {
    agentAvail[eng] = false;
  }
  renderAvail();
  return agentAvail[eng];
}

// Preload the agent in the background so the first real chat is snappy, and
// have Dudu greet the user. Best-effort; runs at most once per app run.
async function warmUpAgent() {
  if (warmTried || warming) return;
  warmTried = true;
  if (!(await chatCheckAvail())) return; // no CLI → skip silently
  if (chatSession || chatMsgs.length) return; // already have a conversation

  warming = true;
  if (!document.querySelector("#chat").hidden) showWarmHint();
  try {
    chatSession = { id: uuidv4(), started: false };
    let prompt =
      "你是这个桌面待办应用里的吉祥物小驴 Dudu,语气活泼、可爱、简洁。" +
      "请用一两句话(中文,不超过40字,不要列清单)跟主人打个招呼,并说明你能帮他整理待办、写工作日志、用本机的 skill 干活。";
    if (chatCfg.context) {
      prompt = `这是我当前的待办数据(供你参考,稍后我可能问相关问题):\n\n${contextMarkdown()}\n\n----\n${prompt}`;
    }
    const reply = await invoke("ask_agent", {
      engine: chatCfg.engine,
      prompt,
      cwd: chatCfg.cwd,
      sessionId: chatSession.id,
      resume: false,
      permissionMode: "default",
    });
    chatSession.started = true;
    if (reply && reply.session_id) chatSession.id = reply.session_id;
    chatMsgs.push({ role: "ai", text: (reply && reply.text) || "嗨,我是 Dudu!🐴" });
    saveChat();
  } catch (e) {
    console.warn("warm-up failed", e);
    chatSession = null; // let the first real message start a fresh session
  } finally {
    warming = false;
    if (!document.querySelector("#chat").hidden) renderChatMsgs();
  }
}

function showWarmHint() {
  const box = document.querySelector("#chat-msgs");
  if (chatMsgs.length || box.querySelector(".warm-hint")) return;
  const el = document.createElement("div");
  el.className = "msg ai thinking warm-hint";
  el.textContent = "Dudu 正在醒来…🐴";
  box.appendChild(el);
}

// Shown when no agent CLI is available — guides the user to install one.
function showInstallNotice() {
  const box = document.querySelector("#chat-msgs");
  box.innerHTML = "";
  const el = document.createElement("div");
  el.className = "chat-notice";
  el.innerHTML =
    "🐴💤 还没找到可用的 AI 环境<br><br>" +
    "请先安装并登录 <b>Claude Code</b> 或 <b>Codex</b> 命令行,再来找我聊~<br>" +
    "<span class='dim'>装好后,在右上角 ⚙ 里切换引擎或重开聊天即可</span>";
  box.appendChild(el);
}

function setChatEnabled(on) {
  const ta = document.querySelector("#chat-text");
  const btn = document.querySelector("#chat-form button");
  ta.disabled = !on;
  btn.disabled = !on;
  ta.placeholder = on ? "问 Dudu…它能用你本机的 skill" : "请先安装 claude 或 codex 环境";
}

async function chatSend(text) {
  if (chatBusy || !text.trim()) return;
  if (agentAvail[chatCfg.engine] === false) {
    showInstallNotice();
    setChatEnabled(false);
    return;
  }
  if (!chatSession) chatSession = { id: uuidv4(), started: false };

  let prompt = text;
  if (chatCfg.context && !chatSession.started) {
    prompt = `这是我当前的待办数据,作为上下文参考:\n\n${contextMarkdown()}\n\n----\n我的问题:${text}`;
  }

  chatAppend("user", text);
  const sendBtn = document.querySelector("#chat-form button");
  const thinking = chatTransient("Dudu 正在思考…");
  chatBusy = true;
  sendBtn.disabled = true;

  try {
    const reply = await invoke("ask_agent", {
      engine: chatCfg.engine,
      prompt,
      cwd: chatCfg.cwd,
      sessionId: chatSession.id,
      resume: chatSession.started,
      permissionMode: chatCfg.full ? "bypassPermissions" : "acceptEdits",
    });
    thinking.remove();
    if (reply && reply.session_id) chatSession.id = reply.session_id;
    chatSession.started = true;
    chatAppend("ai", (reply && reply.text) || "(无内容返回)");
  } catch (e) {
    thinking.remove();
    chatAppend("err", "出错:" + e);
  } finally {
    chatBusy = false;
    sendBtn.disabled = false;
  }
}

function polishPrompt(md) {
  return (
    "请把下面这份原始工作记录整理、润色成一份条理清晰、可直接交付的中文工作日志(Markdown):\n" +
    '- 保留"已完成 / 待办"的结构与关键日期\n' +
    "- 可适当归纳、概括、提炼重点,但不要编造不存在的内容\n" +
    "- 直接输出最终 Markdown,不要额外解释\n\n原始记录:\n\n" +
    md
  );
}

// ---- Toolbox: URL / Base64 codec · JSON format/minify · timestamp ----
// UTF-8 safe Base64 (btoa only handles latin1, so round-trip through bytes).
function b64encode(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  bytes.forEach((b) => (bin += String.fromCharCode(b)));
  return btoa(bin);
}
function b64decode(b64) {
  const bin = atob(b64.trim());
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function tsParse(raw) {
  raw = raw.trim();
  if (!raw) throw new Error("请输入时间戳或日期");
  let date;
  if (/^\d+$/.test(raw)) {
    let n = Number(raw);
    if (raw.length <= 10) n *= 1000; // 10 位及以下按秒处理
    date = new Date(n);
  } else {
    const n = Date.parse(raw);
    if (Number.isNaN(n)) throw new Error("无法识别的日期格式");
    date = new Date(n);
  }
  if (Number.isNaN(date.getTime())) throw new Error("无效的时间");
  return date;
}
function fmtLocalFull(d) {
  return (
    `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ` +
    `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
  );
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (e) {
    return false;
  }
}

function setupTools() {
  const panel = document.querySelector("#tools");
  document.querySelector("#btn-tools").addEventListener("click", () => {
    panel.hidden = false;
  });
  document.querySelector("#tools-back").addEventListener("click", () => {
    panel.hidden = true;
  });

  // Tab switching.
  const tabs = document.querySelector("#tools-tabs");
  tabs.addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    tabs.querySelectorAll("button").forEach((x) => x.classList.toggle("active", x === b));
    panel
      .querySelectorAll(".tool-pane")
      .forEach((p) => (p.hidden = p.dataset.pane !== b.dataset.tool));
  });

  // Codec actions.
  const codecIn = document.querySelector("#codec-input");
  const codecOut = document.querySelector("#codec-output");
  panel.querySelector('[data-pane="codec"] .tool-actions').addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    const src = codecIn.value;
    try {
      let r = "";
      switch (b.dataset.act) {
        case "url-encode":
          r = encodeURIComponent(src);
          break;
        case "url-decode":
          r = decodeURIComponent(src);
          break;
        case "b64-encode":
          r = b64encode(src);
          break;
        case "b64-decode":
          r = b64decode(src);
          break;
      }
      codecOut.value = r;
    } catch (err) {
      codecOut.value = "⚠ 处理失败:" + err.message;
    }
  });

  // JSON actions.
  const jsonIn = document.querySelector("#json-input");
  const jsonOut = document.querySelector("#json-output");
  panel.querySelector('[data-pane="json"] .tool-actions').addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    try {
      const obj = JSON.parse(jsonIn.value);
      jsonOut.value =
        b.dataset.act === "json-minify" ? JSON.stringify(obj) : JSON.stringify(obj, null, 2);
    } catch (err) {
      jsonOut.value = "⚠ 不是合法的 JSON:" + err.message;
    }
  });

  // Timestamp.
  const tsIn = document.querySelector("#ts-input");
  const tsResult = document.querySelector("#ts-result");
  const runTs = () => {
    try {
      const d = tsParse(tsIn.value);
      const rows = [
        ["Unix 秒", String(Math.floor(d.getTime() / 1000))],
        ["Unix 毫秒", String(d.getTime())],
        ["本地时间", fmtLocalFull(d)],
        ["UTC", d.toUTCString()],
        ["ISO 8601", d.toISOString()],
      ];
      tsResult.classList.remove("err");
      tsResult.innerHTML = rows
        .map(
          (r) =>
            `<div class="ts-line"><span class="ts-key">${r[0]}</span>` +
            `<span class="ts-val">${r[1]}</span></div>`
        )
        .join("");
    } catch (err) {
      tsResult.classList.add("err");
      tsResult.textContent = "⚠ " + err.message;
    }
  };
  document.querySelector('[data-act="ts-parse"]').addEventListener("click", runTs);
  tsIn.addEventListener("keydown", (e) => {
    if (e.key === "Enter") runTs();
  });
  document.querySelector("#ts-now").addEventListener("click", () => {
    tsIn.value = String(Date.now());
    runTs();
  });

  // Copy buttons (shared).
  panel.querySelectorAll(".copy-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const out = document.querySelector("#" + btn.dataset.target);
      if (!out || !out.value) return;
      const ok = await copyText(out.value);
      const orig = btn.textContent;
      btn.textContent = ok ? "✓ 已复制" : "复制失败";
      setTimeout(() => (btn.textContent = orig), 1200);
    });
  });
}

// ---- Wire up ----
window.addEventListener("DOMContentLoaded", async () => {
  // Ball: distinguish a click (open panel) from a drag (move window).
  const ball = document.querySelector("#ball");
  let downPt = null;
  let dragged = false;
  ball.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    downPt = { x: e.screenX, y: e.screenY };
    dragged = false;
  });
  ball.addEventListener("mousemove", (e) => {
    if (!downPt) return;
    if (Math.hypot(e.screenX - downPt.x, e.screenY - downPt.y) > 5) {
      dragged = true;
      downPt = null;
      win.startDragging();
    }
  });
  window.addEventListener("mouseup", () => {
    downPt = null;
  });
  ball.addEventListener("click", () => {
    if (!dragged) expand();
    dragged = false;
  });

  // Panel controls
  document.querySelector("#btn-collapse").addEventListener("click", collapse);
  document.querySelector("#btn-test").addEventListener("click", testNotify);
  document.querySelector("#btn-clear-done").addEventListener("click", clearDone);

  // Export modal
  const exportModal = document.querySelector("#export-modal");
  let exportType = "month";
  document.querySelector("#btn-export").addEventListener("click", () => {
    exportModal.hidden = false;
  });
  document.querySelector("#export-cancel").addEventListener("click", () => {
    exportModal.hidden = true;
  });
  document.querySelector("#export-range").addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    exportType = b.dataset.range;
    document
      .querySelectorAll("#export-range button")
      .forEach((x) => x.classList.toggle("active", x === b));
    document.querySelector("#export-custom").hidden = exportType !== "custom";
  });
  document.querySelector("#export-go").addEventListener("click", async (e) => {
    const from = document.querySelector("#export-from").value;
    const to = document.querySelector("#export-to").value;
    const useAi = document.querySelector("#export-ai").checked;
    const go = e.currentTarget;
    go.disabled = true;
    go.textContent = useAi ? "AI 润色中…" : "导出中…";
    try {
      await doExport(exportType, from, to, useAi);
    } finally {
      go.disabled = false;
      go.textContent = "导出 .md";
      exportModal.hidden = true;
    }
  });

  // ---- AI chat panel ----
  const chatPanel = document.querySelector("#chat");
  const chatEngine = document.querySelector("#chat-engine");
  const chatCwd = document.querySelector("#chat-cwd");
  const chatFull = document.querySelector("#chat-full");
  const chatContext = document.querySelector("#chat-context");
  const chatText = document.querySelector("#chat-text");

  function syncChatSettings() {
    chatEngine.value = chatCfg.engine;
    chatCwd.value = chatCfg.cwd;
    chatFull.checked = chatCfg.full;
    chatContext.checked = chatCfg.context;
  }

  document.querySelector("#btn-chat").addEventListener("click", async () => {
    syncChatSettings();
    renderChatMsgs();
    if (warming) showWarmHint();
    chatPanel.hidden = false;
    chatText.focus();
    const ok = await chatCheckAvail();
    setChatEnabled(ok);
    if (ok) {
      warmUpAgent();
    } else if (!chatMsgs.length) {
      showInstallNotice();
    }
  });
  document.querySelector("#chat-back").addEventListener("click", () => {
    chatPanel.hidden = true;
  });
  document.querySelector("#chat-new").addEventListener("click", () => {
    if (chatMsgs.length && !confirm("开一个新会话?当前对话会清空。")) return;
    newChatSession();
    warmTried = false;
    showWarmHint();
    warmUpAgent(); // fresh greeting + warm
  });
  document.querySelector("#chat-settings").addEventListener("click", () => {
    const box = document.querySelector("#chat-settings-box");
    box.hidden = !box.hidden;
    if (!box.hidden) chatCheckAvail();
  });
  chatEngine.addEventListener("change", async () => {
    chatCfg.engine = chatEngine.value;
    chatSession = null; // new engine → fresh session
    warmTried = false;
    const ok = await chatCheckAvail();
    setChatEnabled(ok);
    if (ok) {
      renderChatMsgs();
      warmUpAgent();
    } else if (!chatMsgs.length) {
      showInstallNotice();
    }
  });
  chatCwd.addEventListener("change", () => {
    chatCfg.cwd = chatCwd.value.trim();
    chatSession = null;
    warmTried = false;
  });
  chatFull.addEventListener("change", () => {
    chatCfg.full = chatFull.checked;
  });
  chatContext.addEventListener("change", () => {
    chatCfg.context = chatContext.checked;
  });

  // Auto-grow textarea; Enter sends, Shift+Enter = newline.
  chatText.addEventListener("input", () => {
    chatText.style.height = "auto";
    chatText.style.height = Math.min(96, chatText.scrollHeight) + "px";
  });
  chatText.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      document.querySelector("#chat-form").requestSubmit();
    }
  });
  document.querySelector("#chat-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const text = chatText.value.trim();
    if (!text) return;
    chatText.value = "";
    chatText.style.height = "auto";
    chatSend(text);
  });
  document.querySelector("#add-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const textEl = document.querySelector("#input-text");
    const dueEl = document.querySelector("#input-due");
    const text = textEl.value.trim();
    if (!text) return;
    await add(text, dueEl.value);
    textEl.value = "";
    dueEl.value = "";
    textEl.focus();
  });

  setupImageTools();
  setupTools();
  loadChat();

  await load();
  refresh();
  ensureNotifyPermission();
});
