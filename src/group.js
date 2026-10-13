// 選配：群組發話政策 + 群組素材收集。
// 環境變數全空（或 GROUP_MODE=reply 且沒開 GROUP_COLLECT）時 enabled() 為 false，
// server.js 完全不會走進這裡，行為與沒有這個模組相同。
//
//   GROUP_MODE        空 / reply = 現況（群組每句都回）
//                     mention    = 只有被叫到（喚醒詞或 @bot）才回
//                     silent     = 群組內一律不回
//   GROUP_WAKE_WORDS  mention 模式的喚醒詞，用 | 分隔；空則用 persona 的「名字」
//   GROUP_COLLECT=1   群組訊息落 data/inbox/<groupId>/<YYYY-MM-DD>.jsonl，媒體落 media/；
//                     成員收回（unsend）時那一行原地遮蔽、媒體檔刪掉，編輯（messageEdited）時遮蔽舊行再補記新版
//   GROUP_FORGET_WORDS 「忘了我」指令詞，用 | 分隔；空則用「忘了我」。GROUP_COLLECT=1 或有設這個變數時，
//                     server.js 在群組政策與收集之前攔下（私訊也能下），先問一次，60 秒內回「確定」
//                     （要比指令晚送出）才把這個人收在 inbox 的每一行遮蔽掉
//
// 1:1 對話完全不受影響（「忘了我」除外）。

const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { pipeline } = require('stream/promises');
const { setTimeout: sleep } = require('timers/promises');
const line = require('@line/bot-sdk');
const history = require('./history');

const ROOT_DIR = path.join(__dirname, '..');
const INBOX_DIR = path.join(ROOT_DIR, 'data', 'inbox');
const MEDIA_EXT = { image: '.jpg', video: '.mp4', audio: '.m4a', file: '.bin' };
// 收回時往回找幾天的檔。LINE App 的收回時限依地區與方案不同（1 小時～Premium 7 天，待驗），取最長的。
const UNSEND_LOOKBACK_DAYS = 7;
// 收回比原訊息先處理完（例如媒體還在下載）時要認得出來；只記最近這麼多個，重啟就清掉。
const UNSENT_MEMORY = 1000;
const DEFAULT_FORGET_WORDS = ['忘了我'];
// 「忘了我」的二次確認：下指令後這麼久內、同一人在同一聊天整句回這個詞才真的刪（見 askForgetConfirm）
const FORGET_CONFIRM_WORD = '確定';
const FORGET_CONFIRM_MS = 60 * 1000;
// 改寫 inbox 檔時目標檔被別的程式開著（Windows 上 rename 會 EPERM／EACCES／EBUSY）：再試前各等這麼久（毫秒）
const LOCKED_RETRY_MS = [50, 150];
const LOCKED_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);

let blobClient = null;
// 同一個檔的 append 與改寫排同一條隊：server.js 用 Promise.all 並行處理同一批事件，
// 「讀→改→寫」若跟 appendFile 交錯，會把對方剛寫進去的行蓋掉。同一則訊息的編輯也排一條隊（見 edit）。
const queues = new Map();
const unsentIds = new Set();
// 確認過「忘了我」的人：user_hash -> 他回「確定」那則的 LINE timestamp。在那之前送出、還沒寫進檔的（例如媒體還在下載）寫的時候直接遮蔽。
const forgotten = new Map();
// 遮蔽沒做完的檔（改寫時檔被別的程式鎖住、或媒體檔刪不掉）：下一個群組事件先照 pendingReason 補做，做完才拿掉。
// 跟 unsentIds、forgotten 一樣只放記憶體，重啟就清。
const pendingFiles = new Set();
// 下了「忘了我」、還在等「確定」的人：`聊天 ID|userId` -> { at: 確認話術送出後記下的時間（now()）,
// ts: 指令那則的 LINE timestamp, id: 指令那則的 message id（收回時對得上，見 cancelForgetConfirm）, word: 他打的指令詞（trim 過） }。
// 只放記憶體，重啟就清＝取消（往不刪那邊倒）。Map 的插入順序就是記下的先後（再下一次會先刪再放）。
const forgetAsked = new Map();

