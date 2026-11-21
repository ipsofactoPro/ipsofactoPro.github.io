const ALLOWED_ORIGIN = 'https://ipsofacto.pro';
const NOTIFICATION_RECIPIENT = 'contact@ipsofacto.pro';
const TOKEN_TTL_SECONDS = 24 * 60 * 60;
const MAX_BODY_BYTES = 12_000;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/contact') {
      if (request.method === 'OPTIONS') return corsPreflight(request);
      if (request.method !== 'POST') return json(request, { ok: false, error: 'Method not allowed.' }, 405);
      return handleContact(request, env);
    }
    if (url.pathname === '/confirm') {
      if (request.method === 'GET') return confirmationPage(url.searchParams.get('token'));
      if (request.method === 'POST') return confirmRequest(request, env);
      return htmlPage('Method not allowed', 'This method is not supported.', 405);
    }
    return new Response('Not found', { status: 404 });
  },

  async scheduled(_event, env, ctx) {
    ctx.waitUntil(expireAndRetryNotifications(env));
  }
};

async function handleContact(request, env) {
  if (!isAllowedOrigin(request)) return json(request, { ok: false, error: 'Request origin is not allowed.' }, 403);
  const contentType = request.headers.get('content-type') || '';
  if (!contentType.toLowerCase().includes('application/json')) {
    return json(request, { ok: false, error: 'Send the form as JSON.' }, 415);
  }
  const length = Number(request.headers.get('content-length') || 0);
  if (length > MAX_BODY_BYTES) return json(request, { ok: false, error: 'Request is too large.' }, 413);

  let input;
  try {
    input = await request.json();
  } catch {
    return json(request, { ok: false, error: 'Invalid request body.' }, 400);
  }

  const data = {
    name: cleanString(input?.name, 120),
    telephone: cleanString(input?.telephone, 40),
    email: cleanString(input?.email, 254).toLowerCase(),
    message: cleanString(input?.message, 5000)
  };
  if (!data.name || !data.telephone || !data.message || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email)) {
    return json(request, { ok: false, error: 'Please provide a valid name, telephone, email, and message.' }, 400);
  }

  const token = randomToken();
  const tokenHash = await sha256Hex(token);
  const id = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = now + TOKEN_TTL_SECONDS;

  try {
    await env.DB.prepare(`INSERT INTO contact_requests
      (id, name, telephone, email, message, token_hash, status, created_at, expires_at, notification_status)
      VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, 'not_applicable')`)
      .bind(id, data.name, data.telephone, data.email, tokenHash, now, expiresAt)
      .run();
  } catch (error) {
    console.error('Unable to store contact request', error);
    return json(request, { ok: false, error: 'Unable to submit your message right now.' }, 500);
  }

  const confirmationUrl = `https://id.ipsofacto.pro/confirm?token=${token}`;
  try {
    await sendEmail(env, {
      to: data.email,
      subject: 'Confirm your message to ipsofacto.pro',
      text: `Hello ${data.name},\n\nPlease confirm your email address to send your message to ipsofacto.pro by opening this link within 24 hours:\n\n${confirmationUrl}\n\nIf you did not submit this request, you can ignore this email. No message will be sent to the site owner unless you confirm.`
    }, `contact-confirm-${id}`);
  } catch (error) {
    console.error('Unable to send contact verification email', error);
    await env.DB.prepare("UPDATE contact_requests SET status = 'email_failed', token_hash = NULL WHERE id = ? AND status = 'pending'")
      .bind(id).run();
    return json(request, { ok: false, error: 'The verification email could not be sent. Please try again later.' }, 502);
  }

  return json(request, { ok: true }, 202);
}

function confirmationPage(token) {
  if (!token || !/^[a-f0-9]{64}$/i.test(token)) {
    return htmlPage('Invalid verification link', 'This verification link is invalid or incomplete.', 400);
  }
  return htmlPage('Confirm your email', `
    <p>Click the button below to confirm your email address and send your message.</p>
    <form method="post" action="https://id.ipsofacto.pro/confirm">
      <input type="hidden" name="token" value="${token}">
      <button type="submit">Confirm email and send message</button>
    </form>
    <p>This link expires after 24 hours. If you did not submit the form, you can close this page.</p>
  `);
}

