/**
 * End-to-end test against a running server (default http://localhost:8787).
 *
 *   node test/e2e.mjs                    # against `npm run dev`
 *   node test/e2e.mjs https://your.url   # against production
 *
 * The important test is SECRECY: we learn Alice's word by looking at Bob's
 * screen, then scan every single byte the server ever sent to Alice for it.
 *
 * NOTE ON TIMING: never wait for "the next message". One server broadcast
 * arrives at each player independently, so a player can still be one message
 * behind when another has caught up. Always wait for a CONDITION to become
 * true (`until`), which is immune to that ordering.
 */

const BASE = (process.argv[2] || "http://localhost:8787").replace(/\/$/, "");
const WS_BASE = BASE.replace(/^http/, "ws");

let failures = 0;
function check(label, condition, detail) {
  if (condition) {
    console.log(`  ok    ${label}`);
  } else {
    failures++;
    console.log(`  FAIL  ${label}${detail ? "\n          " + detail : ""}`);
  }
}

/** A fake player: opens a socket, records everything, exposes the latest state. */
class Player {
  constructor(name, pid) {
    this.name = name;
    this.pid = pid || null;
    this.state = null;
    this.rawLog = [];        // every message the server sent us, verbatim
    this.listeners = new Set();
  }

  async connect(code) {
    this.ws = new WebSocket(`${WS_BASE}/ws?code=${code}`);
    await new Promise((res, rej) => {
      this.ws.addEventListener("open", res, { once: true });
      this.ws.addEventListener("error", rej, { once: true });
    });
    this.ws.addEventListener("message", (ev) => {
      this.rawLog.push(String(ev.data));
      const msg = JSON.parse(ev.data);
      if (msg.t === "joined") this.pid = msg.pid;
      if (msg.t === "state") {
        this.state = msg;
        for (const fn of this.listeners) fn(msg);
      }
    });
    this.send({ t: "join", name: this.name, pid: this.pid || undefined });
    await this.until((s) => s.players.some((p) => p.pid === this.pid));
  }

  send(obj) { this.ws.send(JSON.stringify(obj)); }

  /** Resolve once our latest state satisfies `pred` — now or in the future. */
  until(pred, timeoutMs = 5000) {
    if (this.state && pred(this.state)) return Promise.resolve(this.state);
    return new Promise((res, rej) => {
      const done = (msg) => { clearTimeout(timer); this.listeners.delete(fn); res(msg); };
      const fn = (msg) => { if (pred(msg)) done(msg); };
      const timer = setTimeout(() => {
        this.listeners.delete(fn);
        rej(new Error(`${this.name}: condition never became true. Last state: ${JSON.stringify(this.state)}`));
      }, timeoutMs);
      this.listeners.add(fn);
    });
  }

  /** How this player sees another player (or themselves). */
  view(pid) { return this.state.players.find((p) => p.pid === pid); }

  close() { try { this.ws.close(); } catch {} }
}

const settle = (ms = 400) => new Promise((r) => setTimeout(r, ms));
const allUntil = (players, pred) => Promise.all(players.map((p) => p.until(pred)));

console.log(`\nDanny's Head's Up end-to-end test against ${BASE}\n`);

// ---------------------------------------------------------------- room setup

const created = await fetch(`${BASE}/api/new-room`).then((r) => r.json());
check("server hands out a room code", /^[A-Z0-9]{4}$/.test(created.code || ""), JSON.stringify(created));
const code = created.code;
console.log(`  ..    room code ${code}`);

const alice = new Player("Alice");
const bob = new Player("Bob");
const cara = new Player("Cara");

await alice.connect(code);
check("first player to arrive is the host", alice.state.you.isHost === true);

await bob.connect(code);
await cara.connect(code);
const everyone = [alice, bob, cara];
await allUntil(everyone, (s) => s.players.length === 3);

check("everyone sees all three players", everyone.every((p) => p.state.players.length === 3));
check("later joiners are not host", bob.state.you.isHost === false && cara.state.you.isHost === false);
check("players see each other's names",
  bob.state.players.map((p) => p.name).sort().join(",") === "Alice,Bob,Cara",
  bob.state.players.map((p) => p.name).join(","));

