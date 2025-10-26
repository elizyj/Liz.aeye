class AccessibilityAssistant {
  constructor() {
    this.isActive = false;
    this.speechRecognition = null;
    this.speechSynthesis = window.speechSynthesis;
    this.formFields = [];
    this.currentFieldIndex = 0;
    this.selectedFields = [];
    this.settings = { volume: 0.8, speechRate: 1.0 };

    // Hard guarantee: we never add DOM nodes or styles.
    this.neverMutateLayout = true;

    // Prevent double-init of listeners inside the same injected file
    this._listenersBound = false;

    this.init();
  }

  init() {
    // Load settings from storage (non-blocking)
    chrome.storage.local.get(['volume', 'speechRate'], (result) => {
      this.settings = { ...this.settings, ...result };
    });

    if (!this._listenersBound) {
      // Listen for messages from popup (ping/start/stop)
      chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        try {
          if (message && message.type === 'ping') {
            sendResponse?.({ pong: true });
            return false; // done
          }

          if (message && typeof message.action === 'string') {
            if (message.action === 'startAssistant') {
              // Idempotent start
              if (!this.isActive) this.startAssistant();
              sendResponse?.({ success: true });
            } else if (message.action === 'stopAssistant') {
              this.stopAssistant();
              sendResponse?.({ success: true });
            }
          }
        } catch {}
        // Keep channel open for async responses if needed
        return true;
      });

      this._listenersBound = true;
    }
  }

  startAssistant() {
    this.isActive = true;
    this.updateStatus('Assistant started. Analyzing page...');

    // Passive, read-only analysis after a short delay
    setTimeout(() => {
      if (!this.isActive) return;
      this.analyzePage();
    }, 300);
  }

  stopAssistant() {
    this.isActive = false;
    this.stopSpeechRecognition();
    this.stopSpeechSynthesis();
    this.updateStatus('Assistant stopped');
  }

  analyzePage() {
    this.updateStatus('Analyzing page content...');

    // Read-only scan for fields (no focus, no writes)
    this.formFields = this.findFormFields();

    // Speak options; still no DOM touches
    this.speak(
      'Welcome to the Accessibility Assistant. I can provide a page summary or help fill form fields. Please say "summary" or "fill the form".'
    );

    // Begin listening
    this.startSpeechRecognition();
  }

  extractPageContent() {
    // Pure read — textContent avoids layout/style recalculation that innerText can trigger
    const main = document.querySelector('main') || document.body;
    return (main && main.textContent) ? main.textContent : '';
  }

  findFormFields() {
    const fields = [];
    const selectors = [
      'input[type="text"]',
      'input[type="email"]',
      'input[type="password"]',
      'input[type="tel"]',
      'input[type="url"]',
      'input[type="search"]',
      'input[type="number"]',
      'input[type="date"]',
      'input[type="time"]',
      'input[type="datetime-local"]',
      'textarea',
      'select'
    ];

    selectors.forEach(selector => {
      document.querySelectorAll(selector).forEach((el, idx) => {
        // Only consider visible, enabled controls
        if (el && el.offsetParent !== null && !el.disabled) {
          fields.push({
            element: el,
            type: el.type || el.tagName.toLowerCase(),
            name: el.name || el.id || `field-${idx}`,
            label: this.getFieldLabel(el),
            placeholder: el.placeholder || '',
            required: !!el.required
          });
        }
      });
    });

    return fields;
  }

  getFieldLabel(element) {
    // Associated <label for="">
    if (element.id) {
      try {
        const lbl = document.querySelector(`label[for="${CSS.escape(element.id)}"]`);
        if (lbl && lbl.textContent) return lbl.textContent.trim();
      } catch {
        // Fallback if CSS.escape not available
        const lbl = document.querySelector(`label[for="${element.id}"]`);
        if (lbl && lbl.textContent) return lbl.textContent.trim();
      }
    }

    // aria-label
    const aria = element.getAttribute('aria-label');
    if (aria) return aria.trim();

    // placeholder
    if (element.placeholder) return element.placeholder.trim();

    // name
    if (element.name) return element.name.replace(/[-_]/g, ' ').trim();

    return 'Unlabeled field';
  }

  startSpeechRecognition() {
    if (!this.isActive) return;

    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      this.speak('Speech recognition is not supported in this browser.');
      return;
    }

    // Tear down previous instance if any
    if (this.speechRecognition) {
      try { this.speechRecognition.stop(); } catch {}
      this.speechRecognition = null;
    }

    const rec = new SpeechRecognition();
    rec.continuous = false;
    rec.interimResults = false;
    rec.lang = 'en-US';

    rec.onresult = (event) => {
      try {
        const transcript = (event.results && event.results[0] && event.results[0][0] && event.results[0][0].transcript) || '';
        const text = String(transcript || '').toLowerCase().trim();
        if (!text) {
          this.speak('Sorry, I didn’t catch that. Please try again.');
        } else {
          this.handleUserInput(text);
        }
      } catch {
        this.speak('Sorry, I didn’t catch that. Please try again.');
      }
    };

    rec.onerror = () => {
      if (this.isActive) {
        this.speak('Sorry, I didn’t catch that. Please try again.');
      }
    };

    rec.onend = () => {
      // Auto-rearm while active
      if (this.isActive) {
        // Small delay to avoid tight restart loops
        setTimeout(() => this.startSpeechRecognition(), 200);
      }
    };

    this.speechRecognition = rec;
    try { rec.start(); } catch {}
  }

  stopSpeechRecognition() {
    if (this.speechRecognition) {
      try { this.speechRecognition.stop(); } catch {}
      this.speechRecognition = null;
    }
  }

  handleUserInput(transcript) {
    if (transcript.includes('summary') || transcript.includes('summarize')) {
      this.provideSummary();
      return;
    }

    if (transcript.includes('fill') || transcript.includes('blank') || transcript.includes('form')) {
      this.handleFormFilling();
      return;
    }

    if (transcript === 'yes' || transcript.startsWith('yes ')) {
      this.speak('Great! Let’s proceed with filling the form fields.');
      this.handleFormFilling();
      return;
    }

    if (transcript === 'no' || transcript.startsWith('no ')) {
      this.speak('Okay, let me know if you need help with anything else.');
      return;
    }

    // If we are mid-fill and expecting a value for a selected field
    if (this.selectedFields.length > 0 && this.currentFieldIndex < this.selectedFields.length) {
      this.handleFieldValue(transcript);
      return;
    }

    // Optional: allow selection by saying "field 1" or a label/name
    const fieldIdxMatch = transcript.match(/\bfield\s*(\d+)\b/);
    if (fieldIdxMatch) {
      const idx = parseInt(fieldIdxMatch[1], 10) - 1;
      if (!Number.isNaN(idx) && idx >= 0 && idx < this.formFields.length) {
        this.selectedFields = [this.formFields[idx]];
        this.currentFieldIndex = 0;
        this.speak(`Selected ${this.formFields[idx].label}. What would you like to enter?`);
        return;
      }
    }

    this.speak('I didn’t understand. Please say "summary" for a page summary or "fill the form" to fill form fields.');
  }

