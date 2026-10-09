// ===============================================================
//  Dup Me — SERVER (supports many matches at the same time)
//  Run with:  node server.js
//  Server (admin) screen:  http://localhost:3000/server.html
// ===============================================================
const express = require("express");
const http = require("http");
const path = require("path");
const { Server } = require("socket.io");

// ---------- Game settings ----------
const PORT = 3000;
const CREATE_SECONDS = 10;   // time to create a pattern
const REPEAT_SECONDS = 20;   // time to repeat the pattern
const REVIEW_MS = 2500;      // pause to show results after each turn
const MAX_PATTERN = 10;      // max pattern length
const BUTTONS = ["🐷", "🐶", "🐦‍⬛", "🐔", "🐮"];

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } }); // allow index.html to be opened as a local file
app.use(express.static(path.join(__dirname, "public")));

// ---------- Server state ----------
const clients = new Map();     // socket.id -> { id, name, avatar, ip, ready }
let queue = [];                // ids of players in the waiting room, first come first served
const matches = new Map();     // match id -> match object
const playerMatch = new Map(); // socket.id -> match id (only for players in a match)
const logs = [];
let nextMatchId = 1;

function newMatch(players, first, id) {
  return {
    id: id ?? nextMatchId++,
    phase: "create",     // create | repeat | review | ended
    players,             // [idA, idB]
    scores: { [players[0]]: 0, [players[1]]: 0 },
    round: 1,            // 1 or 2
    creator: null,       // player creating the pattern
    repeater: null,      // player repeating the pattern
    pattern: [],
    answer: [],
    deadline: 0,
    firstPlayer: first,  // player who starts this match
    winner: null,        // winner of the match (null = draw)
    rematch: new Set(),  // players who pressed Rematch
    timer: null,         // each match has its own timer
  };
}

// ---------- Helpers ----------
const nameOf = (id) => clients.get(id)?.name ?? "?";
const other = (m, id) => m.players.find((p) => p !== id);
const countCorrect = (m) => m.answer.filter((e, i) => e === m.pattern[i]).length;
const matchOf = (id) => matches.get(playerMatch.get(id));
const label = (m) => `[Match ${m.id}]`;
const allMatches = () => [...matches.values()].sort((a, b) => a.id - b.id);

function log(msg) {
  const t = new Date().toTimeString().slice(0, 8);
  logs.push(`[${t}] ${msg}`);
  if (logs.length > 80) logs.shift();
  console.log(`[${t}] ${msg}`);
}

function printOnline() {
  const names = [...clients.values()].map((c) => c.name).join(", ") || "-";
  console.log(`>>> Online: ${clients.size} client(s), ${matches.size} match(es): ${names}`);
}

// Status of each client: "in game", "ready" (waiting in line) or "break"
function onlineList() {
  const readyQueue = queue.filter((id) => clients.get(id)?.ready);
  return [...clients.values()].map((c) => {
    const m = matchOf(c.id);
    const status = m ? "in game" : c.ready ? "ready" : "break";
    const pos = readyQueue.indexOf(c.id);
    return { ...c, inGame: !!m, matchId: m?.id ?? null, status, queuePos: pos >= 0 ? pos + 1 : null };
  });
}

function publicMatch(m) {
  return {
    id: m.id,
    phase: m.phase,
    round: m.round,
    creator: m.creator,
    repeater: m.repeater,
    pattern: m.pattern,
    answer: m.answer,
    scores: m.scores,
    players: m.players.map((id) => ({ id, name: nameOf(id), avatar: clients.get(id)?.avatar })),
    deadline: m.deadline, // changes every time a new phase starts
    secondsLeft: Math.max(0, Math.ceil((m.deadline - Date.now()) / 1000)),
    firstPlayer: m.firstPlayer,
    winner: m.winner,
    rematch: [...m.rematch],
  };
}

const IDLE = { phase: "idle", players: [] };

// Send the latest state to everyone:
//  - each player gets the state of THEIR OWN match (or "idle" in the waiting room)
//  - everyone gets the online list and a short list of running matches
//  - the server screen gets everything
function sync() {
  const online = onlineList();
  const summary = allMatches().map((m) => ({ id: m.id, players: m.players.map(nameOf), phase: m.phase }));
  io.to("players").emit("online", online);
  io.to("players").emit("matches", summary);
  for (const id of clients.keys()) {
    const m = matchOf(id);
    io.to(id).emit("state", m ? publicMatch(m) : IDLE);
  }
  io.to("admin").emit("admin_state", { online, matches: allMatches().map(publicMatch), logs });
}

