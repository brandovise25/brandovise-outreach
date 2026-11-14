import { createHash, randomBytes } from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';

export const ACCESS_TTL_S = 15 * 60;
export const REFRESH_TTL_S = 30 * 24 * 60 * 60;
const ISSUER = 'outreach-api';
const AUDIENCE = 'outreach-extension';

export interface AccessClaims {
  userId: string;
  deviceId: string;
}

export class TokenService {
  private readonly key: Uint8Array;

  constructor(secret: string) {
    this.key = new TextEncoder().encode(secret);
  }

  async signAccess(
    claims: AccessClaims,
    now = new Date(),
  ): Promise<{ token: string; expiresAt: Date }> {
    const expiresAt = new Date(now.getTime() + ACCESS_TTL_S * 1000);
    const token = await new SignJWT({ did: claims.deviceId })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(claims.userId)
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setIssuedAt(Math.floor(now.getTime() / 1000))
      .setExpirationTime(Math.floor(expiresAt.getTime() / 1000))
      .sign(this.key);
    return { token, expiresAt };
  }

  async verifyAccess(token: string): Promise<AccessClaims> {
    const { payload } = await jwtVerify(token, this.key, {
      issuer: ISSUER,
      audience: AUDIENCE,
      algorithms: ['HS256'],
    });
    if (typeof payload.sub !== 'string' || typeof payload.did !== 'string') {
      throw new Error('malformed token');
    }
    return { userId: payload.sub, deviceId: payload.did };
  }
}

// Refresh tokens are opaque random strings; only their SHA-256 hash is stored.
export function newRefreshToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
