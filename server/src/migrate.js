import fs from 'node:fs/promises';
import { pool, query } from './db.js';

const schema = await fs.readFile(new URL('./schema.sql', import.meta.url), 'utf8');

try {
  await query(schema);
  console.log('Database schema is up to date.');
} catch (error) {
  console.error('Database migration failed:', error);
  process.exitCode = 1;
} finally {
  await pool.end();
}