// ------------------------------------------------------- non-host permissions

bob.send({ t: "deal" });
bob.send({ t: "setBank", text: "sabotage" });
await alice.until((s) => s.wordCount === 1);
check("a non-host cannot start the game", alice.state.phase === "lobby", `phase is ${alice.state.phase}`);
check("a non-host CAN add their own words to the pool", alice.state.wordCount === 1,
  `wordCount is ${alice.state.wordCount}`);
check("a guest's words are not echoed to the host", alice.state.bankText === "",
  JSON.stringify(alice.state.bankText));

bob.send({ t: "setBank", text: "" });
await alice.until((s) => s.wordCount === 0);

// ------------------------------------------------------------------ the deal

alice.send({ t: "setBank", text: "Cleopatra, a raccoon in a trench coat, the Eiffel Tower, sourdough starter, Cleopatra" });
await allUntil(everyone, (s) => s.wordCount === 4);
check("word bank parses and de-duplicates (5 entries, 1 repeat -> 4)", alice.state.wordCount === 4);
check("each player is echoed only their OWN word list",
  alice.state.bankText.includes("Cleopatra") && bob.state.bankText === "",
  `bob sees ${JSON.stringify(bob.state.bankText)}`);

alice.send({ t: "deal" });
await allUntil(everyone, (s) => s.phase === "playing" && s.round === 1);
check("the deal moves everyone into the game", everyone.every((p) => p.state.phase === "playing"));
check("round counter advanced", alice.state.round === 1, `round is ${alice.state.round}`);

// ------------------------------------------------------------ hidden info!!!

// A bank entry is { name, image } now. These unwrap it so the assertions below
// compare the things a human would recognise, not object identity.
const nameOf  = (w) => (w && typeof w === "object" ? w.name : w);
const imageOf = (w) => (w && typeof w === "object" ? w.image : "");

const aliceOnSelf = alice.view(alice.pid);
const aliceViaBob = bob.view(alice.pid);
const aliceWord = nameOf(aliceViaBob.word);

check("you are told you HAVE a word", aliceOnSelf.hasWord === true);
check("you are NOT told what your own word is", aliceOnSelf.word === null,
  `alice's own view of her word: ${JSON.stringify(aliceOnSelf.word)}`);
check("other players CAN see your word", typeof aliceWord === "string" && aliceWord.length > 0,
  `bob sees alice's word as ${JSON.stringify(aliceViaBob.word)}`);
check("a third player sees the same word for her", nameOf(cara.view(alice.pid).word) === aliceWord,
  `cara sees ${JSON.stringify(cara.view(alice.pid).word)}`);

// The real proof: scan every byte a player's browser ever received.
//
// For a NON-HOST this is absolute — their word must appear nowhere, ever.
const bobWord = nameOf(alice.view(bob.pid).word);
const bobLeaks = bob.rawLog.filter((line) => line.includes(bobWord));
check("a non-host's word appears in ZERO bytes ever sent to them", bobLeaks.length === 0,
  bobLeaks.length ? `leaked in ${bobLeaks.length} message(s): ${bobLeaks[0].slice(0, 240)}` : "");

// For the HOST the claim is necessarily weaker: they typed the word bank, so
// their word is one of the candidates they already know. What must still hold
// is that nothing tells them WHICH candidate is theirs. So scan everything
// except the word bank they authored.
const aliceLeaks = alice.rawLog.filter((line) => {
  const msg = JSON.parse(line);
  delete msg.bankText;
  return JSON.stringify(msg).includes(aliceWord);
});
check("nothing outside the host's own word bank reveals the host's word", aliceLeaks.length === 0,
  aliceLeaks.length ? `leaked in ${aliceLeaks.length} message(s): ${aliceLeaks[0].slice(0, 240)}` : "");
check("(documented limitation) the host does receive the candidate list",
  typeof alice.state.bankText === "string" && alice.state.bankText.includes(aliceWord));

const words = alice.state.players.map((p) => (p.pid === alice.pid ? aliceWord : nameOf(p.word)));
check("every player got a word", words.every((w) => typeof w === "string" && w.length > 0), words.join(" | "));
check("with 4 words and 3 players, nobody shares a word", new Set(words).size === 3, words.join(" | "));

