import express, { Request, Response } from 'express';
import puppeteer, { Browser, Page } from 'puppeteer';
import { writeFileSync, existsSync, mkdirSync, readFileSync, unlinkSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { execSync, spawn } from 'child_process';

const CONFIG_DIR = join(homedir(), '.chrome-cli');
const PID_FILE = join(CONFIG_DIR, 'daemon.pid');
const PORT_FILE = join(CONFIG_DIR, 'daemon.port');
const DEFAULT_PORT = 9234;

function getChromePath(): string {
  const platform = process.platform;
  if (platform === 'darwin') {
    return '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  } else if (platform === 'win32') {
    return 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  }
  return '/usr/bin/google-chrome';
}

function getUserDataDir(): string {
  const platform = process.platform;
  if (platform === 'darwin') {
    return join(homedir(), 'Library/Application Support/Google/Chrome');
  } else if (platform === 'win32') {
    return join(homedir(), 'AppData/Local/Google/Chrome/User Data');
  }
  return join(homedir(), '.config/google-chrome');
}

const CHROME_PATH = getChromePath();
const USER_DATA_DIR = getUserDataDir();

interface SessionState {
  browser: Browser | null;
  pages: Map<string, Page>;
  currentPageId: string | null;
  consoleMessages: Map<string, Array<{ type: string; text: string; timestamp: number }>>;
  networkRequests: Map<string, Array<{ url: string; method: string; status: number; type: string }>>;
}

const state: SessionState = {
  browser: null,
  pages: new Map(),
  currentPageId: null,
  consoleMessages: new Map(),
  networkRequests: new Map(),
};

function ensureConfigDir(): void {
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true });
  }
}

function isChromeRunning(): boolean {
  try {
    execSync('pgrep -x "Google Chrome"', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

async function startChromeWithDebugging(): Promise<void> {
  const usePersonalProfile = !isChromeRunning();
  const profileDir = usePersonalProfile ? USER_DATA_DIR : join(CONFIG_DIR, 'chrome-profile');
  
  if (!usePersonalProfile && !existsSync(profileDir)) {
    mkdirSync(profileDir, { recursive: true });
  }
  
  const chromeProcess = spawn(CHROME_PATH, [
    `--remote-debugging-port=9222`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
  ], {
    detached: true,
    stdio: 'ignore',
  });
  chromeProcess.unref();
  
  await new Promise(resolve => setTimeout(resolve, 2000));
}

async function launchBrowser(): Promise<Browser> {
  if (state.browser) {
    return state.browser;
  }
  
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      state.browser = await puppeteer.connect({
        browserURL: 'http://127.0.0.1:9222',
        defaultViewport: null,
      });
      break;
    } catch {
      if (attempt === 0) {
        await startChromeWithDebugging();
      }
    }
  }
  
  if (!state.browser) {
    throw new Error('Failed to connect to Chrome. Please start Chrome with: /Applications/Google\\ Chrome.app/Contents/MacOS/Google\\ Chrome --remote-debugging-port=9222');
  }
  
  state.browser.on('disconnected', () => {
    state.browser = null;
    state.pages.clear();
    state.currentPageId = null;
  });
  
  return state.browser;
}

async function isPageValid(page: Page): Promise<boolean> {
  try {
    await page.evaluate('1');
    return true;
  } catch {
    return false;
  }
}

async function getOrCreatePage(pageId?: string): Promise<{ page: Page; pageId: string }> {
  const browser = await launchBrowser();
  
  if (pageId && state.pages.has(pageId)) {
    const page = state.pages.get(pageId)!;
    if (await isPageValid(page)) {
      return { page, pageId };
    }
    state.pages.delete(pageId);
  }
  
  if (state.currentPageId && state.pages.has(state.currentPageId)) {
    const page = state.pages.get(state.currentPageId)!;
    if (await isPageValid(page)) {
      return { page, pageId: state.currentPageId };
    }
    state.pages.delete(state.currentPageId);
    state.currentPageId = null;
  }
  
  const existingPages = await browser.pages();
  const reusablePage = existingPages.find(p => {
    const url = p.url();
    return url === 'about:blank' || url === 'chrome://newtab/' || url.startsWith('chrome://newtab');
  });
  
  const page = reusablePage || await browser.newPage();
  const newPageId = `page_${Date.now()}`;
  
  state.pages.set(newPageId, page);
  state.currentPageId = newPageId;
  state.consoleMessages.set(newPageId, []);
  state.networkRequests.set(newPageId, []);
  
  page.on('console', (msg) => {
    const messages = state.consoleMessages.get(newPageId) || [];
    messages.push({ type: msg.type(), text: msg.text(), timestamp: Date.now() });
    if (messages.length > 1000) messages.shift();
  });
  
  page.on('request', (req) => {
    const requests = state.networkRequests.get(newPageId) || [];
    requests.push({ url: req.url(), method: req.method(), status: 0, type: req.resourceType() });
    if (requests.length > 1000) requests.shift();
  });
  
  page.on('response', (res) => {
    const requests = state.networkRequests.get(newPageId) || [];
    const req = requests.find(r => r.url === res.url() && r.status === 0);
    if (req) req.status = res.status();
  });
  
  return { page, pageId: newPageId };
}

const app = express();
app.use(express.json());

app.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', browser: !!state.browser, pages: state.pages.size });
});

