/**
 * Danny's Head's Up — server side.
 *
 * Two pieces live in this file:
 *
 *   1. `export default { fetch }`  — the ROUTER. Every request to your domain
 *      that isn't a static file lands here. It figures out which game room the
 *      request is about and forwards it.
 *
 *   2. `export class GameRoom`     — ONE GAME SESSION. Cloudflare guarantees
 *      there is exactly one live instance per room code, so this class can just
 *      keep the players in a plain Map and trust it's the only writer.
 *
 * The security-relevant idea: the room assigns the words and sends every player
 * a DIFFERENT message. Yours has your own word stripped out (see `stateFor`).
 * The browser cannot reveal what it was never sent.
 */

import { DurableObject } from "cloudflare:workers";
import { PACKS, IMG_PREFIX } from "./packs.js";

// No I, O, 0 or 1 — so nobody mistypes a code read aloud across a room.
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_LEN = 4;

const MAX_PLAYERS = 24;
const MAX_WORDS = 1200;
const MAX_NAME_LEN = 20;
const MAX_WORD_LEN = 48;
const MAX_BANK_CHARS = 6000;

function makeCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(CODE_LEN));
  let out = "";
  for (const b of bytes) out += CODE_ALPHABET[b % CODE_ALPHABET.length];
  return out;
}

// ---------------------------------------------------------------- the router

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // "Give me an unused room code." Tries a few codes and asks each room
    // whether it's already in use, so two groups can't collide.
    if (url.pathname === "/api/new-room") {
      for (let attempt = 0; attempt < 8; attempt++) {
        const code = makeCode();
        const room = env.ROOMS.get(env.ROOMS.idFromName(code));
        const res = await room.fetch("https://room/claim");
        if (res.ok) return Response.json({ code });
      }
      return Response.json({ error: "Every code we tried was busy. Try again." }, { status: 503 });
    }

    // A player opening a live connection to a room.
    if (url.pathname === "/ws") {
      const code = (url.searchParams.get("code") || "").toUpperCase();
      if (!isValidCode(code)) return new Response("That isn't a valid room code.", { status: 400 });
      const room = env.ROOMS.get(env.ROOMS.idFromName(code));
      return room.fetch(request); // hand the whole request to that room
    }

    return new Response("Not found", { status: 404 });
  },
};

function isValidCode(code) {
  if (code.length !== CODE_LEN) return false;
  for (const ch of code) if (!CODE_ALPHABET.includes(ch)) return false;
  return true;
}

// ------------------------------------------------------------ one game room

