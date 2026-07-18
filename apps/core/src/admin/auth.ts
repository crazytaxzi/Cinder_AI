import {
  createHmac,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from 'node:crypto';

interface SessionPayload {
  sub: string;
  exp: number;
  csrf: string;
  nonce: string;
}

export function hashDashboardPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64);
  return `scrypt$${salt.toString('base64url')}$${hash.toString('base64url')}`;
}

export function verifyDashboardPassword(password: string, stored: string): boolean {
  const [kind, saltEncoded, hashEncoded] = stored.split('$');
  if (kind !== 'scrypt' || !saltEncoded || !hashEncoded) return false;
  try {
    const salt = Buffer.from(saltEncoded, 'base64url');
    const expected = Buffer.from(hashEncoded, 'base64url');
    const actual = scryptSync(password, salt, expected.length);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

export class DashboardSessions {
  constructor(
    private readonly secret: string,
    private readonly ttlHours: number,
  ) {}

  create(subject = 'senti'): { token: string; csrf: string; expiresAt: string } {
    const payload: SessionPayload = {
      sub: subject,
      exp: Date.now() + this.ttlHours * 60 * 60 * 1000,
      csrf: randomBytes(24).toString('base64url'),
      nonce: randomBytes(16).toString('base64url'),
    };
    const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const signature = this.sign(encoded);
    return {
      token: `${encoded}.${signature}`,
      csrf: payload.csrf,
      expiresAt: new Date(payload.exp).toISOString(),
    };
  }

  verify(token: string | undefined): SessionPayload | undefined {
    if (!token) return undefined;
    const [encoded, signature] = token.split('.');
    if (!encoded || !signature) return undefined;
    const expected = this.sign(encoded);
    const actualBuffer = Buffer.from(signature);
    const expectedBuffer = Buffer.from(expected);
    if (actualBuffer.length !== expectedBuffer.length || !timingSafeEqual(actualBuffer, expectedBuffer)) {
      return undefined;
    }
    try {
      const parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as SessionPayload;
      if (!parsed.sub || !parsed.csrf || !parsed.exp || parsed.exp <= Date.now()) return undefined;
      return parsed;
    } catch {
      return undefined;
    }
  }

  private sign(value: string): string {
    return createHmac('sha256', this.secret).update(value).digest('base64url');
  }
}
