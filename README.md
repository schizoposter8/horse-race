# 🏇 Horse Race — the card drinking game

A multiplayer party game: one person hosts, everyone joins on their phone with a
4-letter room code (Jackbox-style), bets sips on a suit, and watches the horses
race live. Includes a big-screen TV spectator mode.

Hold your horses — Please drink responsibly.

---

## How it's built

- **React + Vite** — the whole game lives in `src/App.jsx`
- **Supabase** — one tiny `kv` table for room state, with realtime
  subscriptions so every phone updates instantly when the host draws a card
- `src/storage.js` is the only file that talks to the backend

## Going live: three steps

### 1. Put the code on GitHub

Create a new repository at github.com, then from this folder:

```bash
git init
git add .
git commit -m "Horse Race v1"
git branch -M main
git remote add origin https://github.com/YOUR-USERNAME/horse-race.git
git push -u origin main
```

### 2. Set up Supabase (free)

1. Go to [supabase.com](https://supabase.com) → New project (any name/region/password)
2. Once it's ready, open **SQL Editor** and run this:

```sql
create table if not exists kv (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz default now()
);

alter table kv enable row level security;
create policy "public read"   on kv for select using (true);
create policy "public insert" on kv for insert with check (true);
create policy "public update" on kv for update using (true);

alter publication supabase_realtime add table kv;
```

3. Go to **Project Settings → API** and copy two values:
   - Project URL
   - `anon` `public` key

### 3. Deploy on Vercel (free)

1. Go to [vercel.com](https://vercel.com) → Add New → Project → import your
   GitHub repo (Vercel auto-detects Vite; no settings needed)
2. Under **Environment Variables**, add:
   - `VITE_SUPABASE_URL` = your Project URL
   - `VITE_SUPABASE_ANON_KEY` = your anon public key
3. Deploy. You'll get a URL like `horse-race-xyz.vercel.app` — that's the game.
   Add a custom domain later under Project → Settings → Domains if you want.

## Running it locally

```bash
cp .env.example .env    # then paste in your Supabase URL + anon key
npm install
npm run dev             # opens at http://localhost:5173
```

Open two browser tabs to test multiplayer: host in one, join in the other.

## Making changes after launch

Every `git push` to `main` auto-redeploys on Vercel in ~1 minute. The loop is:

1. Change the code (edit it yourself, paste files back into Claude and describe
   the tweak, or point Claude Code at the repo)
2. `git add -A && git commit -m "tweak" && git push`
3. Refresh the site

## Good-to-know / honest limitations

- **Room data is public-writable.** Anyone with your Supabase anon key (it's in
  the page source — that's normal and by design) can read/write the `kv` table.
  Fine for a party game; don't store anything sensitive.
- **The deck order lives in the room state**, so a determined nerd with browser
  devtools could peek at upcoming cards. Server-side dealing (a Supabase Edge
  Function) fixes this if it ever matters.
- **Old rooms accumulate** in the table. Harmless, but you can clean up
  periodically in the SQL editor:
  ```sql
  delete from kv where updated_at < now() - interval '2 days';
  ```
- **Same-name collisions:** two players joining with the exact same name share
  a player slot. House rule: use different names.

## Next up: Spotify 🎧

The plan (once the site is live on its Vercel URL):
1. Create an app at [developer.spotify.com/dashboard](https://developer.spotify.com/dashboard)
   and register your site URL as the OAuth redirect
2. Add a "Connect Spotify" button for the host (OAuth PKCE flow — no server needed)
3. Use the Web Playback SDK so the big screen plays the host's playlists,
   ducking the volume during the 3-2-1 countdown and card reveals
4. Winner-picks-the-next-song as a bonus reward

Requires the host to have Spotify Premium (Spotify's rule for playback control).
Bring this README back to Claude when you're ready and we'll build it.
