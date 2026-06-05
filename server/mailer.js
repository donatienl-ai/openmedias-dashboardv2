// ==========================================
//  ENVOI D'EMAIL VIA MAILJET (API v3.1)
// ==========================================
import fetch from 'node-fetch';

/**
 * Envoie un email HTML via Mailjet.
 * Requiert : MAILJET_API_KEY, MAILJET_SECRET_KEY, REPORT_FROM_EMAIL.
 * @param {{to: string[], subject: string, html: string}} params
 */
export async function sendEmail({ to, subject, html }) {
  const apiKey = process.env.MAILJET_API_KEY;
  const secret = process.env.MAILJET_SECRET_KEY;
  const fromEmail = process.env.REPORT_FROM_EMAIL;
  const fromName = process.env.REPORT_FROM_NAME || 'OpenMedias Reporting';

  if (!apiKey || !secret) throw new Error('MAILJET_API_KEY / MAILJET_SECRET_KEY manquantes');
  if (!fromEmail) throw new Error('REPORT_FROM_EMAIL manquante (expéditeur validé Mailjet)');

  const auth = Buffer.from(`${apiKey}:${secret}`).toString('base64');
  const res = await fetch('https://api.mailjet.com/v3.1/send', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      Messages: [
        {
          From: { Email: fromEmail, Name: fromName },
          To: to.map((email) => ({ Email: email })),
          Subject: subject,
          HTMLPart: html,
        },
      ],
    }),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`Mailjet failed (${res.status}): ${JSON.stringify(data)}`);
  }
  const status = data.Messages?.[0]?.Status;
  if (status !== 'success') {
    throw new Error(`Mailjet status: ${JSON.stringify(data.Messages?.[0] || data)}`);
  }
  return data;
}