export class GameRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);

    this.code = null;
    this.claimed = false;

    // pid -> { pid, name, word, score, revealed, joinedAt, sockets:Set<WebSocket> }
    // `pid` is a "player id" the browser stores, so a refresh rejoins as the
    // same person instead of appearing as a duplicate.
    this.players = new Map();
    this.socketPid = new Map(); // WebSocket -> pid

    this.hostPid = null;
    // series name -> { MAIN:bool, SUPPORTING:bool, BACKGROUND:bool }
    this.packSel = {};
    // include characters AniList has no artwork for (mostly unnamed extras)
    this.includeArtless = false;
    // [{ name, image }] — presets and typed entries merged, deduped by name
    this.bank = [];
    // Every character name handed out so far THIS MATCH. A match runs for the
    // life of the room, so this survives a trip back to the lobby.
    this.used = new Set();
    this.phase = "lobby"; // "lobby" | "playing" | "leaderboard"
    // pids revealed individually this round, in the order the host revealed
    // them. Its length is what turns a reveal into a score.
    this.revealOrder = [];
    this.round = 0;
    this.revealed = false;
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === "/claim") {
      if (this.claimed) return new Response("taken", { status: 409 });
      this.claimed = true;
      return new Response("ok");
    }

    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected a WebSocket connection.", { status: 426 });
    }

    this.claimed = true;
    if (!this.code) this.code = (url.searchParams.get("code") || "").toUpperCase();

    // A WebSocketPair is two ends of one pipe: we keep `server`, the browser gets `client`.
    const { 0: client, 1: server } = new WebSocketPair();
    server.accept();
    server.addEventListener("message", (event) => this.onMessage(server, event.data));
    server.addEventListener("close", () => this.onClose(server));
    server.addEventListener("error", () => this.onClose(server));

    return new Response(null, { status: 101, webSocket: client });
  }

  // ------------------------------------------------------- incoming messages

  onMessage(ws, raw) {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (!msg || typeof msg.t !== "string") return;

    if (msg.t === "join") return this.onJoin(ws, msg);

    // Everything below requires the socket to have joined already.
    const pid = this.socketPid.get(ws);
    if (!pid) return;
    const isHost = pid === this.hostPid;

    switch (msg.t) {
      case "ping":
        return send(ws, { t: "pong" });

      case "rename": {
        const name = cleanName(msg.name);
        if (!name) return;
        this.players.get(pid).name = name;
        return this.broadcast();
      }

      // Any player, not just the host. Each one owns their own text.
      case "setBank": {
        this.players.get(pid).bankText = String(msg.text ?? "").slice(0, MAX_BANK_CHARS);
        this.rebuildBank();
        return this.broadcast();
      }

      // The same, but the author is excluded from receiving these.
      case "setBlockedBank": {
        this.players.get(pid).blockedText = String(msg.text ?? "").slice(0, MAX_BANK_CHARS);
        this.rebuildBank();
        return this.broadcast();
      }

      // The host ticks series and, per series, which role tiers to draw from.
      case "setPacks": {
        if (!isHost) return;
        const sel = {};
        for (const [series, tiers] of Object.entries(msg.selection ?? {})) {
          if (!PACKS.some((p) => p.series === series)) continue;
          sel[series] = {
            MAIN: !!tiers?.MAIN,
            SUPPORTING: !!tiers?.SUPPORTING,
            BACKGROUND: !!tiers?.BACKGROUND,
          };
        }
        this.packSel = sel;
        this.includeArtless = !!msg.includeArtless;
        this.rebuildBank();
        return this.broadcast();
      }

      case "deal": {
        if (!isHost) return;
        if (this.bank.length === 0) {
          return send(ws, { t: "error", message: "Add some words first." });
        }
        this.dealWords();
        return this.broadcast();
      }

      // Re-deal ONE player without disturbing anybody else's character.
      // Useful when somebody already knows theirs, or drew a dud.
      case "redealOne": {
        if (!isHost) return;
        if (this.phase !== "playing") return;
        if (this.bank.length === 0) {
          return send(ws, { t: "error", message: "Add some words first." });
        }
        const target = this.players.get(String(msg.pid));
        if (!target) return;
        if (!this.redealOne(target)) {
          return send(ws, { t: "error", message: "No other character left to swap in." });
        }
        return this.broadcast();
      }

      /**
       * The host confirms one player guessed correctly.
       *
       * Scoring: the first person to get there earns one point per opponent,
       * and each later finisher earns one less, so the last player home scores
       * nothing. With N players that is N-1 down to 0.
       */
      case "revealOne": {
        if (!isHost) return;
        if (this.phase !== "playing") return;
        const target = this.players.get(String(msg.pid));
        if (!target || target.revealed || !target.word) return;

        target.revealed = true;
        target.score += Math.max(0, this.players.size - 1 - this.revealOrder.length);
        this.revealOrder.push(target.pid);
        return this.broadcast();
      }

      // Show everybody at once. This ends the round rather than rewarding it,
      // so it deliberately scores nothing.
      case "reveal": {
        if (!isHost) return;
        this.revealed = true;
        return this.broadcast();
      }

      // Forget which characters have come up, without touching scores or the
      // party. Lets one group keep playing past the end of a small bank.
      case "resetSeen": {
        if (!isHost) return;
        this.used = new Set();
        return this.broadcast();
      }

      // Stop play and show the standings.
      case "endMatch": {
        if (!isHost) return;
        this.phase = "leaderboard";
        this.revealed = true;
        return this.broadcast();
      }

      // Same people, clean slate: scores, seen-characters and words all reset.
      case "newMatch": {
        if (!isHost) return;
        this.phase = "lobby";
        this.revealed = false;
        this.round = 0;
        this.used = new Set();
        this.revealOrder = [];
        for (const p of this.players.values()) {
          p.word = null;
          p.score = 0;
          p.revealed = false;
        }
        return this.broadcast();
      }

      case "backToLobby": {
        if (!isHost) return;
        this.phase = "lobby";
        this.revealed = false;
        this.revealOrder = [];
        for (const p of this.players.values()) {
          p.word = null;
          p.revealed = false;
        }
        return this.broadcast();
      }

      case "kick": {
        if (!isHost) return;
        const target = this.players.get(String(msg.pid));
        if (!target || target.pid === this.hostPid) return;
        for (const sock of target.sockets) {
          this.socketPid.delete(sock);
          try {
            sock.close(1000, "Removed by the host");
          } catch {}
        }
        this.players.delete(target.pid);
        return this.broadcast();
      }

      // Only allowed while the host has no live connection, so a game whose
      // host closed their laptop isn't stuck forever.
      case "claimHost": {
        const host = this.players.get(this.hostPid);
        if (host && host.sockets.size > 0) return;
        this.hostPid = pid;
        return this.broadcast();
      }
    }
  }

  onJoin(ws, msg) {
    // Reuse the id the browser remembers, so a refresh rejoins as the same
    // person; mint one only for a genuinely new browser.
    const pid = cleanPid(msg.pid) || crypto.randomUUID();

    let player = this.players.get(pid);
    if (!player) {
      if (this.players.size >= MAX_PLAYERS) {
        send(ws, { t: "error", message: `This room is full (${MAX_PLAYERS} players).`, fatal: true });
        try {
          ws.close(1013, "room full");
        } catch {}
        return;
      }
      player = {
        pid,
        name: cleanName(msg.name) || "Player",
        // Everyone gets their own typed bank. A guest's entries go into the
        // shared pool but are blocked from coming back to them.
        bankText: "",
        // A second bank that is ALWAYS blocked for its author, whoever they
        // are. The host uses this to suggest names they cannot be dealt; for a
        // guest it behaves the same as their main bank, so the UI hides it.
        blockedText: "",
        word: null,
        score: 0,
        revealed: false, // revealed individually this round
        joinedAt: Date.now(),
        sockets: new Set(),
      };
      this.players.set(pid, player);
      if (!this.hostPid) this.hostPid = pid; // whoever arrives first hosts
    } else {
      const name = cleanName(msg.name);
      if (name) player.name = name;
    }

    player.sockets.add(ws);
    this.socketPid.set(ws, pid);

    // Tell this browser which id the server settled on, so it can store it.
    send(ws, { t: "joined", pid });
    this.broadcast();
  }

  onClose(ws) {
    const pid = this.socketPid.get(ws);
    this.socketPid.delete(ws);
    if (!pid) return;
    const player = this.players.get(pid);
    if (!player) return;
    player.sockets.delete(ws);
    // The player stays in the list, marked offline — a refresh or a tunnel
    // ride shouldn't erase them mid-game. The host can remove them.
    this.broadcast();
  }

  // --------------------------------------------------------- the game itself

  /**
   * Rebuild `this.bank` from the two sources the host can use together:
   * the preset packs they ticked, and anything they typed by hand.
   *
   * Entries are objects so a picture travels with the name. That matters for
   * secrecy: `stateFor` nulls the whole entry for its owner, so the image URL
   * is withheld by exactly the same line that withholds the name.
   */
  rebuildBank() {
    const byKey = new Map();
    const out = [];

    /**
     * `blockedFor` is the pid that may never be dealt this entry, or null for
     * an entry anyone can have. Suggesting a name that is already in the pool
     * still blocks it for you — otherwise typing a word already in a pack
     * would hand you a suggestion of your own.
     */
    const add = (name, image, blockedFor) => {
      if (!name) return;
      const key = name.toLowerCase();
      const existing = byKey.get(key);
      if (existing) {
        if (blockedFor && !existing.block.includes(blockedFor)) existing.block.push(blockedFor);
        return;
      }
      if (out.length >= MAX_WORDS) return;
      const entry = { name, image: image || "", block: blockedFor ? [blockedFor] : [] };
      byKey.set(key, entry);
      out.push(entry);
    };

    for (const pack of PACKS) {
      const tiers = this.packSel[pack.series];
      if (!tiers) continue;
      for (const tier of ["MAIN", "SUPPORTING", "BACKGROUND"]) {
        if (!tiers[tier]) continue;
        for (const [name, key] of pack.tiers[tier]) {
          if (!key && !this.includeArtless) continue;
          add(name.slice(0, MAX_WORD_LEN), key ? IMG_PREFIX + key : "", null);
        }
      }
    }

    // Typed entries come after the packs so a preset's picture wins over a
    // bare name. The host's own words behave like a pack: anyone can get them.
    for (const p of this.orderedPlayers()) {
      // The host's main bank is global; a guest's is blocked for them.
      const mine = p.pid === this.hostPid ? null : p.pid;
      for (const name of parseBank(p.bankText)) add(name, "", mine);
      // The second bank is blocked for its author no matter who they are.
      for (const name of parseBank(p.blockedText)) add(name, "", p.pid);
    }

    this.bank = out;
  }

  /**
   * Draw one character nobody has been given yet this match.
   *
   * `alsoAvoid` is the set of names already handed out inside the deal that is
   * currently in progress, so a single round never doubles up.
   *
   * When every character has been seen the cycle restarts: `used` is cleared
   * and drawing continues. That is the only way a repeat happens, which is
   * exactly the "only if there aren't enough left" rule.
   */
  drawFresh(alsoAvoid, forPid) {
    // A guest never receives a name they typed themselves.
    const allowed = (w) => !w.block.includes(forPid);

    let pool = this.bank.filter(
      (w) => allowed(w) && !this.used.has(w.name) && !alsoAvoid.has(w.name)
    );

    if (pool.length === 0) {
      // Everything's been seen. Start a new cycle, but still never repeat a
      // character inside this same round.
      this.used.clear();
      pool = this.bank.filter((w) => allowed(w) && !alsoAvoid.has(w.name));
    }
    // Only reachable when the bank is smaller than the table.
    if (pool.length === 0) pool = this.bank.filter(allowed);
    // Every entry in the bank is one this player suggested: nothing to give.
    if (pool.length === 0) return null;

    const pick = pool[Math.floor(Math.random() * pool.length)];
    this.used.add(pick.name);
    return pick;
  }

  dealWords() {
    const players = this.orderedPlayers();
    const thisRound = new Set();
    for (const p of players) {
      p.word = this.drawFresh(thisRound, p.pid);
      // null means the whole bank is this player's own suggestions. They sit
      // the round out rather than being handed one of their own words.
      if (p.word) thisRound.add(p.word.name);
    }
    for (const p of players) p.revealed = false;
    this.revealOrder = [];
    this.round += 1;
    this.phase = "playing";
    this.revealed = false;
  }

  /**
   * Swap one player onto a different character.
   *
   * Preference order: a character nobody currently holds, then any character
   * other than the one they have now. Returns false when neither exists, which
   * only happens with a single-entry bank.
   *
   * The round counter deliberately does NOT advance — this is a correction to
   * the current round, not a new one, and bumping it would replay the deal
   * animation for everybody.
   */
  redealOne(target) {
    const avoid = new Set(
      [...this.players.values()]
        .filter((p) => p.pid !== target.pid && p.word)
        .map((p) => p.word.name)
    );
    if (target.word) avoid.add(target.word.name);

    // Nothing to swap to: every entry is either on the table already or is one
    // this player suggested themselves.
    const reachable = this.bank.filter(
      (w) => !avoid.has(w.name) && !w.block.includes(target.pid)
    );
    if (reachable.length === 0) return false;

    target.word = this.drawFresh(avoid, target.pid);
    return !!target.word;
  }

  orderedPlayers() {
    return [...this.players.values()].sort((a, b) => a.joinedAt - b.joinedAt);
  }

  // ------------------------------------------------------- outgoing messages

  /**
   * Build the view of the world for ONE player.
   *
   * This is the whole hidden-information mechanism: a player's own `word` is
   * replaced with null unless the host has revealed. Their word is never
   * serialized into the bytes their browser receives, so there is nothing to
   * find in devtools.
   */
  stateFor(pid) {
    const host = this.players.get(this.hostPid);
    const me = this.players.get(pid);

    return {
      t: "state",
      code: this.code,
      phase: this.phase,
      round: this.round,
      revealed: this.revealed,
      wordCount: this.bank.length,
      // Counted against the CURRENT bank: `used` also holds characters from
      // earlier in the match that the host has since packed away, and those
      // would make "how many are left" read as a negative number.
      seenCount: this.bank.filter((w) => this.used.has(w.name)).length,
      hostOnline: !!host && host.sockets.size > 0,
      you: { pid, name: me ? me.name : "", isHost: pid === this.hostPid },
      // You get your own typed list back and nobody else's. Seeing another
      // player's suggestions would narrow down your own character.
      bankText: me ? me.bankText : "",
      yourEntries: me ? parseBank(me.bankText).length : 0,
      blockedText: me ? me.blockedText : "",
      yourBlockedEntries: me ? parseBank(me.blockedText).length : 0,
      // ...and the pack picker, which is a host-only control.
      packCatalog: pid === this.hostPid ? packCatalog() : undefined,
      packSel: pid === this.hostPid ? this.packSel : undefined,
      includeArtless: pid === this.hostPid ? this.includeArtless : undefined,
      players: this.orderedPlayers().map((p) => ({
        pid: p.pid,
        name: p.name,
        online: p.sockets.size > 0,
        isHost: p.pid === this.hostPid,
        hasWord: !!p.word,
        score: p.score,
        revealed: p.revealed,
        word: p.pid === pid && !this.revealed && !p.revealed ? null : publicWord(p.word),
      })),
    };
  }

  broadcast() {
    for (const player of this.players.values()) {
      if (player.sockets.size === 0) continue;
      const payload = JSON.stringify(this.stateFor(player.pid));
      for (const sock of player.sockets) {
        try {
          sock.send(payload);
        } catch {}
      }
    }
  }
}