// --------------------------------------------------------------- re-dealing

alice.send({ t: "deal" });
await allUntil(everyone, (s) => s.round === 2);
check("re-dealing bumps the round", alice.state.round === 2, `round is ${alice.state.round}`);
check("re-dealing keeps every word hidden from its owner",
  everyone.every((p) => p.view(p.pid).word === null));
check("everybody still holds a word after a re-deal",
  everyone.every((p) => p.view(p.pid).hasWord === true));

// ------------------------------------------------------------------- reveal

alice.send({ t: "reveal" });
await allUntil(everyone, (s) => s.revealed === true);
check("after reveal you can finally see your own word",
  everyone.every((p) => typeof nameOf(p.view(p.pid).word) === "string" && nameOf(p.view(p.pid).word).length > 0));

// -------------------------------------------------------- reconnect as self

const bobPid = bob.pid;
bob.close();
await alice.until((s) => { const b = s.players.find((p) => p.pid === bobPid); return b && b.online === false; });
check("a dropped player is shown as offline, not deleted",
  alice.state.players.length === 3 && alice.view(bobPid).online === false,
  JSON.stringify(alice.state.players.map((p) => [p.name, p.online])));

const bobAgain = new Player("Bob", bobPid);
await bobAgain.connect(code);
await bobAgain.until((s) => { const b = s.players.find((p) => p.pid === bobPid); return b && b.online === true; });
check("refreshing rejoins as the same player, not a duplicate",
  bobAgain.state.players.length === 3, `now ${bobAgain.state.players.length} players`);
check("a rejoining player keeps their word", bobAgain.view(bobPid).hasWord === true);
check("a rejoining player still cannot see their own word",
  bobAgain.view(bobPid).word !== null ? bobAgain.state.revealed === true : true,
  "word was visible while not revealed");

// -------------------------------------------------------------- back to lobby

alice.send({ t: "backToLobby" });
await allUntil([alice, cara, bobAgain], (s) => s.phase === "lobby");
check("host can send everyone back to the lobby", cara.state.phase === "lobby");
check("returning to the lobby clears the words", cara.state.players.every((p) => !p.hasWord));
check("returning to the lobby clears the reveal", cara.state.revealed === false);

// ------------------------------------------------- joining a game in progress

alice.send({ t: "setBank", text: "one, two" });
await alice.until((s) => s.wordCount === 2);
alice.send({ t: "deal" });
await allUntil([alice, cara], (s) => s.phase === "playing");

const dave = new Player("Dave");
await dave.connect(code);
await allUntil([alice, dave], (s) => s.players.length === 4);
check("a player joining mid-game lands straight in the game", dave.state.phase === "playing");
check("a mid-game joiner has no word until the next deal", dave.view(dave.pid).hasWord === false);

alice.send({ t: "deal" });
await allUntil([alice, dave], (s) => s.round === 4);
check("the next deal gives the late joiner a word", dave.view(dave.pid).hasWord === true);

const fourWords = alice.state.players.map((p) => (p.pid === alice.pid ? "?" : nameOf(p.word)));
check("with fewer words than players, words repeat instead of failing",
  alice.state.players.every((p) => p.hasWord), fourWords.join(" | "));

alice.send({ t: "backToLobby" });
await allUntil([alice, cara], (s) => s.phase === "lobby");
dave.close();

// --------------------------------------------------------------- kick + codes

const rosterBefore = alice.state.players.length;
check("the player we are about to remove is currently in the room",
  alice.state.players.some((p) => p.pid === cara.pid));
alice.send({ t: "kick", pid: cara.pid });
await alice.until((s) => !s.players.some((p) => p.pid === cara.pid));
check("host can remove a player",
  alice.state.players.length === rosterBefore - 1,
  alice.state.players.map((p) => p.name).join(","));

alice.send({ t: "kick", pid: alice.pid });
await settle();
check("the host cannot remove themselves",
  alice.state.players.some((p) => p.pid === alice.pid));

const badCode = await fetch(`${BASE}/ws?code=zz`);
check("a malformed room code is rejected", badCode.status === 400, `status ${badCode.status}`);

