// Shared by background.js and options.js: shortcut parsing, storage, shortcut sync.
// Row i <-> command "slot-NN" (NN = i + 1). Row: { u: url, k: shortcut, c: note }.

const MAX_SLOTS = 99;
const OPTIONS_CMD = "open-options";
const BLOCKED_URL = /^(about:(?!blank)|chrome:|resource:|javascript:|view-source:)/i;
const SCHEME = /^[a-z][a-z0-9+.-]*:(\/\/|[^\d\/]|$)/i;

const slotName = (i) => "slot-" + String(i + 1).padStart(2, "0");
const slotIndex = (name) => parseInt(name.slice(5), 10) - 1;

// ---- Shortcut parsing (WebExtension commands format) ----
const MODS = { ctrl: "Ctrl", alt: "Alt", shift: "Shift", command: "Command", cmd: "Command", meta: "Command", win: "Command", macctrl: "MacCtrl" };
const MOD_ORDER = ["Ctrl", "Alt", "MacCtrl", "Command", "Shift"];
const NAMED = ["Comma", "Period", "Home", "End", "PageUp", "PageDown", "Space", "Insert", "Delete",
  "Up", "Down", "Left", "Right", "MediaNextTrack", "MediaPlayPause", "MediaPrevTrack", "MediaStop"];
const KEY_BY_NAME = Object.fromEntries([
  ...NAMED.map(n => [n.toLowerCase(), n]),
  ["arrowup", "Up"], ["arrowdown", "Down"], ["arrowleft", "Left"], ["arrowright", "Right"],
  [",", "Comma"], [".", "Period"], ["mediatracknext", "MediaNextTrack"], ["mediatrackprevious", "MediaPrevTrack"],
]);
const KEY_BY_CODE = {
  Comma: "Comma", Period: "Period", Home: "Home", End: "End", PageUp: "PageUp", PageDown: "PageDown",
  Space: "Space", Insert: "Insert", Delete: "Delete", ArrowUp: "Up", ArrowDown: "Down", ArrowLeft: "Left",
  ArrowRight: "Right", MediaTrackNext: "MediaNextTrack", MediaPlayPause: "MediaPlayPause",
  MediaTrackPrevious: "MediaPrevTrack", MediaStop: "MediaStop",
};

const isFree = (key) => /^F\d+$/.test(key) || key.startsWith("Media"); // valid without a modifier

function toKey(p) {
  if (/^[a-z0-9]$/i.test(p)) return p.toUpperCase();
  const l = p.toLowerCase();
  if (/^f([1-9]|1[0-2])$/.test(l)) return l.toUpperCase();
  return KEY_BY_NAME[l] || "";
}

// "alt + shift + k" -> "Alt+Shift+K"; "" if empty or invalid.
function parseShortcut(str) {
  const s = String(str || "").trim();
  if (!s) return "";
  const mods = new Set();
  let key = "";
  for (const p of s.split("+").map(x => x.trim()).filter(Boolean)) {
    const m = MODS[p.toLowerCase()];
    if (m) { mods.add(m); continue; }
    if (key) return "";
    key = toKey(p);
    if (!key) return "";
  }
  if (!key) return "";
  if (!isFree(key) && ![...mods].some(m => m !== "Shift")) return "";
  return [...MOD_ORDER.filter(m => mods.has(m)), key].join("+");
}

function keyFromCode(code = "") {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit\d$/.test(code)) return code.slice(5);
  if (/^F([1-9]|1[0-2])$/.test(code)) return code;
  return KEY_BY_CODE[code] || "";
}

// On macOS the Command key is "Ctrl" and the Control key is "MacCtrl".
function shortcutFromEvent(e, mac) {
  const key = keyFromCode(e.code);
  if (!key) return "";
  const m = [];
  if (mac ? e.metaKey : e.ctrlKey) m.push("Ctrl");
  if (e.altKey) m.push("Alt");
  if (mac && e.ctrlKey) m.push("MacCtrl");
  if (e.shiftKey) m.push("Shift");
  return parseShortcut([...m, key].join("+"));
}

function normalizeUrl(raw) {
  const u = String(raw).trim();
  return SCHEME.test(u) ? u : "https://" + u;
}

// ---- Rows ----
const tidy = (r) => {
  r ||= {};
  return { u: String(r.u || "").trim(), k: parseShortcut(r.k), c: String(r.c || "").trim() };
};
const isBlank = (r) => !r.u && !r.k && !r.c;
const syncSet = (o) => browser.storage.sync.set(o).catch(e => console.warn("sync mirror failed", e));

