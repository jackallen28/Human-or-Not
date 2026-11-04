/** Boots the mock Claude API and the server, then runs the end-to-end suite. */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMock } from './mock-claude.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const mock = await startMock(3501);
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hon-e2e-'));

const server = spawn('node', [path.join(here, '..', 'server', 'index.js')], {
  env: {
    ...process.env,
    PORT: '3500', TEACHER_CODE: 'test-code', TEACHER_2_CODE: 'second-code', TEACHER_2_NAME: 'Ms Second', TEACHER_3_CODE: '', DATA_DIR: dataDir, DATABASE_URL: '',
    ANTHROPIC_API_KEY: 'sk-ant-test', ANTHROPIC_BASE_URL: 'http://localhost:3501',
    BOT_THINK_MS: '100', BOT_REPLY_CAP_MS: '300', BOT_WPM_MIN: '500', BOT_WPM_MAX: '600', BOT_HOLD_BACK: '0',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stdout.on('data', (d) => process.stdout.write(`[server] ${d}`));
server.stderr.on('data', (d) => process.stdout.write(`[server] ${d}`));
await new Promise((r) => setTimeout(r, 1500));

const suite = spawn('node', [path.join(here, 'e2e.mjs')], { stdio: 'inherit', env: { ...process.env, DATA_DIR: dataDir } });
suite.on('exit', (code) => { server.kill(); mock.close(); process.exit(code ?? 1); });
