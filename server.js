// ===============================================================
//  Dup Me — SERVER (supports many matches at the same time)
//  Run with:  node server.js
//  Server (admin) screen:  http://localhost:3000/server.html
// ===============================================================
const express = require("express");
const http = require("http");
const path = require("path");
const { Server } = require("socket.io");
const accounts = require("./accounts");
const bot = require("./bot");
const { makeHint, publicHint } = require("./hints");

// ---------- Game settings ----------
const PORT = 3001;
const CREATE_SECONDS = 10;   // time to create a pattern
const REPEAT_SECONDS = 20;   // time to repeat the pattern
const REVIEW_MS = 2500;      // pause to show results after each turn
const MAX_PATTERN = 10;      // max pattern length
const MIN_BUTTONS = 5, MAX_BUTTONS = 8; // how many buttons a match can use
const MODES = ["normal", "hard"];       // hard = the guesser's buttons move after every press
const MAX_HINTS = 2;         // hints the guesser can ask for per turn
const HINT_COST = 0.5;       // points taken off the guesser's turn for each hint
const BOT_ROUNDS = 3;        // vs the AI bot: the bot creates every pattern, the player guesses every round
const AVATARS = ["🐷", "🐶", "🐦‍⬛", "🐔", "🐮", "🐱", "🐸", "🐑"];
// Sound sync: every press is played on BOTH screens at the same server time.
// The server schedules it a little in the future so the slower player's message can arrive in time.
const SOUND_LEAD_MIN = 80;   // ms
const SOUND_LEAD_MAX = 350;  // ms

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } }); // allow index.html to be opened as a local file
// Allow the sound files to be loaded when index.html is opened as a local file
app.use((req, res, next) => { res.set("Access-Control-Allow-Origin", "*"); next(); });
app.use(express.static(path.join(__dirname, "public")));

// ---------- Server state ----------
// socket.id -> { id, name, avatar, ip, ready, mode, buttons, user (account key or null), isBot, level }
const clients = new Map();
let queue = [];                // ids of players in the waiting room, first come first served
const matches = new Map();     // match id -> match object
const playerMatch = new Map(); // socket.id -> match id (only for players in a match)
const socketUser = new Map();  // socket.id -> account key (logged-in players, even before joining)
const logs = [];
const rtts = new Map();        // socket.id -> round-trip time to that client (ms), reported by the client
let nextMatchId = 1;
let nextBotId = 1;

function newMatch(players, first, id, settings) {
  return {
    id: id ?? nextMatchId++,
    phase: "create",     // create | repeat | review | ended
    players,             // [idA, idB]
    mode: settings.mode,       // "normal" | "hard"
    buttons: settings.buttons, // 5–8 buttons
    scores: { [players[0]]: 0, [players[1]]: 0 },
    round: 1,
    rounds: settings.vsBot ? BOT_ROUNDS : 2, // 2 rounds (roles swap), or BOT_ROUNDS vs the bot
    vsBot: !!settings.vsBot, // vs the bot: every step the player misses is a point for the bot
    creator: null,       // player creating the pattern
    repeater: null,      // player repeating the pattern
    pattern: [],         // button positions (0, 1, 2, ...) — each player shows their own emoji for a position
    answer: [],
    hintLog: [],         // hints given to the guesser this turn
    lastTurn: null,      // { correct, hints, earned } of the last finished turn
    deadline: 0,
    firstPlayer: first,  // player who starts this match
    winner: null,        // winner of the match (null = draw)
    rematch: new Set(),  // players who pressed Rematch
    timer: null,         // each match has its own timer
    botTimers: [],       // the AI bot's scheduled presses
  };
}

// ---------- Helpers ----------
const nameOf = (id) => clients.get(id)?.name ?? "?";
const other = (m, id) => m.players.find((p) => p !== id);
const countCorrect = (m) => m.answer.filter((e, i) => e === m.pattern[i]).length;
const matchOf = (id) => matches.get(playerMatch.get(id));
const label = (m) => `[Match ${m.id}]`;
const allMatches = () => [...matches.values()].sort((a, b) => a.id - b.id);
const isBot = (id) => !!clients.get(id)?.isBot;
const humans = () => [...clients.values()].filter((c) => !c.isBot);
const round1 = (x) => Math.round(x * 10) / 10;