const missing = await fetch(`${BASE}/api/nope`);
check("an unknown API path 404s", missing.status === 404, `status ${missing.status}`);

// ------------------------------------------------- character packs + pictures
//
// Everything above ran on a typed word bank, where every entry has an empty
// image. These checks use a real preset so there ARE picture URLs to leak.

const room2 = await fetch(`${BASE}/api/new-room`).then((r) => r.json());
const host = new Player("Host");
const guest = new Player("Guest");
await host.connect(room2.code);
await guest.connect(room2.code);

host.send({ t: "setBank", text: "" });
host.send({ t: "setPacks", selection: { "Jujutsu Kaisen": { MAIN: true } }, includeArtless: false });
await host.until((s) => s.wordCount > 0);
check("picking a pack fills the bank without typing anything",
  host.state.wordCount >= 10, `wordCount is ${host.state.wordCount}`);

host.send({ t: "setPacks", selection: { "Jujutsu Kaisen": { MAIN: true, SUPPORTING: true } }, includeArtless: false });
await host.until((s) => s.wordCount > 100);
check("adding a tier grows the bank", host.state.wordCount > 100, `wordCount is ${host.state.wordCount}`);

host.send({ t: "setPacks", selection: { "Jujutsu Kaisen": { MAIN: true }, "Dr. Stone": { MAIN: true } }, includeArtless: false });
await host.until((s) => s.wordCount < 100 && s.wordCount >= 20);
check("two series combine into one bank", host.state.wordCount >= 20, `wordCount is ${host.state.wordCount}`);

// Pin the pack-only size first. Waiting on a ">=" bound here used to resolve
// before the typed word had landed, which left the baseline off by one.
const packOnly = host.state.wordCount;
host.send({ t: "setBank", text: "a raccoon in a trench coat" });
await host.until((s) => s.wordCount === packOnly + 1);
check("a typed word is added ON TOP of the packs", host.state.wordCount === packOnly + 1,
  `${packOnly} -> ${host.state.wordCount}`);

// Drop the typed word again: it has no picture, and if the deal lands on it
// the image assertions below fail at random.
host.send({ t: "setBank", text: "" });
await host.until((s) => s.wordCount === packOnly);
host.send({ t: "deal" });
await allUntil([host, guest], (s) => s.phase === "playing" && s.players.every((p) => p.hasWord));

const guestCard = host.view(guest.pid).word;
check("a dealt character carries a name and a picture",
  !!guestCard.name && /^https:\/\/s4\.anilist\.co\//.test(guestCard.image),
  JSON.stringify(guestCard));

check("you are not told your own character", host.view(host.pid).word === null &&
  guest.view(guest.pid).word === null);

// The point of the whole feature: the PICTURE must be as hidden as the name.
const guestImg = guestCard.image;
const imgLeaks = guest.rawLog.filter((line) => line.includes(guestImg));
check("a guest's own PICTURE URL appears in ZERO bytes ever sent to them",
  imgLeaks.length === 0,
  imgLeaks.length ? `leaked in ${imgLeaks.length} message(s): ${imgLeaks[0].slice(0, 240)}` : "");

const nameLeaks = guest.rawLog.filter((line) => line.includes(guestCard.name));
check("a guest's own character NAME appears in ZERO bytes ever sent to them",
  nameLeaks.length === 0,
  nameLeaks.length ? `leaked in ${nameLeaks.length} message(s)` : "");

check("the guest CAN see the host's picture",
  /^https:\/\/s4\.anilist\.co\//.test(imageOf(guest.view(host.pid).word) || ""),
  JSON.stringify(guest.view(host.pid).word));

// The pack list is a catalogue of counts, never of names — so a guest (and the
// host) cannot mine it for who is in play.
check("guests never receive the pack catalogue", guest.state.packCatalog === undefined);
check("the pack catalogue carries counts, not character names",
  !JSON.stringify(host.state.packCatalog).includes(guestCard.name));

// ------------------------------------------------- re-dealing ONE player

const guestBefore = nameOf(host.view(guest.pid).word);
const hostBefore  = nameOf(guest.view(host.pid).word);
const roundBefore = host.state.round;

