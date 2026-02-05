# Chrome CLI + Discord-ChatGPT Bot

A CLI tool for Chrome browser automation with persistent sessions, plus an AI-powered Discord auto-responder that uses ChatGPT for intelligent small talk.

## Features

- **chrome-cli**: Command-line interface for Chrome automation
- **discord-chatgpt-bot**: Automated Discord responder powered by ChatGPT
- Cross-platform support (macOS, Linux, Windows)
- Persistent browser sessions
- Multi-tab management

## Installation

```bash
git clone https://github.com/theabbie/chrome-cli.git
cd chrome-cli
npm install
npm run build
npm link
```

## Quick Start

### 1. Start Chrome with Remote Debugging

```bash
# macOS
./scripts/start-chrome.sh

# Or manually:
# macOS
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --remote-debugging-port=9222 --user-data-dir="$HOME/.chrome-cli/debug-profile"

# Linux
google-chrome --remote-debugging-port=9222 --user-data-dir="$HOME/.chrome-cli/debug-profile"

# Windows
"C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222 --user-data-dir="%USERPROFILE%\.chrome-cli\debug-profile"
```

### 2. Use chrome-cli Commands

```bash
chrome-cli navigate https://example.com
chrome-cli screenshot -o ./screenshot.png
chrome-cli eval "document.title"
chrome-cli pages
chrome-cli stop
```

## Discord-ChatGPT Bot

An automated Discord responder that uses ChatGPT to generate contextual replies.

### Setup

1. Create `.env` file:
```bash
cp .env.example .env
```

2. Edit `.env` with your Discord details:
```
DISCORD_CHANNEL_ID=your_channel_id_here
DISCORD_USER_ID=your_user_id_here
POLL_INTERVAL=7000
USER_COOLDOWN=60000
```

### Finding Your Discord IDs

**Channel ID:**
1. Enable Developer Mode in Discord (Settings → Advanced → Developer Mode)
2. Right-click the channel → Copy ID

**User ID:**
1. Right-click your username → Copy ID

### Running the Bot

1. Start Chrome with debugging enabled
2. Open Discord in one tab, log in to your channel
3. Open ChatGPT (chatgpt.com) in another tab, start a new chat
4. Run the bot:

```bash
node discord-chatgpt-bot.cjs
```

### How It Works

1. Bot sends a base prompt to ChatGPT defining the conversation style
2. Polls Discord for new messages every 7 seconds
3. Filters messages worth replying to (skips emojis, links, short messages)
4. Sends each message to ChatGPT for a response
5. Posts the response as a reply on Discord
6. Applies cooldown per user to avoid spam

### Configuration Options

| Variable | Default | Description |
|----------|---------|-------------|
| `DISCORD_CHANNEL_ID` | required | Target Discord channel |
| `DISCORD_USER_ID` | required | Your Discord user ID (to skip own messages) |
| `POLL_INTERVAL` | 7000 | Milliseconds between message checks |
| `USER_COOLDOWN` | 60000 | Cooldown per user before replying again |

## Tips for AI Integration

### Customizing the ChatGPT Prompt

Edit the `BASE_PROMPT` in `discord-chatgpt-bot.cjs` to change the bot's personality:

```javascript
const BASE_PROMPT = `You are helping me do small talk on a Discord server.

Rules:
1. Reply with SHORT, casual responses (1-2 sentences max)
2. Use hinglish when appropriate
3. Use emojis sparingly
4. If not worth replying, respond with: SKIP
5. Match the energy of the message
6. Be friendly and relatable
`;
```

### Prompt Tips

- **Language**: Specify the language/style (e.g., "Use hinglish", "Be formal")
- **Length**: Control response length ("1-2 sentences max")
- **Skip logic**: Define when to skip ("just emojis", "doesn't make sense")
- **Personality**: Set the tone ("friendly", "sarcastic", "professional")

### Using with Other AI Services

The bot uses ChatGPT's web interface. To use other AI services:

1. Open the AI service in a browser tab instead of ChatGPT
2. Modify `findPages()` to detect your AI service URL
3. Update `initializeChatGPT()` and `askChatGPT()` to match the AI's DOM structure

### Rate Limiting

- `POLL_INTERVAL`: How often to check for new messages
- `USER_COOLDOWN`: Prevents replying to the same user too frequently
- The bot processes one message per poll cycle to avoid spam

## chrome-cli Commands

| Command | Description |
|---------|-------------|
| `navigate <url>` | Go to URL |
| `screenshot [-o path] [-f]` | Take screenshot (-f for full page) |
| `click <selector>` | Click element |
| `fill <selector> <value>` | Fill input field |
| `eval <script>` | Run JavaScript |
| `console` | Get console logs |
| `network` | Get network requests |
| `pages` | List open pages |
| `new-page [-u url]` | Open new page |
| `select-page <pageId>` | Switch to page |
| `close-page` | Close current page |
| `wait [-s selector] [-t text]` | Wait for element/text |
| `snapshot [-o path]` | Get DOM snapshot |
| `status` | Check daemon status |
| `stop` | Stop daemon and browser |

## Architecture

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│  chrome-cli │────▶│   daemon    │────▶│   Chrome    │
│    (CLI)    │     │  (Express)  │     │ (Puppeteer) │
└─────────────┘     └─────────────┘     └─────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────┐
│              discord-chatgpt-bot.cjs                │
│  ┌─────────┐    ┌─────────┐    ┌─────────────────┐  │
│  │ Discord │◀──▶│  Bot    │◀──▶│    ChatGPT      │  │
│  │   Tab   │    │  Logic  │    │      Tab        │  │
│  └─────────┘    └─────────┘    └─────────────────┘  │
└─────────────────────────────────────────────────────┘
```

## Troubleshooting

**"Could not find ChatGPT and Discord tabs"**
- Make sure both tabs are open in the debug Chrome instance
- Verify you started Chrome with `--remote-debugging-port=9222`

**"Failed to initialize ChatGPT"**
- Ensure ChatGPT tab is on a new/empty chat
- Check that you're logged into ChatGPT

**Messages not being sent to Discord**
- Verify your `DISCORD_CHANNEL_ID` is correct
- Make sure you're logged into Discord in the debug Chrome

**Bot replying too fast/slow**
- Adjust `POLL_INTERVAL` in `.env`
- Increase `USER_COOLDOWN` to reduce reply frequency

## License

MIT
