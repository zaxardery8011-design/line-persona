require('dotenv').config();

const fs = require('fs/promises');
const path = require('path');
const express = require('express');
const line = require('@line/bot-sdk');
const { handleMessage } = require('./brain');
const { loadPersona } = require('./persona');

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

app.get('/', (_req, res) => {
  res.status(200).send('line-persona is running');
});

app.post('/webhook', lineMiddleware(), async (req, res) => {
  try {
    const results = await Promise.all(req.body.events.map(handleEvent));
    res.status(200).json(results);
  } catch (error) {
    console.error('Webhook handling failed:', error);
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
  if (event.source && event.source.groupId) {
    await rememberGroupId(event.source.groupId);
  }

  if (event.type !== 'message') {
    return null;
  }

  if (event.message.type !== 'text') {
    // Future hook: download and process image/file/audio content here.
    return replyText(event.replyToken, '目前只處理文字訊息');
  }

  const text = event.message.text || '';
  const reply = await handleMessage({
    text,
    userId: event.source && event.source.userId,
    source: event.source,
    persona
  });

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

app.listen(port, () => {
  console.log(`line-persona listening on http://localhost:${port}`);
});
