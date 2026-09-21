import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config({ path: new URL('../../.env', import.meta.url) });

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error('DATABASE_URL is required. Configure it in the environment before starting SecureExam.');
}

const poolMax = Number(process.env.DB_POOL_MAX || 10);
if (!Number.isInteger(poolMax) || poolMax < 1 || poolMax > 50) {
  throw new Error('DB_POOL_MAX must be an integer between 1 and 50.');
}

export const pool = new pg.Pool({
  connectionString: databaseUrl,
  ssl: {
    rejectUnauthorized: false,
  },
  max: poolMax,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
  maxUses: 10_000,
});

pool.on('error', (error) => {
  console.error('Unexpected PostgreSQL pool error:', error);
});

export const query = (text, params) => pool.query(text, params);
