/**
 * PKCE (RFC 7636) helpers for the authorization-code flow. S256 only;
 * "plain" is never offered.
 */
import * as crypto from 'node:crypto';

export function base64url(buffer: Buffer): string {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

/** 32 random bytes -> 43-character verifier (the RFC recommends 43..128). */
export function createVerifier(): string {
  return base64url(crypto.randomBytes(32));
}

export function challengeFor(verifier: string): string {
  return base64url(crypto.createHash('sha256').update(verifier).digest());
}

export function createState(): string {
  return base64url(crypto.randomBytes(16));
}