app.post('/navigate', async (req: Request, res: Response) => {
  try {
    const { url } = req.body;
    const { page, pageId } = await getOrCreatePage();
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
    const title = await page.title();
    res.json({ success: true, pageId, title, url: page.url() });
  } catch (err) {
    res.status(500).json({ success: false, error: String(err) });
  }
});

app.post('/screenshot', async (req: Request, res: Response) => {
  try {
    const { output, fullPage = false } = req.body;
    const { page, pageId } = await getOrCreatePage();
    const path = output || join(CONFIG_DIR, `screenshot_${Date.now()}.png`);
    await page.screenshot({ path, fullPage });
    res.json({ success: true, pageId, path });
  } catch (err) {
    res.status(500).json({ success: false, error: String(err) });
  }
});

app.post('/click', async (req: Request, res: Response) => {
  try {
    const { selector } = req.body;
    const { page, pageId } = await getOrCreatePage();
    await page.click(selector);
    res.json({ success: true, pageId });
  } catch (err) {
    res.status(500).json({ success: false, error: String(err) });
  }
});

app.post('/fill', async (req: Request, res: Response) => {
  try {
    const { selector, value } = req.body;
    const { page, pageId } = await getOrCreatePage();
    await page.type(selector, value);
    res.json({ success: true, pageId });
  } catch (err) {
    res.status(500).json({ success: false, error: String(err) });
  }
});

app.post('/evaluate', async (req: Request, res: Response) => {
  try {
    const { script } = req.body;
    const { page, pageId } = await getOrCreatePage();
    const result = await page.evaluate(script);
    res.json({ success: true, pageId, result });
  } catch (err) {
    res.status(500).json({ success: false, error: String(err) });
  }
});

app.get('/console', async (req: Request, res: Response) => {
  try {
    const { page: pageId } = req.query;
    const id = pageId as string || state.currentPageId;
    const messages = id ? state.consoleMessages.get(id) || [] : [];
    res.json({ success: true, pageId: id, messages });
  } catch (err) {
    res.status(500).json({ success: false, error: String(err) });
  }
});

app.get('/network', async (req: Request, res: Response) => {
  try {
    const { page: pageId } = req.query;
    const id = pageId as string || state.currentPageId;
    const requests = id ? state.networkRequests.get(id) || [] : [];
    res.json({ success: true, pageId: id, requests });
  } catch (err) {
    res.status(500).json({ success: false, error: String(err) });
  }
});

app.get('/pages', async (_req: Request, res: Response) => {
  try {
    const pages: Array<{ id: string; url: string; title: string }> = [];
    for (const [id, page] of state.pages) {
      try {
        pages.push({ id, url: page.url(), title: await page.title() });
      } catch {
        pages.push({ id, url: 'unknown', title: 'unknown' });
      }
    }
    res.json({ success: true, currentPageId: state.currentPageId, pages });
  } catch (err) {
    res.status(500).json({ success: false, error: String(err) });
  }
});

