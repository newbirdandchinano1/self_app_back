import jwt from 'jsonwebtoken';
import type { RowDataPacket } from 'mysql2';
import { db } from '../db/index.js';
import { verifyPassword } from '../utils/password.js';

const JWT_SECRET = process.env.JWT_SECRET || 'self_app_dev_secret';
const JWT_EXPIRES_IN = '7d';

export interface AdminPayload {
  id: string;
  username: string;
}

export async function loginAdmin(username: string, password: string) {
  const [rows] = await db.query<RowDataPacket[]>(
    'SELECT id, username, password_hash, phone FROM admin_users WHERE username = ? LIMIT 1',
    [username],
  );

  const admin = rows[0];
  if (!admin) {
    return null;
  }

  const valid = await verifyPassword(password, admin.password_hash as string);
  if (!valid) {
    return null;
  }

  const payload: AdminPayload = {
    id: admin.id as string,
    username: admin.username as string,
  };

  const token = jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });

  return {
    token,
    admin: {
      id: payload.id,
      username: payload.username,
      phone: admin.phone as string,
    },
  };
}

export function verifyToken(token: string): AdminPayload {
  return jwt.verify(token, JWT_SECRET) as AdminPayload;
}
