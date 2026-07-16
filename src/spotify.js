// ---------------------------------------------------------------------------
// Spotify integration: browser-only OAuth (PKCE — no server or secret needed),
// token storage + refresh, and the Web Playback SDK so this device can become
// a Spotify speaker named "Horse Race". Playback requires Spotify Premium.
// ---------------------------------------------------------------------------

const CLIENT_ID = import.meta.env.VITE_SPOTIFY_CLIENT_ID;
const TOKEN_KEY = "hr_spotify_token";
const VERIFIER_KEY = "hr_spotify_verifier";
const RETURN_KEY = "hr_spotify_return";

const redirectUri = () => window.location.origin + "/";

export const spotifyConfigured = () => !!CLIENT_ID;
export const spotifyHasToken = () => !!loadToken();

function loadToken() {
  try {
    const t = JSON.parse(localStorage.getItem(TOKEN_KEY));
    return t?.access_token ? t : null;
  } catch { return null; }
}

function saveToken(tok) {
  const prev = loadToken();
  localStorage.setItem(TOKEN_KEY, JSON.stringify({
    access_token: tok.access_token,
    refresh_token: tok.refresh_token || prev?.refresh_token || null,
    expires_at: Date.now() + (tok.expires_in || 3600) * 1000,
  }));
}

export function spotifyLogout() {
  localStorage.removeItem(TOKEN_KEY);
}

function b64url(buf) {
  return btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Send the user to Spotify's login page. returnState is restored after redirect. */
export async function spotifyLogin(returnState) {
  const bytes = new Uint8Array(48);
  crypto.getRandomValues(bytes);
  const verifier = b64url(bytes);
  localStorage.setItem(VERIFIER_KEY, verifier);
  localStorage.setItem(RETURN_KEY, JSON.stringify(returnState || {}));
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    response_type: "code",
    redirect_uri: redirectUri(),
    scope: "streaming user-read-email user-read-private user-modify-playback-state user-read-playback-state",
    code_challenge_method: "S256",
    code_challenge: b64url(digest),
  });
  window.location.assign(`https://accounts.spotify.com/authorize?${params.toString()}`);
}

/**
 * Call once on app load. If we just came back from Spotify's login page,
 * exchanges the code for tokens and returns the saved returnState so the app
 * can put the user back where they were. Returns null on a normal page load.
 */
export async function spotifyHandleRedirect() {
  const params = new URLSearchParams(window.location.search);
  const code = params.get("code");
  const err = params.get("error");
  if (!code && !err) return null;
  let ret = null;
  try { ret = JSON.parse(localStorage.getItem(RETURN_KEY)); } catch { /* fine */ }
  localStorage.removeItem(RETURN_KEY);
  window.history.replaceState({}, "", redirectUri());
  if (err) return ret;
  const verifier = localStorage.getItem(VERIFIER_KEY);
  localStorage.removeItem(VERIFIER_KEY);
  try {
    const res = await fetch("https://accounts.spotify.com/api/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: CLIENT_ID,
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri(),
        code_verifier: verifier,
      }),
    });
    const tok = await res.json();
    if (tok.access_token) saveToken(tok);
    else console.error("Spotify token exchange failed:", tok);
  } catch (e) {
    console.error("Spotify token exchange failed:", e);
  }
  return ret;
}

/** Get a valid access token, refreshing it if it's about to expire. */
export async function getAccessToken() {
  const t = loadToken();
  if (!t) return null;
  if (Date.now() < t.expires_at - 60000) return t.access_token;
  if (!t.refresh_token) return t.access_token;
  try {
    const res = await fetch("https://accounts.spotify.com/api/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: CLIENT_ID,
        grant_type: "refresh_token",
        refresh_token: t.refresh_token,
      }),
    });
    const tok = await res.json();
    if (tok.access_token) { saveToken(tok); return tok.access_token; }
  } catch (e) {
    console.error("Spotify token refresh failed:", e);
  }
  return t.access_token;
}

let sdkPromise = null;
function loadSdk() {
  if (window.Spotify) return Promise.resolve();
  if (sdkPromise) return sdkPromise;
  sdkPromise = new Promise((resolve) => {
    window.onSpotifyWebPlaybackSDKReady = () => resolve();
    const s = document.createElement("script");
    s.src = "https://sdk.scdn.co/spotify-player.js";
    document.body.appendChild(s);
  });
  return sdkPromise;
}

/** Turn this device into a Spotify speaker. Calls onReady(player, deviceId). */
export async function startSpeaker({ onReady, onError }) {
  await loadSdk();
  const player = new window.Spotify.Player({
    name: "Horse Race 🏇",
    getOAuthToken: (cb) => { getAccessToken().then((tk) => cb(tk)); },
    volume: 0.6,
  });
  player.addListener("ready", ({ device_id }) => onReady(player, device_id));
  player.addListener("initialization_error", ({ message }) => onError(message));
  player.addListener("authentication_error", ({ message }) => onError(message));
  player.addListener("account_error", () =>
    onError("Playback needs Spotify Premium on the connected account."));
  await player.connect();
  return player;
}

/** Accepts a pasted Spotify link or URI; returns a spotify: URI or null. */
export function parseSpotifyLink(text) {
  const m = (text || "").match(/(playlist|album|track|artist)[/:]([A-Za-z0-9]+)/);
  return m ? `spotify:${m[1]}:${m[2]}` : null;
}

/** Start playing a playlist/album/track on the given device. */
export async function playOnDevice(uri, deviceId) {
  const tk = await getAccessToken();
  const body = uri.includes(":track:") ? { uris: [uri] } : { context_uri: uri };
  const res = await fetch(`https://api.spotify.com/v1/me/player/play?device_id=${deviceId}`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${tk}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok && res.status !== 204) {
    const e = await res.json().catch(() => ({}));
    throw new Error(e?.error?.message || `Spotify play failed (${res.status})`);
  }
}

/** The lobby theme: Red Right Hand — Nick Cave & The Bad Seeds (Let Love In, 6:10). */
export const THEME_TRACK_URI = "spotify:track:0qHeP8zt2WWef7EWCs1ECj";

/** Loop the current track (so the theme never runs out mid-lobby). */
export async function setRepeatTrack(deviceId) {
  try {
    const tk = await getAccessToken();
    await fetch(`https://api.spotify.com/v1/me/player/repeat?state=track&device_id=${deviceId}`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${tk}` },
    });
  } catch { /* non-critical */ }
}

/** Find a track URI by search (fallback if the hardcoded ID isn't in this region). */
export async function findTrackUri(query) {
  try {
    const tk = await getAccessToken();
    const res = await fetch(
      `https://api.spotify.com/v1/search?q=${encodeURIComponent(query)}&type=track&limit=1`,
      { headers: { Authorization: `Bearer ${tk}` } }
    );
    if (!res.ok) return null;
    const j = await res.json();
    return j?.tracks?.items?.[0]?.uri || null;
  } catch { return null; }
}
