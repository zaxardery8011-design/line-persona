'use strict';

// src/escalation.js — 轉真人閉環（**選配模組，預設完全關閉**）
//
// 這個檔解決的問題：分身說「我幫你轉達真人」之後，**沒有然後**。
// 預設的 persona 範本就教使用者寫這句話（persona/profile.md、使用手冊.md），
// 但框架本身沒有任何機制去兌現它 —— 開了口的承諾，結構上沒有人會接。
//
// 打開它（.env 設 ESCALATION_ENABLED=1）之後的閉環：
//   分身答不出來 → 開單（去重）→ 通知回答者 → 回答者取單作答 → 推回原提問者 → 寫 push 收據
//
// **沒設 ESCALATION_ENABLED 時，maybeEscalate() 第一行就原樣返回，不讀檔、不寫檔、不發訊息。**
//
// 下文三個「咽喉」註解裡的「真實事故」，出處是作者自己營運的 LINE bot（主腦實驗室，
// 非本框架的使用者回報）：26 筆待回覆卡單、最久 94.1 天。本模組是把那次修復抽成可選配的通用版。
//
// 零新相依：只用 Node 內建 fs / path / crypto / fetch（需要 Node 18+，與本專案一致）。
//
// CLI（回答者用）：
//   node src/escalation.js list                         列出待回覆
//   node src/escalation.js stale 3                      列出超過 3 天沒人回的
//   node src/escalation.js remind 3                     重推提醒（預設 dry-run）
//   node src/escalation.js remind 3 --send              真的推
//   node src/escalation.js claim <回答者id>              取一張單（會記在磁碟，重啟可續）
//   node src/escalation.js skip <回答者id>               跳過手上這張（落磁碟）
//   node src/escalation.js defer <回答者id> 24           擱置 24 小時（落磁碟）
//   node src/escalation.js answer <單號> "答案" [--send] 作答；不加 --send 只存草稿不外送

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = path.join(__dirname, '..', 'data', 'escalations');
const NOTIFY_FAILURE_LOG = path.join(DATA_DIR, '_notify_failures.jsonl');
const FLOW_STATE_PATH = path.join(DATA_DIR, '_flow_state.json');

const DEFAULT_TRIGGERS = [
  '轉真人', '轉達真人', '幫你轉達', '請本人確認', '需要本人確認',
  '再跟本人確認', '跟老闆確認', '我不確定', '我不知道', '無法回答'
];

// ── 開關與設定 ──────────────────────────────────────────────────────────