function groupMode() {
  return (process.env.GROUP_MODE || '').trim().toLowerCase();
}

function collectOn() {
  return (process.env.GROUP_COLLECT || '').trim() === '1';
}

function enabled() {
  const mode = groupMode();
  return (mode !== '' && mode !== 'reply') || collectOn();
}

// 回傳 true = 這則群組訊息不要回（server.js 直接結束）；false = 照原本路徑處理。
async function handleGroupEvent(event, { persona, channelAccessToken }) {
  await retryPending();

  // 收回／編輯只改 inbox，永遠不回話
  if (event.type === 'unsend' || event.type === 'messageEdited') {
    if (collectOn()) {
      await (event.type === 'unsend' ? unsend(event) : edit(event));
    }
    return true;
  }

  if (event.type !== 'message' || !event.message) {
    return false;
  }

  if (collectOn()) {
    await collect(event, channelAccessToken);
  }

  const mode = groupMode();
  if (mode === 'silent') {
    return true;
  }
  if (mode === 'mention') {
    return !isAddressed(event.message, persona);
  }
  return false;
}

function isAddressed(message, persona) {
  if (message.type !== 'text') {
    return false;
  }

  const mentionees = (message.mention && message.mention.mentionees) || [];
  if (mentionees.some((m) => m && m.isSelf)) {
    return true;
  }

  const text = message.text || '';
  return wakeWords(persona).some((word) => text.includes(word));
}

function wakeWords(persona) {
  const configured = (process.env.GROUP_WAKE_WORDS || '')
    .split('|')
    .map((w) => w.trim())
    .filter(Boolean);
  if (configured.length) {
    return configured;
  }

  const match = /名字\s*[:：]\s*(\S+)/.exec(String(persona || ''));
  return match ? [match[1]] : [];
}

function hashUser(userId) {
  if (!userId) {
    return null;
  }
  return crypto.createHash('sha256').update(userId).digest('hex').slice(0, 8);
}

// 「忘了我」：GROUP_COLLECT=1 或有設 GROUP_FORGET_WORDS 才攔；trim 後整句完全相符才算（「你會忘了我嗎」不算）。
// 跟 history.js 的清除詞（/clear 等）撞到時讓清除詞照舊，不改變它們的行為。
function isForgetCommand(text) {
  const configured = (process.env.GROUP_FORGET_WORDS || '')
    .split('|')
    .map((w) => w.trim())
    .filter(Boolean);
  if (!collectOn() && !configured.length) {
    return false;
  }

  const said = String(text || '').trim();
  return (configured.length ? configured : DEFAULT_FORGET_WORDS).includes(said) && !history.isClearCommand(said);
}

// 「忘了我」刪了救不回來（有人開玩笑順口一句就刪光），所以 server.js 先不刪，確認話術真的送出去之後才在這裡記一筆待確認。
// 同一人在同一聊天再下一次就重新計時。拿不到 userId（認不出是誰）回傳 false，什麼都不記。
// timestamp 是指令那則的 LINE timestamp：之後只認比它晚送出的「確定」（見 takeForgetConfirm）。messageId 是指令那則的 id。
// LINE 重送來的指令 server.js 不會叫這裡（見 server.js 的 handleEvent）。
function askForgetConfirm(source, word, timestamp, messageId) {
  const key = forgetKey(source);
  if (!key) {
    return false;
  }

  // 順手清掉逾時的：Map 依下指令先後排，碰到第一筆還沒逾時的就停
  const now = module.exports.now();
  for (const [oldKey, ask] of forgetAsked) {
    if (now - ask.at <= FORGET_CONFIRM_MS) {
      break;
    }
    forgetAsked.delete(oldKey);
  }
  forgetAsked.delete(key);
  forgetAsked.set(key, { at: now, ts: timestamp, id: messageId, word: String(word || '').trim() });
  return true;
}

