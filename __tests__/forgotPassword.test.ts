/**
 * Unit tests for Forgot Password and Reset Password flows with AWS Cognito.
 */
const mockForgotPassword = jest.fn();
const mockConfirmForgotPassword = jest.fn();

jest.mock('@/lib/auth/cognitoService', () => ({
  ...jest.requireActual('@/lib/auth/cognitoService'),
  CognitoService: {
    forgotPassword: (...args: unknown[]) => mockForgotPassword(...args),
    confirmForgotPassword: (...args: unknown[]) => mockConfirmForgotPassword(...args),
  },
}));

const mockUpdatePassword = jest.fn();
jest.mock('@/lib/repositories/orgRepository', () => ({
  orgRepository: {
    updatePassword: (...args: unknown[]) => mockUpdatePassword(...args),
  },
}));

import { NextRequest } from 'next/server';
import { POST as forgotPasswordPost } from '@/app/api/auth/forgot-password/route';
import { POST as resetPasswordPost } from '@/app/api/auth/reset-password/route';

describe('Forgot Password & Reset Password Flow', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  describe('POST /api/auth/forgot-password', () => {
    it('successfully initiates password reset and returns generic success message', async () => {
      mockForgotPassword.mockResolvedValueOnce(true);

      const req = new NextRequest('http://localhost/api/auth/forgot-password', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'user@example.com' }),
      });

      const res = await forgotPasswordPost(req);
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.data.message).toContain('verification code has been sent');
      expect(mockForgotPassword).toHaveBeenCalledWith('user@example.com');
    });

    it('returns generic success even if user does not exist in Cognito (anti-enumeration)', async () => {
      const err = new Error('User does not exist');
      (err as any).name = 'UserNotFoundException';
      mockForgotPassword.mockRejectedValueOnce(err);

      const req = new NextRequest('http://localhost/api/auth/forgot-password', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'nonexistent@example.com' }),
      });

      const res = await forgotPasswordPost(req);
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.data.message).toContain('verification code has been sent');
    });

    it('rejects invalid email format with 400', async () => {
      const req = new NextRequest('http://localhost/api/auth/forgot-password', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'not-an-email' }),
      });

      const res = await forgotPasswordPost(req);
      expect(res.status).toBe(400);
    });
  });

  describe('POST /api/auth/reset-password', () => {
    it('successfully resets password with valid code and updates local DB hash', async () => {
      mockConfirmForgotPassword.mockResolvedValueOnce(true);
      mockUpdatePassword.mockResolvedValueOnce(true);

      const req = new NextRequest('http://localhost/api/auth/reset-password', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          email: 'user@example.com',
          code: '123456',
          newPassword: 'NewSecurePassword123!',
        }),
      });

      const res = await resetPasswordPost(req);
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.data.message).toContain('Password has been reset successfully');
      expect(mockConfirmForgotPassword).toHaveBeenCalledWith({
        email: 'user@example.com',
        code: '123456',
        newPassword: 'NewSecurePassword123!',
      });
      expect(mockUpdatePassword).toHaveBeenCalled();
    });

    it('returns 400 when invalid verification code is entered', async () => {
      const err = new Error('Invalid code');
      (err as any).name = 'CodeMismatchException';
      mockConfirmForgotPassword.mockRejectedValueOnce(err);

      const req = new NextRequest('http://localhost/api/auth/reset-password', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          email: 'user@example.com',
          code: '000000',
          newPassword: 'NewSecurePassword123!',
        }),
      });

      const res = await resetPasswordPost(req);
      expect(res.status).toBe(400);

      const body = await res.json();
      expect(body.error?.message ?? body.error).toContain('Invalid verification code');
    });

    it('returns 400 when verification code has expired', async () => {
      const err = new Error('Expired code');
      (err as any).name = 'ExpiredCodeException';
      mockConfirmForgotPassword.mockRejectedValueOnce(err);

      const req = new NextRequest('http://localhost/api/auth/reset-password', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          email: 'user@example.com',
          code: '999999',
          newPassword: 'NewSecurePassword123!',
        }),
      });

      const res = await resetPasswordPost(req);
      expect(res.status).toBe(400);

      const body = await res.json();
      expect(body.error?.message ?? body.error).toContain('expired');
    });

    it('rejects password shorter than 8 characters', async () => {
      const req = new NextRequest('http://localhost/api/auth/reset-password', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          email: 'user@example.com',
          code: '123456',
          newPassword: 'short',
        }),
      });

      const res = await resetPasswordPost(req);
      expect(res.status).toBe(400);
    });
  });
});
