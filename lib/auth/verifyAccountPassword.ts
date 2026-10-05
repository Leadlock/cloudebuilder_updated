/**
 * Re-checks the signed-in person's own password, wherever it lives.
 *
 * Accounts that signed in through AWS Cognito (the normal case) have no password hash in CloudCraft's database: their password is in
 * Cognito, so it is checked by signing in to Cognito again with it (the tokens that come back are thrown away). Older local accounts
 * have a scrypt hash and are checked against that. Which one is used is decided by whether a hash exists.
 *
 * Result: ok | wrong | none (this account has no password anywhere we can check, e.g. a development identity) | unavailable
 * (Cognito could not be reached or throttled us: neither a yes nor a no).
 */
import { orgRepository } from '@/lib/repositories/orgRepository';
import { verifyPassword } from '@/lib/crypto/password';
import { CognitoService } from '@/lib/auth/cognitoService';

export type PasswordCheck = 'ok' | 'wrong' | 'none' | 'unavailable';

export interface VerifyDeps {
  getPasswordHash(userId: string): Promise<string | null>;
  verifyHash(password: string, hash: string): Promise<boolean>;
  cognitoSignIn(email: string, password: string): Promise<{ sub: string }>;
}

const realDeps: VerifyDeps = {
  getPasswordHash: (id) => orgRepository.getPasswordHashById(id),
  verifyHash: verifyPassword,
  cognitoSignIn: (email, password) => CognitoService.signIn(email, password),
};

export async function verifyAccountPassword(input: { userId: string; email?: string; password: string }, deps: VerifyDeps = realDeps): Promise<PasswordCheck> {
  const hash = await deps.getPasswordHash(input.userId);
  if (hash) return (await deps.verifyHash(input.password, hash)) ? 'ok' : 'wrong';
  if (!input.email) return 'none';
  try {
    const result = await deps.cognitoSignIn(input.email, input.password);
    // The Cognito identity must be this very user, not just someone whose password happens to work for that email.
    return result.sub === input.userId ? 'ok' : 'wrong';
  } catch (err) {
    const name = (err as { name?: string })?.name;
    if (name === 'NotAuthorizedException') return 'wrong';
    if (name === 'UserNotFoundException') return 'none';
    return 'unavailable';
  }
}