// 對方收回了自己下的那句指令＝反悔：拿掉那筆待確認，回傳 true。只認那筆記下的指令本身（之後又下了一次的話，
// 那筆是新的指令，收回舊的那句不動它）；別人、別的聊天、沒帶 id 的都對不上。
// 收回比待確認先處理到（確認話術還在送的那一瞬間）時這裡對不到，那筆照樣等到逾時或被「確定」用掉。
function cancelForgetConfirm(source, messageId) {
  const key = forgetKey(source);
  const ask = key && forgetAsked.get(key);
  if (!ask || !messageId || ask.id !== messageId) {
    return false;
  }
  forgetAsked.delete(key);
  return true;
}

// 這句是不是在確認自己剛下的「忘了我」：trim 後整句是「確定」，同一人、同一聊天、記下待確認後 60 秒內（含），
// 而且這則的 LINE timestamp 比指令那則晚。最後這條擋重送與亂序：指令之前就送出的「確定」（例如回別人的一句
// 第一次處理失敗、LINE 之後重送，或兩則分在不同 webhook、後送的先處理）不能拿來確認後來的指令。
// 是就拿掉那筆待確認、回傳當初的指令詞，server.js 才真的刪；不是回傳 null，照一般訊息處理。
// 逾時的那筆一樣拿掉；比指令早（或同一毫秒、或沒帶 timestamp，比不出先後）的「確定」不動那筆，本人之後回的照樣算。
// 別人回、在別的聊天回都對不到那筆，那筆照樣留到逾時。
function takeForgetConfirm(source, text, timestamp) {
  if (String(text || '').trim() !== FORGET_CONFIRM_WORD) {
    return null;
  }
  const key = forgetKey(source);
  const ask = key && forgetAsked.get(key);
  if (!ask) {
    return null;
  }
  if (module.exports.now() - ask.at > FORGET_CONFIRM_MS) {
    forgetAsked.delete(key);
    return null;
  }
  if (!(timestamp > ask.ts)) {
    return null;
  }
  forgetAsked.delete(key);
  return ask.word;
}

// 待確認的 key：聊天（群組／多人聊天室／1:1 的 ID）＋發話者。沒有 userId 就是 null。
function forgetKey(source) {
  if (!source || !source.userId) {
    return null;
  }
  return `${source.groupId || source.roomId || source.userId}|${source.userId}`;
}

// 把 data/inbox/ 底下所有群組、所有日期檔裡這個人（user_hash 相符）的行原地遮蔽（redacted:'forget'），媒體檔刪掉。
// hashUser 只有 8 碼：碰巧跟別人撞雜湊時，別人的行也會被一起遮蔽（寧可多刪）。
// 回傳 { removed: 遮蔽了幾則, failed: 幾個檔沒做完 }。沒做完的部分原樣留著（改寫失敗＝那個檔；媒體檔刪不掉＝那一行，
// 還認得出是他的），再下一次指令會補上；下一個群組事件也會先自動補做（pendingFiles）。
async function forgetUser(userId, timestamp) {
  const hash = hashUser(userId);
  const result = { removed: 0, failed: 0 };
  if (!hash) {
    return result;
  }

  forgotten.delete(hash);
  forgotten.set(hash, timestamp || Date.now());
  if (forgotten.size > UNSENT_MEMORY) {
    forgotten.delete(forgotten.keys().next().value);
  }

  let files = [];
  try {
    files = await inboxFiles();
  } catch (error) {
    result.failed += 1;
    console.warn('GROUP_COLLECT could not forget a member:', error.message);
  }
  for (const file of files) {
    const done = await redactOrRetryLater(file, (rec) => rec.user_hash === hash && 'forget', 'GROUP_COLLECT could not forget a member:');
    if (done) {
      result.removed += done.redacted;
    }
    if (!done || done.stuck) {
      result.failed += 1;
    }
  }
  return result;
}

