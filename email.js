// email.js
// Sends the Discord-signup welcome email over plain SMTP, so it works with
// any provider (Gmail app password, Resend, Postmark, your own mail server,
// etc) rather than locking you into one vendor. Stays silent and inactive
// until real SMTP credentials are in .env.

let nodemailer;
try { nodemailer = require('nodemailer'); } catch (e) { /* installed on npm install */ }

function getTransport() {
  if (!nodemailer || !process.env.SMTP_HOST) return null;
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: Number(process.env.SMTP_PORT) === 465,
    auth: process.env.SMTP_USER
      ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
      : undefined,
  });
}

async function sendWelcomeEmail(to, username) {
  const transport = getTransport();
  if (!transport) {
    console.warn(`[corex] SMTP not configured — skipped welcome email to ${to}`);
    return;
  }
  try {
    await transport.sendMail({
      from: process.env.SMTP_FROM || process.env.SMTP_USER,
      to,
      subject: 'Welcome to corex hosting',
      text:
        `Hey ${username},\n\n` +
        `Your corex hosting account is ready — you signed in with Discord and you're all set to upload a bot.\n\n` +
        `If this wasn't you, you can safely ignore this email.\n\n` +
        `— corex hosting`,
    });
    console.log(`[corex] welcome email sent to ${to}`);
  } catch (e) {
    console.error('[corex] failed to send welcome email:', e.message);
  }
}

module.exports = { sendWelcomeEmail };
