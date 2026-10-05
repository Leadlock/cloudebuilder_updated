/**
 * Production AWS Cognito Authentication Service
 * 
 * Interacts with AWS Cognito User Pools using the AWS SDK v3 Cognito Identity Provider client
 * and validates JWT ID tokens using aws-jwt-verify against Cognito's JWKS endpoint.
 */
import {
  CognitoIdentityProviderClient,
  SignUpCommand,
  ConfirmSignUpCommand,
  ResendConfirmationCodeCommand,
  InitiateAuthCommand,
  RespondToAuthChallengeCommand,
  AssociateSoftwareTokenCommand,
  VerifySoftwareTokenCommand,
  ForgotPasswordCommand,
  ConfirmForgotPasswordCommand,
  AuthFlowType,
  ChallengeNameType,
} from '@aws-sdk/client-cognito-identity-provider';
import { CognitoJwtVerifier } from 'aws-jwt-verify';
import { unverifiedTokenFallbackAllowed } from './localFallback';

const REGION = process.env.COGNITO_REGION || process.env.AWS_REGION || 'us-east-1';
const USER_POOL_ID = process.env.COGNITO_USER_POOL_ID || 'us-east-1_JWhzLoOFB';
const CLIENT_ID = process.env.COGNITO_CLIENT_ID || '3e9fj8jcghd5g1hp03kosmmtjv';
const CLIENT_SECRET = process.env.COGNITO_CLIENT_SECRET || undefined;

// Lazy client instance
let _client: CognitoIdentityProviderClient | null = null;
function getClient(): CognitoIdentityProviderClient {
  if (!_client) {
    _client = new CognitoIdentityProviderClient({ region: REGION });
  }
  return _client;
}

// Lazy JWT verifier instance
let _verifier: ReturnType<typeof CognitoJwtVerifier.create> | null = null;
function getVerifier() {
  if (!_verifier) {
    _verifier = CognitoJwtVerifier.create({
      userPoolId: USER_POOL_ID,
      tokenUse: 'id',
      clientId: CLIENT_ID,
    });
  }
  return _verifier;
}

export interface CognitoAuthResult {
  challenge?: false;
  idToken: string;
  accessToken: string;
  refreshToken?: string;
  expiresIn?: number;
  sub: string;
  email: string;
  name?: string;
}

export interface CognitoMfaChallengeResult {
  challenge: true;
  challengeName: string;
  session: string;
  challengeParameters?: Record<string, string>;
  email: string;
}

export type CognitoSignInResult = CognitoAuthResult | CognitoMfaChallengeResult;

