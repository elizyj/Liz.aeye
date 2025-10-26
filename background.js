// background.js — service worker: keyboard shortcut, LLM summarization

chrome.runtime.onInstalled.addListener(() => {
  console.log('Accessibility Assistant installed');
});

// Ping helper (NO programmatic injection here)
async function pingContent(tabId, attempts = 10, delayMs = 120) {
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await chrome.tabs.sendMessage(tabId, { type: 'ping' });
      if (res?.pong) return true;
    } catch {}
    await new Promise(r => setTimeout(r, delayMs));
  }
  return false;
}

// Keyboard shortcut: open popup & start assistant
chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'start-assistant') return;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.id) return;

    const ready = await pingContent(tab.id);
    if (!ready) {
      console.warn('[AA] Content script not reachable. Refresh the page. If file://, enable “Allow access to file URLs”.');
      return;
    }

    await chrome.tabs.sendMessage(tab.id, { action: 'startAssistant' });
    chrome.action.openPopup();
  } catch (err) {
    console.error('Shortcut start error:', err);
  }
});

// ====== LLM Summarization Pipeline ======

const summaryCache = new Map(); // { key: { summary, t } }

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === 'summarizePage') {
    (async () => {
      try {
        const { payload } = msg;
        const cacheKey = (payload?.url || '') + '|' + (payload?.title || '');
        const cached = summaryCache.get(cacheKey);
        if (cached && (Date.now() - cached.t) < 2 * 60 * 1000) {
          sendResponse({ ok: true, summary: cached.summary, cached: true });
          return;
        }

        const summary = await summarizeWithOpenAI(payload);
        summaryCache.set(cacheKey, { summary, t: Date.now() });
        sendResponse({ ok: true, summary });
      } catch (e) {
        console.error('summarizePage error:', e);
        sendResponse({ ok: false, error: String(e?.message || e) });
      }
    })();
    return true; // async
  }
});

async function getOpenAIKey() {
  return new Promise((resolve) => {
    chrome.storage.local.get(['OPENAI_API_KEY'], (res) => {
      console.log('[AA] OPENAI_API_KEY present?', !!res.OPENAI_API_KEY);
      resolve(res.OPENAI_API_KEY || '');
    });
  });
}

// Keep inputs small to avoid 400/413s
function chunkText(str, chunkSize = 3500, maxChunks = 4) {
  const chunks = [];
  for (let i = 0; i < str.length; i += chunkSize) {
    chunks.push(str.slice(i, i + chunkSize));
  }
  return chunks.slice(0, maxChunks);
}

async function summarizeWithOpenAI(payload) {
  const apiKey = await getOpenAIKey();
  if (!apiKey) throw new Error('Missing OpenAI API key in storage');

  const { url, title, headings = [], landmarks = [], interactiveCounts = {}, text = '' } = payload;
  const chunks = chunkText(text);

  const system = `You are an accessibility assistant summarizing web pages for low-vision users.
- Be concise and action-oriented.
- Focus on what the user can do here (primary tasks, search, filters, forms, pickers).
- Prefer 4–8 bullet points; short lines.
- If there are inputs/pickers, list what needs to be filled/selected.
- Avoid brand fluff; maximize task clarity.`;

  const meta = [
    `URL: ${url}`,
    `Title: ${title || '(none)'}`,
    headings.length ? `Top headings: ${headings.join(' | ')}` : '',
    `Interactive: inputs=${interactiveCounts.inputs||0}, buttons=${interactiveCounts.buttons||0}, links=${interactiveCounts.links||0}`,
    landmarks.length ? `Landmarks: ${landmarks.join(', ')}` : ''
  ].filter(Boolean).join('\n');

  const messages = [
    { role: 'system', content: system },
    { role: 'user', content: meta }
  ];

  chunks.forEach((c, i) => {
    messages.push({ role: 'user', content: `CONTENT CHUNK ${i+1}/${chunks.length}:\n${c}` });
  });

  const resp = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      temperature: 0.2,
      max_tokens: 350,
      messages
    })
  });

  if (!resp.ok) {
    const txt = await resp.text().catch(() => '');
    console.error('[AA] OpenAI error body:', txt);
    throw new Error(`OpenAI ${resp.status}: ${txt.slice(0, 500)}`);
  }

  const data = await resp.json();
  const summary = data?.choices?.[0]?.message?.content?.trim();
  if (!summary) throw new Error('Empty summary from model');
  return summary;
}
