# Contact form verification Worker

The GitHub Pages form sends JSON to `/contact`; it never sends email itself. This Worker stores each request in a private Cloudflare D1 database, emails a one-time verification link, and sends the owner notification only after an unexpired token is confirmed.

## Configure

1. Create a D1 database and run `workers/schema.sql` against it.
2. Bind that database to this Worker as `DB`.
3. Set Worker secrets and variables:
   - `RESEND_API_KEY` — secret API key for Resend (or adapt `sendEmail()` to another provider).
   - `FROM_EMAIL` — a sender address verified with your email provider, e.g. `ipsofacto.pro <no-reply@ipsofacto.pro>`.
   - `TURNSTILE_SECRET_KEY` — secret key for the Turnstile widget, configured as a Worker secret.
4. Create a Turnstile widget for `ipsofacto.pro`, then replace `YOUR_TURNSTILE_SITE_KEY` in `index.html` with that widget's site key. The site key is public; the secret key must only be stored in the Worker secret binding.
5. Deploy the Worker at the endpoint already referenced in `index.html`:
   `https://ipsofacto-pro-contact.lucianocircelli.workers.dev`
6. Configure `id.ipsofacto.pro` as a Cloudflare Worker custom domain for this same Worker. The Worker serves `/confirm` there. The site origin is currently restricted to `https://ipsofacto.pro`; update `ALLOWED_ORIGIN` only if the published site origin changes.
7. Configure a scheduled trigger every five minutes. It expires pending requests, retries confirmed notifications that the email provider could not deliver, and deletes expired and email-failed records once they are 30 days old. Example Wrangler settings:

   ```toml
   [triggers]
   crons = ["*/5 * * * *"]
   ```

Example D1 binding:

```toml
[[d1_databases]]
binding = "DB"
database_name = "contact-requests"
database_id = "YOUR_D1_DATABASE_ID"
```

Keep the D1 database private: do not create a public query endpoint or expose the binding to browser code. The Worker retains expired and email-failed requests for up to 30 days from creation; confirmed records are retained until you establish and implement a separate privacy retention policy.

## Routes

- `POST /contact` — validates form data and the Turnstile token with Cloudflare Siteverify, saves a `pending` request, and sends the visitor a 24-hour verification email.
- `GET /confirm?token=...` — displays a confirmation form. It deliberately requires an explicit button POST so link scanners that merely fetch links do not confirm a request.
- `POST /confirm` — atomically consumes a valid, unexpired token, clears its hash, marks the request confirmed, then sends a notification to `contact@ipsofacto.pro`.
- Scheduled handler — marks unconfirmed expired requests `expired` (and removes their token hash) without notifying the owner; retries notifications for confirmed requests and deletes `expired`/`email_failed` rows at the retention cutoff.

The raw verification token is never stored, only its SHA-256 hash. The confirmation endpoint does not expose visitor data. Configure Cloudflare rate limiting before relying on the public endpoint at scale; CORS is not an abuse-prevention mechanism.
