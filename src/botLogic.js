'use strict';

// ── Helpers ───────────────────────────────────────────────────────────────────

function weightedPick(opts) {
  const total = opts.reduce((s, o) => s + o.w, 0);
  let r = Math.random() * total;
  for (const o of opts) { r -= o.w; if (r <= 0) return o.action; }
  return opts[0].action;
}

function weakestTarget(players) {
  return players.reduce((a, b) =>
    b.livesRevealed.filter(r => r).length > a.livesRevealed.filter(r => r).length ? b : a);
}

function richestTarget(players) {
  return players.reduce((a, b) => b.crypto > a.crypto ? b : a);
}

function globalBreachAt(others) {
  const weak = others.filter(t => t.livesRevealed.filter(r => r).length === 1);
  const pool = weak.length > 0 ? weak : others;
  const t = pool[Math.floor(Math.random() * pool.length)];
  return { type: 'global_breach', targetId: t.id };
}

// ── ACTION PICKER ─────────────────────────────────────────────────────────────

function pickAction(game, player, difficulty = 'normal') {
  if (!player || player.eliminated) return { type: 'income' };

  const others = game.players.filter(p => !p.eliminated && p.id !== player.id);
  if (others.length === 0) return { type: 'income' };

  // Forced Global Breach at ₵10 (all difficulties)
  if (player.crypto >= 10) return globalBreachAt(others);

  if (difficulty === 'easy') {
    // Easy: never uses optional global breach, ignores card synergy, very passive
    if (player.crypto >= 7 && Math.random() < 0.10) return globalBreachAt(others);
    const opts = [
      { action: { type: 'income' },       w: 40 },
      { action: { type: 'foreign_aid' },  w: 30 },
      { action: { type: 'mining',   card: 'Admin' },  w: 15 },
      { action: { type: 'analysis', card: 'Sniffer' }, w: 10 },
    ];
    if (player.crypto >= 3) {
      opts.push({ action: { type: 'injection', card: 'Trojan', targetId: others[Math.floor(Math.random()*others.length)].id }, w: 5 });
    }
    return weightedPick(opts);
  }

  if (difficulty === 'hard') {
    // Hard: opportunistic global breach much more likely, smart targeting, always uses known cards
    if (player.crypto >= 7 && Math.random() < 0.80) return globalBreachAt(others);
    const hand = player.hand || [];
    const opts = [
      { action: { type: 'income' },                                                                 w: 5  },
      { action: { type: 'foreign_aid' },                                                            w: 12 },
      { action: { type: 'mining',    card: 'Admin'   },                                             w: hand.includes('Admin')   ? 45 : 20 },
      { action: { type: 'intercept', card: 'Phisher', targetId: richestTarget(others).id },         w: hand.includes('Phisher') ? 38 : 18 },
      { action: { type: 'analysis',  card: 'Sniffer' },                                             w: hand.includes('Sniffer') ? 32 : 12 },
    ];
    if (player.crypto >= 3) {
      opts.push({
        action: { type: 'injection', card: 'Trojan', targetId: weakestTarget(others).id },
        w: hand.includes('Trojan') ? 42 : 22,
      });
    }
    return weightedPick(opts);
  }

  // Normal (original behaviour)
  if (player.crypto >= 7 && Math.random() < 0.40) return globalBreachAt(others);
  const hand = player.hand || [];
  const opts = [
    { action: { type: 'income' },                                                            w: 10 },
    { action: { type: 'foreign_aid' },                                                       w: 18 },
    { action: { type: 'mining',    card: 'Admin'   },                                        w: hand.includes('Admin')   ? 32 : 18 },
    { action: { type: 'intercept', card: 'Phisher', targetId: richestTarget(others).id },   w: hand.includes('Phisher') ? 26 : 14 },
    { action: { type: 'analysis',  card: 'Sniffer' },                                        w: hand.includes('Sniffer') ? 24 : 10 },
  ];
  if (player.crypto >= 3) {
    opts.push({
      action: { type: 'injection', card: 'Trojan', targetId: weakestTarget(others).id },
      w: hand.includes('Trojan') ? 30 : 16,
    });
  }
  return weightedPick(opts);
}

// ── RESPONSE PICKER ───────────────────────────────────────────────────────────

const BLOCK_MAP = {
  foreign_aid: ['Admin'],
  injection:   ['Firewall'],
  intercept:   ['Sniffer', 'Phisher'],
  mining:      [],
  analysis:    [],
  global_breach: [],
};

function pickResponse(game, playerId, difficulty = 'normal') {
  const action = game.pendingAction;
  if (!action) return { type: 'pass' };

  const canBlock = BLOCK_MAP[action.type] || [];
  const canDDoS = game.ddosAvailable && !(game.ddosUsedBy || []).includes(playerId);
  const r = Math.random();

  if (difficulty === 'easy') {
    // Easy: almost always passes, rarely blocks, never contests
    if (r < 0.05) return { type: 'contest', useDDoS: canDDoS && Math.random() < 0.05 };
    if (r < 0.13 && canBlock.length > 0) {
      const card = canBlock[Math.floor(Math.random() * canBlock.length)];
      return { type: 'block', card };
    }
    return { type: 'pass' };
  }

  if (difficulty === 'hard') {
    // Hard: contests more often, blocks aggressively when possible
    if (r < 0.28) return { type: 'contest', useDDoS: canDDoS && Math.random() < 0.50 };
    if (r < 0.72 && canBlock.length > 0) {
      const card = canBlock[Math.floor(Math.random() * canBlock.length)];
      return { type: 'block', card };
    }
    return { type: 'pass' };
  }

  // Normal: ~15% contest, ~25% block, ~60% pass
  if (r < 0.15) return { type: 'contest', useDDoS: canDDoS && Math.random() < 0.20 };
  if (r < 0.40 && canBlock.length > 0) {
    const card = canBlock[Math.floor(Math.random() * canBlock.length)];
    return { type: 'block', card };
  }
  return { type: 'pass' };
}

// Actor responds to a block
function pickBlockResponse(difficulty = 'normal', game = null, playerId = null) {
  const canDDoS = game && game.ddosAvailable && !(game.ddosUsedBy || []).includes(playerId);
  if (difficulty === 'easy')   return Math.random() < 0.10 ? { type: 'contest', useDDoS: canDDoS && Math.random() < 0.05 } : { type: 'pass' };
  if (difficulty === 'hard')   return Math.random() < 0.58 ? { type: 'contest', useDDoS: canDDoS && Math.random() < 0.50 } : { type: 'pass' };
  // Normal: ~35% contest
  return Math.random() < 0.35 ? { type: 'contest', useDDoS: canDDoS && Math.random() < 0.20 } : { type: 'pass' };
}

// ── SNIFFER PICKER ────────────────────────────────────────────────────────────

const SNIFFER_SKIP_SWAP_PROB = { easy: 0.70, normal: 0.35, hard: 0.20 };

function pickSnifferChoice(game, playerId, difficulty = 'normal') {
  const actor = game.players.find(p => p.id === playerId);
  if (!actor || actor.hand.length === 0) return { swap: false };
  const topCards = game.deck.slice(-2);
  const skipProb = SNIFFER_SKIP_SWAP_PROB[difficulty] ?? 0.35;
  if (topCards.length === 0 || Math.random() < skipProb) return { swap: false };
  return {
    swap: true,
    deckCardIndex: Math.floor(Math.random() * topCards.length),
    handCardIndex: Math.floor(Math.random() * actor.hand.length),
  };
}

module.exports = { pickAction, pickResponse, pickBlockResponse, pickSnifferChoice };
