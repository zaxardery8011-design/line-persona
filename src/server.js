require('dotenv').config();

const fs = require('fs/promises');
const path = require('path');
const express = require('express');
const line = require('@line/bot-sdk');
const { handleMessage } = require('./brain');
const { loadPersona } = require('./persona');
const groupFeed = require('./group');
const history = require('./history');
const { escalateMedia, isEnabled: escalationOn, listTickets } = require('./escalation');
const { bodySizeLimit, createUserRateLimiter, loadLimitsConfig } = require('./limits');

// 私訊收到這幾種，分身看不到內容（不下載）：轉真人開著就開單，沒開就請對方改用文字
const MEDIA_LABELS = { image: '圖片', video: '影片', audio: '語音', file: '檔案' };
// 回覆前最多等 loading 動畫請求這麼久（見 handleEvent）
const LOADING_WAIT_MS = 500;
// 「忘了我」先回這句，等對方確認（秒數與確認詞跟 group.js 的 FORGET_CONFIRM_* 一致）
const FORGET_ASK = '要刪掉這個帳號存的你的訊息嗎？刪了就救不回來，所以請你本人在 60 秒內、在這裡回「確定」，我才會刪；沒回就當取消，什麼都不刪。';
// 最近幾次「確定」刪完回的那句，LINE 重送同一則「確定」時照原樣再回（見 handleEvent）；最多記這麼多筆，只放記憶體
const FORGET_ANSWER_MEMORY = 100;
const forgetAnswers = new Map();

const port = Number(process.env.PORT || 3000);
const lineConfig = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN || '',
  channelSecret: process.env.LINE_CHANNEL_SECRET || ''
};

if (!lineConfig.channelAccessToken || !lineConfig.channelSecret) {
  console.warn('LINE_CHANNEL_ACCESS_TOKEN or LINE_CHANNEL_SECRET is not set. Fill .env before using /webhook.');
}

const client = new line.messagingApi.MessagingApiClient({
  channelAccessToken: lineConfig.channelAccessToken
});

const app = express();
const persona = loadPersona();
const limits = loadLimitsConfig();
const userLimiter = createUserRateLimiter({
  max: limits.rateLimitMax,
  windowMs: limits.rateLimitWindowMs
});
const loadingSeconds = loadLoadingSeconds();

app.get('/', (_req, res) => {
  res.status(200).send('line-persona is running');
});

app.post('/webhook', bodySizeLimit(limits.maxBodyBytes), lineMiddleware(), async (req, res) => {
  try {
    const results = await Promise.all(req.body.events.map(handleEvent));
    res.status(200).json(results);
  } catch (error) {
    console.error('Webhook handling failed:', error.message);
    res.status(500).end();
  }
});

function lineMiddleware() {
  if (!lineConfig.channelSecret) {
    return (_req, res) => {
      res.status(503).json({
        error: 'LINE_CHANNEL_SECRET is not configured'
      });
    };
  }

  return line.middleware(lineConfig);
}

