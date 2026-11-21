-- Private contact requests. Bind this database only to the Worker; do not expose it through a public API.
CREATE TABLE IF NOT EXISTS contact_requests (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  telephone TEXT NOT NULL,
  email TEXT NOT NULL,
  message TEXT NOT NULL,
  token_hash TEXT UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('pending', 'confirmed', 'expired', 'email_failed')),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  confirmed_at INTEGER,
  notification_status TEXT NOT NULL DEFAULT 'not_applicable'
    CHECK (notification_status IN ('not_applicable', 'pending', 'sent')),
  notification_attempts INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS contact_requests_expiry_idx
  ON contact_requests(status, expires_at);
CREATE INDEX IF NOT EXISTS contact_requests_notification_idx
  ON contact_requests(status, notification_status, confirmed_at);
