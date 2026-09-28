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
  ForgotPasswordCommand,
  ConfirmForgotPasswordCommand,
  AuthFlowType,
} from '@aws-sdk/client-cognito-identity-provider';
import { CognitoJwtVerifier } from 'aws-jwt-verify';

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
  idToken: string;
  accessToken: string;
  refreshToken?: string;
  expiresIn?: number;
  sub: string;
  email: string;
  name?: string;
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
   * Authenticate user with Email and Password using USER_PASSWORD_AUTH.
   */
  static async signIn(email: string, password: string): Promise<CognitoAuthResult> {
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
    if (!res.AuthenticationResult || !res.AuthenticationResult.IdToken || !res.AuthenticationResult.AccessToken) {
      throw new Error('Cognito authentication failed to return tokens');
    }

    const idToken = res.AuthenticationResult.IdToken;
    const accessToken = res.AuthenticationResult.AccessToken;
    const refreshToken = res.AuthenticationResult.RefreshToken;
    const expiresIn = res.AuthenticationResult.ExpiresIn;

    // Verify and decode the ID token
    const payload = await this.verifyIdToken(idToken);

    return {
      idToken,
      accessToken,
      refreshToken,
      expiresIn,
      sub: payload.sub,
      email: (payload.email as string) || email,
      name: (payload.name as string) || (payload['cognito:username'] as string) || email,
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
