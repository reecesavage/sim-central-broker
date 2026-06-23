// sim-central-broker
//
// Cloudflare Worker that brokers Discord OAuth2 on behalf of any number
// of Nova sims running the Sim Central Suite. The whole point is to
// dodge Discord's per-app redirect-URI cap: this broker has ONE Discord
// app and ONE registered redirect URI, and dispatches users back to
// whichever sim asked them to sign in.
//
// Flow:
//   1. Sim's "Sign in with Discord" button sends user to
//        GET /start?return_to=<sim_callback_url>
//      We validate the URL, mint a random state token, stash
//        STATE_STORE[state:<token>] = { return_to, origin }   TTL 600s
//      and 302 the user to Discord's authorize endpoint with that state.
//
//   2. Discord redirects user to OUR /callback?code=&state=.
//      We read+delete the KV entry (single-use), exchange the code at
//      Discord's token endpoint, fetch /users/@me, then:
//        - if email not verified  -> 302 return_to?error=email_not_verified
//        - otherwise              -> sign an RS256 JWT and
//                                    302 return_to?token=<JWT>
//
//   3. The sim's callback handler verifies the JWT signature against the
//      broker's public key (baked into the Sim Central Suite or fetched
//      from /.well-known/jwks.json), then logs the user in.
//
// Nothing in this file is secret. Secrets live in Cloudflare's secret
// store (see README): DISCORD_CLIENT_SECRET, JWT_PRIVATE_KEY.
// Public config lives in wrangler.toml: DISCORD_CLIENT_ID,
// JWT_PUBLIC_KEY, BROKER_BASE_URL.

const DISCORD_AUTHORIZE_URL = 'https://discord.com/api/oauth2/authorize';
const DISCORD_TOKEN_URL     = 'https://discord.com/api/oauth2/token';
const DISCORD_ME_URL        = 'https://discord.com/api/users/@me';
const DISCORD_GUILDS_URL    = 'https://discord.com/api/users/@me/guilds';
const BASE_SCOPES           = 'identify email';
const GUILDS_SCOPE          = 'guilds';
const GUILD_MEMBER_SCOPE    = 'guilds.members.read';
const STATE_TTL_SECONDS     = 600;
const JWT_TTL_SECONDS       = 300;
const JWT_KID               = '1';

export default {
	async fetch(request, env) {
		const url = new URL(request.url);
		try {
			switch (url.pathname) {
				case '/start':                 return handleStart(url, env);
				case '/callback':              return handleCallback(url, env);
				case '/.well-known/jwks.json': return handleJwks(env);
				case '/health':                return new Response('ok', { status: 200 });
				default:                       return text('not found', 404);
			}
		} catch (err) {
			// Don't leak stack traces to the user; log to Workers tail.
			console.error('unhandled error', err && err.stack ? err.stack : err);
			return text('internal error', 500);
		}
	},
};

// ---------- /start ----------

async function handleStart(url, env) {
	const returnTo = url.searchParams.get('return_to');
	if ( ! returnTo || ! isValidReturnTo(returnTo)) {
		return text('invalid or missing return_to', 400);
	}
	const returnOrigin = new URL(returnTo).origin;

	// Optional: sim asked for the user's guild memberships so it can
	// enforce a "must be in our Discord server" check. Opt-in via
	// ?guilds=1 keeps the Discord consent screen unchanged for sims
	// that don't need this scope.
	const wantsGuilds = url.searchParams.get('guilds') === '1';

	// Optional: a consumer (e.g. the moderator dashboard) asks for the user's
	// ROLES within a specific guild via ?roles_guild=<guild_id>. This adds the
	// guilds.members.read scope and, on callback, the user's role ids in that
	// guild land in the JWT. Gated like ?guilds so normal sim sign-in is
	// unaffected (no extra consent for sims that don't ask).
	const rolesGuild = (url.searchParams.get('roles_guild') || '').replace(/[^0-9]/g, '');

	const state = randomToken(32);
	await env.STATE_STORE.put(
		'state:' + state,
		JSON.stringify({
			return_to:    returnTo,
			origin:       returnOrigin,
			wants_guilds: wantsGuilds,
			roles_guild:  rolesGuild || null,
			created:      nowSeconds(),
		}),
		{ expirationTtl: STATE_TTL_SECONDS }
	);

	const scopes = [BASE_SCOPES];
	if (wantsGuilds) { scopes.push(GUILDS_SCOPE); }
	if (rolesGuild)  { scopes.push(GUILD_MEMBER_SCOPE); }
	const scope = scopes.join(' ');
	const params = new URLSearchParams({
		client_id:     env.DISCORD_CLIENT_ID,
		redirect_uri:  env.BROKER_BASE_URL + '/callback',
		response_type: 'code',
		scope:         scope,
		state,
		prompt:        'consent',
	});
	return redirect(DISCORD_AUTHORIZE_URL + '?' + params.toString());
}