host.send({ t: "redealOne", pid: guest.pid });
await host.until((s) => nameOf(s.players.find((p) => p.pid === guest.pid).word) !== guestBefore);

check("re-dealing one player changes that player's character",
  nameOf(host.view(guest.pid).word) !== guestBefore,
  `${guestBefore} -> ${nameOf(host.view(guest.pid).word)}`);
check("re-dealing one player leaves everyone else alone",
  nameOf(guest.view(host.pid).word) === hostBefore,
  `host was ${hostBefore}, now ${nameOf(guest.view(host.pid).word)}`);
check("a single re-deal does not advance the round",
  host.state.round === roundBefore, `round ${roundBefore} -> ${host.state.round}`);
check("the re-dealt player still cannot see their own character",
  guest.view(guest.pid).word === null,
  JSON.stringify(guest.view(guest.pid).word));

// The replacement must be as secret as the original.
const swapped = host.view(guest.pid).word;
const swapLeaks = guest.rawLog.filter((line) =>
  line.includes(swapped.name) || (swapped.image && line.includes(swapped.image)));
check("a re-dealt character never reaches the player it belongs to",
  swapLeaks.length === 0,
  swapLeaks.length ? `leaked in ${swapLeaks.length} message(s): ${swapLeaks[0].slice(0, 200)}` : "");

check("the re-dealt player does not collide with someone else",
  nameOf(host.view(guest.pid).word) !== nameOf(guest.view(host.pid).word));

// A guest must not be able to re-deal anybody.
guest.send({ t: "redealOne", pid: host.pid });
await settle();
check("a non-host cannot re-deal a player",
  nameOf(guest.view(host.pid).word) === hostBefore);

// ------------------------------------------- the host can re-deal THEMSELVES

const hostOwn = nameOf(guest.view(host.pid).word);
host.send({ t: "redealOne", pid: host.pid });
await guest.until((s) => nameOf(s.players.find((p) => p.pid === host.pid).word) !== hostOwn);
check("the host can re-deal themselves", nameOf(guest.view(host.pid).word) !== hostOwn,
  `${hostOwn} -> ${nameOf(guest.view(host.pid).word)}`);
check("the host still cannot see their own character after re-dealing themselves",
  host.view(host.pid).word === null, JSON.stringify(host.view(host.pid).word));

// --------------------------------------- unseen characters come out first

// A bank of exactly 4, a table of 2: two deals should exhaust it with no repeat.
host.send({ t: "setPacks", selection: {}, includeArtless: false });
host.send({ t: "setBank", text: "Alpha, Bravo, Charlie, Delta" });
await host.until((s) => s.wordCount === 4);

const drawn = [];
for (let i = 0; i < 2; i++) {
  host.send({ t: "deal" });
  const want = host.state.round + 1;
  await allUntil([host, guest], (s) => s.round >= want);
  drawn.push(nameOf(guest.view(host.pid).word), nameOf(host.view(guest.pid).word));
}
check("two deals over a 4-word bank hand out 4 DIFFERENT characters",
  new Set(drawn).size === 4, drawn.join(" | "));
check("the room reports how much of the bank the match has used",
  host.state.seenCount === 4, `seenCount is ${host.state.seenCount}`);

// A third deal has nothing fresh left, so it must recycle rather than fail.
host.send({ t: "deal" });
const want3 = host.state.round + 1;
await allUntil([host, guest], (s) => s.round >= want3);
const third = [nameOf(guest.view(host.pid).word), nameOf(host.view(guest.pid).word)];
check("a third deal recycles instead of failing", third.every(Boolean), third.join(" | "));
check("even a recycled round gives the two players different characters",
  third[0] !== third[1], third.join(" | "));
check("exhausting the bank starts a fresh cycle", host.state.seenCount === 2,
  `seenCount is ${host.state.seenCount}`);

// History is per MATCH, so a trip through the lobby must not wipe it.
host.send({ t: "backToLobby" });
await allUntil([host, guest], (s) => s.phase === "lobby");
check("returning to the lobby keeps the match's character history",
  host.state.seenCount === 2, `seenCount is ${host.state.seenCount}`);

