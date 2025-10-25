# Accessibility Assistant Chrome Extension

A Chrome extension designed to help lower visibility users navigate and interact with websites through audio assistance and form filling capabilities.

## Features

- **Audio Navigation**: Provides audio summaries of webpage content
- **Form Field Detection**: Automatically identifies fillable form fields on any webpage
- **Voice Interaction**: Users can interact with the extension using voice commands
- **Smart Form Filling**: Guides users through filling form fields one by one
- **Accessibility Focused**: Designed specifically for users with visual impairments

## Installation

1. Download or clone this repository
2. Open Chrome and navigate to `chrome://extensions/`
3. Enable "Developer mode" in the top right corner
4. Click "Load unpacked" and select the extension folder
5. The extension should now appear in your Chrome toolbar

## Usage

### Getting Started

1. Navigate to any website where you need assistance
2. Click the Accessibility Assistant extension icon in your Chrome toolbar
3. Click "Start Assistant" to begin

### Voice Commands

The extension will ask you what you'd like to do. You can respond with:

- **"Summary"** - Get an audio summary of the webpage content
- **"Fill in the blanks"** or **"Fill the form"** - Get help filling out form fields

### Form Filling Process

1. When you choose to fill forms, the extension will:
   - Identify all form fields on the page
   - List them for you with descriptions
   - Ask which fields you want to fill

2. You can specify fields by:
   - Saying the field number (e.g., "field 1", "field 3")
   - Saying the field name or description

3. For each selected field, the extension will:
   - Read the field label aloud
   - Ask what you want to enter
   - Fill the field with your response
   - Move to the next field

### Controls

The extension popup includes:
- **Start/Stop Assistant**: Control the assistant
- **Volume Controls**: Adjust speech volume
- **Speed Controls**: Adjust speech rate
- **Status Display**: Shows current assistant status

## Technical Details

### Files Structure

- `manifest.json` - Extension configuration
- `popup.html` - Extension popup interface
- `popup.js` - Popup functionality
- `content.js` - Main assistant logic (runs on web pages)
- `background.js` - Background service worker

### Permissions

- `activeTab` - Access to current tab content
- `storage` - Save user preferences
- `scripting` - Inject content scripts
- `<all_urls>` - Work on any website

### Browser Compatibility

- Requires Chrome with Web Speech API support
- Uses modern JavaScript features (ES6+)
- Compatible with Chrome Manifest V3

## Development

To modify or extend the extension:

1. Make changes to the source files
2. Go to `chrome://extensions/`
3. Click the refresh icon on the extension
4. Test your changes

## Privacy

- All speech processing happens locally in your browser
- No data is sent to external servers
- Form data is only filled locally on the webpage

## Troubleshooting

### Speech Recognition Not Working
- Ensure your microphone is enabled for the website
- Check that Chrome has permission to access your microphone
- Try refreshing the page and restarting the assistant

### Form Fields Not Detected
- Some forms may use JavaScript to create fields dynamically
- Try waiting a moment for the page to fully load
- Some fields may be hidden or not accessible

### Audio Not Playing
- Check your system volume
- Ensure Chrome isn't muted
- Try adjusting the volume controls in the extension popup

## Support

This extension is designed to be as accessible as possible. If you encounter issues:

1. Check the browser console for error messages
2. Ensure you're using a supported browser
3. Try refreshing the page and restarting the assistant

## License

This project is open source and available under the MIT License.