/** Development-only: decodes an ID token's payload and checks issuer, audience, token use and expiry — NOT its signature. */
export function readClaimsWithoutSignature(idToken: string): Record<string, unknown> | null {
  try {
    const base64Url = idToken.split('.')[1];
    if (!base64Url) return null;
    const claims = JSON.parse(Buffer.from(base64Url.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')) as Record<string, unknown>;
    const exp = Number(claims['exp']);
    const valid = claims['iss'] === `https://cognito-idp.${REGION}.amazonaws.com/${USER_POOL_ID}`
      && claims['token_use'] === 'id'
      && claims['aud'] === CLIENT_ID
      && Number.isFinite(exp) && exp * 1000 > Date.now();
    return valid ? claims : null;
  } catch {
    return null;
  }
}

export class CognitoService {
  /**
   * Register a new user in the Cognito User Pool.
   */
  static async signUp(params: {
    email: string;
    password: string;
    name: string;
  }): Promise<{ userSub: string; isConfirmed: boolean }> {
    const client = getClient();
    const command = new SignUpCommand({
      ClientId: CLIENT_ID,
      Username: params.email,
      Password: params.password,
      UserAttributes: [
        { Name: 'email', Value: params.email },
        { Name: 'name', Value: params.name },
      ],
    });

    const res = await client.send(command);
    return {
      userSub: res.UserSub ?? '',
      isConfirmed: res.UserConfirmed ?? false,
    };
  }

  /**
   * Confirm sign-up using the 6-digit verification code sent to the user's email.
   */
  static async confirmSignUp(email: string, code: string): Promise<boolean> {
    const client = getClient();
    const command = new ConfirmSignUpCommand({
      ClientId: CLIENT_ID,
      Username: email,
      ConfirmationCode: code.trim(),
    });

    await client.send(command);
    return true;
  }

  /**
   * Resend confirmation code to email.
   */
  static async resendConfirmationCode(email: string): Promise<boolean> {
    const client = getClient();
    const command = new ResendConfirmationCodeCommand({
      ClientId: CLIENT_ID,
      Username: email,
    });

    await client.send(command);
    return true;
  }

  /**
   * Helper to verify ID token and package user identity payload.
   */
  private static async processAuthResult(
    authResult: { IdToken?: string; AccessToken?: string; RefreshToken?: string; ExpiresIn?: number },
    defaultEmail: string
  ): Promise<CognitoAuthResult> {
    const idToken = authResult.IdToken;
    const accessToken = authResult.AccessToken;
    const refreshToken = authResult.RefreshToken;
    const expiresIn = authResult.ExpiresIn;

    if (!idToken || !accessToken) {
      throw new Error('Cognito authentication failed to return tokens');
    }

    // Verify and decode the ID token
    let payload: Record<string, unknown>;
    try {
      payload = (await this.verifyIdToken(idToken)) as unknown as Record<string, unknown>;
    } catch (verifyErr) {
      // Reading a token without checking its signature is acceptable only on a developer machine whose network cannot
      // reach Cognito's key server — and even then the token must be for this pool and client and not expired.
      if (!unverifiedTokenFallbackAllowed()) throw verifyErr;
      console.warn('[CognitoService] JWKS verify failed; development fallback to checked, unsigned claims:', verifyErr instanceof Error ? verifyErr.message : String(verifyErr));
      const claims = readClaimsWithoutSignature(idToken);
      if (!claims) throw verifyErr;
      payload = claims;
    }

    return {
      challenge: false,
      idToken,
      accessToken,
      refreshToken,
      expiresIn,
      sub: (payload.sub as string) || (payload['cognito:username'] as string) || defaultEmail,
      email: (payload.email as string) || defaultEmail,
      name: (payload.name as string) || (payload['cognito:username'] as string) || defaultEmail,
    };
  }

  /**
   * Authenticate user with Email and Password using USER_PASSWORD_AUTH.
   * Returns authenticated tokens or an MFA challenge if 2FA is required.
   */
  static async signIn(email: string, password: string): Promise<CognitoSignInResult> {
    const client = getClient();
    const command = new InitiateAuthCommand({
      AuthFlow: AuthFlowType.USER_PASSWORD_AUTH,
      ClientId: CLIENT_ID,
      AuthParameters: {
        USERNAME: email,
        PASSWORD: password,
      },
    });

    const res = await client.send(command);

    if (res.ChallengeName && res.Session) {
      return {
        challenge: true,
        challengeName: res.ChallengeName,
        session: res.Session,
        challengeParameters: res.ChallengeParameters,
        email,
      };
    }

    if (!res.AuthenticationResult) {
      throw new Error('Cognito authentication failed to return tokens');
    }

    return await this.processAuthResult(res.AuthenticationResult, email);
  }

  /**
   * Respond to an MFA challenge (TOTP Software Token / SMS / Email OTP / MFA Setup).
   */
  static async respondToMfaChallenge(params: {
    email: string;
    session: string;
    challengeName: string;
    code: string;
  }): Promise<CognitoSignInResult> {
    const client = getClient();
    const trimmedCode = params.code.trim();

    // 1. If this is an MFA_SETUP challenge, first verify and activate the software token with the user's code!
    if (params.challengeName === 'MFA_SETUP') {
      const verifyCmd = new VerifySoftwareTokenCommand({
        Session: params.session,
        UserCode: trimmedCode,
        FriendlyDeviceName: 'CloudCraft App',
      });

      const verifyRes = await client.send(verifyCmd);
      if (verifyRes.Status !== 'SUCCESS') {
        throw Object.assign(new Error('Invalid verification code. Please check your authenticator and try again.'), {
          name: 'CodeMismatchException',
        });
      }

      // Complete the MFA_SETUP challenge with the session from VerifySoftwareToken
      const sessionAfterVerify = verifyRes.Session || params.session;
      const setupCommand = new RespondToAuthChallengeCommand({
        ClientId: CLIENT_ID,
        ChallengeName: 'MFA_SETUP' as ChallengeNameType,
        Session: sessionAfterVerify,
        ChallengeResponses: {
          USERNAME: params.email,
        },
      });

      const setupRes = await client.send(setupCommand);
      if (setupRes.ChallengeName && setupRes.Session) {
        return {
          challenge: true,
          challengeName: setupRes.ChallengeName,
          session: setupRes.Session,
          challengeParameters: setupRes.ChallengeParameters,
          email: params.email,
        };
      }

      if (!setupRes.AuthenticationResult) {
        throw new Error('Cognito MFA setup did not return authentication tokens');
      }

      return await this.processAuthResult(setupRes.AuthenticationResult, params.email);
    }

    // 2. Standard MFA challenge (e.g. SOFTWARE_TOKEN_MFA, SMS_MFA, EMAIL_OTP)
    const challengeResponses: Record<string, string> = {
      USERNAME: params.email,
    };

    if (params.challengeName === 'SOFTWARE_TOKEN_MFA') {
      challengeResponses.SOFTWARE_TOKEN_MFA_CODE = trimmedCode;
    } else if (params.challengeName === 'SMS_MFA') {
      challengeResponses.SMS_MFA_CODE = trimmedCode;
    } else if (params.challengeName === 'EMAIL_OTP') {
      challengeResponses.EMAIL_OTP_CODE = trimmedCode;
    } else {
      challengeResponses[`${params.challengeName}_CODE`] = trimmedCode;
      challengeResponses.ANSWER = trimmedCode;
    }

    const command = new RespondToAuthChallengeCommand({
      ClientId: CLIENT_ID,
      ChallengeName: params.challengeName as ChallengeNameType,
      Session: params.session,
      ChallengeResponses: challengeResponses,
    });

    const res = await client.send(command);

    if (res.ChallengeName && res.Session) {
      return {
        challenge: true,
        challengeName: res.ChallengeName,
        session: res.Session,
        challengeParameters: res.ChallengeParameters,
        email: params.email,
      };
    }

    if (!res.AuthenticationResult) {
      throw new Error('Cognito MFA challenge response did not return authentication tokens');
    }

    return await this.processAuthResult(res.AuthenticationResult, params.email);
  }

  /**
   * Associate software token (TOTP setup) during an MFA_SETUP challenge or from user settings.
   */
  static async associateSoftwareToken(session: string): Promise<{ secretCode?: string; session?: string }> {
    const client = getClient();
    const command = new AssociateSoftwareTokenCommand({
      Session: session,
    });
    const res = await client.send(command);
    return {
      secretCode: res.SecretCode,
      session: res.Session,
    };
  }

  /**
   * Verify and activate the newly associated software token.
   */
  static async verifySoftwareToken(params: {
    session: string;
    userCode: string;
    friendlyDeviceName?: string;
  }): Promise<{ status?: string; session?: string }> {
    const client = getClient();
    const command = new VerifySoftwareTokenCommand({
      Session: params.session,
      UserCode: params.userCode.trim(),
      FriendlyDeviceName: params.friendlyDeviceName || 'CloudCraft App',
    });
    const res = await client.send(command);
    return {
      status: res.Status,
      session: res.Session,
    };
  }

  /**
   * Initiate forgot password flow — triggers verification code sent to email.
   */
  static async forgotPassword(email: string): Promise<boolean> {
    const client = getClient();
    const command = new ForgotPasswordCommand({
      ClientId: CLIENT_ID,
      Username: email,
    });

    await client.send(command);
    return true;
  }

  /**
   * Confirm forgot password with code and new password.
   */
  static async confirmForgotPassword(params: {
    email: string;
    code: string;
    newPassword: string;
  }): Promise<boolean> {
    const client = getClient();
    const command = new ConfirmForgotPasswordCommand({
      ClientId: CLIENT_ID,
      Username: params.email,
      ConfirmationCode: params.code.trim(),
      Password: params.newPassword,
    });

    await client.send(command);
    return true;
  }

  /**
   * Verify an ID token against Cognito User Pool JWKS.
   */
  static async verifyIdToken(idToken: string) {
    const verifier = getVerifier();
    return await verifier.verify(idToken);
  }
}
