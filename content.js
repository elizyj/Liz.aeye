// content.js — Accessibility Assistant
// Overview + Fill-in-the-blanks with *no hardcoded domains*

(function () {
  // ===== Idempotency guard (MUST run before class definition) =====
  if (window.__AA_LOADED__) {
    // still respond to pings if we got re-injected
    chrome.runtime?.onMessage?.addListener?.((m, _s, send) => {
      if (m?.type === 'ping') {
        send?.({ pong: true });
        return true;
      }
      return false;
    });
    return; // ✅ do not redeclare the class
  }
  window.__AA_LOADED__ = true;

  console.log(
    '[AA] content.js LOADED — top frame?',
    window.top === window,
    'url:',
    location.href
  );

  class AccessibilityAssistant {
    constructor() {
      this.isActive = false;
      this.rec = null;
      this.speechSynthesis = window.speechSynthesis;

      // Field discovery & flow state
      this.formFields = [];
      this.currentFieldIndex = 0;
      this.selectedFields = [];

      // Settings
      this.settings = { volume: 0.8, speechRate: 1.0 };
      this._listenersBound = false;

      // TTS queue
      this.ttsQueue = [];
      this.ttsBusy = false;

      this.init();
    }

    // ======= TTS queue (guarantee ordering) =======
    queueSpeak(text) {
      if (!text) return;
      this.ttsQueue.push(String(text));
      if (!this.ttsBusy) this._dequeueSpeak();
    }
    _dequeueSpeak() {
      if (!this.isActive) {
        this.ttsQueue = [];
        this.ttsBusy = false;
        return;
      }
      const next = this.ttsQueue.shift();
      if (!next) {
        this.ttsBusy = false;
        return;
      }
      this.ttsBusy = true;

      try {
        this.speechSynthesis.cancel();
      } catch {}

      const u = new SpeechSynthesisUtterance(next);
      u.volume = this.settings.volume;
      u.rate = this.settings.speechRate;
      u.lang = 'en-US';
      u.onend = () => {
        this.ttsBusy = false;
        this._dequeueSpeak();
      };
      u.onerror = () => {
        this.ttsBusy = false;
        this._dequeueSpeak();
      };
      try {
        this.speechSynthesis.speak(u);
      } catch {
        this.ttsBusy = false;
      }
    }
    speakNow(text) {
      try {
        this.speechSynthesis.cancel();
      } catch {}
      const u = new SpeechSynthesisUtterance(text);
      u.volume = this.settings.volume;
      u.rate = this.settings.speechRate;
      u.lang = 'en-US';
      try {
        this.speechSynthesis.speak(u);
      } catch {}
    }
    stopSpeechSynthesis() {
      try {
        this.speechSynthesis.cancel();
      } catch {}
    }

    init() {
      chrome.storage.local.get(['volume', 'speechRate'], (result) => {
        this.settings = { ...this.settings, ...result };
      });

      if (!this._listenersBound) {
        chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
          if (message?.type === 'ping') {
            sendResponse?.({ pong: true });
            return true;
          }

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

      console.log('[AA] content.js initialized. Top frame?', window.top === window);
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
      this.ttsQueue = [];
      this.ttsBusy = false;
      this.updateStatus('Assistant stopped');
    }

    analyzePage() {
      this.updateStatus('Scanning for interactive elements...');
      this.formFields = this.findFillables();
      this.queueSpeak(
        'Welcome to the Accessibility Assistant. Say "summary" for a page overview, or say "fill the form" to list blanks and start filling.'
      );
      this.startSpeechRecognition();
    }

    // ===== Page Overview (LLM, neutral) =====
    async providePageOverview() {
      this.updateStatus('Preparing page overview...');
      try {
        const payload = this.collectSummarizationPayload();
        const result = await chrome.runtime.sendMessage({
          type: 'summarizePage',
          payload,
          mode: 'overview'
        });
        if (result?.ok && result.summary) {
          this.queueSpeak(result.summary);
        } else {
          const fallback = this.heuristicOverview(payload);
          this.queueSpeak(fallback);
        }
      } catch {
        const payload = this.collectSummarizationPayload();
        const fallback = this.heuristicOverview(payload);
        this.queueSpeak(fallback);
      }
    }

    heuristicOverview(payload) {
      const { title, text } = payload;
      const words = (text || '').split(/\s+/).filter(Boolean).length;
      return `This page is titled ${title || 'Untitled'}. It contains approximately ${words} words of content.`;
    }

    // ===== Fill-in-the-blanks flow =====
    async runFillInTheBlanksFlow() {
      this.formFields = this.findFillables();

      if (this.formFields.length === 0) {
        this.queueSpeak('I don’t see any fillable fields on this page.');
        return;
      }

      const count = this.formFields.length;
      this.queueSpeak(`I found ${count} fillable ${count === 1 ? 'item' : 'items'}.`);

      const ok = await this.provideFillablesListLLM();
      if (!ok) this.readOutLocalFillablesListWithContext();

      this.queueSpeak(
        'Say a number like "field 1", or say a field name to select. You can say repeat, skip, back, or cancel during entry.'
      );
    }

    async provideFillablesListLLM() {
      try {
        const ctx = this.buildFillableContext();
        const payload = this.collectSummarizationPayload();
        payload.fillableLabels = ctx.fields.map(
          (f) => f.label || f.placeholder || f.name || 'Unlabeled'
        );
        payload.fillableContext = ctx;
        payload.cacheSig = payload.fillableLabels.join('|').slice(0, 400);

        const result = await chrome.runtime.sendMessage({
          type: 'summarizePage',
          payload,
          mode: 'fillables'
        });

        if (result?.ok && result.summary) {
          this.queueSpeak(result.summary);
          return true;
        }
        return false;
      } catch (e) {
        console.warn('[AA] LLM fillables failed:', e);
        return false;
      }
    }

    readOutLocalFillablesListWithContext() {
      const { title, headings, urlHints, globalKeywords } = this.buildFillableContext();
      const ctxWord = this.pickContextKeyword({
        title,
        headings,
        urlHints,
        globalKeywords
      });

      const items = this.formFields.slice(0, 20).map((f, i) => {
        const raw = (f.label || f.placeholder || f.name || 'Field').trim();
        const natural = this.contextualizeLabelGeneric(raw, ctxWord);
        return `${i + 1}. ${natural}`;
      });
      const tail =
        this.formFields.length > 20
          ? `...and ${this.formFields.length - 20} more.`
          : '';
      this.queueSpeak(`${items.join('. ')}. ${tail}`.trim());
    }

    pickContextKeyword({ title = '', headings = [], urlHints = '', globalKeywords = '' }) {
      const txt = `${title}\n${(headings || []).join(' ')}\n${urlHints}\n${globalKeywords}`.toLowerCase();

      const stop = new Set(
        'the of and a an to for in on at by with from your my our their his her its be is are was were will can should must not no yes or if as this that these those you me we they it page form'.split(
          ' '
        )
      );
      const tokens = txt
        .split(/[^a-z0-9]+/g)
        .filter((w) => w && w.length > 2 && !stop.has(w));

      if (!tokens.length) return '';

      const freq = new Map();
      for (const w of tokens) freq.set(w, (freq.get(w) || 0) + 1);

      let best = '';
      let bestScore = 0;
      for (const [w, c] of freq.entries()) {
        if (c > bestScore) {
          bestScore = c;
          best = w;
        }
      }
      return best;
    }

    contextualizeLabelGeneric(label, ctxWord) {
      let base = label.replace(/\s+/g, ' ').replace(/[_-]/g, ' ').trim();
      const clean = base.replace(/[^\p{L}\p{N}\s]/gu, '').toLowerCase();
      const titleCase = (s) => s.replace(/\b\w/g, (m) => m.toUpperCase());
      const alreadyHasCtx = ctxWord && clean.includes(ctxWord.toLowerCase());

      const tok = clean.split(/\s+/).filter(Boolean);
      if (alreadyHasCtx) return titleCase(clean);

      if (ctxWord && tok.length <= 2) {
        return titleCase(`${clean} of ${ctxWord}`);
      }
      return titleCase(clean);
    }

    collectSummarizationPayload() {
      const title = document.title || '';
      const url = location.href;

      const main =
        document.querySelector('main, [role="main"], article') || document.body;
      const text = this.extractVisibleText(main);

      const headings = Array.from(document.querySelectorAll('h1,h2,h3'))
        .slice(0, 12)
        .map((h) => h.textContent.trim())
        .filter(Boolean);

      const interactiveCounts = {
        inputs: document.querySelectorAll(
          'input, textarea, select, [role="textbox"], [role="combobox"]'
        ).length,
        buttons: document.querySelectorAll('button, [role="button"]').length,
        links: document.querySelectorAll('a[href]').length
      };

      const landmarks = Array.from(
        document.querySelectorAll(
          '[role="navigation"], nav, [role="search"], [role="form"], form'
        )
      )
        .slice(0, 6)
        .map(
          (el) =>
            (el.getAttribute('aria-label') ||
              el.getAttribute('name') ||
              el.tagName
            ).toLowerCase()
        );

      return { url, title, headings, interactiveCounts, landmarks, text };
    }

    buildFillableContext() {
      const title = document.title || '';
      const headings = Array.from(document.querySelectorAll('h1,h2,h3'))
        .slice(0, 12)
        .map((h) => h.textContent.trim())
        .filter(Boolean);
      const urlHints = [location.hostname, location.pathname]
        .join(' ')
        .replace(/[\/\-_]+/g, ' ');

      const fields = this.formFields.map((f) => {
        const el = f.element;
        const ariaLabel = el?.getAttribute?.('aria-label') || '';
        const placeholder = el?.getAttribute?.('placeholder') || f.placeholder || '';
        const name = el?.getAttribute?.('name') || f.name || '';
        const group =
          el
            ?.closest?.(
              'fieldset, [role="group"], .form-group, .field, form'
            )
            ?.querySelector?.('legend, h1, h2, h3, [aria-label]')?.textContent
            ?.trim() || '';
        const nearby =
          el
            ?.closest?.(
              '.form-group, .field, .row, .input, .form-item, label'
            )
            ?.textContent?.trim()
            ?.slice(0, 140) || '';
        return {
          label: f.label || '',
          placeholder,
          name,
          ariaLabel,
          group,
          nearby
        };
      });

      const globalKeywords = this.pickContextKeyword({
        title,
        headings,
        urlHints,
        globalKeywords: ''
      });

      return { title, headings, urlHints, globalKeywords, fields };
    }

    extractVisibleText(root) {
      const walker = document.createTreeWalker(
        root,
        NodeFilter.SHOW_TEXT,
        {
          acceptNode: (node) => {
            const t = node.textContent;
            if (!t || !t.trim()) return NodeFilter.FILTER_REJECT;
            const el = node.parentElement;
            if (!el) return NodeFilter.FILTER_REJECT;
            const style = window.getComputedStyle(el);
            if (
              style.display === 'none' ||
              style.visibility === 'hidden' ||
              style.opacity === '0'
            )
              return NodeFilter.FILTER_REJECT;
            const tag = el.tagName;
            if (
              tag === 'SCRIPT' ||
              tag === 'STYLE' ||
              tag === 'NOSCRIPT'
            )
              return NodeFilter.FILTER_REJECT;
            return NodeFilter.FILTER_ACCEPT;
          }
        }
      );
      const parts = [];
      while (walker.nextNode()) {
        parts.push(
          walker.currentNode.textContent.replace(/\s+/g, ' ').trim()
        );
      }
      return parts
        .join('\n')
        .replace(/\n{3,}/g, '\n\n')
        .slice(0, 200000);
    }

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
      const stack = [root];
      while (stack.length) {
        const r = stack.pop();
        const doc =
          r && r.ownerDocument
            ? r.ownerDocument
            : r && r.nodeType === 9
            ? r
            : document;

        let tw;
        try {
          tw = doc.createTreeWalker(r, NodeFilter.SHOW_ELEMENT, null);
        } catch {
          continue;
        }

        let n = tw.nextNode();
        while (n) {
          yield n;
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
        } catch {}
      }
      return out;
    }

    findFillables() {
      const fields = [];

      const isVisible = (el) => {
        if (!el || !el.isConnected) return false;
        const cs = getComputedStyle(el);
        if (
          cs.visibility === 'hidden' ||
          cs.display === 'none' ||
          cs.opacity === '0'
        )
          return false;
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
          const txt = lbIds
            .split(/\s+/)
            .map((id) => doc.getElementById(id)?.textContent?.trim())
            .filter(Boolean)
            .join(' ');
          if (txt) return txt;
        }
        const aria = el.getAttribute?.('aria-label');
        if (aria) return aria.trim();
        if (el.placeholder) return el.placeholder.trim();
        const fieldset = el.closest?.('fieldset');
        const legend = fieldset?.querySelector?.('legend');
        if (legend?.textContent) return legend.textContent.trim();
        const prev =
          el.closest?.(
            '[role="group"], .field, .form-group, .input, .form-item'
          ) || el.parentElement;
        if (prev) {
          const maybe = prev.querySelector?.('label, [data-label], [aria-label]');
          const t =
            maybe?.textContent ||
            maybe?.getAttribute?.('data-label') ||
            maybe?.getAttribute?.('aria-label');
          if (t) return String(t).trim();
        }
        if (el.name) return el.name.replace(/[-_]/g, ' ').trim();
        return 'Unlabeled';
      };

      const roots = this.getCandidateRoots();
      const collect = (sel) =>
        roots.flatMap((r) => this.deepQueryAll(r, sel));

      const push = (el, kind, roleKind = null, extra = {}) => {
        if (!isVisible(el) || el.disabled) return;
        fields.push({
          element: el,
          kind,
          roleKind,
          label: getLabel(el),
          required:
            !!el.required || el.getAttribute?.('aria-required') === 'true',
          placeholder: el.placeholder || '',
          name: el.name || el.id || '',
          meta: extra
        });
      };

      // Native inputs
      collect('input').forEach((el) => {
        const t = (el.type || 'text').toLowerCase();
        const supported = [
          'text',
          'email',
          'password',
          'tel',
          'url',
          'search',
          'number',
          'date',
          'time',
          'datetime-local',
          'month',
          'week'
        ];
        if (supported.includes(t)) {
          push(el, t === 'datetime-local' ? 'datetime' : t);
        }
        if (t === 'checkbox') push(el, 'checkbox');
        if (t === 'radio') push(el, 'radio');
      });

      collect('textarea').forEach((el) => push(el, 'textarea'));
      collect('select').forEach((el) => push(el, 'select'));
      collect('[contenteditable=""], [contenteditable="true"]').forEach((el) =>
        push(el, 'contenteditable')
      );

      // Role widgets
      collect('[role="textbox"]').forEach((el) => push(el, 'text', 'textbox'));
      collect('[role="combobox"]').forEach((el) =>
        push(el, 'combobox', 'combobox')
      );
      collect('[role="spinbutton"]').forEach((el) =>
        push(el, 'spinbutton', 'spinbutton')
      );
      collect('[role="slider"]').forEach((el) =>
        push(el, 'slider', 'slider')
      );
      collect('[role="searchbox"]').forEach((el) =>
        push(el, 'text', 'searchbox')
      );
      collect('[role="listbox"][aria-labelledby]').forEach((el) =>
        push(el, 'pickerButton', 'listbox')
      );

      // Buttons that open pickers
      collect('button, [role="button"], [tabindex]').forEach((el) => {
        if (!isVisible(el)) return;
        const hasPopup = el.getAttribute('aria-haspopup');
        const expanded = el.getAttribute('aria-expanded');
        const controls = el.getAttribute('aria-controls');
        const tabbable = el.hasAttribute('tabindex');
        const isButtony =
          el.tagName === 'BUTTON' ||
          el.getAttribute('role') === 'button' ||
          tabbable;
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
      const SpeechRecognition =
        window.SpeechRecognition || window.webkitSpeechRecognition;
      if (!SpeechRecognition) {
        this.queueSpeak('Speech recognition is not supported in this browser.');
        return;
      }

      if (this.rec) {
        try {
          this.rec.stop();
        } catch {}
        this.rec = null;
      }
      const rec = new SpeechRecognition();
      rec.continuous = false;
      rec.interimResults = false;
      rec.lang = 'en-US';

      rec.onresult = (event) => {
        try {
          const t = event?.results?.[0]?.[0]?.transcript || '';
          const text = String(t).toLowerCase().trim();
          if (!text) {
            this.queueSpeak('Sorry, I didn’t catch that. Please try again.');
          } else {
            this.handleUserInput(text);
          }
        } catch {
          this.queueSpeak('Sorry, I didn’t catch that. Please try again.');
        }
      };

      rec.onerror = () => {
        if (this.isActive)
          this.queueSpeak('Sorry, I didn’t catch that. Please try again.');
      };
      rec.onend = () => {
        if (this.isActive)
          setTimeout(() => this.startSpeechRecognition(), 250);
      };
      this.rec = rec;
      try {
        rec.start();
      } catch {}
    }

    stopSpeechRecognition() {
      if (this.rec) {
        try {
          this.rec.stop();
        } catch {}
        this.rec = null;
      }
    }

    handleUserInput(transcript) {
      const t = transcript.toLowerCase();

      if (
        t.includes('summary') ||
        t.includes('overview') ||
        t.includes('describe page')
      ) {
        this.providePageOverview();
        return;
      }

      if (
        t.includes('fill') ||
        t.includes('blank') ||
        t.includes('form') ||
        t.includes('complete')
      ) {
        this.runFillInTheBlanksFlow();
        return;
      }

      if (t === 'yes' || t.startsWith('yes ')) {
        this.runFillInTheBlanksFlow();
        return;
      }
      if (t === 'no' || t.startsWith('no ')) {
        this.queueSpeak(
          'Okay. Say "summary" for an overview or "fill the form" anytime.'
        );
        return;
      }

      if (
        this.selectedFields.length > 0 &&
        this.currentFieldIndex < this.selectedFields.length
      ) {
        if (t === 'repeat') {
          this.readCurrentField();
          return;
        }
        if (t === 'skip') {
          this.nextField();
          return;
        }
        if (t === 'back') {
          this.prevField();
          return;
        }
        if (t === 'cancel') {
          this.cancelFieldFilling();
          return;
        }
        this.handleFieldValue(transcript);
        return;
      }

      const m = t.match(/\bfield\s*(\d+)\b/);
      if (m) {
        const idx = parseInt(m[1], 10) - 1;
        if (!Number.isNaN(idx) && idx >= 0 && idx < this.formFields.length) {
          this.selectFieldByIndex(idx);
          return;
        }
      }

      const match = this.formFields.find(
        (f) =>
          f.label &&
          t.includes(f.label.toLowerCase().split(/\s+/)[0])
      );
      if (match) {
        this.selectField(match);
        return;
      }

      this.queueSpeak(
        'Say "summary" for a page overview or "fill the form" to list blanks. You can also say "field 1" or a field name.'
      );
    }

    selectFieldByIndex(idx) {
      if (Number.isNaN(idx) || idx < 0 || idx >= this.formFields.length) {
        this.queueSpeak('That number is out of range. Try again.');
        return;
      }
      this.selectField(this.formFields[idx]);
    }

    selectField(field) {
      this.selectedFields = [field];
      this.currentFieldIndex = 0;
      this.readCurrentField();
    }

    readCurrentField() {
      if (this.currentFieldIndex >= this.selectedFields.length) return;
      const field = this.selectedFields[this.currentFieldIndex];
      const req = field.required ? 'required' : 'optional';
      const type = field.kind || field.roleKind || 'field';
      this.queueSpeak(
        `Selected: ${field.label || 'Unlabeled'} — ${type}, ${req}. What would you like me to enter? You can say repeat, skip, back, or cancel.`
      );
    }

    nextField() {
      this.currentFieldIndex++;
      if (this.currentFieldIndex < this.selectedFields.length) {
        this.readCurrentField();
      } else {
        this.queueSpeak(
          'All selected fields have been handled. Do you want to fill another field? Say a number like "field 2", a field name, or say "summary".'
        );
        this.selectedFields = [];
        this.currentFieldIndex = 0;
      }
    }

    prevField() {
      if (this.currentFieldIndex > 0) this.currentFieldIndex--;
      this.readCurrentField();
    }

    cancelFieldFilling() {
      this.selectedFields = [];
      this.currentFieldIndex = 0;
      this.queueSpeak(
        'Canceled filling. Say "fill the form" to hear blanks again or "summary" for a page overview.'
      );
    }

    handleFieldValue(valueTranscript) {
      if (this.currentFieldIndex >= this.selectedFields.length) return;
      const field = this.selectedFields[this.currentFieldIndex];
      const filled = this.tryFillField(field, valueTranscript);
      if (!filled) {
        this.queueSpeak(
          `I could not fill ${field.label}. You can try rephrasing or choose another field.`
        );
        return;
      }
      this.nextField();
    }

    tryFillField(field, value) {
      try {
        const el = field.element;
        if (!el || !el.isConnected || el.disabled) return false;

        if (typeof el.focus === 'function') {
          try {
            el.focus({ preventScroll: true });
          } catch {
            try {
              el.focus();
            } catch {}
          }
        }

        const kind = field.kind;

        if (kind === 'select') {
          const sel = el;
          const lower = String(value).toLowerCase();
          let matched = false;
          for (const opt of sel.options) {
            const txt = (opt.textContent || '').trim().toLowerCase();
            if (txt === lower) {
              sel.value = opt.value;
              matched = true;
              break;
            }
          }
          if (!matched) {
            for (const opt of sel.options) {
              const txt = (opt.textContent || '').trim().toLowerCase();
              if (txt.includes(lower)) {
                sel.value = opt.value;
                matched = true;
                break;
              }
            }
          }
          if (matched) {
            sel.dispatchEvent(new Event('input', { bubbles: true }));
            sel.dispatchEvent(new Event('change', { bubbles: true }));
            this.queueSpeak(`Set ${field.label} to ${value}.`);
            return true;
          }
          return false;
        }

        if (kind === 'checkbox') {
          const v = String(value).trim().toLowerCase();
          const on =
            v === 'yes' ||
            v === 'check' ||
            v === 'true' ||
            v === 'on' ||
            v === 'enable';
          el.checked = on;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          this.queueSpeak(`${on ? 'Checked' : 'Unchecked'} ${field.label}.`);
          return true;
        }

        if (kind === 'radio') {
          const name = el.name;
          if (!name) return false;
          const doc = el.ownerDocument || document;
          const radios = doc.querySelectorAll(
            `input[type="radio"][name="${CSS.escape(name)}"]`
          );
          const lower = String(value).toLowerCase();
          for (const r of radios) {
            let lbl = '';
            if (r.id) {
              const l = doc.querySelector(`label[for="${CSS.escape(r.id)}"]`);
              lbl = (l?.textContent || '').trim();
            }
            if (!lbl) {
              const lbIds = r.getAttribute('aria-labelledby');
              if (lbIds) {
                lbl = lbIds
                  .split(/\s+/)
                  .map((id) =>
                    doc.getElementById(id)?.textContent?.trim()
                  )
                  .filter(Boolean)
                  .join(' ');
              }
            }
            if (!lbl) {
              const parentTxt = (
                r.closest('label, .option, .radio, .form-check')?.textContent ||
                ''
              ).trim();
              if (parentTxt) lbl = parentTxt;
            }
            const candidate = ((r.value || '') + ' ' + (lbl || '')).toLowerCase();
            if (candidate.includes(lower)) {
              r.checked = true;
              r.dispatchEvent(new Event('input', { bubbles: true }));
              r.dispatchEvent(new Event('change', { bubbles: true }));
              this.queueSpeak(
                `Selected ${lbl ? lbl : r.value} for ${field.label}.`
              );
              return true;
            }
          }
          return false;
        }

        if (kind === 'pickerButton') {
          el.click();
          this.queueSpeak(
            `Opened ${field.label}. Use the site’s picker, or say another field.`
          );
          return true;
        }

        if (kind === 'date' || kind === 'time' || kind === 'datetime') {
          el.value = value;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          this.queueSpeak(`Set ${field.label} to ${value}.`);
          return true;
        }

        if (kind === 'combobox' || field.roleKind === 'combobox') {
          el.value = value;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          this.queueSpeak(`Entered ${value} for ${field.label}.`);
          return true;
        }

        if (kind === 'contenteditable') {
          el.innerText = value;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          this.queueSpeak(`Entered ${value} for ${field.label}.`);
          return true;
        }

        el.value = value;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        this.queueSpeak(`Entered ${value} for ${field.label}.`);
        return true;
      } catch (err) {
        console.error('tryFillField error:', err);
        return false;
      } finally {
        try {
          field.element.blur?.();
        } catch {}
      }
    }

    updateStatus(message) {
      try {
        chrome.runtime.sendMessage({ type: 'statusUpdate', text: message });
      } catch {}
    }
  }

  // bootstrap
  (function bootstrap() {
    if (!window.accessibilityAssistant) {
      window.accessibilityAssistant = new AccessibilityAssistant();
    }
  })();
})();