// ---------- /callback ----------

async function handleCallback(url, env) {
	const state = url.searchParams.get('state');
	const code  = url.searchParams.get('code');
	const denied = url.searchParams.get('error'); // Discord-side denial

	if ( ! state) {
		return text('missing state', 400);
	}

	// Look up + delete the state (single-use; guards against replay).
	const raw = await env.STATE_STORE.get('state:' + state);
	if ( ! raw) {
		return text('state expired or unknown - please start sign-in again', 400);
	}
	await env.STATE_STORE.delete('state:' + state);

	let stored;
	try { stored = JSON.parse(raw); }
	catch { return text('corrupt state', 500); }
	const returnTo    = stored.return_to;
	const audience    = stored.origin;
	const wantsGuilds = stored.wants_guilds === true;
	const rolesGuild  = stored.roles_guild || null;

	// User cancelled / Discord refused before we even got a code.
	if (denied) {
		return redirect(appendQuery(returnTo, { error: denied }));
	}
	if ( ! code) {
		return redirect(appendQuery(returnTo, { error: 'missing_code' }));
	}

	// Exchange code for access token.
	const tokenRes = await exchangeCode(code, env);
	if ( ! tokenRes) {
		return redirect(appendQuery(returnTo, { error: 'token_exchange_failed' }));
	}

	// Fetch the user's Discord identity.
	const user = await fetchUser(tokenRes.access_token);
	if ( ! user) {
		return redirect(appendQuery(returnTo, { error: 'identity_fetch_failed' }));
	}

	// Enforce verified email - this is a policy decision baked into the
	// canonical broker. The suite re-checks email_verified as a safety
	// net, but failing here means the user never sees a half-completed
	// sign-up form before getting bounced.
	if (user.verified !== true) {
		return redirect(appendQuery(returnTo, { error: 'email_not_verified' }));
	}

	// Optional: fetch the user's guild memberships when the sim asked
	// for them via ?guilds=1 on /start. Failing this fetch is a hard
	// fail because the sim is presumably about to enforce a
	// "must be in our server" check and a missing list would be unsafe
	// to treat as empty.
	let guildIds = null;
	if (wantsGuilds) {
		guildIds = await fetchGuildIds(tokenRes.access_token);
		if (guildIds === null) {
			return redirect(appendQuery(returnTo, { error: 'guilds_fetch_failed' }));
		}
	}

	// Optional: the user's role ids within a specific guild (?roles_guild=...).
	// Not a member of that guild -> empty list (consumer then denies). A hard
	// fetch error is fatal so the consumer never treats "unknown" as "allowed".
	let memberRoles = null;
	if (rolesGuild) {
		const member = await fetchGuildMember(tokenRes.access_token, rolesGuild);
		if (member === null) {
			return redirect(appendQuery(returnTo, { error: 'guild_member_fetch_failed' }));
		}
		memberRoles = member.roles;
	}

	// Mint and hand off the JWT.
	const now = nowSeconds();
	const claims = {
		iss:            env.BROKER_BASE_URL,
		aud:            audience,
		sub:            String(user.id),
		username:       user.username || null,
		global_name:    user.global_name || null,
		email:          user.email || null,
		email_verified: true,
		avatar:         user.avatar || null,
		iat:            now,
		exp:            now + JWT_TTL_SECONDS,
	};
	if (guildIds !== null) {
		claims.guilds = guildIds;
	}
	if (memberRoles !== null) {
		claims.roles = memberRoles;
		claims.roles_guild = String(rolesGuild);
	}
	const jwt = await signJWT(claims, env.JWT_PRIVATE_KEY);

	return redirect(appendQuery(returnTo, { token: jwt }));
}

// ---------- /.well-known/jwks.json ----------

