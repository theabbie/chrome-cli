#!/usr/bin/env node

const { execSync } = require('child_process');
const { existsSync, readFileSync } = require('fs');
const { join } = require('path');

function loadEnv() {
  const envPath = join(__dirname, '.env');
  if (!existsSync(envPath)) return {};
  const content = readFileSync(envPath, 'utf-8');
  const env = {};
  content.split('\n').forEach(line => {
    const [key, ...vals] = line.split('=');
    if (key && vals.length) env[key.trim()] = vals.join('=').trim();
  });
  return env;
}

const env = loadEnv();
const DISCORD_CHANNEL_ID = env.DISCORD_CHANNEL_ID || process.env.DISCORD_CHANNEL_ID;
const MY_USER_ID = env.DISCORD_USER_ID || process.env.DISCORD_USER_ID;
const POLL_INTERVAL = parseInt(env.POLL_INTERVAL || process.env.POLL_INTERVAL || '7000');
const USER_COOLDOWN = parseInt(env.USER_COOLDOWN || process.env.USER_COOLDOWN || '60000');

if (!DISCORD_CHANNEL_ID || !MY_USER_ID) {
  console.error('Missing required config. Create .env file with:');
  console.error('  DISCORD_CHANNEL_ID=your_channel_id');
  console.error('  DISCORD_USER_ID=your_user_id');
  console.error('\nOr set environment variables.');
  process.exit(1);
}

let CHATGPT_PAGE_ID = null;
let DISCORD_PAGE_ID = null;
const REPLIED_MESSAGES = new Set();
const RECENTLY_REPLIED_USERS = new Map();

const BASE_PROMPT = `You are helping me do small talk on a Discord server. I'll give you messages from other users.

Rules:
1. Reply with SHORT, casual responses (1-2 sentences max)
2. Use hinglish (mix of Hindi and English) when appropriate
3. Use emojis sparingly
4. If the message is not worth replying to (just emojis, links, or doesn't make sense), respond with exactly: SKIP
5. Match the energy and tone of the message
6. Be friendly and relatable
7. Don't be cringe or try too hard

Format your response as just the reply text, nothing else.`;

let chatgptInitialized = false;

function runChromeCli(args) {
  try {
    const result = execSync(`chrome-cli ${args}`, { encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 });
    return JSON.parse(result);
  } catch (e) {
    console.error('chrome-cli error:', e.message);
    return null;
  }
}

function findPages() {
  try {
    const result = execSync('chrome-cli pages', { encoding: 'utf-8' });
    const pages = JSON.parse(result);
    if (pages.success && pages.pages) {
      for (const page of pages.pages) {
        if (page.url.includes('chatgpt.com')) CHATGPT_PAGE_ID = page.id;
        else if (page.url.includes('discord.com')) DISCORD_PAGE_ID = page.id;
      }
    }
    return CHATGPT_PAGE_ID && DISCORD_PAGE_ID;
  } catch (e) {
    console.error('Error finding pages:', e.message);
    return false;
  }
}

function selectPage(pageId) {
  return runChromeCli(`select-page ${pageId}`);
}

