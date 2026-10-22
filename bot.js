// ===============================================================
//  AI bot opponent
//
//  The bot plays through the same game rules as a person:
//   - as the creator it taps a random pattern at a human-like speed, then presses Done.
//     Patterns get one step longer each round, so a match vs the bot gets harder as it goes.
//   - as the guesser it "remembers" each step with some chance of forgetting.
//     Memory gets worse the longer the pattern is (like a real player),
//     and a forgotten step is a believable mistake: usually a button
//     that was elsewhere in the pattern.
// ===============================================================

const LEVELS = {
  easy:   { label: "Easy",   length: [3, 4], memory: 0.80, fade: 0.06, speed: [750, 1100] },
  normal: { label: "Normal", length: [4, 6], memory: 0.92, fade: 0.035, speed: [550, 850] },
  hard:   { label: "Hard",   length: [6, 9], memory: 0.99, fade: 0.012, speed: [380, 600] },
};

const rand = (a, b) => a + Math.random() * (b - a);
const randInt = (a, b) => Math.floor(rand(a, b + 1));

// Schedules the bot's presses. `act` = { press(index), done() } — the same actions a player's socket triggers.
// Returns the list of timers so the match can cancel them.
function playCreate(level, buttons, act, round = 1, maxLength = 10) {
  const L = LEVELS[level] || LEVELS.normal;
  const len = Math.min(maxLength, randInt(...L.length) + (round - 1));
  const timers = [];
  let t = rand(900, 1400); // "thinking" before the first tap
  let last = -1;
  for (let i = 0; i < len; i++) {
    let b = randInt(0, buttons - 1);
    if (b === last && Math.random() < 0.6) b = (b + randInt(1, buttons - 1)) % buttons; // fewer boring repeats
    last = b;
    timers.push(setTimeout(() => act.press(b), t));
    t += rand(...L.speed);
  }
  timers.push(setTimeout(() => act.done(), t + 300));
  return timers;
}

function playRepeat(level, pattern, buttons, act) {
  const L = LEVELS[level] || LEVELS.normal;
  const timers = [];
  let t = rand(1000, 1600);
  pattern.forEach((b, i) => {
    const remembers = Math.random() < L.memory - L.fade * i;
    let guess = b;
    if (!remembers) {
      const others = pattern.filter((x) => x !== b);
      guess = others.length && Math.random() < 0.7
        ? others[randInt(0, others.length - 1)]                 // mixed it up with another step
        : (b + randInt(1, buttons - 1)) % buttons;              // or just a wrong button
    }
    timers.push(setTimeout(() => act.press(guess), t));
    t += rand(...L.speed) * (remembers ? 1 : 1.6); // hesitates when unsure
  });
  return timers;
}

module.exports = { LEVELS, playCreate, playRepeat };
