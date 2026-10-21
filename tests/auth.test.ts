import { describe, expect, it } from 'vitest';
import { checkAuth } from '../src/auth.js';

const key = 'mr-test-key';

describe('checkAuth', () => {
  it('accepts a bearer token', () => {
    expect(checkAuth({ authorization: `Bearer ${key}` }, key)).toBe(true);
  });

  it('accepts x-api-key, which Claude Code sends', () => {
    expect(checkAuth({ xApiKey: key }, key)).toBe(true);
  });

  it('accepts either credential when both are present', () => {
    expect(checkAuth({ authorization: 'Bearer wrong', xApiKey: key }, key)).toBe(true);
  });

  it('rejects missing, malformed, and wrong credentials', () => {
    expect(checkAuth({}, key)).toBe(false);
    expect(checkAuth({ authorization: key }, key)).toBe(false);
    expect(checkAuth({ authorization: 'Bearer wrong' }, key)).toBe(false);
    expect(checkAuth({ xApiKey: 'wrong' }, key)).toBe(false);
  });

  it('rejects a prefix of the key (no partial match)', () => {
    expect(checkAuth({ xApiKey: key.slice(0, -1) }, key)).toBe(false);
  });
});