function isEnabled() {
  const v = String(process.env.ESCALATION_ENABLED || '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'on';
}

function triggerWords() {
  const raw = String(process.env.ESCALATION_TRIGGERS || '').trim();
  if (!raw) return DEFAULT_TRIGGERS;
  return raw.split('|').map((s) => s.trim()).filter(Boolean);
}

function responderIds() {
  return String(process.env.ESCALATION_NOTIFY_TO || '')
    .split(',').map((s) => s.trim()).filter(Boolean);
}

function looksUnanswered(reply) {
  const text = String(reply || '');
  return triggerWords().some((word) => text.includes(word));
}

// 使用者 id 一律雜湊後才進檔名與 log。原始 id 只留在 data/（已被 .gitignore 擋住），
// 因為要推回答案時非用原始 id 不可。
function hashId(userId) {
  return 'U' + crypto.createHash('sha256').update(String(userId || '')).digest('hex').slice(0, 12);
}

// ── 磁碟讀寫 ────────────────────────────────────────────────────────────

async function ensureDir() {
  await fsp.mkdir(DATA_DIR, { recursive: true });
}

async function writeTicket(ticket) {
  await ensureDir();
  await fsp.writeFile(path.join(DATA_DIR, ticket.id), JSON.stringify(ticket, null, 2), 'utf8');
  return ticket;
}

async function readTicket(id) {
  try {
    return JSON.parse(await fsp.readFile(path.join(DATA_DIR, id), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function listTickets(status) {
  let names = [];
  try {
    names = await fsp.readdir(DATA_DIR);
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }

  const out = [];
  for (const name of names) {
    if (name.startsWith('_') || !name.endsWith('.json')) continue;
    const ticket = await readTicket(name);
    if (ticket && (!status || ticket.status === status)) out.push(ticket);
  }
  return out.sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
}

function ageDays(ticket) {
  return (Date.now() - new Date(ticket.ts).getTime()) / 86400000;
}

// ── LINE push（零相依，直接打 Messaging API）─────────────────────────────

async function linePush(to, text) {
  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN || '';
  if (!token) throw new Error('LINE_CHANNEL_ACCESS_TOKEN is empty');

  const response = await fetch('https://api.line.me/v2/bot/message/push', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ to, messages: [{ type: 'text', text: String(text).slice(0, 5000) }] })
  });

  if (!response.ok) {
    throw new Error(`LINE push ${response.status}: ${(await response.text()).slice(0, 200)}`);
  }
  return true;
}

// ── 開單（含去重）────────────────────────────────────────────────────────

async function openTicket(userId, question) {
  const windowMin = Number(process.env.ESCALATION_DEDUPE_MIN || 60);
  const now = new Date();
  const mine = (await listTickets('pending'))
    .filter((t) => t.userId === userId)
    .sort((a, b) => String(b.ts).localeCompare(String(a.ts)));

  if (mine.length) {
    const last = mine[0];
    const lastAt = new Date(last.last_follow_up_at || last.ts);
    if (now - lastAt <= windowMin * 60000) {
      last.follow_ups = (last.follow_ups || []).concat([{ ts: now.toISOString(), question }]);
      last.follow_up_count = last.follow_ups.length;
      last.last_follow_up_at = now.toISOString();
      last.urgency = last.follow_up_count >= 2 ? 'urgent' : 'normal';
      await writeTicket(last);
      return { ticket: last, isNew: false };
    }
  }

  const ticket = {
    id: `${now.toISOString().replace(/[:.]/g, '')}_${hashId(userId)}.json`,
    status: 'pending',              // status 只有 pending / resolved，不要發明第三個
    userId,
    question: String(question || '').slice(0, 2000),
    ts: now.toISOString(),
    follow_ups: [],
    follow_up_count: 0,
    urgency: 'normal',
    last_follow_up_at: null,
    answer: null,
    resolved_at: null,
    resolved_by: null,
    push_status: null,              // 「答案真的送到」的唯一收據，見 resolve()
    reminder_count: 0,
    last_reminded_at: null
  };
  await writeTicket(ticket);
  return { ticket, isNew: true };
}

// ── 咽喉 1：通知對象為 0 時必須留下紀錄，不准靜默 ─────────────────────────
//
// 真實事故：回答者名單只登記 1 人，而那個人正是最大量的提問者。
// 「跳過提問者本人」看起來完全合理 —— 直到他自己問倒 bot，
// targets 變成空陣列，迴圈一圈都不跑，一個人都沒被通知，而磁碟上
// 只留下一個 status:pending 的檔。「開了單」與「有人知道這張單」在磁碟上同形。

async function recordNotifyFailure(ticket, reason, detail) {
  await ensureDir();
  const row = {
    ts: new Date().toISOString(),
    ticket_id: ticket && ticket.id ? ticket.id : '(none)',
    asker: hashId(ticket && ticket.userId),
    reason,
    detail: detail ? String(detail).slice(0, 300) : null
  };
  await fsp.appendFile(NOTIFY_FAILURE_LOG, JSON.stringify(row) + '\n', 'utf8');
  console.warn(`[escalation] 通知未送達：${reason} ticket=${row.ticket_id}`);
  return row;
}

async function notifyResponders(ticket, textOverride) {
  const all = responderIds();
  const skipAsker = String(process.env.ESCALATION_NOTIFY_SKIP_ASKER || '').trim() === '1';
  const targets = skipAsker ? all.filter((id) => id !== ticket.userId) : all;

  if (targets.length === 0) {
    // 這不是「沒事發生」，這是一個必須被記錄的異常
    await recordNotifyFailure(
      ticket,
      all.length === 0 ? 'no_responder_configured' : 'no_responder_available'
    );
    return { attempted: 0, ok: 0 };
  }

  const text = textOverride || [
    '【待回覆】分身答不出來，需要你回一句',
    `單號：${ticket.id}`,
    `問題：${ticket.question}`,
    `作答：node src/escalation.js answer ${ticket.id} "你的答案" --send`
  ].join('\n');

  let ok = 0;
  for (const to of targets) {
    try {
      await linePush(to, text);
      ok += 1;
    } catch (error) {
      await recordNotifyFailure(ticket, 'push_failed', error.message);
    }
  }
  if (ok === 0) await recordNotifyFailure(ticket, 'all_push_failed');
  return { attempted: targets.length, ok };
}

// ── 咽喉 2：通知只發一次就沒有下文，是卡單最久的真正成因 ───────────────────
//
// 真實事故：開單時推一次通知，就這一次。那次若被滑掉，這張單就永遠
// 留在磁碟上，沒有任何東西會再提起它（最久 94.1 天）。
// listStale() / remind() 是給排程（Windows 工作排程器、cron、任何週期性觸發）
// 呼叫的介面；排程本身刻意不內建，因為那是使用者環境的事。

async function listStale(days) {
  const threshold = Number(days || 3);
  return (await listTickets('pending')).filter((t) => ageDays(t) >= threshold);
}

// 提醒是「每次執行、每位回答者一則彙整」，不是一張單一則。
// 設計理由：若積了 20 張逾期單，逐張提醒會讓回答者的手機一次連響 20 次——
// 提醒變成噪音，比沒有提醒更容易被整批滑掉。（同形問題在作者自己營運的 bot 上撞過：
// 限流名額一輪全落在同一位提問者，差點讓他幾小時內連收好幾則道歉。）
const DIGEST_MAX_LISTED = 10;
const DIGEST_MAX_CHARS = 4500;   // LINE 單則上限 5000，留餘裕

function digestText(tickets, days) {
  const oneLine = (s) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, 40);
  const listed = tickets.slice(0, DIGEST_MAX_LISTED);   // tickets 已由舊到新排序，最久的在前
  const lines = [`【逾期未回】${tickets.length} 張單沒人回，最久 ${ageDays(tickets[0]).toFixed(1)} 天`];
  listed.forEach((t, i) => {
    lines.push(`${i + 1}. ${t.id}／${ageDays(t).toFixed(1)} 天／${oneLine(t.question)}／已提醒 ${Number(t.reminder_count || 0)} 次`);
  });
  if (tickets.length > listed.length) lines.push(`…還有 ${tickets.length - listed.length} 張`);
  lines.push(`全部：node src/escalation.js stale ${Number(days || 3)}`);
  return lines.join('\n').slice(0, DIGEST_MAX_CHARS);
}

// 彙整不屬於任何一張單，所以不借用 notifyResponders()（它的「跳過提問者」與
// 失敗記錄都綁單張）。失敗一樣寫 _notify_failures.jsonl，ticket_id 標成彙整。
async function notifyDigest(tickets, text) {
  const tag = { id: `(remind_digest:${tickets.length})`, userId: '' };
  const all = responderIds();
  const skipAsker = String(process.env.ESCALATION_NOTIFY_SKIP_ASKER || '').trim() === '1';
  // 回答者只在「彙整裡每張都是他自己問的」時才跳過
  const targets = skipAsker ? all.filter((id) => !tickets.every((t) => t.userId === id)) : all;

  if (targets.length === 0) {
    await recordNotifyFailure(tag, all.length === 0 ? 'no_responder_configured' : 'no_responder_available');
    return { attempted: 0, ok: 0 };
  }

  let ok = 0;
  for (const to of targets) {
    try {
      await linePush(to, text);
      ok += 1;
    } catch (error) {
      await recordNotifyFailure(tag, 'push_failed', error.message);
    }
  }
  if (ok === 0) await recordNotifyFailure(tag, 'all_push_failed');
  return { attempted: targets.length, ok };
}

async function remind(days, options) {
  const opts = options || {};
  const send = opts.send === true;
  const maxReminders = Number(process.env.ESCALATION_MAX_REMINDERS || opts.maxReminders || 5);
  const results = [];
  const due = [];

  for (const ticket of await listStale(days)) {
    if (Number(ticket.reminder_count || 0) >= maxReminders) {
      // 有上限才不會變成無限重推
      results.push({ id: ticket.id, age_days: Number(ageDays(ticket).toFixed(1)), skipped: 'reminder_cap_reached' });
      continue;
    }
    due.push(ticket);
  }

  // 0 張就一則都不發
  if (due.length === 0) {
    results.push({ summary: true, dry_run: !send, tickets_listed: 0, pushes: 0 });
    return results;
  }

  const text = digestText(due, days);

  if (!send) {
    const wouldNotify = responderIds().length;
    for (const ticket of due) {
      results.push({ id: ticket.id, age_days: Number(ageDays(ticket).toFixed(1)), dry_run: true, would_notify: wouldNotify });
    }
    results.push({ summary: true, dry_run: true, tickets_listed: due.length, pushes: wouldNotify, text });
    return results;
  }

  const outcome = await notifyDigest(due, text);
  const now = new Date().toISOString();
  for (const ticket of due) {
    // 一則都沒送到就不算提醒過：否則推播故障期間每跑一次都會吃掉重推額度，
    // 幾次之後這張單就永遠到上限、再也不會被提起。失敗已記在 _notify_failures.jsonl。
    if (outcome.ok > 0) {
      ticket.reminder_count = Number(ticket.reminder_count || 0) + 1;
      ticket.last_reminded_at = now;
      await writeTicket(ticket);
    }
    results.push({ id: ticket.id, age_days: Number(ageDays(ticket).toFixed(1)), attempted: outcome.attempted, ok: outcome.ok });
  }
  results.push({ summary: true, dry_run: false, tickets_listed: due.length, pushes: outcome.attempted, ok: outcome.ok });
  return results;
}

// ── 咽喉 3：回覆流程的狀態必須落磁碟，不能只放記憶體 ───────────────────────
//
// 真實事故：取單 → 作答 → 確認的中間狀態存在記憶體 Map，TTL 10 分鐘。
// 某次回答者連續清掉 9 筆，停在第 10 筆 —— 第 8 到第 9 筆之間隔了 21.6 分鐘，
// 超過 TTL，進度歸零，人就沒再回來。那 9 筆是三個月來唯一一次清理。
// 這裡的 claim / skip / defer 全部寫進 _flow_state.json，服務重啟後 claim()
// 會先把回答者手上那張單還給他，不是從最舊的重來。

async function readFlowState() {
  try {
    const parsed = JSON.parse(await fsp.readFile(FLOW_STATE_PATH, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    console.warn('[escalation] _flow_state.json 讀不到，重建:', error.message);
    return {};
  }
}

async function writeFlowState(state) {
  await ensureDir();
  await fsp.writeFile(FLOW_STATE_PATH, JSON.stringify(state, null, 2), 'utf8');
}

function slotOf(state, responderId) {
  if (!state[responderId]) state[responderId] = { holding: null, skipped: {} };
  if (!state[responderId].skipped) state[responderId].skipped = {};
  return state[responderId];
}

async function claim(responderId) {
  const state = await readFlowState();
  const slot = slotOf(state, responderId);

  // 重啟後續接：手上那張還在 pending 就還給他
  if (slot.holding && slot.holding.id) {
    const held = await readTicket(slot.holding.id);
    if (held && held.status === 'pending') return held;
    slot.holding = null;
  }

  const now = Date.now();
  const candidates = (await listTickets('pending')).filter((t) => {
    const mark = slot.skipped[t.id];
    if (!mark) return true;
    return mark.remind_after ? new Date(mark.remind_after).getTime() <= now : false;
  });

  candidates.sort((a, b) => {
    const ua = a.urgency === 'urgent' ? 0 : 1;
    const ub = b.urgency === 'urgent' ? 0 : 1;
    return ua !== ub ? ua - ub : String(a.ts).localeCompare(String(b.ts));
  });

  const picked = candidates[0] || null;
  slot.holding = picked ? { id: picked.id, action: 'claimed', at: new Date().toISOString() } : null;
  await writeFlowState(state);
  return picked;
}

async function releaseHeld(responderId, action, hours) {
  const state = await readFlowState();
  const slot = slotOf(state, responderId);
  if (!slot.holding || !slot.holding.id) return null;

  const id = slot.holding.id;
  slot.skipped[id] = {
    action,
    at: new Date().toISOString(),
    remind_after: hours ? new Date(Date.now() + Number(hours) * 3600000).toISOString() : null
  };
  slot.holding = null;
  await writeFlowState(state);
  return { id, action, remind_after: slot.skipped[id].remind_after };
}

const skip = (responderId) => releaseHeld(responderId, 'skipped', null);
const defer = (responderId, hours) => releaseHeld(responderId, 'deferred', hours || 24);

// ── 收官：標記已解 + 推回提問者 + 寫 push 收據 ────────────────────────────
//
// 反模式「catch (e) { console.error(e) }」就結束是所有卡單的共同根因：
// 上層永遠拿不到「送到沒」。所以失敗一樣寫進 push_status，不吞掉。

async function resolve(id, answer, responderId, options) {
  const send = options && options.send === true;
  const ticket = await readTicket(id);
  if (!ticket) throw new Error(`ticket not found: ${id}`);

  ticket.status = 'resolved';
  ticket.answer = String(answer || '');
  ticket.resolved_at = new Date().toISOString();
  ticket.resolved_by = responderId || null;

  if (!send) {
    // 草稿先落磁碟，使用者端一個字都不會收到（手滑送出半句話是不可逆的）
    ticket.status = 'pending';
    ticket.push_status = 'draft_saved';
    return writeTicket(ticket);
  }

  try {
    await linePush(ticket.userId, ticket.answer);
    ticket.push_status = 'ok';
  } catch (error) {
    ticket.push_status = `failed: ${error.message}`.slice(0, 300);
  }
  return writeTicket(ticket);
}

// ── 主線唯一接點 ────────────────────────────────────────────────────────

async function maybeEscalate(ctx, reply) {
  if (!isEnabled()) return reply;   // ← opt-in：關閉時原樣返回，不讀檔不寫檔不發訊息

  try {
    if (!looksUnanswered(reply)) return reply;

    if (!ctx || !ctx.userId) {
      // 沒有 userId 就永遠推不回去，這同樣是異常而不是「沒事發生」
      await recordNotifyFailure({ id: '(none)', userId: '' }, 'missing_user_id');
      return reply;
    }

    const { ticket, isNew } = await openTicket(ctx.userId, ctx.text);
    if (isNew) await notifyResponders(ticket);

    const ack = process.env.ESCALATION_ACK_TEXT || '（已經幫你登記了，有答案會主動回你）';
    return ack ? `${reply}\n\n${ack}` : reply;
  } catch (error) {
    // 選配模組壞掉不得拖垮主線回覆
    console.error('[escalation] 開單流程失敗:', error.message);
    return reply;
  }
}

module.exports = {
  isEnabled,
  looksUnanswered,
  maybeEscalate,
  openTicket,
  notifyResponders,
  listTickets,
  listStale,
  remind,
  claim,
  skip,
  defer,
  resolve
};

// ── CLI ────────────────────────────────────────────────────────────────

async function main(argv) {
  try {
    require('dotenv').config();
  } catch (error) {
    // dotenv 沒裝就直接吃環境變數，不強制
  }

  const [command, ...rest] = argv;
  const send = rest.includes('--send');
  const args = rest.filter((a) => a !== '--send');
  const brief = (t) => ({
    id: t.id, urgency: t.urgency, age_days: Number(ageDays(t).toFixed(1)),
    follow_up_count: t.follow_up_count, asker: hashId(t.userId), question: t.question
  });

  switch (command) {
    case 'list':
      console.log(JSON.stringify((await listTickets('pending')).map(brief), null, 2));
      break;
    case 'stale':
      console.log(JSON.stringify((await listStale(args[0])).map(brief), null, 2));
      break;
    case 'remind':
      console.log(JSON.stringify(await remind(args[0], { send }), null, 2));
      if (!send) console.log('（以上為 dry-run。要真的推，加 --send）');
      break;
    case 'claim': {
      const picked = await claim(args[0]);
      console.log(picked ? JSON.stringify(brief(picked), null, 2) : '目前沒有待回覆的單');
      break;
    }
    case 'skip':
      console.log(JSON.stringify(await skip(args[0])));
      break;
    case 'defer':
      console.log(JSON.stringify(await defer(args[0], args[1])));
      break;
    case 'answer': {
      const done = await resolve(args[0], args[1], args[2] || 'cli', { send });
      console.log(JSON.stringify({ id: done.id, status: done.status, push_status: done.push_status }, null, 2));
      if (!send) console.log('（草稿已存，使用者端沒收到任何東西。確認無誤後加 --send 送出）');
      break;
    }
    default:
      // 用法直接取自本檔頂端註解，不用硬編行號（行號會隨改檔漂移）
      console.log(
        fs.readFileSync(__filename, 'utf8')
          .split('\n')
          .filter((line) => line.startsWith('//   node src/escalation.js'))
          .map((line) => line.replace(/^\/\/ {3}/, ''))
          .join('\n')
      );
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((error) => {
    console.error('escalation CLI 失敗:', error.message);
    process.exit(1);
  });
}