async function confirmRequest(request, env) {
  let form;
  try {
    form = await request.formData();
  } catch {
    return htmlPage('Invalid request', 'The verification request could not be read.', 400);
  }
  const token = String(form.get('token') || '');
  if (!/^[a-f0-9]{64}$/i.test(token)) {
    return htmlPage('Invalid verification link', 'This verification link is invalid or incomplete.', 400);
  }

  const now = Math.floor(Date.now() / 1000);
  const tokenHash = await sha256Hex(token);
  let updated;
  try {
    updated = await env.DB.prepare(`UPDATE contact_requests
      SET status = 'confirmed', confirmed_at = ?, notification_status = 'pending'
      WHERE token_hash = ? AND status = 'pending' AND expires_at > ?
      RETURNING id`)
      .bind(now, tokenHash, now).all();
  } catch (error) {
    console.error('Unable to confirm contact request', error);
    return htmlPage('Temporary error', 'Please try again later.', 503);
  }

  const row = updated.results?.[0];
  if (!row) {
    return htmlPage('Link unavailable', 'This link is invalid, expired, or has already been used. No new notification was sent.', 410);
  }

  // Confirmation is recorded before notification. If email delivery fails, the scheduled retry will send it.
  try {
    await sendNotification(env, row.id);
  } catch (error) {
    console.error('Contact notification deferred to scheduled retry', error);
  }
  return htmlPage('Email confirmed', 'Your email is confirmed and your message has been sent to ipsofacto.pro. Thank you.');
}

async function sendNotification(env, id) {
  const row = await env.DB.prepare(`SELECT id, name, telephone, email, message
    FROM contact_requests WHERE id = ? AND status = 'confirmed' AND notification_status = 'pending'`)
    .bind(id).first();
  if (!row) return;

  await env.DB.prepare('UPDATE contact_requests SET notification_attempts = notification_attempts + 1 WHERE id = ?')
    .bind(id).run();
  await sendEmail(env, {
    to: NOTIFICATION_RECIPIENT,
    subject: 'Verified contact form message from ipsofacto.pro',
    text: `A visitor confirmed their email address.\n\nName: ${row.name}\nTelephone: ${row.telephone}\nEmail: ${row.email}\n\nMessage:\n${row.message}`
  }, `contact-notification-${id}`);
  await env.DB.prepare("UPDATE contact_requests SET notification_status = 'sent' WHERE id = ? AND status = 'confirmed'")
    .bind(id).run();
}

async function expireAndRetryNotifications(env) {
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(`UPDATE contact_requests SET status = 'expired', token_hash = NULL
    WHERE status = 'pending' AND expires_at <= ?`).bind(now).run();

  const pending = await env.DB.prepare(`SELECT id FROM contact_requests
    WHERE status = 'confirmed' AND notification_status = 'pending'
    ORDER BY confirmed_at ASC LIMIT 50`).all();
  for (const row of pending.results || []) {
    try {
      await sendNotification(env, row.id);
    } catch (error) {
      console.error('Notification retry failed', row.id, error);
    }
  }
}

async function sendEmail(env, message, idempotencyKey) {
  if (!env.RESEND_API_KEY || !env.FROM_EMAIL) throw new Error('Email provider configuration is missing.');
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': idempotencyKey
    },
    body: JSON.stringify({ from: env.FROM_EMAIL, ...message })
  });
  if (!response.ok) throw new Error(`Email provider returned HTTP ${response.status}.`);
}

function cleanString(value, maxLength) {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function sha256Hex(value) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function isAllowedOrigin(request) {
  return request.headers.get('Origin') === ALLOWED_ORIGIN;
}

function corsHeaders(request) {
  const origin = request.headers.get('Origin');
  const headers = { 'Vary': 'Origin' };
  if (origin === ALLOWED_ORIGIN) {
    headers['Access-Control-Allow-Origin'] = ALLOWED_ORIGIN;
    headers['Access-Control-Allow-Methods'] = 'POST, OPTIONS';
    headers['Access-Control-Allow-Headers'] = 'Content-Type, Accept';
    headers['Access-Control-Max-Age'] = '86400';
  }
  return headers;
}

function corsPreflight(request) {
  if (!isAllowedOrigin(request)) return new Response(null, { status: 403 });
  return new Response(null, { status: 204, headers: corsHeaders(request) });
}

function json(request, body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...corsHeaders(request) }
  });
}

function htmlPage(title, content, status = 200) {
  const safeTitle = escapeHtml(title);
  return new Response(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer"><title>${safeTitle}</title>
<style>body{font:16px/1.6 system-ui,sans-serif;max-width:42rem;margin:10vh auto;padding:0 1.25rem;color:#172033}button{padding:.7rem 1rem;cursor:pointer}</style></head>
<body><main><h1>${safeTitle}</h1>${content}</main></body></html>`, {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https://id.ipsofacto.pro; base-uri 'none'; frame-ancestors 'none'"
    }
  });
}

function escapeHtml(value) {
  return value.replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[char]);
}