// ---------- Game flow ----------
// Keep pairing ready players from the waiting room until fewer than 2 are left
function tryStartMatches() {
  let ready = queue.filter((id) => clients.get(id)?.ready);
  while (ready.length >= 2) {
    const players = ready.slice(0, 2);
    queue = queue.filter((id) => !players.includes(id));
    const first = players[Math.floor(Math.random() * 2)];
    startMatch(players, first, true);
    ready = ready.slice(2);
  }
}

// keepId: reuse the match number for a rematch / reset
function startMatch(players, first, random = false, keepId) {
  const m = newMatch(players, first, keepId);
  matches.set(m.id, m);
  players.forEach((id) => playerMatch.set(id, m.id));
  log(`${label(m)} Match started: ${nameOf(players[0])} vs ${nameOf(players[1])}`);
  if (random) log(`${label(m)} Random first player -> ${nameOf(first)}`);
  startCreate(m, first);
  return m;
}

// Create phase (10 s)
function startCreate(m, creatorId) {
  clearTimeout(m.timer);
  m.phase = "create";
  m.creator = creatorId;
  m.repeater = other(m, creatorId);
  m.pattern = [];
  m.answer = [];
  m.deadline = Date.now() + CREATE_SECONDS * 1000;
  m.timer = setTimeout(() => startRepeat(m), CREATE_SECONDS * 1000);
  log(`${label(m)} Round ${m.round}: ${nameOf(creatorId)} is creating a pattern`);
  sync();
}

// Repeat phase (20 s)
function startRepeat(m) {
  clearTimeout(m.timer);
  if (m.pattern.length === 0) {
    log(`${label(m)} ${nameOf(m.creator)} did not press anything`);
    return endTurn(m);
  }
  m.phase = "repeat";
  m.answer = [];
  m.deadline = Date.now() + REPEAT_SECONDS * 1000;
  m.timer = setTimeout(() => endTurn(m), REPEAT_SECONDS * 1000);
  log(`${label(m)} Round ${m.round}: ${nameOf(m.repeater)} is repeating`);
  sync();
}

// End of turn: score the repeater, then pause briefly to show the result
function endTurn(m) {
  clearTimeout(m.timer);
  const correct = countCorrect(m);
  m.scores[m.repeater] += correct;
  m.phase = "review";
  m.deadline = 0;
  log(`${label(m)} ${nameOf(m.repeater)} got ${correct} step(s) correct`);
  sync();

  m.timer = setTimeout(() => {
    if (m.round === 1) {
      m.round = 2;
      startCreate(m, m.repeater); // swap roles
    } else {
      endMatch(m);
    }
  }, REVIEW_MS);
}

function endMatch(m) {
  const [a, b] = m.players;
  const sa = m.scores[a], sb = m.scores[b];
  m.winner = sa > sb ? a : sb > sa ? b : null;
  m.phase = "ended";
  log(m.winner ? `${label(m)} Match over: ${nameOf(m.winner)} wins (${sa}-${sb})` : `${label(m)} Match over: draw (${sa}-${sb})`);
  sync();
}

// Close a match. Players still online go back to the waiting room.
//   toFront: ids that should be first in line (they did not choose to leave)
//   toBack:  ids that go to the end of the line
function closeMatch(m, toFront = [], toBack = []) {
  clearTimeout(m.timer);
  matches.delete(m.id);
  m.players.forEach((id) => playerMatch.delete(id));
  const keep = (id) => clients.has(id) && !queue.includes(id);
  queue = [...toFront.filter(keep), ...queue, ...toBack.filter(keep)];
}

// Restart a match from zero with the same players (used by the Reset button)
function resetMatch(m) {
  io.to(m.players).emit("notice", "Server reset the game and scores");
  log(`${label(m)} RESET: game and scores reset`);
  closeMatch(m);
  const first = m.players[Math.floor(Math.random() * 2)];
  const nm = startMatch(m.players, first, false, m.id);
  log(`${label(nm)} Random first player -> ${nameOf(first)}`);
}