// data/inbox/<群>/*.jsonl 全部列出來；inbox 還不存在就是空的。
async function inboxFiles() {
  let groups;
  try {
    groups = await fsp.readdir(INBOX_DIR, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') {
      return [];
    }
    throw error;
  }

  const files = [];
  for (const dir of groups.filter((d) => d.isDirectory())) {
    const groupDir = path.join(INBOX_DIR, dir.name);
    for (const name of (await fsp.readdir(groupDir)).filter((n) => n.endsWith('.jsonl')).sort()) {
      files.push(path.join(groupDir, name));
    }
  }
  return files;
}

async function collect(event, channelAccessToken) {
  const groupId = event.source.groupId;
  const message = event.message;
  const when = new Date(event.timestamp || Date.now());
  const groupDir = path.join(INBOX_DIR, safeName(groupId));
  const record = {
    ts: when.toISOString(),
    user_hash: hashUser(event.source.userId),
    type: message.type,
    // 每一筆都記：收回／編輯時靠它找到這一行
    message_id: message.id
  };

  try {
    await fsp.mkdir(groupDir, { recursive: true });

    if (message.type === 'text') {
      record.text = message.text || '';
    } else if (MEDIA_EXT[message.type]) {
      try {
        record.media_path = await saveMedia(message, groupDir, channelAccessToken);
      } catch (error) {
        // 下載失敗也要留一行：LINE 的內容會過期，沒記下來就再也不知道漏了什麼。
        record.media_error = String(error && error.message ? error.message : error).slice(0, 200);
      }
    }

    await appendRecord(path.join(groupDir, `${localDate(when)}.jsonl`), record);
  } catch (error) {
    console.warn('GROUP_COLLECT could not write inbox:', error.message);
  }
}

// 成員收回訊息：近幾天 inbox 裡同一個 message_id 的行原地遮蔽、媒體檔刪掉；找不到就算了。
async function unsend(event) {
  const messageId = event.unsend && event.unsend.messageId;
  if (!messageId || !event.source) {
    return;
  }

  rememberUnsent(messageId);
  const reasonOf = (rec) => rec.message_id === messageId && 'unsend';
  for (const file of recentFiles(event.source.groupId, new Date(event.timestamp || Date.now()))) {
    await redactOrRetryLater(file, reasonOf, 'GROUP_COLLECT could not redact an unsent message:');
  }
}

// 成員編輯訊息（LINE 只在群組送，內容只會是文字）：舊行遮蔽、補記一行新版。
// 同一則的多次編輯可能亂序到達：手上已有同時或更新的版本就不動；已被收回（或因別的原因遮蔽）的不補記。
async function edit(event) {
  const message = event.message || {};
  if (!message.id || !event.source || unsentIds.has(message.id)) {
    return;
  }

  // 同一則的編輯排同一條隊，「讀→遮蔽→補記」整段做完下一個才開始：同一批事件是 Promise.all 並行處理的，
  // 不排隊的話兩個編輯會同時通過下面的檢查、各補一行，舊版就沒被遮蔽。
  await withLock(`edit:${safeName(event.source.groupId)}:${message.id}`, async () => {
    const when = new Date(event.timestamp || Date.now());
    const files = recentFiles(event.source.groupId, when);
    const isThis = (rec) => rec.message_id === message.id;
    try {
      const known = [];
      for (const file of files) {
        known.push(...(await readRecords(file)).filter(isThis));
      }
      if (known.some((rec) => (rec.redacted && rec.redacted !== 'edited') || Date.parse(rec.ts) >= when.getTime())) {
        return;
      }

      for (const file of files) {
        await redactLines(file, (rec) => isThis(rec) && 'edited');
      }
      await fsp.mkdir(path.dirname(files[0]), { recursive: true });
      await appendRecord(files[0], {
        ts: when.toISOString(),
        user_hash: hashUser(event.source.userId),
        type: message.type || 'text',
        message_id: message.id,
        text: message.text || '',
        edited: true
      });
    } catch (error) {
      console.warn('GROUP_COLLECT could not record an edited message:', error.message);
    }
  });
}