// ------------------------------------------------------------------- helpers

function send(ws, obj) {
  try {
    ws.send(JSON.stringify(obj));
  } catch {}
}

function cleanName(value) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_NAME_LEN);
}

function cleanPid(value) {
  const pid = String(value ?? "");
  return /^[A-Za-z0-9_-]{8,64}$/.test(pid) ? pid : null;
}

/** "cat, dog, hippo" -> ["cat","dog","hippo"], de-duplicated, newlines allowed. */
/**
 * How many characters each series/tier offers, split by whether AniList has
 * artwork. The host needs the counts to choose sensibly; they do not need the
 * names, so the catalogue deliberately carries no character data.
 */
function packCatalog() {
  return PACKS.map((pack) => ({
    series: pack.series,
    tiers: Object.fromEntries(
      ["MAIN", "SUPPORTING", "BACKGROUND"].map((tier) => {
        const all = pack.tiers[tier];
        return [tier, { total: all.length, withArt: all.filter(([, k]) => k).length }];
      })
    ),
  }));
}

/**
 * Strip a bank entry down to what a browser is allowed to know. `block` holds
 * the pids a character must not be dealt to, which would reveal who suggested
 * the character another player is holding.
 */
function publicWord(word) {
  if (!word) return null;
  return { name: word.name, image: word.image };
}

function parseBank(text) {
  const seen = new Set();
  const out = [];
  for (const chunk of String(text).split(/[,\n\r;]+/)) {
    const word = chunk.replace(/\s+/g, " ").trim().slice(0, MAX_WORD_LEN);
    if (!word) continue;
    const key = word.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(word);
    if (out.length >= MAX_WORDS) break;
  }
  return out;
}

/** Fisher-Yates: the standard unbiased shuffle. */
function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}