async function handleJwks(env) {
	const key = await crypto.subtle.importKey(
		'spki',
		pemToDer(env.JWT_PUBLIC_KEY, 'PUBLIC KEY'),
		{ name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
		true,
		['verify']
	);
	const jwk = await crypto.subtle.exportKey('jwk', key);
	const body = JSON.stringify({
		keys: [{
			kty: 'RSA',
			use: 'sig',
			alg: 'RS256',
			kid: JWT_KID,
			n:   jwk.n,
			e:   jwk.e,
		}],
	});
	return new Response(body, {
		status: 200,
		headers: {
			'Content-Type':  'application/json',
			'Cache-Control': 'public, max-age=3600',
		},
	});
}

// ---------- Discord helpers ----------

async function exchangeCode(code, env) {
	const body = new URLSearchParams({
		client_id:     env.DISCORD_CLIENT_ID,
		client_secret: env.DISCORD_CLIENT_SECRET,
		grant_type:    'authorization_code',
		code,
		redirect_uri:  env.BROKER_BASE_URL + '/callback',
	});
	const res = await fetch(DISCORD_TOKEN_URL, {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		body,
	});
	if ( ! res.ok) {
		console.warn('discord token exchange failed', res.status, await res.text());
		return null;
	}
	return res.json();
}

async function fetchUser(accessToken) {
	const res = await fetch(DISCORD_ME_URL, {
		headers: { Authorization: 'Bearer ' + accessToken },
	});
	if ( ! res.ok) {
		console.warn('discord users/@me failed', res.status, await res.text());
		return null;
	}
	return res.json();
}

/**
 * Fetch the user's guild memberships, returning an array of guild ID
 * strings (the rest of the guild object is discarded to keep the JWT
 * compact). Returns null on any failure - the caller treats that as a
 * hard error rather than "user is in zero guilds," since silently
 * downgrading would let users bypass a "must be in guild X" check.
 */
async function fetchGuildIds(accessToken) {
	const res = await fetch(DISCORD_GUILDS_URL, {
		headers: { Authorization: 'Bearer ' + accessToken },
	});
	if ( ! res.ok) {
		console.warn('discord users/@me/guilds failed', res.status, await res.text());
		return null;
	}
	let data;
	try { data = await res.json(); }
	catch (e) {
		console.warn('discord users/@me/guilds returned non-JSON', e);
		return null;
	}
	if ( ! Array.isArray(data)) {
		return null;
	}
	return data.map(g => String(g && g.id)).filter(Boolean);
}

// Fetch the user's member object (incl. role ids) for one guild via the
// guilds.members.read scope. Returns { roles: string[] }; a 404 means the user
// isn't in that guild (-> empty roles); null means a hard fetch failure.
async function fetchGuildMember(accessToken, guildId) {
	const res = await fetch(
		'https://discord.com/api/users/@me/guilds/' + encodeURIComponent(guildId) + '/member',
		{ headers: { Authorization: 'Bearer ' + accessToken } }
	);
	if (res.status === 404) {
		return { roles: [] };
	}
	if ( ! res.ok) {
		console.warn('discord guild member fetch failed', res.status, await res.text());
		return null;
	}
	let data;
	try { data = await res.json(); }
	catch (e) {
		console.warn('discord guild member returned non-JSON', e);
		return null;
	}
	const roles = (data && Array.isArray(data.roles)) ? data.roles.map(String).filter(Boolean) : [];
	return { roles };
}

// ---------- JWT (RS256) ----------

async function signJWT(payload, privateKeyPem) {
	const header = { alg: 'RS256', typ: 'JWT', kid: JWT_KID };
	const headerB64  = base64UrlEncode(new TextEncoder().encode(JSON.stringify(header)));
	const payloadB64 = base64UrlEncode(new TextEncoder().encode(JSON.stringify(payload)));
	const signingInput = headerB64 + '.' + payloadB64;

	const key = await crypto.subtle.importKey(
		'pkcs8',
		pemToDer(privateKeyPem, 'PRIVATE KEY'),
		{ name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
		false,
		['sign']
	);
	const sig = await crypto.subtle.sign(
		'RSASSA-PKCS1-v1_5',
		key,
		new TextEncoder().encode(signingInput)
	);
	return signingInput + '.' + base64UrlEncode(new Uint8Array(sig));
}

// ---------- low-level helpers ----------

function isValidReturnTo(value) {
	try {
		const u = new URL(value);
		// Allow http for dev sims; production sims will be https.
		// We rely on the JWT's `aud` claim to bind the token to the
		// requesting origin, so we don't need to enforce https here.
		return u.protocol === 'http:' || u.protocol === 'https:';
	} catch {
		return false;
	}
}

function appendQuery(url, params) {
	const u = new URL(url);
	for (const [k, v] of Object.entries(params)) {
		u.searchParams.set(k, v);
	}
	return u.toString();
}

function randomToken(byteLen) {
	const bytes = new Uint8Array(byteLen);
	crypto.getRandomValues(bytes);
	return base64UrlEncode(bytes);
}

function base64UrlEncode(bytes) {
	let bin = '';
	for (let i = 0; i < bytes.length; i++) {
		bin += String.fromCharCode(bytes[i]);
	}
	return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function pemToDer(pem, label) {
	const begin = '-----BEGIN ' + label + '-----';
	const end   = '-----END ' + label + '-----';
	const b64 = pem
		.replace(begin, '')
		.replace(end, '')
		.replace(/\s+/g, '');
	const bin = atob(b64);
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
	return out.buffer;
}

function nowSeconds() {
	return Math.floor(Date.now() / 1000);
}

function redirect(url) {
	return new Response(null, {
		status: 302,
		headers: { Location: url, 'Cache-Control': 'no-store' },
	});
}

function text(body, status) {
	return new Response(body + '\n', {
		status,
		headers: { 'Content-Type': 'text/plain; charset=utf-8' },
	});
}
