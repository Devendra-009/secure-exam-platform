import bcrypt from 'bcryptjs';
import { pool, query } from './db.js';

const name = String(process.env.SEED_ADMIN_NAME || '').trim();
const email = String(process.env.SEED_ADMIN_EMAIL || '').trim().toLowerCase();
const password = String(process.env.SEED_ADMIN_PASSWORD || '');

function validatePassword(value) {
  const bytes = Buffer.byteLength(value, 'utf8');
  return value.length >= 12 && bytes <= 72;
}

if (!name || !email || !validatePassword(password)) {
  console.error('Seed skipped: set SEED_ADMIN_NAME, SEED_ADMIN_EMAIL and a password of at least 12 characters (max 72 UTF-8 bytes).');
  process.exitCode = 1;
} else {
  try {
    const hash = await bcrypt.hash(password, 12);
    await query(
      `INSERT INTO users(name,email,password_hash,role)
       VALUES($1,$2,$3,'admin')
       ON CONFLICT(email) DO UPDATE SET password_hash=EXCLUDED.password_hash,role='admin',name=EXCLUDED.name`,
      [name, email, hash],
    );
    console.log('Admin account seeded successfully.');
  } catch (error) {
    console.error('Database seed failed:', error);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}
