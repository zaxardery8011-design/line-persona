// 選配：多輪對話記憶。HISTORY_TURNS 空或 0 時 enabled() 為 false，brain.js 不會碰這裡。
// 只放記憶體（重啟即清）、不落磁碟、不寫 log——刻意的隱私取捨。

const MAX_KEYS = 1000;
const DEFAULT_CLEAR_WORDS = '/clear|清除對話|忘記剛剛';
const CLEARED_REPLY = '好，剛剛的對話我先忘掉了，我們重新開始。';

const store = new Map(); // key -> { turns: [{ user, assistant }], lastAt }

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

function record(key, user, assistant) {
  if (!key) return;
  const turns = get(key).concat([{ user, assistant }]).slice(-turnsLimit());
  store.delete(key); // 重新插入 = 移到最新，Map 的插入順序即 LRU 順序
  store.set(key, { turns, lastAt: module.exports.now() });
  while (store.size > MAX_KEYS) {
    store.delete(store.keys().next().value);
  }
}

function clear(key) {
  store.delete(key);
}

module.exports = {
  enabled,
  keyOf,
  isClearCommand,
  toMessages,
  record,
  clear,
  CLEARED_REPLY,
  now: () => Date.now(),
  _store: store,
  MAX_KEYS
};
