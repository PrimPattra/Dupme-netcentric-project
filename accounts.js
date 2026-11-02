// ===============================================================
//  Accounts: sign up / log in, saved stats and saved settings
//  Everything is stored in data/users.json next to server.js
// ===============================================================
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const DATA_DIR = path.join(__dirname, "data");
const FILE = path.join(DATA_DIR, "users.json");

// Tables have no prototype, so names like "constructor" are just ordinary keys
const table = (rows) => Object.assign(Object.create(null), rows);

let db = { users: table(), sessions: table() }; // users: key (lowercase name) -> user, sessions: token -> key

function load() {
  try {
    const saved = JSON.parse(fs.readFileSync(FILE, "utf8"));
    db = { users: table(saved.users), sessions: table(saved.sessions) };
  } catch {
    db = { users: table(), sessions: table() }; // first run: no file yet
  }
}

// Write to a temp file first, then rename, so a crash never leaves a half-written file
let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
    fs.renameSync(tmp, FILE);
  }, 200);
}

const emptyStats = () => ({
  played: 0, wins: 0, losses: 0, draws: 0,
  botPlayed: 0, botWins: 0, hardWins: 0,
  rounds: 0, correctSteps: 0, perfectRounds: 0, hintsUsed: 0,
  streak: 0, bestStreak: 0, bestScore: 0, xp: 0,
});

// Level from XP: level 2 at 20 XP, level 3 at 60, level 4 at 120, ...
function levelOf(xp) {
  let level = 1;
  while (xp >= 10 * level * (level + 1)) level++;
  const from = 10 * (level - 1) * level, to = 10 * level * (level + 1);
  return { level, levelFrom: from, levelTo: to };
}

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 32).toString("hex");
}

// Name: 3–12 letters/numbers/underscore (Thai letters allowed). Password: at least 4 characters.
const NAME_RE = /^[A-Za-z0-9_฀-๿]{3,12}$/;

function signup(name, password) {
  name = String(name || "").trim();
  password = String(password || "");
  if (!NAME_RE.test(name)) return { error: "Username must be 3–12 letters, numbers or _" };
  if (password.length < 4) return { error: "Password must be at least 4 characters" };
  const key = name.toLowerCase();
  if (db.users[key]) return { error: "That username is taken" };
  const salt = crypto.randomBytes(16).toString("hex");
  db.users[key] = { name, salt, hash: hashPassword(password, salt), created: Date.now(), stats: emptyStats(), prefs: {} };
  return { token: newSession(key), user: publicUser(key) };
}

function login(name, password) {
  const key = String(name || "").trim().toLowerCase();
  const u = db.users[key];
  if (!u) return { error: "Wrong username or password" };
  const attempt = Buffer.from(hashPassword(String(password || ""), u.salt), "hex");
  if (!crypto.timingSafeEqual(attempt, Buffer.from(u.hash, "hex"))) return { error: "Wrong username or password" };
  return { token: newSession(key), user: publicUser(key) };
}

function newSession(key) {
  const token = crypto.randomBytes(24).toString("hex");
  db.sessions[token] = key;
  save();
  return token;
}

function logout(token) {
  if (db.sessions[token]) { delete db.sessions[token]; save(); }
}

// Returns the user key for a saved login token (or null)
function keyFromToken(token) {
  const key = db.sessions[String(token || "")];
  return key && db.users[key] ? key : null;
}

function publicUser(key) {
  const u = db.users[key];
  if (!u) return null;
  return { name: u.name, stats: { ...u.stats, ...levelOf(u.stats.xp) }, prefs: u.prefs };
}

// Settings the player can save (theme, emoji set, sound, etc.)
function savePrefs(key, prefs) {
  const u = db.users[key];
  if (!u || typeof prefs !== "object" || !prefs) return;
  const clean = {};
  if (Array.isArray(prefs.emojis)) clean.emojis = prefs.emojis.slice(0, 8).map((e) => String(e).slice(0, 16));
  for (const k of ["theme", "voice", "mode", "avatar"]) if (typeof prefs[k] === "string") clean[k] = prefs[k].slice(0, 20);
  if (Number.isInteger(prefs.buttons)) clean.buttons = prefs.buttons;
  if (typeof prefs.music === "boolean") clean.music = prefs.music;
  u.prefs = { ...u.prefs, ...clean };
  save();
}

// After each turn where this user was the guesser
function recordTurn(key, { correct, length, hints }) {
  const s = db.users[key]?.stats;
  if (!s) return;
  s.rounds++;
  s.correctSteps += correct;
  s.hintsUsed += hints;
  if (length > 0 && correct === length) s.perfectRounds++;
  s.xp += correct;
  save();
}

// After each finished match. result: "win" | "loss" | "draw"
function recordMatch(key, { result, score, vsBot, hard }) {
  const s = db.users[key]?.stats;
  if (!s) return;
  s.played++;
  if (vsBot) s.botPlayed++;
  if (result === "win") {
    s.wins++; s.streak++; s.xp += 5;
    if (vsBot) s.botWins++;
    if (hard) { s.hardWins++; s.xp += 3; }
  } else if (result === "loss") { s.losses++; s.streak = 0; }
  else { s.draws++; s.xp += 2; }
  s.bestStreak = Math.max(s.bestStreak, s.streak);
  s.bestScore = Math.max(s.bestScore, score);
  save();
}

load();
module.exports = { signup, login, logout, keyFromToken, publicUser, savePrefs, recordTurn, recordMatch };