app.post('/select-page', async (req: Request, res: Response) => {
  try {
    const { pageId } = req.body;
    if (state.pages.has(pageId)) {
      state.currentPageId = pageId;
      const page = state.pages.get(pageId)!;
      await page.bringToFront();
      res.json({ success: true, pageId });
    } else {
      res.status(404).json({ success: false, error: 'Page not found' });
    }
  } catch (err) {
    res.status(500).json({ success: false, error: String(err) });
  }
});

app.post('/new-page', async (req: Request, res: Response) => {
  try {
    const { url } = req.body;
    const browser = await launchBrowser();
    const page = await browser.newPage();
    const pageId = `page_${Date.now()}`;
    
    state.pages.set(pageId, page);
    state.currentPageId = pageId;
    state.consoleMessages.set(pageId, []);
    state.networkRequests.set(pageId, []);
    
    if (url) {
      await page.goto(url, { waitUntil: 'networkidle2' });
    }
    
    res.json({ success: true, pageId, url: page.url() });
  } catch (err) {
    res.status(500).json({ success: false, error: String(err) });
  }
});

app.post('/close-page', async (req: Request, res: Response) => {
  try {
    const { pageId } = req.body;
    const id = pageId || state.currentPageId;
    if (id && state.pages.has(id)) {
      const page = state.pages.get(id)!;
      await page.close();
      state.pages.delete(id);
      state.consoleMessages.delete(id);
      state.networkRequests.delete(id);
      if (state.currentPageId === id) {
        state.currentPageId = state.pages.keys().next().value || null;
      }
      res.json({ success: true });
    } else {
      res.status(404).json({ success: false, error: 'Page not found' });
    }
  } catch (err) {
    res.status(500).json({ success: false, error: String(err) });
  }
});

app.post('/wait', async (req: Request, res: Response) => {
  try {
    const { selector, text, timeout = 5000 } = req.body;
    const { page, pageId } = await getOrCreatePage();
    
    if (selector) {
      await page.waitForSelector(selector, { timeout });
    } else if (text) {
      await page.waitForFunction(
        `document.body.innerText.includes("${text.replace(/"/g, '\\"')}")`,
        { timeout }
      );
    }
    
    res.json({ success: true, pageId });
  } catch (err) {
    res.status(500).json({ success: false, error: String(err) });
  }
});

app.post('/snapshot', async (req: Request, res: Response) => {
  try {
    const { output } = req.body;
    const { page, pageId } = await getOrCreatePage();
    
    const snapshot = await page.evaluate(`
      (function() {
        function getSnapshot(el, depth) {
          depth = depth || 0;
          if (depth > 10) return '';
          var tag = el.tagName.toLowerCase();
          var id = el.id ? '#' + el.id : '';
          var cls = el.className && typeof el.className === 'string' 
            ? '.' + el.className.split(' ').filter(Boolean).join('.') 
            : '';
          var text = el.textContent ? el.textContent.trim().slice(0, 50) : '';
          var indent = '  '.repeat(depth);
          var result = indent + tag + id + cls + (text ? ' "' + text + '"' : '') + '\\n';
          for (var i = 0; i < el.children.length; i++) {
            result += getSnapshot(el.children[i], depth + 1);
          }
          return result;
        }
        return getSnapshot(document.body, 0);
      })()
    `);
    
    if (output) {
      writeFileSync(output, String(snapshot));
    }
    
    res.json({ success: true, pageId, snapshot: output ? `Saved to ${output}` : snapshot });
  } catch (err) {
    res.status(500).json({ success: false, error: String(err) });
  }
});

app.post('/shutdown', async (_req: Request, res: Response) => {
  res.json({ success: true, message: 'Shutting down' });
  if (state.browser) {
    await state.browser.close();
  }
  try { unlinkSync(PID_FILE); } catch {}
  try { unlinkSync(PORT_FILE); } catch {}
  process.exit(0);
});

function startDaemon(port: number): void {
  ensureConfigDir();
  
  app.listen(port, () => {
    writeFileSync(PID_FILE, String(process.pid));
    writeFileSync(PORT_FILE, String(port));
    console.log(`Chrome CLI daemon running on port ${port}`);
    console.log(`PID: ${process.pid}`);
    console.log(`Config dir: ${CONFIG_DIR}`);
  });
}

const port = parseInt(process.argv[2] || String(DEFAULT_PORT), 10);
startDaemon(port);