// Clear the typed words too: leaving them in means the deal below can land on
// a bare word with no picture, which made this suite fail about half the time.
host.send({ t: "setBank", text: "" });
host.send({ t: "setPacks", selection: { "Jujutsu Kaisen": { MAIN: true } }, includeArtless: false });
await host.until((s) => s.wordCount > 4);
host.send({ t: "deal" });
await allUntil([host, guest], (s) => s.phase === "playing" && s.players.every((p) => p.hasWord));

// --------------------------------- a guest's suggestions never come back to them

{
  const r = await fetch(`${BASE}/api/new-room`).then((x) => x.json());
  const hh = new Player("HostH");
  const g1 = new Player("Gee");
  const g2 = new Player("Aitch");
  await hh.connect(r.code);
  await g1.connect(r.code);
  await g2.connect(r.code);

  // Only guest words in the pool: 2 from each guest, none from the host.
  g1.send({ t: "setBank", text: "Kermit the Frog, SpongeBob" });
  g2.send({ t: "setBank", text: "Gonzo, Patrick Star" });
  await allUntil([hh, g1, g2], (s) => s.wordCount === 4);
  check("both guests' words land in the shared pool", hh.state.wordCount === 4,
    `wordCount is ${hh.state.wordCount}`);

  const G1 = ["kermit the frog", "spongebob"];
  const G2 = ["gonzo", "patrick star"];

  // Deal repeatedly: a guest must never once be handed their own suggestion.
  let ownWord = null;
  for (let i = 0; i < 12 && !ownWord; i++) {
    hh.send({ t: "deal" });
    const want = hh.state.round + 1;
    await allUntil([hh, g1, g2], (s) => s.round >= want);

    const w1 = (nameOf(hh.view(g1.pid).word) || "").toLowerCase();
    const w2 = (nameOf(hh.view(g2.pid).word) || "").toLowerCase();
    if (G1.includes(w1)) ownWord = `Gee got their own word: ${w1}`;
    if (G2.includes(w2)) ownWord = `Aitch got their own word: ${w2}`;
  }
  check("over 12 deals, no guest is ever handed a word they typed", ownWord === null, ownWord || "");

  // The host's own words behave like a pack: they can get them back.
  hh.send({ t: "setBank", text: "Fozzie Bear" });
  await allUntil([hh, g1, g2], (s) => s.wordCount === 5);
  check("the host's words join the pool too", hh.state.wordCount === 5);

  // Typing a word that is already in the pool still blocks it for you.
  g1.send({ t: "setBank", text: "Kermit the Frog, SpongeBob, Fozzie Bear" });
  // Wait on g1's OWN entry count, not the pool size: the pool stays at 5
  // either way, so waiting on it passes before the change has applied.
  await g1.until((s) => s.yourEntries === 3);
  let gotFozzie = false;
  for (let i = 0; i < 12 && !gotFozzie; i++) {
    hh.send({ t: "deal" });
    const want = hh.state.round + 1;
    await allUntil([hh, g1, g2], (s) => s.round >= want);
    if ((nameOf(hh.view(g1.pid).word) || "").toLowerCase() === "fozzie bear") gotFozzie = true;
  }
  check("suggesting a word already in the pool still blocks it for you", !gotFozzie);

  // A re-deal honours the same rule.
  let redealOwn = null;
  for (let i = 0; i < 12 && !redealOwn; i++) {
    hh.send({ t: "redealOne", pid: g1.pid });
    await settle(120);
    const w = (nameOf(hh.view(g1.pid).word) || "").toLowerCase();
    if (G1.includes(w) || w === "fozzie bear") redealOwn = w;
  }
  check("a single re-deal also never hands back your own word", redealOwn === null, redealOwn || "");

  // A guest whose suggestions ARE the whole pool sits the round out rather
  // than being handed one of their own.
  hh.send({ t: "setBank", text: "" });
  g2.send({ t: "setBank", text: "" });
  await allUntil([hh, g1, g2], (s) => s.wordCount === 3);
  hh.send({ t: "deal" });
  const wantLast = hh.state.round + 1;
  await allUntil([hh, g1, g2], (s) => s.round >= wantLast);
  check("a guest gets no word when the pool is entirely their own suggestions",
    hh.view(g1.pid).word === null && hh.view(g1.pid).hasWord === false,
    JSON.stringify(hh.view(g1.pid).word));
  // Read the host's word through a GUEST: the host's own copy is nulled.
  check("the other players still get a word in that case",
    !!nameOf(hh.view(g2.pid).word) && !!nameOf(g2.view(hh.pid).word),
    `${nameOf(hh.view(g2.pid).word)} / ${nameOf(g2.view(hh.pid).word)}`);

  [hh, g1, g2].forEach((p) => p.close());
}

