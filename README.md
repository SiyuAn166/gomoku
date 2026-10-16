# Gomoku · LAN Play

A Gomoku (five-in-a-row) web game for two phones on the same WiFi. Deploys to GitHub Pages as pure static files — no server needed.

## How to play

- **Create room** → you play Black (first move); first come, first seated
- **First to join** the room plays White (second move)
- **Everyone joining after that** becomes a spectator with a live board
- 4-character room code; tap it to copy and share
- Resign, rematch (needs opponent confirmation), last-move marker, winning-line highlight

## Try it locally (two phones)

1. On your computer, serve this folder:
   ```bash
   cd gomoku
   python3 -m http.server 8080
   ```
2. Find your computer's LAN IP (macOS: `ipconfig getifaddr en0`; Windows: `ipconfig`)
3. Connect both phones to the same WiFi and open `http://<computer-IP>:8080`
4. Create a room on one phone, join with the room code on the other

## Deploy to GitHub Pages

1. Create a new GitHub repo (e.g. `gomoku`) and upload these 4 files:
   `index.html`, `styles.css`, `logic.js`, `app.js` (README optional)
2. Go to **Settings → Pages**
3. Under **Build and deployment → Source**, choose **Deploy from a branch**
4. Pick branch `main` (or `master`), folder `/ (root)`, click **Save**
5. After 1–2 minutes, play at `https://<your-username>.github.io/gomoku/`

Both phones open that URL on the same WiFi to start a room and play.

## How it works

- **GitHub Pages only hosts static files**, so there is no game server. Multiplayer runs over **WebRTC peer-to-peer** (PeerJS library).
- Peers exchange connection info ("signaling") through PeerJS's free public signaling server (`0.peerjs.com`) — it only introduces the two phones.
- Once connected, moves travel over a WebRTC **DataChannel** directly between the phones — on the same WiFi that's a direct LAN connection with very low latency.
- The host (Black) is authoritative: validates moves, detects wins, and broadcasts the full board state to everyone.

## Notes / FAQ

- **Both phones need internet access** to load the page and establish the connection; after that, game data goes direct over LAN.
- **"Room not found"**: make sure the host's page is still open (closing it dissolves the room) and the code is typed correctly.
- **Stuck on "connecting"**: your router may have AP/client isolation enabled (blocking devices from talking to each other). PeerJS ships with a TURN relay fallback that usually gets through; if not, try a different hotspot.
- A fully offline variant (no internet at all) would need manual connection-info exchange (e.g. scanning SDP via QR code) — not supported in this version.
- Best experienced in mobile Chrome / Safari / Edge.
