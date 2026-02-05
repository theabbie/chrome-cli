#!/usr/bin/env node

import { program } from 'commander';
import { spawn, execSync } from 'child_process';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const CONFIG_DIR = join(homedir(), '.chrome-cli');
const PID_FILE = join(CONFIG_DIR, 'daemon.pid');
const PORT_FILE = join(CONFIG_DIR, 'daemon.port');
const DEFAULT_PORT = 9234;

function getDaemonPort(): number {
  if (existsSync(PORT_FILE)) {
    return parseInt(readFileSync(PORT_FILE, 'utf-8').trim(), 10);
  }
  return DEFAULT_PORT;
}

function isDaemonRunning(): boolean {
  if (!existsSync(PID_FILE)) return false;
  const pid = readFileSync(PID_FILE, 'utf-8').trim();
  try {
    process.kill(parseInt(pid, 10), 0);
    return true;
  } catch {
    return false;
  }
}

async function ensureDaemon(): Promise<number> {
  if (isDaemonRunning()) {
    return getDaemonPort();
  }
  
  const port = DEFAULT_PORT;
  const daemonPath = join(__dirname, 'daemon.js');
  const tsPath = join(__dirname, '..', 'src', 'daemon.ts');
  
  let cmd: string;
  let args: string[];
  
  if (existsSync(daemonPath)) {
    cmd = 'node';
    args = [daemonPath, String(port)];
  } else if (existsSync(tsPath)) {
    cmd = 'npx';
    args = ['tsx', tsPath, String(port)];
  } else {
    throw new Error('Daemon not found. Run npm run build first.');
  }
  
  const child = spawn(cmd, args, {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  
  await new Promise(resolve => setTimeout(resolve, 2000));
  
  if (!isDaemonRunning()) {
    throw new Error('Failed to start daemon');
  }
  
  return port;
}

async function callDaemon(method: string, path: string, body?: object): Promise<unknown> {
  const port = await ensureDaemon();
  const url = `http://127.0.0.1:${port}${path}`;
  
  const options: RequestInit = {
    method,
    headers: { 'Content-Type': 'application/json' },
  };
  
  if (body) {
    options.body = JSON.stringify(body);
  }
  
  const response = await fetch(url, options);
  return response.json();
}

function output(data: unknown): void {
  console.log(JSON.stringify(data, null, 2));
}

program
  .name('chrome-cli')
  .description('CLI for Chrome browser automation with persistent sessions')
  .version('1.0.0');

program
  .command('start')
  .description('Start the daemon (auto-starts on first command)')
  .action(async () => {
    try {
      const port = await ensureDaemon();
      output({ success: true, message: `Daemon running on port ${port}` });
    } catch (err) {
      output({ success: false, error: String(err) });
      process.exit(1);
    }
  });

program
  .command('stop')
  .description('Stop the daemon and close browser')
  .action(async () => {
    try {
      const result = await callDaemon('POST', '/shutdown');
      output(result);
    } catch {
      output({ success: true, message: 'Daemon not running' });
    }
  });

program
  .command('status')
  .description('Check daemon and browser status')
  .action(async () => {
    try {
      const result = await callDaemon('GET', '/health');
      output(result);
    } catch {
      output({ success: false, status: 'Daemon not running' });
    }
  });

program
  .command('navigate <url>')
  .description('Navigate to a URL')
  .action(async (url: string) => {
    try {
      const result = await callDaemon('POST', '/navigate', { url });
      output(result);
    } catch (err) {
      output({ success: false, error: String(err) });
      process.exit(1);
    }
  });

program
  .command('screenshot')
  .description('Take a screenshot')
  .option('-o, --output <path>', 'Output file path')
  .option('-f, --full-page', 'Capture full page')
  .action(async (options: { output?: string; fullPage?: boolean }) => {
    try {
      const result = await callDaemon('POST', '/screenshot', {
        output: options.output,
        fullPage: options.fullPage,
      });
      output(result);
    } catch (err) {
      output({ success: false, error: String(err) });
      process.exit(1);
    }
  });

program
  .command('click <selector>')
  .description('Click on an element')
  .action(async (selector: string) => {
    try {
      const result = await callDaemon('POST', '/click', { selector });
      output(result);
    } catch (err) {
      output({ success: false, error: String(err) });
      process.exit(1);
    }
  });

program
  .command('fill <selector> <value>')
  .description('Fill a form field')
  .action(async (selector: string, value: string) => {
    try {
      const result = await callDaemon('POST', '/fill', { selector, value });
      output(result);
    } catch (err) {
      output({ success: false, error: String(err) });
      process.exit(1);
    }
  });

program
  .command('eval <script>')
  .description('Evaluate JavaScript in the page')
  .action(async (script: string) => {
    try {
      const result = await callDaemon('POST', '/evaluate', { script });
      output(result);
    } catch (err) {
      output({ success: false, error: String(err) });
      process.exit(1);
    }
  });

program
  .command('console')
  .description('Get console messages')
  .action(async () => {
    try {
      const result = await callDaemon('GET', '/console');
      output(result);
    } catch (err) {
      output({ success: false, error: String(err) });
      process.exit(1);
    }
  });

program
  .command('network')
  .description('Get network requests')
  .action(async () => {
    try {
      const result = await callDaemon('GET', '/network');
      output(result);
    } catch (err) {
      output({ success: false, error: String(err) });
      process.exit(1);
    }
  });

program
  .command('pages')
  .description('List all open pages')
  .action(async () => {
    try {
      const result = await callDaemon('GET', '/pages');
      output(result);
    } catch (err) {
      output({ success: false, error: String(err) });
      process.exit(1);
    }
  });

program
  .command('new-page')
  .description('Open a new page')
  .option('-u, --url <url>', 'URL to open')
  .action(async (options: { url?: string }) => {
    try {
      const result = await callDaemon('POST', '/new-page', { url: options.url });
      output(result);
    } catch (err) {
      output({ success: false, error: String(err) });
      process.exit(1);
    }
  });

program
  .command('select-page <pageId>')
  .description('Select a page as active')
  .action(async (pageId: string) => {
    try {
      const result = await callDaemon('POST', '/select-page', { pageId });
      output(result);
    } catch (err) {
      output({ success: false, error: String(err) });
      process.exit(1);
    }
  });

program
  .command('close-page')
  .description('Close the current page')
  .option('-p, --page <pageId>', 'Page ID to close')
  .action(async (options: { page?: string }) => {
    try {
      const result = await callDaemon('POST', '/close-page', { pageId: options.page });
      output(result);
    } catch (err) {
      output({ success: false, error: String(err) });
      process.exit(1);
    }
  });

program
  .command('wait')
  .description('Wait for element or text')
  .option('-s, --selector <selector>', 'CSS selector to wait for')
  .option('-t, --text <text>', 'Text to wait for')
  .option('--timeout <ms>', 'Timeout in milliseconds', '5000')
  .action(async (options: { selector?: string; text?: string; timeout?: string }) => {
    try {
      const result = await callDaemon('POST', '/wait', {
        selector: options.selector,
        text: options.text,
        timeout: parseInt(options.timeout || '5000', 10),
      });
      output(result);
    } catch (err) {
      output({ success: false, error: String(err) });
      process.exit(1);
    }
  });

program
  .command('snapshot')
  .description('Get DOM snapshot')
  .option('-o, --output <path>', 'Output file path')
  .action(async (options: { output?: string }) => {
    try {
      const result = await callDaemon('POST', '/snapshot', { output: options.output });
      output(result);
    } catch (err) {
      output({ success: false, error: String(err) });
      process.exit(1);
    }
  });

program.parse();
