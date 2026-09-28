/**
 * CloudCraft Outbound Email Service (AWS SES & SMTP)
 * 
 * Delivers transactional emails including Team Invitations using AWS SES
 * via SMTP (Nodemailer) or AWS SES SDK.
 */
import nodemailer from 'nodemailer';
import { SESClient, SendEmailCommand } from '@aws-sdk/client-ses';

export interface SendInviteEmailParams {
  toEmail: string;
  inviterName?: string;
  orgName: string;
  role: string;
  acceptUrl: string;
  expiresInDays?: number;
}

// Lazy SMTP transporter
let _transporter: nodemailer.Transporter | null = null;
function getTransporter(): nodemailer.Transporter | null {
  const host = process.env.SMTP_HOST;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  const port = parseInt(process.env.SMTP_PORT || '587', 10);
  const secure = process.env.SMTP_SECURE === 'true';

  if (!host || !user || !pass) {
    return null;
  }

  if (!_transporter) {
    _transporter = nodemailer.createTransport({
      host,
      port,
      secure,
      auth: {
        user,
        pass,
      },
    });
  }
  return _transporter;
}

export class EmailService {
  /**
   * Send a team invitation email to a new or existing teammate.
   */
  static async sendTeamInvite(params: SendInviteEmailParams): Promise<{ sent: boolean; messageId?: string; error?: string }> {
    const fromAddress = process.env.EMAIL_FROM || 'CloudCraft <no-reply@cloudcraft.local>';
    const appUrl = process.env.APP_URL || 'http://localhost:3000';
    const inviter = params.inviterName || 'A team administrator';
    const days = params.expiresInDays || 7;

    const subject = `You've been invited to join ${params.orgName} on CloudCraft`;

    const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${subject}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #030712; color: #f3f4f6; margin: 0; padding: 0; }
    .container { max-width: 580px; margin: 40px auto; background-color: #0f172a; border: 1px solid #1e293b; border-radius: 16px; overflow: hidden; box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.5); }
    .header { background: linear-gradient(135deg, #0284c7 0%, #0369a1 50%, #0f172a 100%); padding: 32px 24px; text-align: center; }
    .logo-badge { display: inline-block; background-color: #0284c7; color: #ffffff; padding: 6px 14px; border-radius: 8px; font-weight: 700; font-size: 16px; letter-spacing: -0.5px; margin-bottom: 12px; }
    .title { color: #ffffff; font-size: 22px; font-weight: 700; margin: 0; letter-spacing: -0.5px; }
    .content { padding: 32px 28px; line-height: 1.6; color: #cbd5e1; font-size: 15px; }
    .highlight-card { background-color: #090d16; border: 1px solid #1e293b; border-radius: 12px; padding: 18px 20px; margin: 20px 0; }
    .highlight-row { display: flex; justify-content: space-between; margin-bottom: 8px; font-size: 14px; }
    .highlight-row:last-child { margin-bottom: 0; }
    .label { color: #94a3b8; }
    .value { color: #f8fafc; font-weight: 600; }
    .btn-container { text-align: center; margin: 32px 0 24px 0; }
    .btn { display: inline-block; background: linear-gradient(135deg, #0284c7, #2563eb); color: #ffffff !important; text-decoration: none; padding: 14px 32px; border-radius: 10px; font-weight: 600; font-size: 15px; box-shadow: 0 4px 14px 0 rgba(2, 132, 199, 0.4); }
    .link-fallback { font-size: 12px; color: #64748b; word-break: break-all; margin-top: 24px; }
    .link-fallback a { color: #38bdf8; }
    .footer { background-color: #090d16; border-top: 1px solid #1e293b; padding: 20px; text-align: center; font-size: 12px; color: #64748b; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <div class="logo-badge">⚡ CloudCraft</div>
      <h1 class="title">Join ${params.orgName}</h1>
    </div>
    <div class="content">
      <p>Hello,</p>
      <p><strong>${inviter}</strong> has invited you to collaborate on cloud architecture diagrams, Terraform deployments, and security governance on <strong>${params.orgName}</strong>.</p>
      
      <div class="highlight-card">
        <div class="highlight-row">
          <span class="label">Organization:</span>
          <span class="value">${params.orgName}</span>
        </div>
        <div class="highlight-row">
          <span class="label">Role:</span>
          <span class="value">${params.role.toUpperCase()}</span>
        </div>
        <div class="highlight-row">
          <span class="label">Expires in:</span>
          <span class="value">${days} days</span>
        </div>
      </div>

      <div class="btn-container">
        <a href="${params.acceptUrl}" class="btn" target="_blank">Accept Invitation & Join Team</a>
      </div>

      <p class="link-fallback">
        If the button above does not work, copy and paste this link into your browser:<br>
        <a href="${params.acceptUrl}">${params.acceptUrl}</a>
      </p>
    </div>
    <div class="footer">
      This invitation was sent by CloudCraft on behalf of ${params.orgName}. If you did not expect this invitation, you can safely ignore this email.
    </div>
  </div>
</body>
</html>
    `.trim();

    const text = `
You've been invited to join ${params.orgName} on CloudCraft!

${inviter} has invited you to join ${params.orgName} as a ${params.role}.

Accept your invitation here:
${params.acceptUrl}

(This invitation is valid for ${days} days)
    `.trim();

    const transporter = getTransporter();
    if (!transporter) {
      console.warn('[EmailService] SMTP credentials not fully configured in environment variables. Email was skipped.');
      return { sent: false, error: 'SMTP credentials not configured in environment' };
    }

    try {
      const info = await transporter.sendMail({
        from: fromAddress,
        to: params.toEmail,
        subject,
        text,
        html,
      });

      console.log(`[EmailService] Invitation email delivered to ${params.toEmail} (Message ID: ${info.messageId})`);
      return { sent: true, messageId: info.messageId };
    } catch (err: any) {
      console.error(`[EmailService] Failed to send email to ${params.toEmail}:`, err);
      return { sent: false, error: err.message || 'SMTP sending error' };
    }
  }
}