// 寫一行到 inbox（跟遮蔽排同一條隊）。這則在寫進去之前就被收回了（例如媒體還在下載），
// 或發話者在這則之後下了「忘了我」，只寫遮蔽版、媒體檔不留；媒體檔刪不掉時先照原樣寫（還指得到檔），排進 pendingFiles 之後補做。
function appendRecord(file, record) {
  return withFileLock(file, async () => {
    let row = record;
    const reason = pendingReason(record);
    if (reason) {
      if (await mediaRemover(file)(record)) {
        row = redactRecord(record, reason);
      } else {
        pendingFiles.add(path.resolve(file));
      }
    }
    await fsp.appendFile(file, JSON.stringify(row) + '\n', 'utf8');
  });
}

// 照記憶體裡的兩份清單判斷一行該不該遮蔽：收回過的 message_id、確認過「忘了我」的人在確認前（含同一毫秒）說的。
function pendingReason(rec) {
  if (rec.message_id && unsentIds.has(rec.message_id)) {
    return 'unsend';
  }
  return isForgotten(rec) ? 'forget' : null;
}

function isForgotten(rec) {
  return Boolean(rec.user_hash) && forgotten.get(rec.user_hash) >= Date.parse(rec.ts);
}

// 之前沒做完的遮蔽再補一次（例如當時檔被別的程式鎖住）；還是不行的留在清單裡等下一次。
async function retryPending() {
  for (const file of [...pendingFiles]) {
    pendingFiles.delete(file);
    await redactOrRetryLater(file, pendingReason, 'GROUP_COLLECT could not finish an earlier redaction:');
  }
}

// redactLines 外加記帳：改寫失敗（記 warn）或有媒體檔刪不掉，就把這個檔排進 pendingFiles。改寫失敗時回傳 null。
async function redactOrRetryLater(file, reasonOf, warning) {
  try {
    const done = await redactLines(file, reasonOf);
    if (done.stuck) {
      pendingFiles.add(path.resolve(file));
    }
    return done;
  } catch (error) {
    pendingFiles.add(path.resolve(file));
    console.warn(warning, error.message);
    return null;
  }
}

// 把 file 裡 reasonOf(record) 回傳遮蔽原因的行原地換成遮蔽版；回傳 { redacted: 遮蔽了幾行, stuck: 幾行因為媒體檔刪不掉先原樣留著 }。
// 原因：收回 'unsend'、編輯 'edited'、「忘了我」'forget'；之後別種遮蔽也走這支（所以有 export），reasonOf 回傳別的原因就好。
// 行數絕不增減：absorb.js 的已讀水位是「每個檔讀過幾行」。改寫見 replaceFile。
// 有媒體的行先刪媒體檔、刪乾淨了才遮蔽：刪不掉（Windows 上檔被別的程式開著會 EBUSY／EPERM）的那行先原樣留著，
// 還指得到檔、也還認得出是誰的，之後補做或再下一次「忘了我」才找得回來，不會留下沒有任何一行指向的檔。
async function redactLines(file, reasonOf) {
  return withFileLock(file, async () => {
    let content;
    try {
      content = await fsp.readFile(file, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') {
        return { redacted: 0, stuck: 0 };
      }
      throw error;
    }

    const removeMedia = mediaRemover(file);
    const lines = [];
    let redacted = 0;
    let stuck = 0;
    let changed = false;
    for (const raw of content.split('\n')) {
      const rec = parseRecord(raw);
      const reason = rec && reasonOf(rec);
      if (!reason) {
        lines.push(raw);
      } else if (rec.redacted) {
        // 內容早就遮蔽了；「忘了我」只再拿掉發話者雜湊（不算進遮蔽了幾則）
        if (rec.user_hash == null || (reason !== 'forget' && !isForgotten(rec))) {
          lines.push(raw);
        } else {
          lines.push(JSON.stringify({ ...rec, user_hash: null }));
          changed = true;
        }
      } else if (!(await removeMedia(rec))) {
        stuck += 1;
        lines.push(raw);
      } else {
        lines.push(JSON.stringify(redactRecord(rec, reason)));
        redacted += 1;
        changed = true;
      }
    }

    if (changed) {
      await replaceFile(file, lines.join('\n'));
    }
    return { redacted, stuck };
  });
}

