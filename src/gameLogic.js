'use strict';

const CARDS = ['Admin', 'Trojan', 'Firewall', 'Phisher', 'Sniffer'];
const DECK_SIZE = 15; // always 3 of each card type

// Maximum number of adjacent same-type pairs tolerated before reshuffling.
// With 15 cards (3×5 types), a pure Fisher-Yates shuffle produces ~2 such pairs
// on average; rejecting results above this threshold reduces visible clustering
// while still allowing natural duplicates (e.g. two identical cards in a hand).
const MAX_ADJACENT_PAIRS = 2;
// How many shuffle attempts before giving up and accepting any result.
// P(accept on first try) ≈ 62 %, so 8 attempts succeeds in > 99.9 % of calls.
const MAX_SHUFFLE_ATTEMPTS = 8;

function createDeck() {
  const base = [];
  for (const card of CARDS) {
    base.push(card, card, card); // 3 of each = 15 total
  }
  let deck;
  let attempts = 0;
  do {
    deck = shuffle(base);
    attempts++;
  } while (attempts < MAX_SHUFFLE_ATTEMPTS && countAdjacentPairs(deck) > MAX_ADJACENT_PAIRS);
  return deck;
}

function countAdjacentPairs(deck) {
  return deck.reduce((n, c, i) => n + (i > 0 && c === deck[i - 1] ? 1 : 0), 0);
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function createPlayer(id, nick) {
  return {
    id,
    nick,
    hand: [],        // cards in hand (hidden from others)
    lives: [null, null], // 2 face-down identity cards
    livesRevealed: [false, false],
    crypto: 2,
    connected: true,
    eliminated: false,
  };
}

function dealInitialCards(game) {
  for (const player of game.players) {
    // Draw 2 cards — they serve as both hand (for bluffing) and lives.
    const card1 = drawCard(game);
    const card2 = drawCard(game);
    player.hand = [card1, card2];
    player.lives = [card1, card2];
  }
}

function drawCard(game) {
  if (game.deck.length === 0) return null; // safety fallback
  return game.deck.pop();
}

function createGame(roomId, players, options) {
  const n = players.length;
  const opts = options || {};
  // Core (DDoS) is disabled in 2-player games, or if host explicitly disabled it.
  // 5-6 player games require 4 charges instead of 3.
  const coreEnabled = opts.ddos === false ? false : n >= 3;
  const maxCharges = n >= 5 ? 4 : 3;

  const game = {
    roomId,
    players: players.map(p => createPlayer(p.id, p.nick)),
    deck: createDeck(),
    discardPile: [],
    eliminatedCards: [], // life cards that have been revealed/lost
    core: { charges: 0, maxCharges, crypto: 0, enabled: coreEnabled },
    currentPlayerIndex: Math.floor(Math.random() * n),
    phase: 'action',
    turnNumber: 0,
    pendingAction: null,
    pendingBlock: null,
    pendingContest: null,
    ddosAvailable: false,
    ddosUsedBy: [],        // playerIds that already used DDoS this game
    log: [],
    winner: null,
    waitingFor: [],        // playerIds we're waiting on
  };

  dealInitialCards(game);
  game.log.push('🔴 SYSTEM BREACH iniciado. Conexões estabelecidas.');
  advanceTurn(game);
  return game;
}

function advanceTurn(game) {
  game.phase = 'action';
  game.pendingAction = null;
  game.pendingBlock = null;
  game.pendingContest = null;
  game.waitingFor = [];

  // Check DDoS availability
  checkDDoS(game);

  const current = currentPlayer(game);
  game.log.push(`⚡ Turno de ${current.nick}`);

  // Check Rastro Digital (forced Global Breach)
  if (current.crypto >= 10) {
    game.phase = 'forced_global_breach';
    game.log.push(`⚠️ ${current.nick} tem ₵${current.crypto} — RASTRO DIGITAL! Global Breach obrigatório.`);
  }
}

function currentPlayer(game) {
  return game.players[game.currentPlayerIndex];
}

function nextTurn(game) {
  // If a previous elimination already ended the game, do NOT advance the turn.
  // advanceTurn() unconditionally sets phase='action', which would overwrite
  // the 'ended' phase set by checkWin() and prevent the server from detecting
  // the game-over state — causing the game to freeze in an infinite bot loop.
  if (game.phase === 'ended') return;

  let next = (game.currentPlayerIndex + 1) % game.players.length;
  let attempts = 0;
  while (game.players[next].eliminated && attempts < game.players.length) {
    next = (next + 1) % game.players.length;
    attempts++;
  }
  game.currentPlayerIndex = next;
  game.turnNumber++;
  advanceTurn(game);
  checkWin(game);
}

function checkWin(game) {
  const alive = game.players.filter(p => !p.eliminated);
  if (alive.length === 1) {
    game.winner = alive[0].id;
    game.phase = 'ended';
    game.log.push(`🏆 ${alive[0].nick} conquistou o ACESSO ROOT!`);
    alive[0].crypto += 1; // Prestige coin represented as extra crypto for now
  }
}

function getActivePlayers(game) {
  return game.players.filter(p => !p.eliminated);
}

// ─── ACTIONS ────────────────────────────────────────────────────────────────

function performAction(game, playerId, action) {
  const player = game.players.find(p => p.id === playerId);
  if (!player) return { error: 'Jogador não encontrado' };

  const curr = currentPlayer(game);
  if (curr.id !== playerId) return { error: 'Não é seu turno' };
  if (game.phase !== 'action' && game.phase !== 'forced_global_breach') {
    return { error: 'Ação não permitida nessa fase' };
  }

  const { type, targetId, card } = action;

  // Forced global breach
  if (game.phase === 'forced_global_breach' && type !== 'global_breach') {
    return { error: 'Você deve executar Global Breach (Rastro Digital ativo)' };
  }

  switch (type) {
    case 'income': {
      // Always available, no card needed, unblockable
      player.crypto += 1;
      game.log.push(`💰 ${player.nick} coletou ₵1 (Renda Básica)`);
      nextTurn(game);
      return { ok: true };
    }

    case 'foreign_aid': {
      // Collect ₵2, blockable by Admin
      game.pendingAction = { type: 'foreign_aid', actorId: playerId, card: null };
      game.phase = 'block';
      game.waitingFor = getActivePlayers(game)
        .filter(p => p.id !== playerId)
        .map(p => p.id);
      game.log.push(`📡 ${player.nick} solicita Ajuda Externa (₵2). Alguém bloqueia?`);
      return { ok: true };
    }

    case 'global_breach': {
      if (player.crypto < 7) return { error: 'Crypto insuficiente (precisa ₵7)' };
      if (!targetId) return { error: 'Selecione um alvo' };
      const target = game.players.find(p => p.id === targetId);
      if (!target || target.eliminated) return { error: 'Alvo inválido' };

      player.crypto -= 7;
      game.log.push(`💥 ${player.nick} executou GLOBAL BREACH em ${target.nick}!`);
      loseLife(game, target);
      nextTurn(game);
      return { ok: true };
    }

    // Card-based actions (can be bluffed)
    case 'mining': { // Admin
      game.pendingAction = { type: 'mining', actorId: playerId, card: card || 'Admin', cost: 0 };
      game.phase = 'block_or_contest';
      game.waitingFor = getActivePlayers(game).filter(p => p.id !== playerId).map(p => p.id);
      game.log.push(`⛏️ ${player.nick} ativa ADMIN — coleta ₵3.`);
      return { ok: true };
    }

    case 'injection': { // Trojan
      if (player.crypto < 3) return { error: 'Precisa de ₵3 para ativar o Trojan' };
      if (!targetId) return { error: 'Selecione um alvo' };
      const target = game.players.find(p => p.id === targetId);
      if (!target || target.eliminated) return { error: 'Alvo inválido' };

      game.pendingAction = { type: 'injection', actorId: playerId, targetId, card: card || 'Trojan', cost: 3 };
      game.phase = 'block_or_contest';
      game.waitingFor = getActivePlayers(game).filter(p => p.id !== playerId).map(p => p.id);
      game.log.push(`💉 ${player.nick} ativa TROJAN em ${target.nick}!`);
      return { ok: true };
    }

    case 'intercept': { // Phisher
      if (!targetId) return { error: 'Selecione um alvo' };
      const target = game.players.find(p => p.id === targetId);
      if (!target || target.eliminated) return { error: 'Alvo inválido' };

      game.pendingAction = { type: 'intercept', actorId: playerId, targetId, card: card || 'Phisher', cost: 0 };
      game.phase = 'block_or_contest';
      game.waitingFor = getActivePlayers(game).filter(p => p.id !== playerId).map(p => p.id);
      game.log.push(`🎣 ${player.nick} ativa INTERCEPTAÇÃO [Phisher] em ${target.nick}!`);
      return { ok: true };
    }

    case 'analysis': { // Sniffer
      game.pendingAction = { type: 'analysis', actorId: playerId, card: card || 'Sniffer', cost: 0 };
      game.phase = 'block_or_contest';
      game.waitingFor = getActivePlayers(game).filter(p => p.id !== playerId).map(p => p.id);
      game.log.push(`🔍 ${player.nick} ativa ANÁLISE [Sniffer].`);
      return { ok: true };
    }

    default:
      return { error: 'Ação desconhecida' };
  }
}

function respondToAction(game, playerId, response) {
  // response: { type: 'pass' | 'block' | 'contest', card? }
  if (!['block_or_contest', 'block', 'contest'].includes(game.phase)) {
    return { error: 'Nenhuma ação pendente para responder' };
  }

  const idx = game.waitingFor.indexOf(playerId);
  if (idx === -1) return { error: 'Não é sua vez de responder' };

  if (response.type === 'pass') {
    game.waitingFor.splice(idx, 1);
    if (game.waitingFor.length === 0) {
      // Everyone passed — resolve the action
      resolveAction(game);
    }
    return { ok: true };
  }

  if (response.type === 'block') {
    game.pendingBlock = { blockerId: playerId, card: response.card };
    game.phase = 'contest_block';
    // Now actor can contest the block or pass
    game.waitingFor = [game.pendingAction.actorId];
    const blocker = game.players.find(p => p.id === playerId);
    game.log.push(`🛡️ ${blocker.nick} tenta BLOQUEAR com [${response.card}]!`);
    return { ok: true };
  }

  if (response.type === 'contest') {
    // foreign_aid is unblockable by claim — it cannot be contested (no card is claimed)
    if (game.phase === 'block' && game.pendingAction?.type === 'foreign_aid') {
      return { error: 'Ajuda Externa não pode ser contestada, apenas bloqueada' };
    }
    // DDoS escalation — optionally attached to the contest
    const isDDoS = response.useDDoS === true;
    if (isDDoS) {
      if (!game.ddosAvailable) return { error: 'DDoS não disponível' };
      if ((game.ddosUsedBy || []).includes(playerId)) return { error: 'Você já usou o DDoS nesta partida' };
      if (!game.ddosUsedBy) game.ddosUsedBy = [];
      game.ddosUsedBy.push(playerId);
    }
    // Challenge the actor's claimed card
    startContest(game, playerId, game.pendingAction.actorId, game.pendingAction.card, 'action', isDDoS);
    return { ok: true };
  }

  return { error: 'Resposta inválida' };
}

function respondToBlock(game, playerId, response) {
  // Actor responds to a block
  if (game.phase !== 'contest_block') return { error: 'Fase incorreta' };
  if (game.waitingFor[0] !== playerId) return { error: 'Não é sua vez' };

  if (response.type === 'pass') {
    // Actor accepts the block — action fails, next turn
    game.log.push(`✅ Bloqueio aceito. Ação cancelada.`);
    nextTurn(game);
    return { ok: true };
  }

  if (response.type === 'contest') {
    // Actor contests the block — optionally with DDoS
    const isDDoS = response.useDDoS === true;
    if (isDDoS) {
      if (!game.ddosAvailable) return { error: 'DDoS não disponível' };
      if ((game.ddosUsedBy || []).includes(playerId)) return { error: 'Você já usou o DDoS nesta partida' };
      if (!game.ddosUsedBy) game.ddosUsedBy = [];
      game.ddosUsedBy.push(playerId);
    }
    startContest(game, playerId, game.pendingBlock.blockerId, game.pendingBlock.card, 'block', isDDoS);
    return { ok: true };
  }

  return { error: 'Resposta inválida' };
}

function startContest(game, contesterId, targetId, claimedCard, contestType, isDDoS = false) {
  game.pendingContest = { contesterId, targetId, claimedCard, contestType, isDDoS };
  game.phase = 'resolving_contest';

  const contester = game.players.find(p => p.id === contesterId);
  const target = game.players.find(p => p.id === targetId);

  if (!contester || !target) {
    const missing = !contester ? contesterId : targetId;
    game.log.push(`⚠️ Erro: jogador ${missing} não encontrado na contestação.`);
    nextTurn(game);
    return;
  }

  if (isDDoS) {
    game.log.push(`☢️ ${contester.nick} ativa PROTOCOLO DDoS na contestação!`);
  }

  // Check if target actually has the claimed card
  const hasCard = target.hand.includes(claimedCard);

  if (hasCard) {
    // Target was honest — contester loses
    game.lastReveal = { playerId: target.id, nick: target.nick, card: claimedCard };

    if (isDDoS) {
      game.log.push(`✅ ${target.nick} prova [${claimedCard}]! ☢️ ${contester.nick} é ELIMINADO pelo DDoS!`);
      eliminatePlayerDDoS(game, contester);
      // Winner collects core crypto
      const pot = game.core.crypto;
      target.crypto += pot;
      if (pot > 0) game.log.push(`☢️ ${target.nick} coleta ₵${pot} do Núcleo!`);
      resetCore(game);
    } else {
      game.log.push(`✅ ${target.nick} prova [${claimedCard}]! ${contester.nick} perde 1 vida.`);
      loseLife(game, contester);
      // Deduct penalty coin from player (does NOT go to core)
      if (contester.crypto > 0) contester.crypto -= 1;
    }

    // Target shuffles card back and draws new one
    const cardIdx = target.hand.indexOf(claimedCard);
    target.hand.splice(cardIdx, 1);
    game.deck.push(claimedCard);
    game.deck = shuffle(game.deck);
    const newCard = drawCard(game);
    if (newCard) {
      target.hand.push(newCard);
      // Keep lives in sync — update the matching unrevealed life card
      const lifeSwapIdx = target.lives.findIndex((c, i) => c === claimedCard && !target.livesRevealed[i]);
      if (lifeSwapIdx !== -1) target.lives[lifeSwapIdx] = newCard;
    }

    if (contestType === 'block') {
      game.log.push(`🛡️ Bloqueio confirmado. Ação cancelada.`);
      nextTurn(game);
    } else {
      resolveAction(game);
    }
  } else {
    // Target was lying — target loses
    if (isDDoS) {
      game.log.push(`❌ ${target.nick} estava mentindo! ☢️ ${target.nick} é ELIMINADO pelo DDoS!`);
      eliminatePlayerDDoS(game, target);
      // Winner (contester) collects core crypto
      const pot = game.core.crypto;
      contester.crypto += pot;
      if (pot > 0) game.log.push(`☢️ ${contester.nick} coleta ₵${pot} do Núcleo!`);
      resetCore(game);
    } else {
      game.log.push(`❌ ${target.nick} estava mentindo! Perde 1 vida.`);
      loseLife(game, target);
      if (target.crypto > 0) target.crypto -= 1;
    }

    if (contestType === 'block') {
      resolveAction(game);
    } else {
      nextTurn(game);
    }
  }

  checkDDoS(game);
  checkWin(game);
}


function loseLife(game, player) {
  const lifeIdx = player.livesRevealed.findIndex(r => !r);
  if (lifeIdx === -1) {
    eliminatePlayer(game, player);
    return;
  }
  player.livesRevealed[lifeIdx] = true;
  const card = player.lives[lifeIdx];
  game.eliminatedCards.push(card);
  // Remove the lost card from hand (no longer usable for bluffing)
  const handIdx = player.hand.indexOf(card);
  if (handIdx !== -1) player.hand.splice(handIdx, 1);
  game.log.push(`💀 ${player.nick} perdeu 1 vida: [${card}]!`);

  // Every life lost charges the core by 1 (capped at maxCharges)
  if (game.core.enabled !== false) {
    game.core.charges = Math.min(game.core.charges + 1, game.core.maxCharges);
    game.core.crypto  = Math.min(game.core.crypto  + 1, game.core.maxCharges);
    checkDDoS(game);
  }

  if (player.livesRevealed.every(r => r)) {
    eliminatePlayer(game, player);
  }
}

function eliminatePlayerDDoS(game, player) {
  // DDoS elimination — reveal ALL remaining lives, crypto goes to bank
  for (let i = 0; i < player.livesRevealed.length; i++) {
    if (!player.livesRevealed[i]) {
      player.livesRevealed[i] = true;
      if (player.lives[i]) {
        game.eliminatedCards.push(player.lives[i]);
      }
    }
  }
  player.hand = []; // clear hand — all cards are now revealed/eliminated
  player.crypto = 0;
  player.eliminated = true;
  game.log.push(`☠️ ${player.nick} foi DESCONECTADO da rede pelo DDoS!`);
  checkWin(game);
}

function resetCore(game) {
  game.core.crypto = 0;
  game.core.charges = 0;
  game.ddosAvailable = false;
}

function eliminatePlayer(game, player) {
  player.eliminated = true;
  // Coins go back to bank (just disappear)
  game.log.push(`☠️ ${player.nick} foi DESCONECTADO da rede!`);
  checkWin(game);
}

function checkDDoS(game) {
  game.ddosAvailable = game.core.enabled !== false && game.core.charges >= game.core.maxCharges;
}

function resolveAction(game) {
  const action = game.pendingAction;
  if (!action) { nextTurn(game); return; }

  const actor = game.players.find(p => p.id === action.actorId);
  if (!actor) { nextTurn(game); return; }

  switch (action.type) {
    case 'foreign_aid': {
      actor.crypto += 2;
      game.log.push(`📡 ${actor.nick} recebeu Ajuda Externa: +₵2`);
      break;
    }
    case 'mining': {
      actor.crypto += 3;
      game.log.push(`⛏️ ${actor.nick} coletou ₵3 com o Admin!`);
      break;
    }
    case 'injection': {
      const target = game.players.find(p => p.id === action.targetId);
      if (!target) { break; }
      actor.crypto -= action.cost;
      if (target.eliminated) {
        // Target was already eliminated during a contest — skip the extra loseLife
        game.log.push(`💉 Trojan cancelado: ${target.nick} já foi eliminado.`);
      } else {
        game.log.push(`💉 Trojan executado! ${target.nick} perde 1 carta.`);
        loseLife(game, target);
      }
      break;
    }
    case 'intercept': {
      const target = game.players.find(p => p.id === action.targetId);
      if (!target) { break; }
      const stolen = Math.min(target.crypto, 2);
      target.crypto -= stolen;
      actor.crypto += stolen;
      game.log.push(`🎣 ${actor.nick} roubou ₵${stolen} de ${target.nick}!`);
      break;
    }
    case 'analysis': {
      // Sniffer — actor sees top 2 cards
      const top2 = game.deck.slice(-2);
      game.pendingAction = { ...action, snifferCards: top2 };
      game.phase = 'sniffer_choice';
      game.waitingFor = [actor.id];
      game.log.push(`🔍 ${actor.nick} analisa o deck...`);
      return; // Don't advance turn yet
    }
  }

  if (game.phase !== 'ended') checkWin(game);
  nextTurn(game);
}

function resolveSnifferChoice(game, playerId, choice) {
  // choice: { swap: boolean, deckCardIndex?: 0|1, handCardIndex?: 0|1 }
  if (game.phase !== 'sniffer_choice') return { error: 'Fase incorreta' };
  const actor = game.players.find(p => p.id === playerId);
  if (!actor) return { error: 'Jogador não encontrado' };

  if (choice.swap) {
    const topCards = game.deck.slice(-2);
    if (topCards.length === 0) {
      // Edge case: empty deck — just give +₵1
      actor.crypto += 1;
      game.log.push(`🔍 ${actor.nick} — deck vazio, +₵1`);
    } else {
      const deckIdx = typeof choice.deckCardIndex === 'number' ? choice.deckCardIndex : 0;
      const handIdx = typeof choice.handCardIndex === 'number' ? choice.handCardIndex : 0;
      const safeHandIdx = handIdx < actor.hand.length ? handIdx : 0;

      const deckCard = topCards[Math.min(deckIdx, topCards.length - 1)];

      // Remove chosen deck card (index 1 = last element, index 0 = second-to-last)
      if (deckIdx === 1) game.deck.pop();
      else game.deck.splice(game.deck.length - 2, 1);

      // Swap: replace the chosen hand card with the deck card
      const oldHandCard = actor.hand[safeHandIdx];
      actor.hand[safeHandIdx] = deckCard;
      game.deck.push(oldHandCard);
      game.deck = shuffle(game.deck);
      // Keep lives in sync — update the matching unrevealed life card
      const lifeSwapIdx = actor.lives.findIndex((c, i) => c === oldHandCard && !actor.livesRevealed[i]);
      if (lifeSwapIdx !== -1) actor.lives[lifeSwapIdx] = deckCard;
      game.log.push(`🔍 ${actor.nick} trocou [${oldHandCard}] pelo [${deckCard}] do deck.`);
    }
  } else {
    // No swap — gain ₵1 bonus (Otimização)
    actor.crypto += 1;
    game.log.push(`🔍 ${actor.nick} não trocou — Otimização: +₵1`);
  }

  nextTurn(game);
  return { ok: true };
}

function triggerDDoS(game, triggererId) {
  // DDoS is now activated as part of a contestation (Duvidar + DDoS).
  // Standalone trigger is no longer supported.
  return { error: 'DDoS agora é ativado junto com uma contestação (Duvidar + DDoS)' };
}

// ─── SANITIZE FOR CLIENT ────────────────────────────────────────────────────

function getStateForPlayer(game, playerId) {
  return {
    roomId: game.roomId,
    phase: game.phase,
    turnNumber: game.turnNumber,
    core: game.core,
    ddosAvailable: game.ddosAvailable,
    myDdosUsed: (game.ddosUsedBy || []).includes(playerId),
    currentPlayerId: currentPlayer(game)?.id,
    pendingAction: game.pendingAction ? {
      type: game.pendingAction.type,
      actorId: game.pendingAction.actorId,
      targetId: game.pendingAction.targetId,
      card: game.pendingAction.card,
      // Only show sniffer cards to the sniffer player
      snifferCards: game.pendingAction.actorId === playerId ? game.pendingAction.snifferCards : undefined,
    } : null,
    pendingBlock: game.pendingBlock,
    waitingFor: game.waitingFor,
    winner: game.winner,
    log: game.log,
    deckSize: game.deck.length,
    eliminatedCards: game.eliminatedCards || [],
    players: game.players.map(p => ({
      id: p.id,
      nick: p.nick,
      crypto: p.crypto,
      eliminated: p.eliminated,
      connected: p.connected,
      livesRevealed: p.livesRevealed,
      lives: p.livesRevealed.map((revealed, i) => revealed ? p.lives[i] : null),
      livesCount: p.livesRevealed.filter(r => !r).length,
      // Only show own hand
      hand: p.id === playerId ? p.hand : p.hand.map(() => '?'),
      handCount: p.hand.length,
    })),
  };
}

function autoPassWaiting(g, playerId) {
  if (!g.waitingFor.includes(playerId)) return {error:'Não aguardando este jogador'};
  return respondToAction(g, playerId, {type:'pass'});
}

module.exports = {
  createGame,
  performAction,
  respondToAction,
  respondToBlock,
  resolveSnifferChoice,
  triggerDDoS,
  getStateForPlayer,
  getActivePlayers,
  autoPassWaiting,
};
