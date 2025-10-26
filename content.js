// content.js — LLM summary + generic fillable detector (deep: shadow DOM + iframes)

// ===== Idempotency guard (prevents “already been declared”) =====
if (window.__AA_LOADED__) {
  // If this frame already has our assistant, answer pings and exit.
  chrome.runtime?.onMessage?.addListener?.((m, s, send) => {
    if (m?.type === 'ping') { send?.({ pong: true }); return true; }
    return false;
  });
} else {
  window.__AA_LOADED__ = true;
  console.log('[AA] content.js LOADED — top frame?', window.top === window, 'url:', location.href);


  class AccessibilityAssistant {
    constructor() {
      this.isActive = false;
      this.speechRecognition = null;
      this.speechSynthesis = window.speechSynthesis;

      this.formFields = [];
      this.currentFieldIndex = 0;
      this.selectedFields = [];

      this.settings = { volume: 0.8, speechRate: 1.0 };
      this._listenersBound = false;

      this.init();
    }

    init() {
      chrome.storage.local.get(['volume', 'speechRate'], (result) => {
        this.settings = { ...this.settings, ...result };
      });

      if (!this._listenersBound) {
        chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
          // Always respond to pings
          if (message?.type === 'ping') { sendResponse?.({ pong: true }); return true; }

          if (typeof message?.action === 'string') {
            if (message.action === 'startAssistant') {
              if (window.top === window) {
                if (!this.isActive) this.startAssistant();
                sendResponse?.({ success: true });
              } else {
                sendResponse?.({ success: false, reason: 'not top frame' });
              }
              return true;
            }
            if (message.action === 'stopAssistant') {
              if (window.top === window) this.stopAssistant();
              sendResponse?.({ success: true });
              return true;
            }
          }
          return false;
        });
        this._listenersBound = true;
      }

      console.log('[AA] content.js loaded in frame. Top frame?', window.top === window);
    }

    // ===== Life cycle =====
    startAssistant() {
      this.isActive = true;
      this.updateStatus('Assistant started. Analyzing page...');
      setTimeout(() => {
        if (!this.isActive) return;
        this.analyzePage();
      }, 250);
    }

    stopAssistant() {
      this.isActive = false;
      this.stopSpeechRecognition();
      this.stopSpeechSynthesis();
      this.updateStatus('Assistant stopped');
    }

    analyzePage() {
      this.updateStatus('Scanning for interactive elements...');
      this.formFields = this.findFillables();
      this.speak('Welcome to the Accessibility Assistant. I can summarize the page or help fill blanks. Say "summary" or "fill the form".');
      this.startSpeechRecognition();
    }

    // ===== Summarization =====
    async provideSummaryLLM() {
      this.updateStatus('Preparing summary...');
      try {
        const payload = this.collectSummarizationPayload();
        const result = await chrome.runtime.sendMessage({ type: 'summarizePage', payload });
        if (result?.ok && result.summary) {
          this.speak(result.summary);
        } else {
          if (result?.error) {
            console.warn('LLM summary error:', result.error);
            this.updateStatus('LLM summary error: ' + result.error);
          }
          this.speak(this.heuristicSummary(payload));
        }
      } catch (err) {
        console.error('Summary error:', err);
        this.speak(this.heuristicSummary(this.collectSummarizationPayload()));
      }
    }

    collectSummarizationPayload() {
      const title = document.title || '';
      const url = location.href;

      const main = document.querySelector('main, [role="main"], article') || document.body;
      const text = this.extractVisibleText(main);

      const headings = Array.from(document.querySelectorAll('h1,h2,h3'))
        .slice(0, 12)
        .map(h => h.textContent.trim())
        .filter(Boolean);

      const interactiveCounts = {
        inputs: document.querySelectorAll('input, textarea, select, [role="textbox"], [role="combobox"]').length,
        buttons: document.querySelectorAll('button, [role="button"]').length,
        links: document.querySelectorAll('a[href]').length
      };

      const landmarks = Array.from(document.querySelectorAll('[role="navigation"], nav, [role="search"], [role="form"], form'))
        .slice(0, 6)
        .map(el => (el.getAttribute('aria-label') || el.getAttribute('name') || el.tagName).toLowerCase());

      return { url, title, headings, interactiveCounts, landmarks, text };
    }

    extractVisibleText(root) {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
        acceptNode: (node) => {
          const t = node.textContent;
          if (!t || !t.trim()) return NodeFilter.FILTER_REJECT;
          const el = node.parentElement;
          if (!el) return NodeFilter.FILTER_REJECT;
          const style = window.getComputedStyle(el);
          if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return NodeFilter.FILTER_REJECT;
          const tag = el.tagName;
          if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT') return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        }
      });
      const parts = [];
      while (walker.nextNode()) {
        parts.push(walker.currentNode.textContent.replace(/\s+/g, ' ').trim());
      }
      return parts.join('\n').replace(/\n{3,}/g, '\n\n').slice(0, 200000);
    }

    heuristicSummary(payload) {
      const { title, headings, interactiveCounts, text } = payload;
      const words = (text || '').split(/\s+/).filter(Boolean).length;
      return [
        `Page title: ${title || 'Untitled'}.`,
        headings?.length ? `Top headings: ${headings.slice(0,5).join(' · ')}.` : '',
        `Interactive: ${interactiveCounts.inputs} fields, ${interactiveCounts.buttons} buttons, ${interactiveCounts.links} links.`,
        `Approximate length: ${words} words.`,
        `Say "fill the form" to hear the blanks I found.`
      ].filter(Boolean).join(' ');
    }

    // ===== Deep DOM helpers (shadow DOM + same-origin iframes) =====
    getCandidateRoots() {
      const roots = [document];
      document.querySelectorAll('iframe').forEach((ifr) => {
        try {
          const doc = ifr.contentDocument;
          if (doc) roots.push(doc);
        } catch {}
      });
      return roots;
    }

    *iterAllElementsDeep(root) {
  // Non-recursive traversal that works for Document + ShadowRoot
  const stack = [root];
  while (stack.length) {
    const r = stack.pop();

    // createTreeWalker is on Document, not ShadowRoot/DocumentFragment
    const doc = (r && r.ownerDocument) ? r.ownerDocument
              : (r && r.nodeType === 9) ? r       // if r is a Document
              : document;

    let tw;
    try {
      // filter=null, entityReferenceExpansion=false (ignored)
      tw = doc.createTreeWalker(r, NodeFilter.SHOW_ELEMENT, null);
    } catch (e) {
      // Some nodes (e.g., detached or special fragments) can throw; skip them
      continue;
    }

    let n = tw.nextNode();
    while (n) {
      yield n;
      // Dive into shadow DOMs
      if (n.shadowRoot) stack.push(n.shadowRoot);
      n = tw.nextNode();
    }
  }
}

