# Sim Central Broker v1.2.0 — Request versioning (`?v=2`), opt-in email scope, guild roles

Two additions, both fully backward-compatible: versioned requests that make the `email` scope opt-in, and a per-guild role lookup for role-gated consumers like the Sim Central moderator dashboard. Unversioned requests behave exactly as they always have &mdash; no consumer breaks by upgrading the broker.

## What's new

### Request versioning: `?v=2` on `/start`

Until now the broker always requested the Discord `identify email` scopes. Most consumers never use the email &mdash; matching is done on the Discord ID (`sub` claim) &mdash; so v2 trims the consent screen to the minimum:

- **`?v=2`** &mdash; requests only the `identify` scope. The JWT carries no `email` / `email_verified` claims and no verified-email check is performed (Discord only exposes the verified flag under the email scope).
- **`?v=2&email=1`** &mdash; opts back into the email scope, the verified-email enforcement, and both claims. For consumers that genuinely want the address (e.g. pre-filling a sign-up form).
- **No `v` (or `v=1`)** &mdash; the legacy flow, byte-for-byte: `identify email` scope, verified-email hard fail, `email` + `email_verified` always in the JWT.

Consumers that gate on guild membership lose nothing by skipping the email scope: Discord requires a verified email to join most servers, so the guild check implies verification.

**v1 is now deprecated.** It keeps working indefinitely for existing installs, but new integrations should send `?v=2`, and a future major version will remove the unversioned flow.

### Guild role lookup: `?roles_guild=<guild_id>` on `/start`

For consumers that authorize by Discord **role** rather than mere membership. The broker adds the `guilds.members.read` scope, fetches the user's member object for that single guild, and includes `roles` (array of role ID strings; empty if not a member) and `roles_guild` (the guild asked about) in the JWT. Hard fetch failures redirect with `?error=guild_member_fetch_failed` so "unknown" is never treated as "allowed". No bot required &mdash; the lookup rides the user's own access token.

This is the mechanism behind the Sim Central moderator dashboard's Discord-role sign-in.

## Backward compatibility

- Consumers not passing `?v=2` (every Sim Central Suite release up to and including v1.24.x, and any self-hosted integration) get the exact flow they had on broker v1.1.0. Same scopes, same consent screen, same JWT claims.
- Sign-ins already in flight across the deploy complete on the legacy path.
- `?guilds=1` works identically in both versions.

## Operator notes

- **No Discord app config change.** Scopes are requested per-flow.
- **No KV schema change.** The new `version` / `wants_email` flags ride the same per-flow state value.
- **No new secrets.**

## Upgrade

```sh
cd sim-central-broker
git pull
npx wrangler deploy
```

## Credits

Same as v1.0.0. MIT licensed.

Issues: <https://github.com/reecesavage/sim-central-broker/issues>
Chat: [Sim Central on Discord](https://discord.gg/simcentral)
