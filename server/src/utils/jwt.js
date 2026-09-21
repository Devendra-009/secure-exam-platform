import jwt from 'jsonwebtoken';
import dotenv from 'dotenv';

dotenv.config({ path: new URL('../../../.env', import.meta.url) });

const secret = process.env.JWT_SECRET;
const expiresIn = process.env.JWT_EXPIRES_IN || '1d';
const issuer = process.env.JWT_ISSUER || 'secure-exam';
const audience = process.env.JWT_AUDIENCE || 'secure-exam-client';

if (!secret || secret.length < 32) {
  throw new Error('JWT_SECRET must be configured and contain at least 32 characters.');
}

export function signUser(user) {
  return jwt.sign(
    { id: user.id, role: user.role },
    secret,
    {
      algorithm: 'HS256',
      expiresIn,
      issuer,
      audience,
      subject: user.id,
    },
  );
}

export function verifyUser(token) {
  return jwt.verify(token, secret, {
    algorithms: ['HS256'],
    issuer,
    audience,
  });
}