deepQueryAll(rootNode, selector) {
  const out = [];
  for (const el of this.iterAllElementsDeep(rootNode)) {
    try {
      if (el.matches && el.matches(selector)) out.push(el);
    } catch {
      // Some elements can throw on matches due to parsing quirks—ignore
    }
  }
  return out;
}

    // ===== Fillable detection =====
    findFillables() {
      const fields = [];

      const isVisible = (el) => {
        if (!el || !el.isConnected) return false;
        const cs = getComputedStyle(el);
        if (cs.visibility === 'hidden' || cs.display === 'none' || cs.opacity === '0') return false;
        return true;
      };

      const getLabel = (el) => {
        const doc = el.ownerDocument || document;
        if (el.id) {
          try {
            const lbl = doc.querySelector(`label[for="${CSS.escape(el.id)}"]`);
            if (lbl?.textContent) return lbl.textContent.trim();
          } catch {
            const lbl = doc.querySelector(`label[for="${el.id}"]`);
            if (lbl?.textContent) return lbl.textContent.trim();
          }
        }
        const lbIds = el.getAttribute?.('aria-labelledby');
        if (lbIds) {
          const txt = lbIds.split(/\s+/).map(id => doc.getElementById(id)?.textContent?.trim()).filter(Boolean).join(' ');
          if (txt) return txt;
        }
        const aria = el.getAttribute?.('aria-label');
        if (aria) return aria.trim();
        if (el.placeholder) return el.placeholder.trim();
        const fieldset = el.closest?.('fieldset');
        const legend = fieldset?.querySelector?.('legend');
        if (legend?.textContent) return legend.textContent.trim();

        const prev = el.closest?.('[role="group"], .field, .form-group, .input, .form-item') || el.parentElement;
        if (prev) {
          const maybe = prev.querySelector?.('label, [data-label], [aria-label]');
          const t = maybe?.textContent || maybe?.getAttribute?.('data-label') || maybe?.getAttribute?.('aria-label');
          if (t) return String(t).trim();
        }

        if (el.name) return el.name.replace(/[-_]/g, ' ').trim();
        return 'Unlabeled field';
      };

      const push = (el, kind, roleKind = null, extra = {}) => {
        if (!isVisible(el) || el.disabled) return;
        fields.push({
          element: el,
          kind,
          roleKind,
          label: getLabel(el),
          required: !!el.required || el.getAttribute?.('aria-required') === 'true',
          placeholder: el.placeholder || '',
          name: el.name || el.id || '',
          meta: extra
        });
      };

      const roots = this.getCandidateRoots();
      const collect = (sel) => roots.flatMap((r) => this.deepQueryAll(r, sel));

      // Native inputs
      collect('input').forEach((el) => {
        const t = (el.type || 'text').toLowerCase();
        const supported = ['text','email','password','tel','url','search','number','date','time','datetime-local','month','week'];
        if (supported.includes(t)) push(el, t === 'datetime-local' ? 'datetime' : t);
        if (t === 'checkbox') push(el, 'checkbox');
        if (t === 'radio') push(el, 'radio');
      });

      collect('textarea').forEach((el) => push(el, 'textarea'));
      collect('select').forEach((el) => push(el, 'select'));
      collect('[contenteditable=""], [contenteditable="true"]').forEach((el) => push(el, 'contenteditable'));

      // Role widgets
      collect('[role="textbox"]').forEach((el) => push(el, 'text', 'textbox'));
      collect('[role="combobox"]').forEach((el) => push(el, 'combobox', 'combobox'));
      collect('[role="spinbutton"]').forEach((el) => push(el, 'spinbutton', 'spinbutton'));
      collect('[role="slider"]').forEach((el) => push(el, 'slider', 'slider'));
      collect('[role="searchbox"]').forEach((el) => push(el, 'text', 'searchbox'));
      collect('[role="listbox"][aria-labelledby]').forEach((el) => push(el, 'pickerButton', 'listbox'));

      // Buttons that open pickers
      collect('button, [role="button"], [tabindex]').forEach((el) => {
        if (!isVisible(el)) return;
        const hasPopup = el.getAttribute('aria-haspopup');
        const expanded = el.getAttribute('aria-expanded');
        const controls = el.getAttribute('aria-controls');
        const tabbable = el.hasAttribute('tabindex');
        const isButtony = el.tagName === 'BUTTON' || el.getAttribute('role') === 'button' || tabbable;
        if (isButtony && (hasPopup || expanded || controls)) {
          push(el, 'pickerButton', 'button', {
            hasPopup: !!hasPopup,
            expanded: expanded === 'true',
            controls: controls || null
          });
        }
      });

      // De-dupe
      const seen = new Set();
      const unique = [];
      for (const f of fields) {
        if (!f.element || seen.has(f.element)) continue;
        seen.add(f.element);
        unique.push(f);
      }
      return unique;
    }

    // ===== Voice flow =====
    startSpeechRecognition() {
      const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
      if (!SpeechRecognition) { this.speak('Speech recognition is not supported in this browser.'); return; }

      if (this.speechRecognition) { try { this.speechRecognition.stop(); } catch {} this.speechRecognition = null; }
      const rec = new SpeechRecognition();
      rec.continuous = false;
      rec.interimResults = false;
      rec.lang = 'en-US';

      rec.onresult = (event) => {
        try {
          const t = event?.results?.[0]?.[0]?.transcript || '';
          const text = String(t).toLowerCase().trim();
          if (!text) this.speak('Sorry, I didn’t catch that. Please try again.');
          else this.handleUserInput(text);
        } catch {
          this.speak('Sorry, I didn’t catch that. Please try again.');
        }
      };

      rec.onerror = () => { if (this.isActive) this.speak('Sorry, I didn’t catch that. Please try again.'); };
      rec.onend = () => { if (this.isActive) setTimeout(() => this.startSpeechRecognition(), 200); };
      this.speechRecognition = rec;
      try { rec.start(); } catch {}
    }

    stopSpeechRecognition() { if (this.speechRecognition) { try { this.speechRecognition.stop(); } catch {} this.speechRecognition = null; } }

    handleUserInput(transcript) {
      if (transcript.includes('summary') || transcript.includes('summarize')) {
        this.provideSummaryLLM();
        return;
      }
      if (transcript.includes('fill') || transcript.includes('blank') || transcript.includes('form')) {
        this.summarizeFillablesThenAsk();
        return;
      }
      if (transcript === 'yes' || transcript.startsWith('yes ')) {
        this.summarizeFillablesThenAsk();
        return;
      }
      if (transcript === 'no' || transcript.startsWith('no ')) {
        this.speak('Okay. Say "summary" or "fill the form" anytime.');
        return;
      }

      if (this.selectedFields.length > 0 && this.currentFieldIndex < this.selectedFields.length) {
        this.handleFieldValue(transcript);
        return;
      }

      const m = transcript.match(/\bfield\s*(\d+)\b/);
      if (m) {
        const idx = parseInt(m[1], 10) - 1;
        if (!Number.isNaN(idx) && idx >= 0 && idx < this.formFields.length) {
          this.selectedFields = [this.formFields[idx]];
          this.currentFieldIndex = 0;
          this.speak(`Selected ${this.formFields[idx].label}. What would you like to enter?`);
          return;
        }
      }

      const match = this.formFields.find(f => f.label && transcript.includes(f.label.toLowerCase().split(/\s+/)[0]));
      if (match) {
        this.selectedFields = [match];
        this.currentFieldIndex = 0;
        this.speak(`Selected ${match.label}. What would you like to enter?`);
        return;
      }

      this.speak('Say "summary" for a page summary or "fill the form" to fill blanks. You can also say "field 1", "field 2", or a field name.');
    }

    summarizeFillablesThenAsk() {
      if (this.formFields.length === 0) {
        this.speak('I don’t see any fillable fields on this page.');
        return;
      }
      const parts = this.formFields.slice(0, 15).map((f, i) => {
        const req = f.required ? 'required' : 'optional';
        const type = f.kind || f.roleKind || 'field';
        return `${i+1}. ${f.label} — ${type}, ${req}`;
      });
      const tail = this.formFields.length > 15 ? `...and ${this.formFields.length - 15} more.` : '';
      this.speak(`I found ${this.formFields.length} fillable items. ${parts.join('. ')}. ${tail} Say a number like "field 1" or say the field name to select.`);
    }

    handleFieldValue(valueTranscript) {
      if (this.currentFieldIndex >= this.selectedFields.length) return;

      const field = this.selectedFields[this.currentFieldIndex];
      const filled = this.tryFillField(field, valueTranscript);

      if (!filled) {
        this.speak(`I could not fill ${field.label}. You can try rephrasing or choose another field.`);
        return;
      }

      this.currentFieldIndex++;
      if (this.currentFieldIndex < this.selectedFields.length) {
        const nextField = this.selectedFields[this.currentFieldIndex];
        this.speak(`Next field: ${nextField.label}. What would you like to enter?`);
      } else {
        this.speak('All selected fields have been filled. Do you need help with anything else?');
        this.selectedFields = [];
        this.currentFieldIndex = 0;
      }
    }

    tryFillField(field, value) {
      try {
        const el = field.element;
        if (!el || !el.isConnected || el.disabled) return false;

        if (typeof el.focus === 'function') {
          try { el.focus({ preventScroll: true }); } catch { try { el.focus(); } catch {} }
        }

        const kind = field.kind;

        if (kind === 'select') {
          const sel = el;
          const lower = value.toLowerCase();
          let matched = false;
          for (const opt of sel.options) {
            if ((opt.textContent || '').trim().toLowerCase() === lower) {
              sel.value = opt.value;
              matched = true;
              break;
            }
          }
          if (!matched) {
            for (const opt of sel.options) {
              if ((opt.textContent || '').toLowerCase().includes(lower)) {
                sel.value = opt.value;
                matched = true;
                break;
              }
            }
          }
          if (matched) {
            sel.dispatchEvent(new Event('input', { bubbles: true }));
            sel.dispatchEvent(new Event('change', { bubbles: true }));
            this.speak(`Set ${field.label} to ${value}.`);
            return true;
          }
          return false;
        }

        if (kind === 'checkbox') {
          const v = value.trim().toLowerCase();
          const on = v === 'yes' || v === 'check' || v === 'true' || v === 'on' || v === 'enable';
          el.checked = on;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          this.speak(`${on ? 'Checked' : 'Unchecked'} ${field.label}.`);
          return true;
        }

        if (kind === 'radio') {
          const name = el.name;
          if (!name) return false;
          const doc = el.ownerDocument || document;
          const radios = doc.querySelectorAll(`input[type="radio"][name="${CSS.escape(name)}"]`);
          const lower = value.toLowerCase();
          for (const r of radios) {
            let lbl = '';
            if (r.id) {
              const l = doc.querySelector(`label[for="${CSS.escape(r.id)}"]`);
              lbl = (l?.textContent || '').trim();
            }
            if (!lbl) {
              const lbIds = r.getAttribute('aria-labelledby');
              if (lbIds) {
                lbl = lbIds.split(/\s+/).map(id => doc.getElementById(id)?.textContent?.trim()).filter(Boolean).join(' ');
              }
            }
            if (!lbl) {
              const parentTxt = (r.closest('label, .option, .radio, .form-check')?.textContent || '').trim();
              if (parentTxt) lbl = parentTxt;
            }
            const candidate = ((r.value || '') + ' ' + (lbl || '')).toLowerCase();
            if (candidate.includes(lower)) {
              r.checked = true;
              r.dispatchEvent(new Event('input', { bubbles: true }));
              r.dispatchEvent(new Event('change', { bubbles: true }));
              this.speak(`Selected ${lbl ? lbl : r.value} for ${field.label}.`);
              return true;
            }
          }
          return false;
        }

        if (kind === 'pickerButton') {
          el.click();
          this.speak(`Opened ${field.label}. Use the site’s picker, or say another field.`);
          return true;
        }

        if (kind === 'date' || kind === 'time' || kind === 'datetime') {
          el.value = value;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          this.speak(`Set ${field.label} to ${value}.`);
          return true;
        }

        if (kind === 'combobox' || field.roleKind === 'combobox') {
          el.value = value;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          this.speak(`Entered ${value} for ${field.label}.`);
          return true;
        }

        if (kind === 'contenteditable') {
          el.innerText = value;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          this.speak(`Entered ${value} for ${field.label}.`);
          return true;
        }

        el.value = value;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        this.speak(`Entered ${value} for ${field.label}.`);
        return true;

      } catch (err) {
        console.error('tryFillField error:', err);
        return false;
      } finally {
        try { field.element.blur?.(); } catch {}
      }
    }

    // ===== TTS =====
    speak(text) {
      if (!this.isActive) return;
      this.stopSpeechSynthesis();
      const u = new SpeechSynthesisUtterance(text);
      u.volume = this.settings.volume;
      u.rate   = this.settings.speechRate;
      u.lang   = 'en-US';
      try { this.speechSynthesis.speak(u); } catch {}
    }
    stopSpeechSynthesis() { try { this.speechSynthesis.cancel(); } catch {} }

    updateStatus(message) {
      try { chrome.runtime.sendMessage({ type: 'statusUpdate', text: message }); } catch {}
    }
  }

  // One instance per frame
  (function bootstrap() {
    if (!window.accessibilityAssistant) {
      window.accessibilityAssistant = new AccessibilityAssistant();
    }
  })();
}