async function handleEvent(event) {
  const userId = event.source && event.source.userId;
  if (event.type === 'message' && !userLimiter.allow(userId)) {
    // 超量：不進 LLM、不回覆，避免同一個使用者刷爆花費
    console.warn(`Rate limited userId=${userId}`);
    return null;
  }

  // 「忘了我」（GROUP_COLLECT=1 或有設 GROUP_FORGET_WORDS 才攔）：排在群組收集與 silent／mention 之前，
  // silent 也回話；私訊也能下。上面的限流照樣算。刪了救不回來，所以分兩步：指令先不刪、問一次，
  // 同一人 60 秒內在同一聊天回「確定」（要比指令晚送出）才刪（見 group.js 的 askForgetConfirm）。指令和那句「確定」都不落檔。
  if (event.type === 'message' && event.message && event.message.type === 'text') {
    const word = groupFeed.takeForgetConfirm(event.source, event.message.text, event.timestamp);
    if (word) {
      const answer = await forgetMe(userId, event.timestamp, word);
      rememberForgetAnswer(event, answer);
      return replyText(event.replyToken, answer);
    }
    // 刪完了、回覆卻沒送到（reply API 失敗，webhook 回 500）時，LINE 會帶原本的 timestamp 重送同一則「確定」。
    // 那時待確認已經用掉，不攔的話它會被當一般訊息送進模型。同一則（同一人、同一個 message id、同一毫秒）就照原樣再回一次刪除結果。
    const answered = forgetAnswers.get(forgetAnswerKey(event));
    if (answered) {
      return replyText(event.replyToken, answered);
    }
    if (groupFeed.isForgetCommand(event.message.text)) {
      if (!userId) {
        return replyText(event.replyToken, '我這邊拿不到你的 LINE 身分，找不出哪些是你的訊息，所以什麼都沒刪。');
      }
      // 確認話術真的送出去了才記待確認：沒有 replyToken（回不了話）或回覆失敗（throw，webhook 回 500）時
      // 對方根本沒看到「請回確定」，之後順口一句「確定」不能算數。
      if (!event.replyToken) {
        return null;
      }
      // LINE 重送來的指令：第一次沒處理成功（多半是確認話術沒送到）。這時才問，等的起點就比對方實際看到話術晚，
      // 他在這之間（還沒看到話術時）說的「確定」也可能排在後面重送，比指令晚送出、又在等的時窗內，會被當成確認。
      // 所以重送的指令一律不記待確認，請他再傳一次；第一次就處理成功時記下的那筆（如果有）不動。
      if (event.deliveryContext && event.deliveryContext.isRedelivery) {
        const said = String(event.message.text).trim();
        return replyText(event.replyToken, `這句「${said}」是 LINE 補送的，我沒辦法確定你看過要你回「確定」的那句話，所以這次不算，什麼都沒刪。要刪的話請再傳一次「${said}」。`);
      }
      const sent = await replyText(event.replyToken, FORGET_ASK);
      groupFeed.askForgetConfirm(event.source, event.message.text, event.timestamp, event.message.id);
      return sent;
    }
  }

  // 收回／編輯過的訊息（私訊、群組都算）：那一輪從多輪記憶拿掉，不然之後每一輪都還會送給模型。
  // HISTORY_TURNS 沒開時什麼都不做；群組收集檔裡的那一行另外由 group.js 遮蔽。
  if (event.type === 'unsend' || event.type === 'messageEdited') {
    history.forgetMessage(event.type === 'unsend' ? event.unsend && event.unsend.messageId : event.message && event.message.id);
  }
  // 收回了自己下的「忘了我」＝反悔：還在等「確定」的那筆拿掉，之後的「確定」照一般訊息處理（見 group.js 的 cancelForgetConfirm）
  if (event.type === 'unsend') {
    groupFeed.cancelForgetConfirm(event.source, event.unsend && event.unsend.messageId);
  }

  if (event.source && event.source.groupId) {
    await rememberGroupId(event.source.groupId);

    // 選配：群組發話政策 / 素材收集（src/group.js）。相關環境變數全空時不會進來。
    if (groupFeed.enabled() && await groupFeed.handleGroupEvent(event, {
      persona,
      channelAccessToken: lineConfig.channelAccessToken
    })) {
      return null;
    }
  }

  if (event.type !== 'message') {
    return null;
  }

  if (event.message.type !== 'text') {
    const label = MEDIA_LABELS[event.message.type];
    if (label && event.source && event.source.type === 'user') {
      // Future hook: download and process image/file/audio content here.
      const handedOff = await escalateMedia(
        { userId: event.source.userId, text: `[使用者傳了${label}]` },
        `我這邊看不到${label}的內容，已經幫你轉給真人。`
      );
      return replyText(event.replyToken, handedOff || `我這邊看不到${label}的內容，請改用文字描述。`);
    }
    // 貼圖、位置等，以及群組／多人聊天室裡的任何非文字：照舊，不開單
    return replyText(event.replyToken, '目前只處理文字訊息');
  }

  // 只在 1:1 私訊、會回覆時才秀動畫（限流、群組政策不回、非文字訊息在上面就 return 了）
  const loading = loadingSeconds > 0 && event.replyToken && event.source && event.source.type === 'user' && event.source.userId
    ? showLoading(event.source.userId)
    : null;

  const text = event.message.text || '';
  const reply = await handleMessage({
    text,
    userId: event.source && event.source.userId,
    timestamp: event.timestamp,
    messageId: event.message.id,
    source: event.source,
    persona
  });

  // 大腦秒回時（清除詞、LLM 沒設好或馬上失敗），回覆可能比動畫請求先到 LINE，動畫就會在回覆之後才開始轉。
  // 所以回覆前先等動畫請求有回應，最多 LOADING_WAIT_MS；LINE 一直不回也照樣回覆。平常 LLM 要好幾秒，早就回應了，不會多等。
  if (loading) {
    await atMost(loading, LOADING_WAIT_MS);
  }

  return replyText(event.replyToken, reply);
}

async function replyText(replyToken, text) {
  if (!replyToken) {
    return null;
  }

  return client.replyMessage({
    replyToken,
    messages: [
      {
        type: 'text',
        text: String(text).slice(0, 5000)
      }
    ]
  });
}