// 改寫整個檔：先寫暫存檔再 rename 蓋過去。Windows 上目標檔正被別的程式開著（同步、防毒、索引、absorb 正在讀）時，
// rename 會 EPERM／EACCES／EBUSY，就算對方允許刪除也一樣；這時改成直接覆寫原檔（從頭寫、截掉多的，鎖內做所以不會跟自己的寫入交錯），
// 還是不行就等一下再整套重試，試完還不行才丟錯（呼叫端會排進 pendingFiles）。暫存檔一定清掉。
async function replaceFile(file, content) {
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    await fsp.writeFile(tmp, content, 'utf8');
    for (let attempt = 0; ; attempt += 1) {
      try {
        await fsp.rename(tmp, file);
        return;
      } catch (error) {
        if (!LOCKED_CODES.has(error.code)) {
          throw error;
        }
        try {
          await overwrite(file, content);
          return;
        } catch (_fallbackError) {
          if (attempt >= LOCKED_RETRY_MS.length) {
            throw error;
          }
        }
        await sleep(LOCKED_RETRY_MS[attempt]);
      }
    }
  } finally {
    // rename 成功時暫存檔已經不在。清不掉（例如那個路徑是目錄）也不蓋掉原本的錯。
    await fsp.rm(tmp, { force: true }).catch(() => {});
  }
}

async function overwrite(file, content) {
  const data = Buffer.from(content, 'utf8');
  const handle = await fsp.open(file, 'r+');
  try {
    await handle.write(data, 0, data.length, 0);
    await handle.truncate(data.length);
  } finally {
    await handle.close();
  }
}

// 遮蔽版只留時間、類型、發話者雜湊與 message_id；text、media_path、media_error 等內容欄位全拿掉。
// 「忘了我」連發話者雜湊也不留，不然還看得出他哪天講過幾句；別的原因遮蔽、但發話者已下過「忘了我」的也一樣。
function redactRecord(rec, reason) {
  return {
    ts: rec.ts,
    user_hash: reason === 'forget' || isForgotten(rec) ? null : rec.user_hash,
    type: rec.type,
    message_id: rec.message_id,
    redacted: reason,
    redacted_at: new Date().toISOString()
  };
}

function readRecords(file) {
  return withFileLock(file, async () => {
    try {
      return (await fsp.readFile(file, 'utf8')).split('\n').map(parseRecord).filter(Boolean);
    } catch (error) {
      if (error.code === 'ENOENT') {
        return [];
      }
      throw error;
    }
  });
}

function parseRecord(raw) {
  try {
    const rec = JSON.parse(raw);
    return rec && typeof rec === 'object' ? rec : null;
  } catch (_error) {
    return null;
  }
}

