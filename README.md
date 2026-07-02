# Sim Central Broker

<p align="center">
  <a href="https://opensource.org/licenses/MIT"><img src="https://img.shields.io/badge/license-MIT-red.svg"></a>
  <img src="https://img.shields.io/badge/runtime-Cloudflare%20Workers-orange.svg">
</p>

A small Cloudflare Worker that brokers Discord OAuth2 on behalf of any number of [Nova](https://anodyne-productions.com/nova) sims running the [Sim Central Suite](https://github.com/reecesavage/sim-central-suite). One Discord app, one registered redirect URI, however many sims you like.

## Why this exists

Discord OAuth2 apps cap at 10 redirect URIs each. If you run several sims and want "Sign in with Discord" on each one, you either:

- maintain multiple Discord apps and juggle credentials per sim, **or**
- run a central broker like this one that handles the OAuth dance for everyone.

The canonical deployment lives at <https://auth.simcentral.host>. The Sim Central Suite ships pointed at it by default. If you'd rather run your own, this repo has everything you need.

## How it works

```
  ┌─ Sim A ─┐      ┌──────────────────┐      ┌─────────┐
  │ Login   │─────▶│                  │─────▶│         │
  │ button  │      │                  │      │ Discord │
  └─────────┘      │   sim-central-   │◀─────│         │
       ▲           │     broker       │      └─────────┘
       │           │                  │
       └───────────│  one Discord app │
   signed JWT      │  one redirect    │
                   │  URI registered  │
  ┌─ Sim B ─┐      │  with Discord    │
  │ Login   │─────▶│                  │
  │ button  │      └──────────────────┘
  └─────────┘
       ▲
       │
       └─── signed JWT
```

1. A sim sends the user to `https://auth.simcentral.host/start?return_to=https://your-sim.example.com/discord_auth/callback`.
2. The broker stashes the `return_to` in Workers KV against a random state token, then redirects the user to Discord's authorize page.
3. Discord redirects the user back to the broker (`/callback`).
4. The broker exchanges the code, fetches the user's Discord identity, mints a short-lived JWT signed with its private key, and redirects the user to the original `return_to?token=<JWT>`.
5. The sim verifies the JWT signature against the broker's public key (baked into the Sim Central Suite, or fetched from `/.well-known/jwks.json`).

The sim never has to register anything with Discord. The broker never has to know which sims exist.

## Endpoints

| Path | Method | Purpose |
| --- | --- | --- |
| `/start` | GET | Begins an OAuth flow. Requires `?return_to=<https-or-http url>`. Optional: `?v=2` (request version, see below), `?email=1` (v2 only, opts into the `email` scope), `?guilds=1` (opts into the Discord `guilds` scope), `?roles_guild=<guild_id>` (opts into `guilds.members.read` for one guild's role IDs). Redirects to Discord. |
| `/callback` | GET | Discord redirects here. Exchanges code, validates email is verified (when the email scope was requested), fetches guilds/roles if requested, mints JWT, redirects to the original `return_to`. |
| `/.well-known/jwks.json` | GET | Public key in standard JWKS format. Cacheable for an hour. |
| `/health` | GET | `200 ok`. For uptime monitoring. |

## JWT contents

Signed with **RS256**. Claims:

| Claim | Description |
| --- | --- |
| `iss` | Broker base URL (e.g. `https://auth.simcentral.host`) |
| `aud` | Origin of the original `return_to` &mdash; binds the token to one sim |
| `sub` | Discord user ID (snowflake, as string) |
| `username` | Current Discord username |
| `global_name` | Display name (nullable) |
| `email` | *(v1 requests, or v2 with `?email=1`)* Discord email address (verified; see below) |
| `email_verified` | *(v1 requests, or v2 with `?email=1`)* Always `true` &mdash; the broker refuses to mint a JWT for unverified emails when the email scope is in play |
| `avatar` | Discord avatar hash (nullable) |
| `guilds` | *(v1.1.0+ only, when `?guilds=1` was passed on `/start`)* Array of Discord guild ID strings the user is a member of. Just IDs, no names/icons, to keep the JWT compact. |
| `roles` | *(v1.2.0+ only, when `?roles_guild=<id>` was passed on `/start`)* Array of the user's role ID strings within that guild. Empty array if they're not a member. |
| `roles_guild` | *(v1.2.0+ only, alongside `roles`)* The guild ID the `roles` claim was fetched for. |
| `iat` | Issued at (unix seconds) |
| `exp` | Expires (iat + 300 seconds) |

### Request versioning (v1.2.0+)

`/start` accepts a `?v=` parameter:

- **No `v` (or `v=1`)** &mdash; legacy behaviour, unchanged since v1.0.0: the `email` scope is always requested, the user's email must be verified, and `email` / `email_verified` always appear in the JWT. Existing consumers keep working without touching anything. **Deprecated**: new integrations should use v2, and v1 will be removed in a future major version.
- **`v=2`** &mdash; the broker requests only the `identify` scope by default. The JWT carries no `email` or `email_verified` claims, and no verified-email check is performed (Discord only exposes the verified flag under the email scope). Pass `?email=1` alongside `v=2` to opt back into the email scope, the verified-email enforcement, and both claims.

Most consumers don't need the email at all &mdash; matching is done on the Discord ID (`sub`), and consumers that gate on guild membership get email verification implicitly, since Discord requires a verified email to join most servers. v2 keeps the consent screen as small as possible.

### Opting into the guilds scope (v1.1.0+)

When the sim passes `?guilds=1` on `/start`, the broker:

- Adds `guilds` to the OAuth scope, so Discord's consent screen will additionally ask the user to share their server list.
- After token exchange, calls `/users/@me/guilds` and folds the resulting IDs into the JWT as a `guilds` claim.

Sims that don't pass `?guilds=1` see no change &mdash; same scope, no `guilds` claim, same consent prompt. The flag is opt-in so sims that don't need guild membership checks don't trigger an extra Discord permission prompt for their users.

If `?guilds=1` is passed and the `/users/@me/guilds` fetch fails for any reason, the broker redirects with `?error=guilds_fetch_failed` instead of minting a JWT. Silently downgrading to an empty list would let a user bypass any "must be in our server" check the sim is about to enforce.

### Opting into guild roles (v1.2.0+)

A consumer that authorizes by Discord **role** (e.g. the Sim Central moderator dashboard) passes `?roles_guild=<guild_id>` on `/start`. The broker adds the `guilds.members.read` scope, fetches the user's member object for that one guild after token exchange, and folds the role IDs into the JWT as `roles` (with `roles_guild` echoing the guild it asked about). A user who isn't in the guild gets an empty `roles` array &mdash; the consumer then denies. A hard fetch failure redirects with `?error=guild_member_fetch_failed` so "unknown" is never treated as "allowed". No bot required; this reads the member object on the user's own access token.

### Error redirects

When something goes wrong AFTER the state lookup succeeds, the broker redirects to `return_to` with an `?error=` parameter instead of `?token=`. Possible errors:

| Code | Cause |
| --- | --- |
| `email_not_verified` | User's Discord email is not verified (only when the email scope was requested: v1, or v2 with `?email=1`). They must verify it on Discord first. |
| `token_exchange_failed` | Discord rejected the authorization code (rare; usually transient). |
| `identity_fetch_failed` | Discord's `/users/@me` returned non-200 (rare; usually transient). |
| `missing_code` | Discord redirected without a code (shouldn't happen unless something tampered with the flow). |
| `access_denied` | User clicked Cancel on Discord's authorize screen. |
| `guilds_fetch_failed` | *(v1.1.0+ only)* `?guilds=1` was passed but the `/users/@me/guilds` call failed. Usually transient; user should retry. |
| `guild_member_fetch_failed` | *(v1.2.0+ only)* `?roles_guild=` was passed but the member/roles fetch failed (other than a clean "not a member"). Usually transient; user should retry. |

When the state lookup itself fails (token missing, expired, or unknown), the broker has no `return_to` to send the user to, so it renders a plain-text error page instead.

## Self-hosting

If you want to run your own broker instead of using `auth.simcentral.host`, the whole setup is about 15 minutes the first time.

### Prerequisites

- A Cloudflare account (the free tier covers this comfortably &mdash; ~100k requests/day)
- A Discord application (create one at <https://discord.com/developers/applications>)
- Node.js + npm (to install `wrangler`)
- A domain or subdomain you control (e.g. `auth.example.com`), proxied through Cloudflare

### Step 1: Generate an RSA keypair

The broker signs JWTs with this private key. The Sim Central Suite verifies them with the public key.

```sh
openssl genrsa -out priv.pem 2048
openssl rsa  -in priv.pem -pubout -out pub.pem
```

Keep `priv.pem` secret. `pub.pem` is the public half &mdash; it goes in your Worker config (and is served from `/.well-known/jwks.json`).

### Step 2: Set up the Discord application

1. Go to <https://discord.com/developers/applications>, create a new app.
2. **OAuth2 &rarr; Redirects**: add `https://YOUR-BROKER-DOMAIN/callback` (e.g. `https://auth.example.com/callback`). This is the ONE redirect URI you'll ever register.
3. **OAuth2**: copy the **Client ID** and **Client Secret**.

### Step 3: Clone + configure

```sh
git clone https://github.com/reecesavage/sim-central-broker
cd sim-central-broker
npm install                                  # installs wrangler

cp wrangler.toml.example wrangler.toml       # public config + key bindings
cp .dev.vars.example    .dev.vars            # local dev secrets only
```

Edit `wrangler.toml`:

- `DISCORD_CLIENT_ID` &mdash; from step 2
- `BROKER_BASE_URL` &mdash; the URL where this Worker will live (e.g. `https://auth.example.com`)
- `JWT_PUBLIC_KEY` &mdash; paste the full contents of `pub.pem` (with the BEGIN/END lines)

### Step 4: Create the KV namespace

```sh
npx wrangler kv:namespace create STATE_STORE
```

Copy the returned namespace ID into the `[[kv_namespaces]]` block in `wrangler.toml`.

### Step 5: Deploy

```sh
npx wrangler deploy
```

### Step 6: Add the secrets

```sh
npx wrangler secret put DISCORD_CLIENT_SECRET    # paste the secret from step 2
npx wrangler secret put JWT_PRIVATE_KEY          # paste the full contents of priv.pem
```

### Step 7: Wire up the custom domain

In the Cloudflare dashboard:

1. Go to **Workers &amp; Pages &rarr; sim-central-broker &rarr; Settings &rarr; Domains &amp; Routes**.
2. Add a custom domain matching `BROKER_BASE_URL` (e.g. `auth.example.com`).
3. Cloudflare handles DNS + SSL automatically as long as the zone is on your Cloudflare account.

### Step 8: Smoke test

```sh
curl -i "https://YOUR-BROKER-DOMAIN/health"
# expect: HTTP/2 200, body "ok"

curl -i "https://YOUR-BROKER-DOMAIN/.well-known/jwks.json"
# expect: HTTP/2 200, JSON with one key in the `keys` array

curl -i "https://YOUR-BROKER-DOMAIN/start?return_to=https://example.com/cb"
# expect: HTTP/2 302, Location header pointing at discord.com/api/oauth2/authorize?...
```

If all three work, the broker is live.

## Local development

```sh
npx wrangler dev
```

Reads `.dev.vars` for secrets and runs the Worker on `http://localhost:8787`. You can point a test sim at `http://localhost:8787` and run the full OAuth flow locally, provided you've added `http://localhost:8787/callback` to your Discord app's redirect URI list (separate from the production one).

## Tailing logs

```sh
npx wrangler tail
```

Streams `console.log` / `console.warn` / `console.error` from the deployed Worker in real time. Useful when debugging a sim that can't complete the flow.

## Security model

| Layer | What it protects |
| --- | --- |
| HTTPS (Cloudflare-managed) | Network sniffing of the JWT in transit |
| Random state token, single-use, 600s TTL | OAuth CSRF; replay of the same callback URL |
| `aud` claim in JWT | A token issued for Sim A can't be replayed against Sim B |
| `exp` claim (5 min) | A leaked URL can't be used hours later |
| Email-verified gate at broker | Unverified Discord accounts can't sign in to any sim using this broker |
| Cloudflare WAF / rate limiting (optional) | Abusive request floods |

The private key never leaves Cloudflare's secret store. The Discord client secret never leaves Cloudflare's secret store. The repo intentionally contains no credentials.

## License

MIT. See [`LICENSE`](LICENSE).
