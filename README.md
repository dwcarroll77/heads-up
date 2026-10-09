# Danny's Head's Up

Everyone in a session gets a character. You can read everybody
else's word; you cannot read your own. Think "guess who you are" with a phone
each instead of sticky notes.

## How the pieces fit together

```
 phone / laptop  ──WebSocket──►  Worker (router)  ──►  Durable Object "ABCD"
                                                        ├ players
                                                        ├ word bank
                                                        └ who holds which word
```

- **`public/index.html`** — the whole client: markup, styles and script in one
  file. Cloudflare serves it as a plain static file.
- **`src/index.js`** — two things:
  - the **Worker**, a router. It mints room codes and forwards each player's
    connection to the right room.
  - the **Durable Object** `GameRoom`, which *is* one game session. Cloudflare
    guarantees exactly one live instance per room code, so it can hold the
    players in an ordinary `Map` and trust it's the only writer. This is what
    makes "everyone in room ABCD sees the same thing" work.

### Why the secret is safe

`GameRoom.stateFor(pid)` builds a **different message for every player** and
replaces that player's own word with `null`. Your word is never encoded into the
bytes your browser receives, so there is nothing to find in devtools. The word
lives only on the server until the host hits *Reveal*.

One honest limitation: the **host** types the word bank, so the host knows the
list their own word was drawn from — the same advantage the person who writes
the sticky notes has in the physical game. If you want it airtight, have someone
who isn't playing act as host.

## Running it on your own machine

```sh
npm install          # once
npm run dev          # serves http://localhost:8787
```

`wrangler dev` runs Cloudflare's real server runtime locally, Durable Objects
included, so local behaviour matches production. Open two browser windows on
http://localhost:8787 to play both sides.

## Testing

```sh
node test/e2e.mjs                     # against npm run dev
node test/e2e.mjs https://your.url    # against production
```

The suite drives real WebSocket clients through a whole game. The check that
matters most scans **every byte the server ever sent** to a player for their own
word.

A rule the hard way: never write a test that waits for "the next message".
One broadcast reaches each player independently, so a player can be a message
behind when another has caught up, and you end up asserting against a stale
screen. Wait for a *condition* to become true instead — that's what the `until`
helper is for.

## Deploying

```sh
npx wrangler login    # opens a browser, once per machine
npm run deploy
```

The URL it prints (`https://dannys-heads-up.<your-subdomain>.workers.dev`) is public —
anyone can open it, no account needed. Redeploy any time by re-running
`npm run deploy`.

## Things worth knowing

- A room lives in memory only. When the last player disconnects it evaporates,
  which is what you want for a party game — but it also means a room won't
  survive everybody closing their laptops at once.
- Room codes avoid `I`, `O`, `0` and `1` so a code read aloud isn't ambiguous.
- Caps: 24 players and 300 words per room, 20 characters per name.
- Refreshing rejoins as the same player. The browser remembers its player id in
  `localStorage`, and the server matches on it.
- If the host closes their laptop, anyone else can press *Take over as host*.
- Words repeat if there are fewer words than players, rather than failing.