// 刪掉群組收集檔（data/inbox/）裡這個人的每一行與媒體檔、清掉他在多輪記憶裡說過的話，照實回刪了幾則。
// 刪不到的副本一條條講明：LINE 聊天室本身；absorb.js 印給人（或 AI 助理）讀過的新料、抄進 persona/ 的內容；
// 送去 LLM 服務產生回覆的內容；轉真人的單（data/escalations/）是客服紀錄，不動。
// 只在對方回了「確定」之後呼叫（userId 一定有）；timestamp 是那句「確定」的 LINE timestamp，word 是他當初打的指令詞。
async function forgetMe(userId, timestamp, word) {
  const { removed, failed } = await groupFeed.forgetUser(userId, timestamp);
  history.forgetUser(userId, timestamp);

  const parts = [];
  if (failed) {
    parts.push(`群組收集檔裡你的訊息這次沒有全部刪完（已刪 ${removed} 則），請稍後再傳一次「${word}」，再回「確定」。`);
  } else if (removed) {
    parts.push(`好，群組收集檔裡你的 ${removed} 則訊息已經刪掉了（附帶的圖片、檔案一起刪）。`);
  } else {
    parts.push('好，群組收集檔裡沒有你的訊息，沒有要刪的。');
  }
  if (history.enabled()) {
    parts.push('對話記憶裡你說過的話也清掉了。');
  }

  const kept = [
    'LINE 聊天室裡的訊息本身不受影響',
    '管理者（或幫他整理資料的 AI 助理）先前已經讀過、或已經整理進分身知識庫的內容，是另外抄過去的，刪不到',
    '已經送給 AI 模型服務來產生回覆的內容，那邊的紀錄這裡也管不到'
  ];
  if (escalationOn() || await hasHandoffTicket(userId)) {
    kept.push('轉真人的客服紀錄也會留著');
  }
  return `${parts.join('')}\n\n先說清楚，這個指令只刪這個帳號自己存的副本：${kept.join('；')}。需要的話請直接聯絡這個帳號的管理者。`;
}

// 記下這則「確定」刪完回的那句，LINE 重送同一則時照原樣再回（見 handleEvent）。超過 FORGET_ANSWER_MEMORY 筆就丟最舊的。
function rememberForgetAnswer(event, answer) {
  forgetAnswers.set(forgetAnswerKey(event), answer);
  if (forgetAnswers.size > FORGET_ANSWER_MEMORY) {
    forgetAnswers.delete(forgetAnswers.keys().next().value);
  }
}

// 重送的事件跟第一次是同一則：userId、message id、LINE timestamp 都不變
function forgetAnswerKey(event) {
  return `${event.source && event.source.userId}|${event.message.id}|${event.timestamp}`;
}

// 轉真人關掉之後，舊單照樣留在 data/escalations/（存的是原始 userId），所以也要查磁碟。讀不到就當有（寧可多講一句）。
async function hasHandoffTicket(userId) {
  try {
    return (await listTickets()).some((ticket) => ticket.userId === userId);
  } catch (error) {
    console.warn('Could not check handoff tickets:', error.message);
    return true;
  }
}

// 1:1 私訊等大腦時，讓對方看到「輸入中」動畫（LINE 只支援一對一，群組帶 ID 會 400）。
// 這裡不 await：先發出去就去叫 LLM；失敗只記 warn，回覆照常；送出回覆時動畫會自己消失。
// 回傳的 promise 只給回覆前那段短暫等待用（見 handleEvent），它不會 reject。
function showLoading(chatId) {
  return client.showLoadingAnimation({ chatId, loadingSeconds })
    .catch((error) => console.warn('Loading animation failed:', error.message));
}

// 等 promise 最多 ms 毫秒：先到的那個放行，計時器一定清掉。
function atMost(promise, ms) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(resolve, ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// LINE_LOADING_SECONDS：空＝20；0 或負數＝關；其他夾到 LINE 接受的 5～60、5 的倍數（往上取）。
function loadLoadingSeconds() {
  const raw = process.env.LINE_LOADING_SECONDS;
  const n = raw === undefined || raw === '' ? 20 : Number(raw);
  if (!Number.isFinite(n)) return 20;
  if (n <= 0) return 0;
  return Math.min(60, Math.max(5, Math.ceil(n / 5) * 5));
}

async function rememberGroupId(groupId) {
  const dataDir = path.join(__dirname, '..', 'data');
  const groupsPath = path.join(dataDir, 'groups.json');

  await fs.mkdir(dataDir, { recursive: true });

  let groups = [];
  try {
    groups = JSON.parse(await fs.readFile(groupsPath, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.warn('Could not read data/groups.json, recreating it:', error.message);
    }
  }

  if (!Array.isArray(groups)) {
    groups = [];
  }

  if (!groups.includes(groupId)) {
    groups.push(groupId);
    await fs.writeFile(groupsPath, JSON.stringify(groups, null, 2), 'utf8');
  }
}

// Only listen when started directly (npm start); tests require() the app instead.
if (require.main === module) {
  app.listen(port, () => {
    console.log(`line-persona listening on http://localhost:${port}`);
  });
}

module.exports = { app };