// ---------- Messages from clients ----------
io.on("connection", (socket) => {
  // Player enters a nickname
  socket.on("join", ({ name, avatar } = {}) => {
    const clean = String(name || "").trim().slice(0, 12) || "Player";
    const ip = (socket.handshake.address || "").replace("::ffff:", "");
    const isNew = !clients.has(socket.id);
    clients.set(socket.id, { id: socket.id, name: clean, avatar: BUTTONS.includes(avatar) ? avatar : "🐷", ip, ready: true });
    if (isNew && !matchOf(socket.id)) queue.push(socket.id);
    socket.join("players");
    socket.emit("welcome", { id: socket.id, name: clean });
    log(`${clean} connected (${ip})`);
    printOnline();
    tryStartMatches();
    sync();
  });

  // Player presses a button (only affects their own match)
  socket.on("press", (emoji) => {
    const m = matchOf(socket.id);
    if (!m || !BUTTONS.includes(emoji)) return;

    if (m.phase === "create" && socket.id === m.creator && m.pattern.length < MAX_PATTERN) {
      m.pattern.push(emoji);
      sync();
    } else if (m.phase === "repeat" && socket.id === m.repeater && m.answer.length < m.pattern.length) {
      m.answer.push(emoji);
      sync();
      if (m.answer.length === m.pattern.length) endTurn(m); // all steps entered, no need to wait for the timer
    }
  });

  // Creator presses "Done" before time runs out
  socket.on("done", () => {
    const m = matchOf(socket.id);
    if (m && m.phase === "create" && socket.id === m.creator && m.pattern.length > 0) startRepeat(m);
  });

  // Rematch request
  socket.on("rematch", () => {
    const m = matchOf(socket.id);
    if (!m || m.phase !== "ended") return;
    m.rematch.add(socket.id);
    log(`${label(m)} ${nameOf(socket.id)} requested a rematch`);
    if (m.rematch.size === 2) {
      // Winner goes first; on a draw, pick at random
      const first = m.winner || m.players[Math.floor(Math.random() * 2)];
      closeMatch(m);
      const nm = startMatch(m.players, first, false, m.id);
      log(`${label(nm)} Rematch: ${nameOf(first)} goes first`);
    } else {
      sync();
    }
  });

  // After a match: go back to the waiting room so other players can play
  socket.on("leave_match", () => {
    const m = matchOf(socket.id);
    if (!m || m.phase !== "ended") return;
    const opp = other(m, socket.id);
    const me = clients.get(socket.id);
    me.ready = false; // the leaver takes a break until they press Ready
    log(`${label(m)} ${me.name} went back to the waiting room`);
    io.to(opp).emit("notice", `${me.name} left the match. You're back in the waiting room.`);
    closeMatch(m, [], [opp, socket.id]); // both go to the end of the line, so waiting players play next
    tryStartMatches();
    sync();
  });

  // Waiting room: "Ready to play" / "Take a break"
  socket.on("set_ready", (ready) => {
    const c = clients.get(socket.id);
    if (!c || matchOf(socket.id)) return;
    c.ready = !!ready;
    log(`${c.name} is ${c.ready ? "ready to play" : "taking a break"}`);
    tryStartMatches();
    sync();
  });

  // Exit: leave the game completely and go back to the nickname screen
  socket.on("quit", () => removePlayer(socket, "left the game"));

  // ---- Server (admin) screen ----
  socket.on("admin_join", () => {
    socket.join("admin");
    socket.emit("admin_state", { online: onlineList(), matches: allMatches().map(publicMatch), logs });
  });

  // Reset game & scores: one match (matchId) or all matches (no matchId)
  socket.on("admin_reset", (matchId) => {
    const list = matchId ? [matches.get(matchId)].filter(Boolean) : allMatches();
    if (list.length === 0) log("RESET: no match to reset");
    list.forEach(resetMatch);
    sync();
  });

  // Player closes the page
  socket.on("disconnect", () => removePlayer(socket, "disconnected"));
});

function removePlayer(socket, reason) {
  const c = clients.get(socket.id);
  if (!c) return; // admin screen, or already removed
  const m = matchOf(socket.id);
  clients.delete(socket.id);
  queue = queue.filter((id) => id !== socket.id);
  socket.leave("players");
  log(`${c.name} ${reason}`);
  printOnline();
  if (m) {
    const opp = other(m, socket.id);
    io.to(opp).emit("notice", `${c.name} left the game. You're back in the waiting room.`);
    log(`${label(m)} Match stopped because a player left`);
    closeMatch(m, [opp]); // the remaining player is first in line
    tryStartMatches();
  }
  sync();
}

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Dup Me server is running on port ${PORT}`);
  console.log(`Server screen: http://localhost:${PORT}/server.html`);
});