// ------------------------------- the host's own self-excluded bank

{
  const r = await fetch(`${BASE}/api/new-room`).then((x) => x.json());
  const hh = new Player("Hoster");
  const gg = new Player("Gest");
  await hh.connect(r.code);
  await gg.connect(r.code);

  // Global box: two words anyone can get. Blocked box: two the host cannot.
  hh.send({ t: "setBank", text: "Kermit the Frog, SpongeBob" });
  hh.send({ t: "setBlockedBank", text: "Gonzo, Miss Piggy" });
  await allUntil([hh, gg], (s) => s.wordCount === 4);
  check("the host's two boxes both feed the pool", hh.state.wordCount === 4,
    `wordCount is ${hh.state.wordCount}`);
  check("the host is told how many of their words are self-excluded",
    hh.state.yourBlockedEntries === 2, `${hh.state.yourBlockedEntries}`);
  check("a guest never sees the host's blocked box", gg.state.blockedText === "",
    JSON.stringify(gg.state.blockedText));

  const BLOCKED = ["gonzo", "miss piggy"];
  const GLOBAL = ["kermit the frog", "spongebob"];

  let hostGotBlocked = null;
  let hostEverGotGlobal = false;
  let guestEverGotBlocked = false;
  for (let i = 0; i < 16; i++) {
    hh.send({ t: "deal" });
    const want = hh.state.round + 1;
    await allUntil([hh, gg], (s) => s.round >= want);

    const hostWord = (nameOf(gg.view(hh.pid).word) || "").toLowerCase();
    const guestWord = (nameOf(hh.view(gg.pid).word) || "").toLowerCase();
    if (BLOCKED.includes(hostWord)) hostGotBlocked = hostWord;
    if (GLOBAL.includes(hostWord)) hostEverGotGlobal = true;
    if (BLOCKED.includes(guestWord)) guestEverGotBlocked = true;
  }
  check("over 16 deals the host is never dealt a word from their blocked box",
    hostGotBlocked === null, hostGotBlocked || "");
  check("the host CAN still be dealt words from their global box", hostEverGotGlobal);
  check("the blocked words are still dealt to other players", guestEverGotBlocked);

  // With only blocked words in the pool, the host sits out.
  hh.send({ t: "setBank", text: "" });
  await allUntil([hh, gg], (s) => s.wordCount === 2);
  hh.send({ t: "deal" });
  const wantOut = hh.state.round + 1;
  await allUntil([hh, gg], (s) => s.round >= wantOut);
  check("the host gets no word when every word is in their blocked box",
    gg.view(hh.pid).word === null && gg.view(hh.pid).hasWord === false,
    JSON.stringify(gg.view(hh.pid).word));
  check("the guest is still dealt one of them", !!nameOf(hh.view(gg.pid).word),
    `${nameOf(hh.view(gg.pid).word)}`);

  [hh, gg].forEach((p) => p.close());
}

// ------------------------------------------------- the host can reset history

const seenBefore = host.state.seenCount;
check("there is history to forget", seenBefore > 0, `seenCount is ${seenBefore}`);
host.send({ t: "resetSeen" });
await host.until((s) => s.seenCount === 0);
check("the host can reset the seen list", host.state.seenCount === 0);
guest.send({ t: "resetSeen" });
await settle();
check("a non-host cannot reset the seen list", host.state.seenCount === 0);

// ------------------------------------------------------- points and reveals

// Three players so the scoring ladder has more than one rung.
const carl = new Player("Carl");
await carl.connect(room2.code);
const table = [host, guest, carl];
host.send({ t: "deal" });
await allUntil(table, (s) => s.phase === "playing" && s.players.length === 3);

