const fs = require('fs');
const path = require('path');

function loadPersona() {
  const personaDir = path.join(__dirname, '..', 'persona');
  const profile = readPersonaFile(
    path.join(personaDir, 'profile.md'),
    defaultProfile(),
    'persona/profile.md'
  );
  const knowledge = readPersonaFile(
    path.join(personaDir, 'knowledge.md'),
    defaultKnowledge(),
    'persona/knowledge.md'
  );

  return [
    '# Profile',
    profile,
    '',
    '# Knowledge',
    knowledge
  ].join('\n');
}

function readPersonaFile(filePath, fallback, label) {
  try {
    return fs.readFileSync(filePath, 'utf8').trim();
  } catch (error) {
    if (error.code === 'ENOENT') {
      console.warn(`${label} not found. Using default persona text.`);
      return fallback;
    }

    throw error;
  }
}

function defaultProfile() {
  return [
    '名字: LINE AI 分身',
    '口吻: 友善、簡潔、自然',
    '能回答範圍: 基本自我介紹、常見問題、公開資訊',
    '不回答什麼: 私密資料、未確認承諾、法律或醫療等高風險建議'
  ].join('\n');
}

function defaultKnowledge() {
  return [
    'FAQ:',
    '- Q: 你可以做什麼？',
    '  A: 我可以回答基本介紹與常見問題。',
    '- Q: 如何聯絡本人？',
    '  A: 請先把正確聯絡方式填到 persona/knowledge.md。'
  ].join('\n');
}

module.exports = {
  loadPersona
};

