# Sim Central Broker v1.1.0 — Opt-in `guilds` scope

Adds support for the upcoming Sim Central Suite v1.7.0 "Required Discord guild membership" feature. Fully backward-compatible &mdash; sims that don't request the new scope see zero behavioural change.

## What's new

### `?guilds=1` query parameter on `/start`

When a sim passes `?guilds=1` along with `?return_to=`, the broker:

- Adds `guilds` to the OAuth scope, so Discord's consent screen additionally prompts the user to share their server list with the broker.
- After the token exchange, calls `https://discord.com/api/users/@me/guilds` and includes a `guilds` claim in the issued JWT &mdash; an array of Discord guild ID strings the user is a member of.

Just IDs are included &mdash; not names, icons, or any other guild metadata &mdash; to keep the JWT compact (a power user in 100 servers adds ~1.8 KB). Sims that need names look them up in their own admin config; the suite reuses the admin-supplied names for error messages instead of trusting Discord-supplied data.

### Backward compatibility

Sims **not** passing `?guilds=1`:

- Scope stays `identify email` &mdash; no change to the Discord consent prompt for the user.
- No `guilds` claim in the JWT.
- No call to `/users/@me/guilds` &mdash; fewer requests against the user's access token.

That includes Sim Central Suite **v1.6.x and earlier**, which doesn't know about the new flag. Those installations get the exact same flow they had before.

### Hard fail on guild fetch errors

If `?guilds=1` is passed and the `/users/@me/guilds` request fails (network, 5xx, rate-limited, malformed JSON), the broker redirects to `return_to?error=guilds_fetch_failed` instead of minting a JWT with no `guilds` claim. Downgrading silently would let a user bypass any "must be in our server" check the sim is about to enforce; failing visibly is the safer policy.

The suite surfaces a user-facing message and offers a "Try again" button when it receives this error code.

## Operator notes

- **No re-deploy of Discord app config required.** The `guilds` scope is requested per-flow; no permissions change in your Discord app dashboard.
- **No KV schema change.** The `wants_guilds` flag is stored in the same per-flow state value alongside `return_to` and `origin`.
- **No new secrets.** Uses the existing `DISCORD_CLIENT_SECRET` and `JWT_PRIVATE_KEY`.

## Upgrade

```sh
cd sim-central-broker
git pull
npx wrangler deploy
```

That's it. The first `?guilds=1` request from a v1.7.0+ suite will exercise the new code path; everything else continues as before.

## Credits

Same as v1.0.0. MIT licensed.

Issues: <https://github.com/reecesavage/sim-central-broker/issues>
Chat: [Sim Central on Discord](https://discord.gg/simcentral)