check("everyone starts on zero",
  host.state.players.every((p) => p.score === 0),
  host.state.players.map((p) => `${p.name}:${p.score}`).join(" "));

// 3 players -> first correct guess is worth 2, then 1, then 0.
host.send({ t: "revealOne", pid: guest.pid });
await allUntil(table, (s) => s.players.find((p) => p.pid === guest.pid).revealed);
check("first player home scores (players - 1)",
  host.view(guest.pid).score === 2, `${host.view(guest.pid).score}`);

check("being revealed shows that player their OWN character",
  guest.view(guest.pid).word !== null, JSON.stringify(guest.view(guest.pid).word));
check("revealing one player does not reveal the others",
  guest.view(host.pid).word !== null && host.view(host.pid).word === null);

host.send({ t: "revealOne", pid: carl.pid });
await allUntil(table, (s) => s.players.find((p) => p.pid === carl.pid).revealed);
check("second player home scores one less", host.view(carl.pid).score === 1,
  `${host.view(carl.pid).score}`);

host.send({ t: "revealOne", pid: host.pid });
await allUntil(table, (s) => s.players.find((p) => p.pid === host.pid).revealed);
check("last player home scores nothing", guest.view(host.pid).score === 0,
  `${guest.view(host.pid).score}`);

// Revealing twice must not pay twice.
host.send({ t: "revealOne", pid: guest.pid });
await settle();
check("a second reveal of the same player pays nothing extra",
  host.view(guest.pid).score === 2, `${host.view(guest.pid).score}`);

guest.send({ t: "revealOne", pid: guest.pid });
await settle();
check("a non-host cannot reveal anyone", host.view(guest.pid).score === 2);

// A new round resets who has been revealed, and scores carry over.
host.send({ t: "deal" });
await allUntil(table, (s) => s.players.every((p) => !p.revealed));
check("a new round clears last round's reveals",
  host.state.players.every((p) => !p.revealed));
check("scores carry across rounds", host.view(guest.pid).score === 2);
check("a new round hides your character again", guest.view(guest.pid).word === null);

host.send({ t: "revealOne", pid: host.pid });
await allUntil(table, (s) => s.players.find((p) => p.pid === host.pid).revealed);
check("scores accumulate round on round", guest.view(host.pid).score === 2,
  `${guest.view(host.pid).score}`);

// ------------------------------------------------------------- leaderboard

host.send({ t: "endMatch" });
await allUntil(table, (s) => s.phase === "leaderboard");
check("the host can end the match", host.state.phase === "leaderboard");
check("every player lands on the leaderboard together",
  table.every((p) => p.state.phase === "leaderboard"));
check("the leaderboard carries every score",
  host.state.players.every((p) => typeof p.score === "number"),
  host.state.players.map((p) => `${p.name}:${p.score}`).join(" "));
check("ending the match reveals the characters",
  guest.view(guest.pid).word !== null);

host.send({ t: "newMatch" });
await allUntil(table, (s) => s.phase === "lobby");
check("the host can start a new match with the same party",
  host.state.players.length === 3 && host.state.phase === "lobby");
check("a new match zeroes the scores",
  host.state.players.every((p) => p.score === 0),
  host.state.players.map((p) => `${p.name}:${p.score}`).join(" "));
check("a new match forgets the seen characters", host.state.seenCount === 0);
check("a new match clears everyone's character",
  host.state.players.every((p) => !p.hasWord));

carl.close();

host.send({ t: "deal" });
await allUntil([host, guest], (s) => s.phase === "playing" && s.players.every((p) => p.hasWord));

host.send({ t: "reveal" });
await allUntil([host, guest], (s) => s.revealed === true);
check("after the reveal you finally see your own picture",
  /^https:\/\/s4\.anilist\.co\//.test(imageOf(guest.view(guest.pid).word) || ""),
  JSON.stringify(guest.view(guest.pid).word));

[host, guest].forEach((p) => p.close());

[alice, bobAgain].forEach((p) => p.close());

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : failures + " CHECK(S) FAILED"}\n`);
process.exit(failures === 0 ? 0 : 1);