provideSummary() {
  this.updateStatus('Providing detailed page summary...');

  try {
    const hostname = window.location.hostname || 'this website';
    const title = document.title || '';
    const content = this.extractPageContent();

    const wordCount = content ? content.trim().split(/\s+/).filter(Boolean).length : 0;

    // Basic heuristic description
    let description = 'This page contains general content.';
    const lc = content.toLowerCase();

    if (lc.includes('login') || lc.includes('sign in')) {
      description = 'This looks like a login or authentication page.';
    } else if (lc.includes('register') || lc.includes('sign up')) {
      description = 'This appears to be a registration or sign-up page.';
    } else if (lc.includes('checkout') || lc.includes('cart')) {
      description = 'This seems to be a shopping or checkout page.';
    } else if (lc.includes('contact')) {
      description = 'This page likely provides contact or support information.';
    } else if (lc.includes('about')) {
      description = 'This appears to be an “About” or information page.';
    } else if (lc.includes('article') || lc.includes('blog')) {
      description = 'This seems to be an article or blog post.';
    } else if (lc.includes('search results')) {
      description = 'This page shows search results.';
    } else if (lc.includes('dashboard')) {
      description = 'This looks like a user dashboard or account overview.';
    }

    const fieldCount = this.formFields.length;
    const fieldPhrase =
      fieldCount === 0 ? 'no fillable form fields'
      : fieldCount === 1 ? '1 fillable form field'
      : `${fieldCount} fillable form fields`;

    const summary = `
      You are on ${hostname}. 
      The page title is "${title}". 
      ${description} 
      It contains approximately ${wordCount} words and ${fieldPhrase}.
    `;

    this.speak(summary);
  } catch (err) {
    console.error('Error providing summary:', err);
    this.speak('Sorry, I was unable to summarize this page.');
  }
}


  handleFormFilling() {
    if (this.formFields.length === 0) {
      this.speak('I don’t see any form fields on this page.');
      return;
    }

    this.updateStatus('Analyzing form fields...');

    const list = this.formFields.map((f, i) => {
      const req = f.required ? ' - required' : '';
      return `${i + 1}. ${f.label} (${f.type})${req}`;
    }).join('. ');

    this.speak(
      `I found ${this.formFields.length} form fields: ${list}. ` +
      'Which fields would you like to fill? You can say the numbers, like "field 1", or say the field name. ' +
      'After selecting, I will ask what to enter.'
    );
  }

  handleYesNoResponse(transcript) {
    if (transcript.includes('yes')) {
      this.speak('Great! Let’s proceed with filling the form fields.');
      this.handleFormFilling();
    } else {
      this.speak('Okay, let me know if you need help with anything else.');
    }
  }

  handleFieldValue(valueTranscript) {
    if (this.currentFieldIndex >= this.selectedFields.length) return;

    const field = this.selectedFields[this.currentFieldIndex];
    this.fillField(field, valueTranscript);
    this.currentFieldIndex++;

    if (this.currentFieldIndex < this.selectedFields.length) {
      const nextField = this.selectedFields[this.currentFieldIndex];
      this.speak(`Next field: ${nextField.label}. What would you like to enter?`);
    } else {
      this.speak('All selected fields have been filled. Is there anything else you need help with?');
      this.selectedFields = [];
      this.currentFieldIndex = 0;
    }
  }

  fillField(field, value) {
    try {
      const el = field.element;
      // Verify it still exists and is actionable
      if (!el || !el.isConnected || el.disabled || el.offsetParent === null) {
        this.speak(`Sorry, the ${field.label} field is not available.`);
        return;
      }

      // Only at this moment do we touch focus/value (prevent page jumps)
      if (typeof el.focus === 'function') {
        try { el.focus({ preventScroll: true }); } catch { try { el.focus(); } catch {} }
      }

      // Set value (do not modify attributes or styles that might affect layout)
      el.value = value;

      // Dispatch standard events so frameworks notice
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));

      // Optional: avoid extra focus/blur cycles that can cause layout thrash
      if (typeof el.blur === 'function') {
        try { el.blur(); } catch {}
      }

      this.speak(`Filled ${field.label} with ${value}.`);
    } catch (err) {
      console.error('Error filling field:', err);
      this.speak(`Sorry, I couldn’t fill the ${field.label} field.`);
    }
  }

  speak(text) {
    if (!this.isActive) return;

    this.stopSpeechSynthesis();

    const utterance = new SpeechSynthesisUtterance(text);
    utterance.volume = this.settings.volume;
    utterance.rate = this.settings.speechRate;
    utterance.lang = 'en-US';

    try {
      this.speechSynthesis.speak(utterance);
    } catch {
      // swallow TTS errors silently
    }
  }

  stopSpeechSynthesis() {
    try { this.speechSynthesis.cancel(); } catch {}
  }

  updateStatus(message) {
    try {
      chrome.runtime.sendMessage({ type: 'statusUpdate', text: message });
    } catch {
      // ignore cross-context errors
    }
  }
}

// Single-instance guard without DOM mutations
(function bootstrap() {
  if (!window.accessibilityAssistant) {
    window.accessibilityAssistant = new AccessibilityAssistant();
  }
})();