function log(msg) {
  const t = new Date().toTimeString().slice(0, 8);
  logs.push(`[${t}] ${msg}`);
  if (logs.length > 80) logs.shift();
  console.log(`[${t}] ${msg}`);
}

function printOnline() {
  const names = humans().map((c) => c.name).join(", ") || "-";
  console.log(`>>> Online: ${humans().length} client(s), ${matches.size} match(es): ${names}`);
}

// Status of each client: "in game", "ready" (waiting in line) or "break"
function onlineList() {
  const readyQueue = queue.filter((id) => clients.get(id)?.ready);
  return humans().map((c) => {
    const m = matchOf(c.id);
    const status = m ? "in game" : c.ready ? "ready" : "break";
    const pos = readyQueue.indexOf(c.id);
    const { user, ...pub } = c;
    return { ...pub, loggedIn: !!user, inGame: !!m, matchId: m?.id ?? null, vsBot: m ? m.players.some(isBot) : false,
             status, queuePos: pos >= 0 ? pos + 1 : null };
  });
}

// viewerId: who will receive this state. The repeater (guesser) must NOT receive the pattern
// while it is being created or repeated — they only get its length, shown as solid boxes.
// The pattern is revealed to everyone in the "review" and "ended" phases.
function publicMatch(m, viewerId = null) {
  const blind = viewerId === m.repeater && (m.phase === "create" || m.phase === "repeat");
  return {
    id: m.id,
    phase: m.phase,
    round: m.round,
    rounds: m.rounds,
    vsBot: m.vsBot,
    mode: m.mode,
    buttons: m.buttons,
    creator: m.creator,
    repeater: m.repeater,
    pattern: blind ? null : m.pattern,
    patternLength: m.pattern.length,
    answer: m.answer,
    answerOk: m.answer.map((e, i) => e === m.pattern[i]), // checked on the server, so the client never needs the pattern
    hints: m.hintLog.map(publicHint),
    hintsLeft: MAX_HINTS - m.hintLog.length,
    hintCost: HINT_COST,
    lastTurn: m.lastTurn,
    scores: m.scores,
    players: m.players.map((id) => ({ id, name: nameOf(id), avatar: clients.get(id)?.avatar, isBot: isBot(id) })),
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
  const summary = allMatches().map((m) => ({ id: m.id, players: m.players.map(nameOf), phase: m.phase, mode: m.mode, buttons: m.buttons }));
  io.to("players").emit("online", online);
  io.to("players").emit("matches", summary);
  for (const c of humans()) {
    const m = matchOf(c.id);
    io.to(c.id).emit("state", m ? publicMatch(m, c.id) : IDLE);
  }
  io.to("admin").emit("admin_state", { online, matches: allMatches().map((m) => publicMatch(m)), logs });
}

// ---------- Game flow ----------
// Pair ready players from the waiting room. Two players are only paired if they chose
// the same mode (normal / hard) and the same number of buttons.
function tryStartMatches() {
  let found = true;
  while (found) {
    found = false;
    const ready = queue.filter((id) => clients.get(id)?.ready);
    for (let i = 0; i < ready.length && !found; i++) {
      const a = clients.get(ready[i]);
      const b = ready.slice(i + 1).map((id) => clients.get(id))
        .find((c) => c.mode === a.mode && c.buttons === a.buttons && (!a.user || c.user !== a.user));
      if (!b) continue;
      const players = [a.id, b.id];
      queue = queue.filter((id) => !players.includes(id));
      startMatch(players, players[Math.floor(Math.random() * 2)], true, undefined, { mode: a.mode, buttons: a.buttons });
      found = true;
    }
  }
}

// keepId: reuse the match number for a rematch / reset
function startMatch(players, first, random = false, keepId, settings) {
  const m = newMatch(players, first, keepId, settings);
  matches.set(m.id, m);
  players.forEach((id) => playerMatch.set(id, m.id));
  log(`${label(m)} Match started: ${nameOf(players[0])} vs ${nameOf(players[1])} (${m.mode}, ${m.buttons} buttons)`);
  if (random) log(`${label(m)} Random first player -> ${nameOf(first)}`);
  startCreate(m, first);
  return m;
}

function clearBot(m) {
  m.botTimers.forEach(clearTimeout);
  m.botTimers = [];
}

// What the AI bot is allowed to do — exactly the same actions a player's socket can do
const botActions = (m, botId) => ({
  press: (index) => handlePress(m, botId, index),
  done: () => handleDone(m, botId),
});

// Create phase (10 s)
function startCreate(m, creatorId) {
  clearTimeout(m.timer);
  clearBot(m);
  m.phase = "create";
  m.creator = creatorId;
  m.repeater = other(m, creatorId);
  m.pattern = [];
  m.answer = [];
  m.hintLog = [];
  m.deadline = Date.now() + CREATE_SECONDS * 1000;
  m.timer = setTimeout(() => startRepeat(m), CREATE_SECONDS * 1000);
  log(`${label(m)} Round ${m.round}: ${nameOf(creatorId)} is creating a pattern`);
  sync();
  if (isBot(creatorId)) m.botTimers = bot.playCreate(clients.get(creatorId).level, m.buttons, botActions(m, creatorId), m.round, MAX_PATTERN);
}

// Repeat phase (20 s)
function startRepeat(m) {
  clearTimeout(m.timer);
  clearBot(m);
  if (m.pattern.length === 0) {
    log(`${label(m)} ${nameOf(m.creator)} did not press anything`);
    return endTurn(m);
  }
  m.phase = "repeat";
  m.answer = [];
  m.hintLog = [];
  m.deadline = Date.now() + REPEAT_SECONDS * 1000;
  m.timer = setTimeout(() => endTurn(m), REPEAT_SECONDS * 1000);
  log(`${label(m)} Round ${m.round}: ${nameOf(m.repeater)} is repeating`);
  sync();
  if (isBot(m.repeater)) m.botTimers = bot.playRepeat(clients.get(m.repeater).level, m.pattern, m.buttons, botActions(m, m.repeater));
}

// End of turn: score the repeater (minus hints), then pause briefly to show the result
function endTurn(m) {
  clearTimeout(m.timer);
  clearBot(m);
  const correct = countCorrect(m);
  const hints = m.hintLog.length;
  const earned = Math.max(0, round1(correct - hints * HINT_COST));
  m.scores[m.repeater] = round1(m.scores[m.repeater] + earned);
  // vs the bot, the player always guesses: every missed step (and hint cost) goes to the bot
  if (m.vsBot) m.scores[m.creator] = round1(m.scores[m.creator] + Math.max(0, m.pattern.length - earned));
  m.lastTurn = { correct, hints, earned };
  m.phase = "review";
  m.deadline = 0;
  log(`${label(m)} ${nameOf(m.repeater)} got ${correct} step(s) correct` + (hints ? `, used ${hints} hint(s) -> ${earned} point(s)` : ""));
  const key = clients.get(m.repeater)?.user;
  if (key && m.pattern.length) accounts.recordTurn(key, { correct, length: m.pattern.length, hints });
  sync();

  m.timer = setTimeout(() => {
    if (m.round < m.rounds) {
      m.round++;
      startCreate(m, m.vsBot ? m.creator : m.repeater); // vs bot: the bot creates again; otherwise swap roles
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

  sync(); // show the end screen first, then the updated stats

  // Save stats for logged-in players and send them their updated account
  const vsBot = m.players.some(isBot);
  for (const id of m.players) {
    const key = clients.get(id)?.user;
    if (!key) continue;
    const result = m.winner === null ? "draw" : m.winner === id ? "win" : "loss";
    accounts.recordMatch(key, { result, score: m.scores[id], vsBot, hard: m.mode === "hard" });
    io.to(id).emit("account", accounts.publicUser(key));
  }
}

// Close a match. Players still online go back to the waiting room.
//   toFront: ids that should be first in line (they did not choose to leave)
//   toBack:  ids that go to the end of the line
function closeMatch(m, toFront = [], toBack = []) {
  clearTimeout(m.timer);
  clearBot(m);
  matches.delete(m.id);
  m.players.forEach((id) => playerMatch.delete(id));
  const keep = (id) => clients.has(id) && !isBot(id) && !queue.includes(id);
  queue = [...toFront.filter(keep), ...queue, ...toBack.filter(keep)];
}

// A bot only exists for its match
function dropBots(m) {
  m.players.filter(isBot).forEach((id) => clients.delete(id));
}

// Restart a match from zero with the same players (used by the Reset button)
function resetMatch(m) {
  io.to(m.players).emit("notice", "Server reset the game and scores");
  log(`${label(m)} RESET: game and scores reset`);
  closeMatch(m);
  const first = m.vsBot ? m.players.find(isBot) : m.players[Math.floor(Math.random() * 2)];
  const nm = startMatch(m.players, first, false, m.id, m);
  log(`${label(nm)} Random first player -> ${nameOf(first)}`);
}

// A button press from a player or the bot (only affects their own match)
function handlePress(m, id, index) {
  if (!Number.isInteger(index) || index < 0 || index >= m.buttons || matchOf(id) !== m) return;
  if (m.phase === "create" && id === m.creator && m.pattern.length < MAX_PATTERN) {
    m.pattern.push(index);
    broadcastPress(m, id, index);
    sync();
  } else if (m.phase === "repeat" && id === m.repeater && m.answer.length < m.pattern.length) {
    m.answer.push(index);
    broadcastPress(m, id, index);
    sync();
    if (m.answer.length === m.pattern.length) endTurn(m); // all steps entered, no need to wait for the timer
  }
}

// Creator presses "Done" before time runs out
function handleDone(m, id) {
  if (matchOf(id) === m && m.phase === "create" && id === m.creator && m.pattern.length > 0) startRepeat(m);
}

// Tell BOTH players in the match which button was pressed, and the exact server time to play it.
// Both screens animate the button and play the sound at that time; each player hears their own chosen sound type.
function broadcastPress(m, by, index) {
  const people = m.players.filter((id) => !isBot(id));
  const slowest = Math.max(...people.map((id) => rtts.get(id) ?? 100));
  const lead = Math.round(Math.min(SOUND_LEAD_MAX, Math.max(SOUND_LEAD_MIN, slowest / 2 + 50)));
  io.to(people).emit("pressed", { index, by, at: Date.now() + lead });
}

const cleanMode = (x) => (MODES.includes(x) ? x : "normal");
const cleanButtons = (x) => (Number.isInteger(x) && x >= MIN_BUTTONS && x <= MAX_BUTTONS ? x : MIN_BUTTONS);

// ---------- Messages from clients ----------
io.on("connection", (socket) => {
  // ---- Accounts (sign up / log in happen on the first screen, before joining) ----
  const reply = (ack, data) => typeof ack === "function" && ack(data);

  socket.on("signup", ({ name, password } = {}, ack) => {
    const r = accounts.signup(name, password);
    if (r.token) { socketUser.set(socket.id, r.user.name.toLowerCase()); log(`New account: ${r.user.name}`); }
    reply(ack, r);
  });
  socket.on("login", ({ name, password, token } = {}, ack) => {
    // with a saved token (auto log-in) or with name + password
    const key = token ? accounts.keyFromToken(token) : null;
    const r = key ? { token, user: accounts.publicUser(key) } : token ? { error: "Please log in again" } : accounts.login(name, password);
    if (r.user) socketUser.set(socket.id, r.user.name.toLowerCase());
    reply(ack, r);
  });
  socket.on("logout", (token) => {
    accounts.logout(token);
    socketUser.delete(socket.id);
    const c = clients.get(socket.id);
    if (c) c.user = null;
  });
  socket.on("save_prefs", (prefs) => {
    const key = socketUser.get(socket.id);
    if (key) accounts.savePrefs(key, prefs);
  });

  // Player enters the waiting room (guest nickname, or their account name if logged in)
  socket.on("join", ({ name, avatar, mode, buttons } = {}) => {
    const key = socketUser.get(socket.id) ?? null;
    const account = key ? accounts.publicUser(key) : null;
    const clean = account?.name ?? (String(name || "").trim().slice(0, 12) || "Player");
    const ip = (socket.handshake.address || "").replace("::ffff:", "");
    const isNew = !clients.has(socket.id);
    clients.set(socket.id, {
      id: socket.id, name: clean, avatar: AVATARS.includes(avatar) ? avatar : "🐷", ip, ready: true,
      mode: cleanMode(mode), buttons: cleanButtons(buttons), user: key,
    });
    if (isNew && !matchOf(socket.id)) queue.push(socket.id);
    socket.join("players");
    socket.emit("welcome", { id: socket.id, name: clean, user: account });
    log(`${clean} connected (${ip})${key ? " [logged in]" : ""}`);
    printOnline();
    tryStartMatches();
    sync();
  });

  // Waiting room: choose mode and number of buttons (used for matchmaking)
  socket.on("set_prefs", ({ mode, buttons } = {}) => {
    const c = clients.get(socket.id);
    if (!c || matchOf(socket.id)) return;
    c.mode = cleanMode(mode);
    c.buttons = cleanButtons(buttons);
    tryStartMatches();
    sync();
  });

  // Play against the AI bot right away
  socket.on("play_bot", (level) => {
    const c = clients.get(socket.id);
    if (!c || matchOf(socket.id)) return;
    level = bot.LEVELS[level] ? level : "normal";
    const botId = `bot-${nextBotId++}`;
    clients.set(botId, { id: botId, name: `AI ${bot.LEVELS[level].label}`, avatar: "🤖", isBot: true, level, ready: false, mode: c.mode, buttons: c.buttons });
    queue = queue.filter((id) => id !== socket.id);
    const players = [socket.id, botId];
    startMatch(players, botId, false, undefined, { mode: c.mode, buttons: c.buttons, vsBot: true }); // the bot always creates
  });

  // Clock sync: the client asks for the server time so it can convert "play at" times to its own clock
  socket.on("clock", (ack) => { if (typeof ack === "function") ack(Date.now()); });
  socket.on("rtt", (ms) => { if (Number.isFinite(ms)) rtts.set(socket.id, Math.min(2000, Math.max(0, ms))); });

  // Player presses a button: data = button position (0, 1, 2, ...)
  socket.on("press", (data) => {
    const m = matchOf(socket.id);
    const index = typeof data === "object" && data ? data.index : data;
    if (m) handlePress(m, socket.id, index);
  });

  socket.on("done", () => {
    const m = matchOf(socket.id);
    if (m) handleDone(m, socket.id);
  });

  // Guesser asks for a smart hint (costs HINT_COST points, MAX_HINTS per turn)
  socket.on("hint", () => {
    const m = matchOf(socket.id);
    if (!m || m.phase !== "repeat" || socket.id !== m.repeater) return;
    if (m.hintLog.length >= MAX_HINTS || m.answer.length >= m.pattern.length) return;
    m.hintLog.push(makeHint(m));
    log(`${label(m)} ${nameOf(socket.id)} used a hint (${m.hintLog.at(-1).kind})`);
    sync();
  });

  // Rematch request
  socket.on("rematch", () => {
    const m = matchOf(socket.id);
    if (!m || m.phase !== "ended") return;
    m.rematch.add(socket.id);
    m.players.filter(isBot).forEach((id) => m.rematch.add(id)); // the bot always says yes
    log(`${label(m)} ${nameOf(socket.id)} requested a rematch`);
    if (m.rematch.size === 2) {
      // Winner goes first; on a draw, pick at random
      const first = m.vsBot ? m.players.find(isBot) : m.winner || m.players[Math.floor(Math.random() * 2)];
      closeMatch(m);
      const nm = startMatch(m.players, first, false, m.id, m);
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
    if (!isBot(opp)) io.to(opp).emit("notice", `${me.name} left the match. You're back in the waiting room.`);
    closeMatch(m, [], [opp, socket.id]); // both go to the end of the line, so waiting players play next
    dropBots(m);
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

  // Exit: leave the game completely and go back to the first screen
  socket.on("quit", () => removePlayer(socket, "left the game"));

  // ---- Server (admin) screen ----
  socket.on("admin_join", () => {
    socket.join("admin");
    socket.emit("admin_state", { online: onlineList(), matches: allMatches().map((m) => publicMatch(m)), logs });
  });

  // Reset game & scores: one match (matchId) or all matches (no matchId)
  socket.on("admin_reset", (matchId) => {
    const list = matchId ? [matches.get(matchId)].filter(Boolean) : allMatches();
    if (list.length === 0) log("RESET: no match to reset");
    list.forEach(resetMatch);
    sync();
  });

  // Player closes the page
  socket.on("disconnect", () => {
    socketUser.delete(socket.id);
    removePlayer(socket, "disconnected");
  });
});

function removePlayer(socket, reason) {
  if (reason === "disconnected") rtts.delete(socket.id);
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
    if (!isBot(opp)) io.to(opp).emit("notice", `${c.name} left the game. You're back in the waiting room.`);
    log(`${label(m)} Match stopped because a player left`);
    closeMatch(m, [opp]); // the remaining player is first in line
    dropBots(m);
    tryStartMatches();
  }
  sync();
}

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Dup Me server is running on port ${PORT}`);
  console.log(`Server screen: http://localhost:${PORT}/server.html`);
});