async function loadRows() {
  const { rows } = await browser.storage.local.get("rows");
  return Array.isArray(rows) ? rows.map(tidy).slice(0, MAX_SLOTS) : [];
}

// Stores compacted rows and returns them
async function saveRows(rows) {
  const clean = rows.map(tidy).filter(r => !isBlank(r)).slice(0, MAX_SLOTS);
  await browser.storage.local.set({ rows: clean });
  await mirrorRows(clean);
  return clean;
}

// Backup copy in storage.sync as r1..rN (stale keys removed)
async function mirrorRows(rows) {
  try {
    const sync = browser.storage.sync;
    const set = Object.fromEntries(rows.map((r, i) => [`r${i + 1}`, r]));
    const stale = Object.keys(await sync.get(null)).filter(k => /^r\d+$/.test(k) && !(k in set));
    if (rows.length) await sync.set(set);
    if (stale.length) await sync.remove(stale);
  } catch (e) { console.warn("sync mirror failed", e); }
}

// Fill settings/extras from sync if missing locally. With no local rows, rebuild them
// from the sync mirror. Returns true if anything was restored.
async function restore() {
  try {
    const local = browser.storage.local;
    const [cur, remote] = await Promise.all([
      local.get(["settings", "rows", "extras"]),
      browser.storage.sync.get(null),
    ]);
    const back = {};
    for (const k of ["settings", "extras"]) if (!cur[k] && remote[k]) back[k] = remote[k];
    if (Object.keys(back).length) await local.set(back);
    let restored = "extras" in back;
    if (cur.rows !== undefined) return restored;

    const rows = Object.keys(remote)
      .map(k => /^r(\d+)$/.exec(k))
      .filter(Boolean)
      .sort((a, b) => a[1] - b[1])
      .map(m => tidy(remote[m[0]]))
      .filter(r => !isBlank(r));
    if (!rows.length) return restored;
    await local.set({ rows });
    return true;
  } catch (e) { console.warn("restore failed", e); return false; }
}

// ---- Extras: { optionsKey: shortcut that opens the options page } ----
const tidyExtras = (x) => ({ optionsKey: parseShortcut(x && x.optionsKey) });

async function loadExtras() {
  return tidyExtras((await browser.storage.local.get("extras")).extras);
}

async function saveExtras(x) {
  x = tidyExtras(x);
  await browser.storage.local.set({ extras: x });
  await syncSet({ extras: x });
}

// ---- Shortcuts <-> Firefox commands ----
async function liveShortcuts() {
  return new Map((await browser.commands.getAll()).map(c => [c.name, parseShortcut(c.shortcut)]));
}

// Rows for the model: stored URLs/notes plus the live shortcuts (which may be edited in about:addons)
async function loadModel() {
  const [rows, live] = [await loadRows(), await liveShortcuts()];
  let last = rows.length;
  for (let i = 0; i < MAX_SLOTS; i++) if (live.get(slotName(i))) last = Math.max(last, i + 1);
  while (rows.length < last) rows.push({ u: "", k: "", c: "" });
  rows.forEach((r, i) => { r.k = live.get(slotName(i)) || ""; });
  return rows;
}

// Make the commands match the rows. First duplicate wins. Returns [{ name, shortcut, message }] for
// shortcuts Firefox rejected.
async function applyShortcuts(rows, extras = {}) {
  const targets = new Map(), seen = new Set();
  const put = (name, k) => {
    const ok = !!k && !seen.has(k);
    if (ok) seen.add(k);
    targets.set(name, ok ? k : "");
  };
  put(OPTIONS_CMD, extras.optionsKey);
  for (let i = 0; i < MAX_SLOTS; i++) put(slotName(i), rows[i]?.k || "");

  const live = await liveShortcuts();
  const diff = [...targets].filter(([n, k]) => (live.get(n) || "") !== k);
  await Promise.all(diff.filter(([, k]) => !k).map(([n]) => browser.commands.reset(n)));

  const failed = [];
  for (const [name, shortcut] of diff) {
    if (!shortcut) continue;
    try { await browser.commands.update({ name, shortcut }); }
    catch (err) { failed.push({ name, shortcut, message: err.message }); }
  }
  return failed;
}
