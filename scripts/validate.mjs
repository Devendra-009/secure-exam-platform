import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const rootPath = fileURLToPath(new URL('..', import.meta.url));

const jsFiles = [
  'server/src/index.js',
  'server/src/db.js',
  'server/src/migrate.js',
  'server/src/seed.js',
  'server/src/utils/jwt.js',
  'electron-app/main.js',
  'electron-app/preload.cjs',
  'client/src/api.js',
];

for (const file of jsFiles) {
  const result = spawnSync(process.execPath, ['--check', file], { cwd: rootPath, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`${file}\n${result.stderr}`);
}

const packageFiles = ['package.json', 'client/package.json', 'server/package.json', 'electron-app/package.json'];
for (const file of packageFiles) {
  const data = JSON.parse(fs.readFileSync(path.join(rootPath, file), 'utf8'));
  if (data.version !== '3.1.0') throw new Error(`${file} version is not 3.1.0`);
}

const schema = fs.readFileSync(path.join(rootPath, 'server/src/schema.sql'), 'utf8');
for (const needle of [
  'avatar_url TEXT',
  'updated_at TIMESTAMPTZ',
  'CREATE TABLE IF NOT EXISTS exam_series',
  'CREATE TABLE IF NOT EXISTS exam_enrollments',
  'CREATE TABLE IF NOT EXISTS violation_events',
]) {
  if (!schema.includes(needle)) throw new Error(`schema missing ${needle}`);
}

for (const forbiddenPath of ['.env', 'server/.env', 'client/.env', 'client/.env.local', 'electron-app/.env']) {
  if (fs.existsSync(path.join(rootPath, forbiddenPath))) throw new Error(`Local environment file must not be included: ${forbiddenPath}`);
}

const envExample = fs.readFileSync(path.join(rootPath, '.env.example'), 'utf8');
const projectText = [
  'README.md', 'client/src/main.jsx', 'server/src/seed.js', 'server/src/db.js',
  'server/src/utils/jwt.js', 'electron-app/main.js', 'docker-compose.yml', '.env.example',
].map((file) => fs.readFileSync(path.join(rootPath, file), 'utf8')).join('\n');

const forbiddenPatterns = [
  /admin@secureexam\.local/i,
  /Admin@123/i,
  /postgres:(?:postgres|postgreSQL)@/i,
  /JWT_SECRET=fgvbhj/i,
  /@mediapipe\/tasks-vision@latest/i,
];
for (const pattern of forbiddenPatterns) {
  if (projectText.match(pattern)) throw new Error(`Forbidden credential or floating dependency detected: ${pattern}`);
}

for (const required of ['JWT_SECRET=', 'DATABASE_URL=', 'ELECTRON_START_URL=', 'SEED_ADMIN_PASSWORD=']) {
  if (!envExample.includes(required)) throw new Error(`.env.example is missing ${required}`);
}

if (!fs.existsSync(path.join(rootPath, 'render.yaml'))) throw new Error('render.yaml is missing');
if (!fs.existsSync(path.join(rootPath, '.github/workflows/ci.yml'))) throw new Error('CI workflow is missing');

const client = fs.readFileSync(path.join(rootPath, 'client/src/main.jsx'), 'utf8');
for (const needle of ['/auth/register', '/admin/exam-series', 'EditExamDrawer', 'FULLSCREEN_EXIT']) {
  if (!client.includes(needle)) throw new Error(`client missing ${needle}`);
}

const electron = fs.readFileSync(path.join(rootPath, 'electron-app/main.js'), 'utf8');
for (const needle of ['setKiosk(true)', 'setFullScreen(true)', 'display-metrics-changed', "on('leave-full-screen'", 'contextIsolation: true', 'sandbox: true']) {
  if (!electron.includes(needle)) throw new Error(`electron security feature missing ${needle}`);
}

console.log('SecureExam 3.1.0 validation passed.');
