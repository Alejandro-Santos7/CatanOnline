# Hexland Settlers — online play

Real-time multiplayer for the game in `public/index.html`. Every browser runs the same game
(same seed, same rules); `server.js` just hands out room codes, seats and colors, orders every
move, keeps the move log (so anyone can reconnect or refresh), and relays chat.
No dependencies, only Node 18+.

## Play tonight (your computer)

    node server.js            # http://localhost:8080

Friends on your Wi-Fi open `http://<your-LAN-IP>:8080`. Over the internet, expose it with a tunnel:

    cloudflared tunnel --url http://localhost:8080     # or:  ngrok http 8080

Open the game, go to **Online → Create room**, and send the invite link (or 4-letter code).

## Host it for free, always on

The server needs WebSockets, so Vercel/Netlify do not work. Any of these do:

- **Render**: New → Web Service → connect this folder's repo. `render.yaml` is included. Free tier sleeps
  after ~15 min idle (first visit takes ~30 s to wake).
- **Fly.io / Railway / Koyeb**: use the included `Dockerfile` (listens on `$PORT`, default 8080).
- **Any VPS**: `PORT=80 node server.js` (put it behind Caddy/nginx for HTTPS).

Keep the game files served by the same server (default). To host the HTML elsewhere, open it with
`?server=wss://your-server.example.com` and it will connect there.

## Environment

- `PORT` — listen port (default 8080)
- `DATA_FILE` — optional path; rooms are saved there (about a second after each move, and on Ctrl+C) so games
  survive a server restart

## Look and feel

A medieval table: a walnut top lit by torches, stitched leather panels, heraldic shields for the players,
Cinzel and Alegreya type (loaded from Google Fonts; plain serif fonts are used if they cannot load).

The board is a tilted 3D table: raised hex slabs with textured cliffs, standing forests, windmills, kilns and mountains,
cottages that grow into castles, cogs for ships, a wooden rail around the sea and clouds drifting over the island.
Every surface is a real texture (grass, forest floor, wheat, clay, rock, sand, water, wood, stone, roof tiles). It is
still plain SVG and CSS, so there is nothing to install. The buttons next to the zoom controls:

- **3D** flips to a flat top-down view.
- **Eco** is the low-power mode: nothing animates continuously and there are no clouds, so phones and tablets run
  cool. Touch devices start in Eco; flip it off for the full look. The choice is remembered per browser.

Both are purely visual and never affect the shared game or other players.

### Performance

The board is two stacked SVGs: a static one (sea, tiles, harbors) that is never repainted, and a live one (pieces).
No blur or drop-shadow filters, no animation inside the static layer, and the ambient motion (clouds, torchlight) is
stepped or GPU-only. Idle CPU dropped from about 240% of a core to about 25%, and to about 0% in Eco.

### Textures

The textures are generated, not hand-drawn. `tools/make-textures.html` builds them (tileable noise, lit from the
top-left, plus scattered details such as grass blades and cracks). Open it in a browser, copy `window.TEX` and paste
the entries into the `TEX` block of `public/index.html`. Nothing from `tools/` is loaded when you play.

## Things to know

- Lockstep design: each browser holds the whole game state, so it is trust-based (a tech-savvy friend
  could peek at hidden cards). Fine for friends, not for strangers.
- If a player's connection drops, they rejoin from the same browser and replay to the current state.
  Use **Take over with AI** if someone stays away.
- The server's move log is the single source of truth. A browser that misses a move (a flaky tunnel, a phone
  that slept) notices the gap and fetches what it missed; a silent connection is replaced after 30 seconds.
- Every turn the browsers compare a fingerprint of the game. One that disagrees with the majority rebuilds
  itself from the server's log automatically, so nobody needs to reload.
- Opening the same game in a second tab takes the seat over; the first tab offers to take it back.

## Troubleshooting

- **"Not found" on the tunnel link**: the server is up but can't see the game file. Keep the folder structure
  exactly as delivered (`server.js` next to a `public/` folder containing `index.html`) and run `node server.js`
  from inside it. Check `http://localhost:8080` works first, then start the tunnel.
