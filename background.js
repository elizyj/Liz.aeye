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
        const { payload, mode = 'overview' } = msg; // 'overview' | 'fillables'
        const cacheKey = JSON.stringify({ u: payload?.url || '', t: payload?.title || '', mode, sig: payload?.cacheSig || 0 });
        const cached = summaryCache.get(cacheKey);
        if (cached && (Date.now() - cached.t) < 2 * 60 * 1000) {
          sendResponse({ ok: true, summary: cached.summary, cached: true });
          return;
        }
        const summary = await summarizeWithOpenAI(payload, mode);
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

async function summarizeWithOpenAI(payload, mode = 'overview') {
  const apiKey = await getOpenAIKey();
  if (!apiKey) throw new Error('Missing OpenAI API key in storage');

  const {
    url, title, headings = [], landmarks = [], interactiveCounts = {}, text = '',
    // New for fillables
    fillableLabels = [],
    fillableContext = null,
  } = payload;

  const chunks = chunkText(text);

  const SYSTEMS = {
    overview: `You are an accessibility assistant producing a neutral overview for low-vision users.
- Summarize the page content in 3–6 concise sentences.
- Do not give instructions or checklists.
- Avoid brand hype; stay factual and plain-language.`,

    // Natural, labels-only, context-aware list (no types or required flags)
    fillables: `You are an accessibility assistant helping a low-vision user understand what the page asks them to fill.
- Rewrite the provided field labels into a numbered list (1., 2., 3., ...).
- Make each item short, natural, and contextual: add generic prepositions using page context (e.g., "Dates of travel", "Number of travelers", "Shipping address").
- DO NOT include field types, "required/optional", examples, or extra steps.
- Keep between 3 and 12 bullets when possible; preserve perceived importance (location/search terms first, then dates/times, then counts/people, then options).
- Output ONLY the numbered list, no preface or epilogue.`
  };

  const system = SYSTEMS[mode] || SYSTEMS.overview;

  const meta = [
    `URL: ${url}`,
    `Title: ${title || '(none)'}`,
    headings.length ? `Top headings: ${headings.join(' | ')}` : '',
    `Interactive: inputs=${interactiveCounts.inputs||0}, buttons=${interactiveCounts.buttons||0}, links=${interactiveCounts.links||0}`,
    landmarks.length ? `Landmarks: ${landmarks.join(', ')}` : ''
  ].filter(Boolean).join('\n');

  const messages = [{ role: 'system', content: system }, { role: 'user', content: meta }];

  if (mode === 'overview') {
    chunks.forEach((c, i) => messages.push({ role: 'user', content: `CONTENT CHUNK ${i+1}/${chunks.length}:\n${c}` }));
  } else if (mode === 'fillables') {
    const labelBlock = (fillableLabels || []).slice(0, 100).map((l, i) => `${i + 1}. ${l || 'Unlabeled'}`).join('\n');
    messages.push({ role: 'user', content: `FIELD LABELS:\n${labelBlock}` });

    if (fillableContext) {
      messages.push({
        role: 'user',
        content:
`PAGE CONTEXT:
Title: ${fillableContext.title || '(none)'}
Headings: ${Array.isArray(fillableContext.headings) ? fillableContext.headings.join(' | ') : ''}
URL hints: ${fillableContext.urlHints || ''}
Global hints: ${fillableContext.globalKeywords || ''}

PER-FIELD HINTS (labels, placeholders, surrounding phrases):
${(fillableContext.fields || []).slice(0, 50).map((f, i) => {
  const hints = [
    f.label && `label="${f.label}"`,
    f.placeholder && `placeholder="${f.placeholder}"`,
    f.name && `name="${f.name}"`,
    f.ariaLabel && `aria="${f.ariaLabel}"`,
    f.group && `group="${f.group}"`,
    f.nearby && `nearby="${f.nearby}"`,
  ].filter(Boolean).join(', ');
  return `#${i+1}: ${hints}`;
}).join('\n')}
`
      });
    }
  }

  const resp = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'gpt-4o-mini', temperature: 0.2, max_tokens: 350, messages })
  });

  if (!resp.ok) {
    const txt = await resp.text().catch(() => '');
    throw new Error(`OpenAI ${resp.status}: ${txt.slice(0, 500)}`);
  }

  const data = await resp.json();
  const summary = data?.choices?.[0]?.message?.content?.trim();
  if (!summary) throw new Error('Empty summary from model');
  return summary;
}
