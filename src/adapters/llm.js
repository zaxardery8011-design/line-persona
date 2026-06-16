async function chat(messages) {
  const baseUrl = trimTrailingSlash(process.env.LLM_BASE_URL || '');
  const apiKey = process.env.LLM_API_KEY || '';
  const model = process.env.LLM_MODEL || '';

  if (!baseUrl || !model) {
    return 'LLM 尚未設定完成，請先在 .env 填入 LLM_BASE_URL 與 LLM_MODEL。';
  }

  const headers = {
    'Content-Type': 'application/json'
  };

  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model,
      messages,
      temperature: 0.7
    })
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`LLM request failed with ${response.status}: ${body.slice(0, 500)}`);
  }

  const data = await response.json();
  const content = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;

  return content && content.trim() ? content.trim() : '我目前沒有產生可用回覆。';
}

function trimTrailingSlash(value) {
  return value.replace(/\/+$/, '');
}

module.exports = {
  chat
};

