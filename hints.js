// ===============================================================
//  Smart hints for the guesser
//
//  A hint never gives the answer directly. The hint engine:
//   1. keeps track of which buttons are still possible for the current step
//      (everything already said in earlier hints is taken into account),
//   2. builds every kind of clue that is TRUE for the hidden pattern,
//   3. throws away clues that would leave only one possible button
//      (the first hint for a step always leaves at least 3 possibilities, a second one at least 2),
//   4. picks the clue that cuts the possibilities roughly in half, preferring a kind not used yet.
//
//  Hints use button POSITIONS (0, 1, 2, ...), so each player's screen shows them
//  with their own emoji set.
// ===============================================================

const range = (n) => [...Array(n).keys()];
const shuffle = (a) => { a = [...a]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };

// Every clue we could give about step `i`. Each has `allowed` = the buttons it leaves possible.
function cluesFor(pattern, i, n, hard, possible) {
  const target = pattern[i];
  const before = pattern.slice(0, i);
  const clues = [];

  // "Step 3 is NOT 🐷 or 🐮" — rule out about half of the remaining wrong buttons
  const wrong = shuffle([...possible].filter((b) => b !== target));
  const keep = Math.max(2, Math.ceil(possible.size / 2));
  const drop = wrong.slice(0, Math.max(0, possible.size - keep));
  if (drop.length) clues.push({ kind: "not", buttons: drop.sort((a, b) => a - b), allowed: range(n).filter((b) => !drop.includes(b)) });

  // "Step 3 repeats a button from earlier" / "Step 3 is a button that hasn't appeared yet"
  if (i > 0) {
    const seen = new Set(before);
    clues.push(seen.has(target)
      ? { kind: "earlier", allowed: [...seen] }
      : { kind: "new", allowed: range(n).filter((b) => !seen.has(b)) });
  }

  // "Step 3 is different from step 2"
  if (i > 0 && pattern[i - 1] !== target) {
    clues.push({ kind: "differs", from: i - 1, allowed: range(n).filter((b) => b !== pattern[i - 1]) });
  }

  // "Step 3's button appears 2 times in the whole pattern"
  const count = pattern.filter((b) => b === target).length;
  clues.push({ kind: "count", times: count, allowed: range(n).filter((b) => pattern.filter((x) => x === b).length === count) });

  // Where the button sits on screen (not in hard mode — the buttons move there)
  if (!hard) {
    if (n >= 6) {
      const cols = Math.ceil(n / 2);
      const top = target < cols;
      clues.push({ kind: "row", row: top ? "top" : "bottom", allowed: range(n).filter((b) => (b < cols) === top) });
    } else {
      const left = range(Math.ceil(n / 2)), right = range(n).slice(Math.floor(n / 2));
      const side = left.includes(target) ? "left" : "right";
      clues.push({ kind: "side", side, size: left.length, allowed: side === "left" ? left : right });
    }
  }
  return clues;
}

// m.hintLog: hints already given this turn ({ step, kind, allowed, ... })
function makeHint(m) {
  const n = m.buttons, hard = m.mode === "hard";
  const first = m.answer.length;

  // Try the current step first, then later steps if nothing useful can be said
  for (let i = first; i < m.pattern.length; i++) {
    const earlier = m.hintLog.filter((h) => h.step === i);
    let possible = new Set(range(n));
    for (const h of earlier) possible = new Set([...possible].filter((b) => h.allowed.includes(b)));
    const minLeft = earlier.length === 0 ? Math.min(3, n - 1) : 2;
    const goal = Math.max(minLeft, Math.ceil(possible.size / 2));
    const usedKinds = new Set(m.hintLog.map((h) => h.kind));

    const options = cluesFor(m.pattern, i, n, hard, possible)
      .map((c) => ({ ...c, left: c.allowed.filter((b) => possible.has(b)).length }))
      .filter((c) => c.left >= minLeft && c.left < possible.size); // must help, but must not give it away
    if (!options.length) continue;

    // Best = close to "half the possibilities", a kind not used yet this turn, plus some randomness for variety
    const score = (c) => Math.abs(c.left - goal) + (usedKinds.has(c.kind) ? 2 : 0) + (c.kind === "not" ? 0.5 : 0) + Math.random() * 1.5;
    options.forEach((c) => (c.score = score(c)));
    options.sort((a, b) => a.score - b.score);
    const { left, score: _, ...hint } = options[0];
    return { step: i, ...hint };
  }

  // Nothing step-specific left to say: a general clue about the whole pattern
  return { step: null, kind: "distinct", count: new Set(m.pattern).size, allowed: [] };
}

// What the players receive (the `allowed` list stays on the server)
const publicHint = ({ allowed, ...h }) => h;

module.exports = { makeHint, publicHint };
