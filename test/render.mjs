/**
 * Render tests.
 *
 * The end-to-end suite talks WebSocket and checks what the SERVER sends. It is
 * blind to the browser, which is how two bugs reached the player: the host had
 * no "I got it" button, and an individually-revealed player was still shown a
 * redaction bar. These tests load the real page in a fake DOM, push a state
 * message through it, and inspect what actually appears on screen.
 */

import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";

let failures = 0;
function check(label, cond, detail) {
  if (cond) { console.log(`  ok    ${label}`); return; }
  failures++;
  console.log(`  FAIL  ${label}`);
  if (detail) console.log(`          ${detail}`);
}

const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");

/**
 * Boot the page as a RETURNING player (a stored name plus a #ROOM in the URL
 * makes it auto-connect), stub the socket, then push one state message in
 * exactly as the server would. The page's own code does the rest.
 */
function renderState(state) {
  const sockets = [];
  const dom = new JSDOM(html, {
    runScripts: "dangerously",
    url: "http://localhost:8787/#ABCD",
    beforeParse(win) {
      win.localStorage.setItem("blindspot.name", state.you.name);
      win.localStorage.setItem("blindspot.pid", state.you.pid);
      win.WebSocket = class {
        static OPEN = 1;
        constructor() { this.readyState = 1; sockets.push(this); }
        send() {}
        close() {}
      };
    },
  });

  const ws = sockets[0];
  if (!ws) throw new Error("the page never opened a socket");
  ws.onopen && ws.onopen();
  ws.onmessage({ data: JSON.stringify({ t: "joined", pid: state.you.pid }) });
  ws.onmessage({ data: JSON.stringify(state) });
  return dom.window.document;
}

function player(over = {}) {
  return { pid: "p1", name: "Ann", online: true, isHost: true, hasWord: true,
           score: 0, revealed: false, word: null, ...over };
}

function state(over = {}) {
  return {
    t: "state", code: "ABCD", phase: "playing", round: 1, revealed: false,
    wordCount: 10, seenCount: 0,
    you: { pid: "p1", name: "Ann", isHost: true },
    players: [player(), player({ pid: "p2", name: "Bob", isHost: false, word: { name: "Levi", image: "" } })],
    ...over,
  };
}

console.log("\nDanny's Head's Up render tests\n");

// --- the host's own tag ---
let doc = renderState(state());
let self = doc.querySelector(".tag-self");
check("your own hidden tag shows a redaction bar", !!self.querySelector(".redaction"));
check("the host gets an 'I got it' button on their OWN tag",
  /I got it/.test(self.textContent), self.textContent.trim().replace(/\s+/g, " "));
check("the host gets a 'Re-deal me' button on their own tag",
  /Re-deal me/.test(self.textContent));

// --- a host who has been revealed individually ---
doc = renderState(state({
  players: [player({ revealed: true, word: { name: "Satoru Gojo", image: "" } }),
            player({ pid: "p2", name: "Bob", isHost: false, word: { name: "Levi", image: "" } })],
}));
self = doc.querySelector(".tag-self");
check("an individually-revealed player sees their character, not a redaction bar",
  !self.querySelector(".redaction") && /Satoru Gojo/.test(self.textContent),
  self.textContent.trim().replace(/\s+/g, " "));

// --- a non-host sees no host controls ---
doc = renderState(state({
  you: { pid: "p2", name: "Bob", isHost: false },
  players: [player({ pid: "p2", name: "Bob", isHost: false }),
            player({ pid: "p1", name: "Ann", isHost: true, word: { name: "Levi", image: "" } })],
}));
check("a guest sees no 'I got it' button", !/I got it/.test(doc.querySelector(".tag-self").textContent));
check("a guest sees no reveal button on other tags",
  !/They got it/.test(doc.querySelector("#tag-grid").textContent));

// --- other players' tags, host view ---
doc = renderState(state());
const other = [...doc.querySelectorAll(".tag")].find((t) => !t.classList.contains("tag-self"));
check("another player's tag shows their character", /Levi/.test(other.textContent));
check("the host gets a 'They got it' button on another player's tag",
  /They got it/.test(other.textContent), other.textContent.trim().replace(/\s+/g, " "));
check("the points on offer count down as players are revealed",
  /They got it \(\+1\)/.test(other.textContent), other.textContent.trim().replace(/\s+/g, " "));

// --- the two word-bank boxes in the lobby ---
doc = renderState(state({ phase: "lobby", blockedText: "", yourBlockedEntries: 0 }));
check("the lobby shows everyone a word bank", !doc.getElementById("bank-panel").hidden);
check("the host sees the self-excluded box", !doc.getElementById("blocked-wrap").hidden);
check("the host sees the packs panel", !doc.getElementById("host-panel").hidden);
check("the host sees the deal panel", !doc.getElementById("deal-panel").hidden);

doc = renderState(state({
  phase: "lobby", blockedText: "", yourBlockedEntries: 0,
  you: { pid: "p2", name: "Bob", isHost: false },
  players: [player({ pid: "p2", name: "Bob", isHost: false }), player()],
}));
check("a guest also gets a word bank", !doc.getElementById("bank-panel").hidden);
check("a guest does NOT get the self-excluded box", doc.getElementById("blocked-wrap").hidden);
check("a guest does not see the packs panel", doc.getElementById("host-panel").hidden);
check("a guest does not see the deal panel", doc.getElementById("deal-panel").hidden);

// --- the leaderboard ---
doc = renderState(state({
  phase: "leaderboard", revealed: true,
  players: [player({ score: 5, word: { name: "A", image: "" } }),
            player({ pid: "p2", name: "Bob", isHost: false, score: 9, word: { name: "B", image: "" } })],
}));
check("ending the match shows the leaderboard", !doc.getElementById("screen-board").hidden);
check("the play screen is hidden on the leaderboard", doc.getElementById("screen-play").hidden);
const rows = [...doc.querySelectorAll("#board-list li")];
check("the leaderboard sorts by score, highest first",
  /Bob/.test(rows[0].textContent) && /Ann/.test(rows[1].textContent),
  rows.map((r) => r.textContent.trim().replace(/\s+/g, " ")).join(" | "));
check("the leader is marked first place", /#1/.test(rows[0].textContent) && rows[0].classList.contains("first"));
check("the host sees the new-match control", !doc.getElementById("board-host-panel").hidden);

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : failures + " CHECK(S) FAILED"}\n`);
process.exit(failures === 0 ? 0 : 1);
