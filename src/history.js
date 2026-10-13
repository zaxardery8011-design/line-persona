// 選配：多輪對話記憶。HISTORY_TURNS 空或 0 時 enabled() 為 false，brain.js 不會碰這裡。
// 只放記憶體（重啟即清）、不落磁碟、不寫 log——刻意的隱私取捨。

const MAX_KEYS = 1000;
const DEFAULT_CLEAR_WORDS = '/clear|清除對話|忘記剛剛';
const CLEARED_REPLY = '好，剛剛的對話我先忘掉了，我們重新開始。';

const store = new Map(); // key -> { turns: [{ user, assistant, by, mid }], lastAt }；by = 說這句的 userId（「忘了我」用），mid = 那則的 message id（收回／編輯用）
const forgotten = new Map(); // userId -> 他下「忘了我」的 LINE timestamp（ms）；上限 MAX_KEYS，重啟即清
const withdrawn = new Set(); // 收回或編輯過的 message id；上限 MAX_KEYS，重啟即清

function turnsLimit() {
  const n = parseInt(process.env.HISTORY_TURNS || '0', 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function enabled() {
  return turnsLimit() > 0;
}

function ttlMs() {
  const min = Number(process.env.HISTORY_TTL_MIN || 60);
  return (Number.isFinite(min) && min > 0 ? min : 60) * 60 * 1000;
}

// 群組 / 多人聊天室共享同一段脈絡；一對一以 userId 為鍵
function keyOf(source) {
  if (!source) return '';
  return source.groupId || source.roomId || source.userId || '';
}

function isClearCommand(text) {
  const words = (process.env.HISTORY_CLEAR_WORDS || DEFAULT_CLEAR_WORDS)
    .split('|').map((w) => w.trim()).filter(Boolean);
  return words.includes(String(text || '').trim());
}

function get(key) {
  const entry = store.get(key);
  if (!entry) return [];
  if (module.exports.now() - entry.lastAt > ttlMs()) {
    store.delete(key);
    return [];
  }
  return entry.turns;
}

function toMessages(key) {
  const out = [];
  for (const turn of get(key)) {
    out.push({ role: 'user', content: turn.user });
    out.push({ role: 'assistant', content: turn.assistant });
  }
  return out;
}

// at = 這句的 LINE timestamp。他確認「忘了我」之前（或同一毫秒）說的、只是 LLM 比確認晚回來的那一輪，不寫回去。
// mid = 這句的 message id。LLM 還在想時就被收回／編輯的那一輪，同樣不寫回去。
function record(key, user, assistant, by, at, mid) {
  if (!key) return;
  if (by && forgotten.get(by) >= at) return;
  if (mid && withdrawn.has(mid)) return;
  const turns = get(key).concat([{ user, assistant, by, mid }]).slice(-turnsLimit());
  store.delete(key); // 重新插入 = 移到最新，Map 的插入順序即 LRU 順序
  store.set(key, { turns, lastAt: module.exports.now() });
  while (store.size > MAX_KEYS) {
    store.delete(store.keys().next().value);
  }
}

function clear(key) {
  store.delete(key);
}

// 「忘了我」（server.js）：拿掉這個人說過的每一輪（連同分身那句回覆）。1:1 那段整段刪；
// 群組／多人聊天室只拿掉他那幾輪，別人的留著。回傳拿掉幾輪。
// timestamp = 他回「確定」那則的 LINE timestamp：記下來給 record() 擋「確認前說的、答案還在路上」的那幾輪（跟 group.js 的 forgotten 同一招）。
function forgetUser(userId, timestamp) {
  if (!userId) return 0;
  forgotten.delete(userId);
  forgotten.set(userId, timestamp || module.exports.now());
  if (forgotten.size > MAX_KEYS) {
    forgotten.delete(forgotten.keys().next().value);
  }
  let removed = 0;
  for (const [key, entry] of store) {
    const kept = key === userId ? [] : entry.turns.filter((t) => t.by !== userId);
    removed += entry.turns.length - kept.length;
    if (kept.length) entry.turns = kept;
    else store.delete(key);
  }
  return removed;
}

// 收回（unsend）或編輯（messageEdited）過的訊息（server.js）：那一輪連同分身的回覆從記憶拿掉，之後也不再寫回去。
// LINE 建議收回的訊息之後不要再被看到或使用；編輯過的舊版也一樣不留，不然之後每一輪都還會把它送給模型。回傳拿掉幾輪。
function forgetMessage(messageId) {
  if (!messageId || !enabled()) return 0;
  withdrawn.delete(messageId);
  withdrawn.add(messageId);
  if (withdrawn.size > MAX_KEYS) {
    withdrawn.delete(withdrawn.values().next().value);
  }
  let removed = 0;
  for (const [key, entry] of store) {
    const kept = entry.turns.filter((t) => t.mid !== messageId);
    removed += entry.turns.length - kept.length;
    if (kept.length) entry.turns = kept;
    else store.delete(key);
  }
  return removed;
}

module.exports = {
  enabled,
  keyOf,
  isClearCommand,
  toMessages,
  record,
  clear,
  forgetUser,
  forgetMessage,
  CLEARED_REPLY,
  now: () => Date.now(),
  _store: store,
  _forgotten: forgotten,
  _withdrawn: withdrawn,
  MAX_KEYS
};