// 回傳「刪掉一行的媒體檔」的函式，回傳 true＝都刪掉了（或本來就沒有）。同一個檔的多行共用一次 media/ 列表。
// 要刪的：media_path 指的檔（相對專案根目錄；只刪得到 inbox 底下的檔），加上這個群 media/ 裡以 message_id 命名的檔
// （saveMedia 的檔名就是 safeName(message_id)＋副檔名；下載到一半斷掉留下的半截檔沒有 media_path，也靠這個找到）。
// 每個檔各自刪，刪不掉的記 warn、不中斷。
function mediaRemover(file) {
  const mediaDir = path.join(path.dirname(file), 'media');
  let names = null;
  return async (rec) => {
    const targets = new Set();
    let ok = true;
    if (rec.media_path) {
      const target = path.resolve(ROOT_DIR, rec.media_path);
      if (target.startsWith(INBOX_DIR + path.sep)) {
        targets.add(target);
      }
    }
    if (rec.message_id && MEDIA_EXT[rec.type]) {
      const stem = safeName(rec.message_id);
      try {
        names = names || await listDir(mediaDir);
        for (const name of names) {
          if (name === stem || name.startsWith(`${stem}.`)) {
            targets.add(path.join(mediaDir, name));
          }
        }
      } catch (error) {
        ok = false;
        console.warn('GROUP_COLLECT could not list media files:', error.message);
      }
    }
    for (const target of targets) {
      try {
        await fsp.rm(target, { force: true });
      } catch (error) {
        ok = false;
        console.warn('GROUP_COLLECT could not delete a media file (will retry):', error.message);
      }
    }
    return ok;
  };
}

async function listDir(dir) {
  try {
    return await fsp.readdir(dir);
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') {
      return [];
    }
    throw error;
  }
}

// 從事件當天往回列 UNSEND_LOOKBACK_DAYS 天的檔名（本地日期，跟 collect 寫的檔名一致；不存在的檔之後會略過）。
function recentFiles(groupId, when) {
  const groupDir = path.join(INBOX_DIR, safeName(groupId));
  const files = [];
  for (let back = 0; back <= UNSEND_LOOKBACK_DAYS; back += 1) {
    const day = new Date(when.getFullYear(), when.getMonth(), when.getDate() - back);
    files.push(path.join(groupDir, `${localDate(day)}.jsonl`));
  }
  return files;
}

function rememberUnsent(messageId) {
  unsentIds.add(messageId);
  if (unsentIds.size > UNSENT_MEMORY) {
    unsentIds.delete(unsentIds.values().next().value);
  }
}

// 同一個 key 的工作依序做；前一個失敗不擋後面的。
function withLock(key, task) {
  const run = (queues.get(key) || Promise.resolve()).then(task);
  const done = run.catch(() => {});
  queues.set(key, done);
  done.then(() => {
    if (queues.get(key) === done) {
      queues.delete(key);
    }
  });
  return run;
}

// 檔案以絕對路徑排隊。
function withFileLock(file, task) {
  return withLock(path.resolve(file), task);
}

async function saveMedia(message, groupDir, channelAccessToken) {
  if (!blobClient) {
    blobClient = new line.messagingApi.MessagingApiBlobClient({ channelAccessToken: channelAccessToken || '' });
  }

  const mediaDir = path.join(groupDir, 'media');
  await fsp.mkdir(mediaDir, { recursive: true });

  const ext = (message.type === 'file' && path.extname(message.fileName || '').replace(/[^.\w]/g, '')) || MEDIA_EXT[message.type];
  const fileName = `${safeName(message.id)}${ext}`;
  const target = path.join(mediaDir, fileName);

  const content = await blobClient.getMessageContent(message.id);
  if (Buffer.isBuffer(content) || content instanceof Uint8Array) {
    await fsp.writeFile(target, content);
  } else {
    await pipeline(content, fs.createWriteStream(target));
  }

  return path.posix.join('data', 'inbox', path.basename(groupDir), 'media', fileName);
}

function safeName(value) {
  return String(value || 'unknown').replace(/[^\w-]/g, '_');
}

function localDate(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

module.exports = {
  enabled,
  handleGroupEvent,
  isForgetCommand,
  askForgetConfirm,
  takeForgetConfirm,
  cancelForgetConfirm,
  forgetUser,
  redactLines,
  // 二次確認的計時用；測試換成假時鐘
  now: () => Date.now(),
  _forgetAsked: forgetAsked
};
