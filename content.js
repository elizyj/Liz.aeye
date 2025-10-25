class AccessibilityAssistant {
  constructor() {
    this.isActive = false;
    this.speechRecognition = null;
    this.speechSynthesis = window.speechSynthesis;
    this.formFields = [];
    this.currentFieldIndex = 0;
    this.selectedFields = [];
    this.settings = { volume: 0.8, speechRate: 1.0 };
    
    this.init();
  }

  init() {
    // Load settings from storage
    chrome.storage.local.get(['volume', 'speechRate'], (result) => {
      this.settings = { ...this.settings, ...result };
    });

    // Listen for messages from popup
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (message.action === 'startAssistant') {
        this.startAssistant();
      } else if (message.action === 'stopAssistant') {
        this.stopAssistant();
      }
    });
  }

  startAssistant() {
    this.isActive = true;
    this.updateStatus('Assistant started. Analyzing page...');
    
    // Wait a moment for page to fully load
    setTimeout(() => {
      this.analyzePage();
    }, 1000);
  }

  stopAssistant() {
    this.isActive = false;
    this.stopSpeechRecognition();
    this.stopSpeechSynthesis();
    this.updateStatus('Assistant stopped');
  }

  analyzePage() {
    this.updateStatus('Analyzing page content...');
    
    // Extract page content
    const pageContent = this.extractPageContent();
    
    // Find form fields
    this.formFields = this.findFormFields();
    
    // Speak the initial options
    this.speak('Welcome to the Accessibility Assistant. I can help you with this webpage in two ways: I can provide a summary of the page content, or I can help you fill in form fields. Would you like a summary or to fill in the blanks?');
    
    // Start listening for user response
    this.startSpeechRecognition();
  }

  extractPageContent() {
    // Remove script and style elements
    const scripts = document.querySelectorAll('script, style, nav, header, footer');
    scripts.forEach(el => el.remove());
    
    // Get main content
    const mainContent = document.querySelector('main') || document.body;
    return mainContent.innerText || mainContent.textContent || '';
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
      const elements = document.querySelectorAll(selector);
      elements.forEach((element, index) => {
        if (element.offsetParent !== null) { // Check if element is visible
          fields.push({
            element: element,
            type: element.type || element.tagName.toLowerCase(),
            name: element.name || element.id || `field-${index}`,
            label: this.getFieldLabel(element),
            placeholder: element.placeholder || '',
            required: element.required || false
          });
        }
      });
    });

    return fields;
  }

  getFieldLabel(element) {
    // Try to find associated label
    const label = document.querySelector(`label[for="${element.id}"]`);
    if (label) return label.textContent.trim();
    
    // Try aria-label
    if (element.getAttribute('aria-label')) {
      return element.getAttribute('aria-label');
    }
    
    // Try placeholder
    if (element.placeholder) {
      return element.placeholder;
    }
    
    // Try name attribute
    if (element.name) {
      return element.name.replace(/[-_]/g, ' ');
    }
    
    return 'Unlabeled field';
  }

  startSpeechRecognition() {
    if (!('webkitSpeechRecognition' in window) && !('SpeechRecognition' in window)) {
      this.speak('Speech recognition is not supported in this browser.');
      return;
    }

    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    this.speechRecognition = new SpeechRecognition();
    
    this.speechRecognition.continuous = false;
    this.speechRecognition.interimResults = false;
    this.speechRecognition.lang = 'en-US';

    this.speechRecognition.onresult = (event) => {
      const transcript = event.results[0][0].transcript.toLowerCase();
      this.handleUserInput(transcript);
    };

    this.speechRecognition.onerror = (event) => {
      console.error('Speech recognition error:', event.error);
      this.speak('Sorry, I didn\'t catch that. Please try again.');
      this.startSpeechRecognition();
    };

    this.speechRecognition.onend = () => {
      if (this.isActive) {
        this.startSpeechRecognition();
      }
    };

    this.speechRecognition.start();
  }

  stopSpeechRecognition() {
    if (this.speechRecognition) {
      this.speechRecognition.stop();
      this.speechRecognition = null;
    }
  }

  handleUserInput(transcript) {
    console.log('User said:', transcript);
    
    if (transcript.includes('summary') || transcript.includes('summarize')) {
      this.provideSummary();
    } else if (transcript.includes('fill') || transcript.includes('blank') || transcript.includes('form')) {
      this.handleFormFilling();
    } else if (transcript.includes('yes') || transcript.includes('no')) {
      this.handleYesNoResponse(transcript);
    } else if (this.selectedFields.length > 0) {
      this.handleFieldValue(transcript);
    } else {
      this.speak('I didn\'t understand. Please say "summary" for a page summary or "fill in the blanks" to fill form fields.');
    }
  }

  provideSummary() {
    this.updateStatus('Providing page summary...');
    const content = this.extractPageContent();
    const summary = this.generateSummary(content);
    this.speak(summary);
  }

  generateSummary(content) {
    // Simple summary generation - in a real app, you might use AI
    const sentences = content.split(/[.!?]+/).filter(s => s.trim().length > 20);
    const summary = sentences.slice(0, 5).join('. ');
    return `This page contains: ${summary}. The page has ${this.formFields.length} form fields that can be filled.`;
  }

  handleFormFilling() {
    if (this.formFields.length === 0) {
      this.speak('I don\'t see any form fields on this page.');
      return;
    }

    this.updateStatus('Analyzing form fields...');
    let fieldDescription = `I found ${this.formFields.length} form fields: `;
    
    this.formFields.forEach((field, index) => {
      fieldDescription += `${index + 1}. ${field.label} (${field.type})`;
      if (field.required) fieldDescription += ' - required';
      fieldDescription += '. ';
    });

    fieldDescription += 'Which fields would you like to fill? You can say the numbers or names.';
    
    this.speak(fieldDescription);
  }

  handleYesNoResponse(transcript) {
    if (transcript.includes('yes')) {
      this.speak('Great! Let\'s proceed with filling the form fields.');
      this.handleFormFilling();
    } else {
      this.speak('Okay, let me know if you need help with anything else.');
    }
  }

  handleFieldValue(transcript) {
    if (this.currentFieldIndex < this.selectedFields.length) {
      const field = this.selectedFields[this.currentFieldIndex];
      this.fillField(field, transcript);
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
  }

  fillField(field, value) {
    try {
      const element = field.element;
      element.focus();
      element.value = value;
      
      // Trigger change event
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
      
      this.speak(`Filled ${field.label} with ${value}`);
    } catch (error) {
      console.error('Error filling field:', error);
      this.speak(`Sorry, I couldn't fill the ${field.label} field.`);
    }
  }

  speak(text) {
    if (!this.isActive) return;
    
    this.stopSpeechSynthesis();
    
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.volume = this.settings.volume;
    utterance.rate = this.settings.speechRate;
    utterance.lang = 'en-US';
    
    utterance.onend = () => {
      console.log('Speech completed');
    };
    
    this.speechSynthesis.speak(utterance);
  }

  stopSpeechSynthesis() {
    this.speechSynthesis.cancel();
  }

  updateStatus(message) {
    chrome.runtime.sendMessage({
      type: 'statusUpdate',
      text: message
    });
  }
}

// Initialize the assistant when the page loads
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    window.accessibilityAssistant = new AccessibilityAssistant();
  });
} else {
  window.accessibilityAssistant = new AccessibilityAssistant();
}