function evalOnPage(pageId, script) {
  selectPage(pageId);
  const escaped = script.replace(/'/g, "'\\''");
  return runChromeCli(`eval '${escaped}'`);
}

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function initializeChatGPT() {
  if (chatgptInitialized) return true;
  console.log('Initializing ChatGPT with base prompt...');
  
  const script = `
    (async function() {
      const editor = document.querySelector('[contenteditable="true"]');
      if (!editor) return JSON.stringify({error: 'no editor'});
      editor.focus();
      editor.innerHTML = '<p>${BASE_PROMPT.replace(/\n/g, '</p><p>').replace(/'/g, "\\'")}</p>';
      editor.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise(r => setTimeout(r, 500));
      const buttons = Array.from(document.querySelectorAll('button'));
      const sendBtn = buttons.find(b => (b.getAttribute('aria-label') || '').toLowerCase().includes('send'));
      if (sendBtn) { sendBtn.click(); return JSON.stringify({success: true}); }
      return JSON.stringify({error: 'no send button'});
    })();
  `;
  
  const result = evalOnPage(CHATGPT_PAGE_ID, script);
  if (result?.success && result?.result) {
    const parsed = JSON.parse(result.result);
    if (parsed.success) {
      console.log('Waiting for ChatGPT to process base prompt...');
      await sleep(10000);
      chatgptInitialized = true;
      return true;
    }
  }
  console.error('Failed to initialize ChatGPT');
  return false;
}

async function getDiscordMessages() {
  const script = `
    (async function() {
      let token;
      const iframe = document.createElement('iframe');
      iframe.style.display = 'none';
      document.body.appendChild(iframe);
      token = iframe.contentWindow.localStorage.getItem('token');
      iframe.remove();
      token = token.replace(/^"|"$/g, '');
      const response = await fetch('https://discord.com/api/v9/channels/${DISCORD_CHANNEL_ID}/messages?limit=20', {
        headers: { 'Authorization': token }
      });
      const messages = await response.json();
      if (!Array.isArray(messages)) return JSON.stringify({error: 'API error'});
      return JSON.stringify(messages.map(m => ({
        id: m.id,
        author: m.author?.username,
        authorId: m.author?.id,
        content: m.content
      })));
    })();
  `;
  
  const result = evalOnPage(DISCORD_PAGE_ID, script);
  if (result?.success && result?.result) return JSON.parse(result.result);
  return [];
}

async function askChatGPT(message, author) {
  const prompt = `User "${author}" says: "${message}"\n\nReply naturally:`;
  const script = `
    (async function() {
      const editor = document.querySelector('[contenteditable="true"]');
      if (!editor) return JSON.stringify({error: 'no editor'});
      editor.focus();
      editor.innerHTML = '<p>${prompt.replace(/\n/g, '</p><p>').replace(/'/g, "\\'").replace(/"/g, '\\"')}</p>';
      editor.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise(r => setTimeout(r, 300));
      const buttons = Array.from(document.querySelectorAll('button'));
      const sendBtn = buttons.find(b => (b.getAttribute('aria-label') || '').toLowerCase().includes('send'));
      if (sendBtn) { sendBtn.click(); return JSON.stringify({success: true}); }
      return JSON.stringify({error: 'no send button'});
    })();
  `;
  
  const result = evalOnPage(CHATGPT_PAGE_ID, script);
  if (!result?.success) return null;
  
  await sleep(8000);
  
  const getResponseScript = `
    (function() {
      const messages = document.querySelectorAll('[data-message-author-role="assistant"]');
      if (messages.length === 0) return JSON.stringify({error: 'no response'});
      const lastResponse = messages[messages.length - 1];
      return JSON.stringify({response: lastResponse?.innerText?.trim()});
    })();
  `;
  
  const responseResult = evalOnPage(CHATGPT_PAGE_ID, getResponseScript);
  if (responseResult?.success && responseResult?.result) {
    const parsed = JSON.parse(responseResult.result);
    return parsed.response;
  }
  return null;
}

async function sendDiscordReply(messageId, content) {
  const script = `
    (async function() {
      let token;
      const iframe = document.createElement('iframe');
      iframe.style.display = 'none';
      document.body.appendChild(iframe);
      token = iframe.contentWindow.localStorage.getItem('token');
      iframe.remove();
      token = token.replace(/^"|"$/g, '');
      const response = await fetch('https://discord.com/api/v9/channels/${DISCORD_CHANNEL_ID}/messages', {
        method: 'POST',
        headers: { 'Authorization': token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          content: '${content.replace(/'/g, "\\'").replace(/\n/g, ' ')}',
          message_reference: { message_id: '${messageId}' }
        })
      });
      const result = await response.json();
      return JSON.stringify({success: response.ok, id: result.id});
    })();
  `;
  
  const result = evalOnPage(DISCORD_PAGE_ID, script);
  return result?.success;
}

function isUserOnCooldown(userId) {
  const lastReply = RECENTLY_REPLIED_USERS.get(userId);
  if (!lastReply) return false;
  return (Date.now() - lastReply) < USER_COOLDOWN;
}

function markUserReplied(userId) {
  RECENTLY_REPLIED_USERS.set(userId, Date.now());
}

async function processMessages() {
  console.log('\nFetching Discord messages...');
  const messages = await getDiscordMessages();
  
  if (!Array.isArray(messages) || messages.length === 0) {
    console.log('No messages found');
    return;
  }
  
  const worthReplying = messages.filter(m => {
    if (m.authorId === MY_USER_ID) return false;
    if (REPLIED_MESSAGES.has(m.id)) return false;
    if (!m.content || m.content.length < 3) return false;
    if (m.content.match(/^<:[^>]+>$/)) return false;
    if (m.content.match(/^https?:\/\//)) return false;
    return true;
  });
  
  console.log(`Found ${worthReplying.length} messages worth considering`);
  
  const prioritized = worthReplying
    .map(m => ({ ...m, onCooldown: isUserOnCooldown(m.authorId) }))
    .sort((a, b) => {
      if (a.onCooldown !== b.onCooldown) return a.onCooldown ? 1 : -1;
      return worthReplying.indexOf(b) - worthReplying.indexOf(a);
    });
  
  const msg = prioritized.find(m => !m.onCooldown);
  
  if (!msg) {
    console.log('All users on cooldown, skipping this round');
    return;
  }
  
  console.log(`\nProcessing message from ${msg.author}: "${msg.content.substring(0, 50)}..."`);
  
  const response = await askChatGPT(msg.content, msg.author);
  
  if (response && response !== 'SKIP' && !response.includes('SKIP')) {
    console.log(`ChatGPT response: "${response}"`);
    const sent = await sendDiscordReply(msg.id, response);
    if (sent) {
      console.log('Reply sent successfully!');
      REPLIED_MESSAGES.add(msg.id);
      markUserReplied(msg.authorId);
    } else {
      console.log('Failed to send reply');
    }
  } else {
    console.log('ChatGPT decided to skip this message');
    REPLIED_MESSAGES.add(msg.id);
  }
}

async function main() {
  console.log('=== Discord-ChatGPT Auto-Responder ===\n');
  console.log(`Channel: ${DISCORD_CHANNEL_ID}`);
  console.log(`User ID: ${MY_USER_ID}`);
  console.log(`Poll interval: ${POLL_INTERVAL}ms`);
  console.log(`User cooldown: ${USER_COOLDOWN}ms\n`);
  
  console.log('Finding browser tabs...');
  if (!findPages()) {
    console.error('Could not find ChatGPT and Discord tabs. Make sure both are open.');
    process.exit(1);
  }
  console.log(`Found ChatGPT: ${CHATGPT_PAGE_ID}`);
  console.log(`Found Discord: ${DISCORD_PAGE_ID}\n`);
  
  const initialized = await initializeChatGPT();
  if (!initialized) {
    console.error('Failed to initialize. Make sure ChatGPT tab is open.');
    process.exit(1);
  }
  
  console.log('ChatGPT initialized! Starting message polling...\n');
  
  while (true) {
    try {
      await processMessages();
    } catch (e) {
      console.error('Error processing messages:', e.message);
    }
    console.log(`\nWaiting ${POLL_INTERVAL/1000}s before next poll...`);
    await sleep(POLL_INTERVAL);
  }
}

main().catch(console.error);
