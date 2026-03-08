'use strict';
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const multer = require('multer');

const rateLimit = require('express-rate-limit');
const db = require('./src/db');
const game = require('./src/gameLogic');
const botLogic = require('./src/botLogic');

const JWT_SECRET = process.env.JWT_SECRET || 'systembreach_jwt_secret_change_me_2024';
const TURN_TIMEOUT_MS = 45000; // 45 seconds
const RESPOND_TIMEOUT_MS = 15000; // 15 seconds for block/contest window

// Card image upload config
const CARD_IMAGES_DIR = path.join(__dirname, 'public', 'card-images');
const VALID_CARD_TYPES = ['Admin', 'Trojan', 'Firewall', 'Phisher', 'Sniffer', 'Back'];
if (!fs.existsSync(CARD_IMAGES_DIR)) fs.mkdirSync(CARD_IMAGES_DIR, { recursive: true });

const cardImageStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, CARD_IMAGES_DIR),
  filename: (req, file, cb) => {
    const type = req.params.type;
    cb(null, `${type}.png`);
  },
});
const cardImageUpload = multer({
  storage: cardImageStorage,
  limits: { fileSize: 4 * 1024 * 1024 }, // 4 MB max
  fileFilter: (req, file, cb) => {
    if (file.mimetype !== 'image/png') return cb(new Error('Apenas PNG é permitido'));
    cb(null, true);
  },
});

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.set('trust proxy', 1);
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/admin', express.static(path.join(__dirname, 'public/admin')));

const activeGames = new Map();   // roomId -> gameState
const clientMap = new Map();     // ws -> { playerId, roomId }
const playerSockets = new Map(); // playerId -> ws
const onlinePlayers = new Map(); // playerId -> { nick, since }
const turnTimers = new Map();    // roomId -> { timer, startedAt, playerId, allowedMs }
const gameStartTimes = new Map();// roomId -> Date
const pauseVotes = new Map();    // roomId -> Set<playerId>
const gamePaused = new Map();    // roomId -> { until, timer, savedRemainingMs }
const simulatedGames = new Map();// simId  -> { game, interval, stuckCount, startedAt, speed }
const simSpectators = new Map(); // simId  -> Set<ws>  (admin observers)
const botRooms = new Map();      // roomId -> { bots: [{id,nick}], difficulty, tickTimer }

// Returns the ID of the player whose turn it currently is (works on the raw game object).
function getGameCurrentPlayerId(g) {
  return g.players[g.currentPlayerIndex]?.id;
}

// Returns the minimum number of alive-player votes needed to trigger a pause.
function computePauseNeeded(g) {
  const alive = game.getActivePlayers(g).length;
  return Math.floor(alive / 2) + 1;
}

// ── JWT ──────────────────────────────────────────────────────────────────────
function signToken(p, rememberMe) { return jwt.sign({id:p.id,nick:p.nick,role:p.role}, JWT_SECRET, {expiresIn:rememberMe?'30d':'7d'}); }
function verifyToken(t) { try { return jwt.verify(t, JWT_SECRET); } catch { return null; } }
function authMiddleware(req, res, next) {
  const t = (req.headers.authorization||'').replace('Bearer ','');
  const p = verifyToken(t);
  if (!p) return res.status(401).json({error:'Não autenticado'});
  req.user = p; next();
}
function adminMiddleware(req, res, next) {
  authMiddleware(req, res, () => {
    if (req.user.role !== 'admin') return res.status(403).json({error:'Acesso negado'});
    next();
  });
}

// ── AUTH ROUTES ───────────────────────────────────────────────────────────────
app.post('/api/register', async (req,res) => {
  const r = await db.registerPlayer(req.body.nick, req.body.password);
  if (r.error) return res.status(400).json(r);
  res.json({token:signToken(r,false), player:r});
});
app.post('/api/login', async (req,res) => {
  const r = await db.loginPlayer(req.body.nick, req.body.password);
  if (r.error) return res.status(401).json(r);
  res.json({token:signToken(r,req.body.rememberMe), player:r});
});
app.post('/api/change-password', authMiddleware, async (req,res) => {
  const r = await db.changePassword(req.user.id, req.body.oldPassword, req.body.newPassword);
  if (r.error) return res.status(400).json(r);
  res.json(r);
});
app.get('/api/me', authMiddleware, (req,res) => {
  const p = db.getPlayer(req.user.id);
  if (!p) return res.status(404).json({error:'Não encontrado'});
  res.json(p);
});
app.get('/api/my-history', authMiddleware, (req,res) => {
  res.json(db.getPlayerHistory(req.user.id, 20));
});

// ── GAME ROUTES ───────────────────────────────────────────────────────────────
app.get('/api/leaderboard', (req,res) => res.json(db.getLeaderboard()));

// ── ADMIN ROUTES ──────────────────────────────────────────────────────────────
app.get('/api/admin/stats', adminMiddleware, (req,res) => {
  const s = db.getStats(); s.onlineNow = onlinePlayers.size; res.json(s);
});
app.get('/api/admin/players', adminMiddleware, (req,res) => {
  res.json(db.getAllPlayers().map(p=>({...p, online:onlinePlayers.has(p.id)})));
});
app.post('/api/admin/players/:id/ban', adminMiddleware, (req,res) => {
  if (req.body.banned) { const ws=playerSockets.get(req.params.id); if(ws){ws.send(JSON.stringify({type:'banned'}));ws.close();} }
  res.json(db.banPlayer(req.params.id, req.body.banned));
});
app.post('/api/admin/players/:id/reset-password', adminMiddleware, async (req,res) => {
  res.json(await db.adminResetPassword(req.params.id, req.body.newPassword));
});
app.delete('/api/admin/players/:id', adminMiddleware, (req,res) => {
  const ws=playerSockets.get(req.params.id); if(ws){ws.send(JSON.stringify({type:'account_deleted'}));ws.close();}
  res.json(db.deletePlayer(req.params.id));
});
app.get('/api/admin/rooms', adminMiddleware, (req,res) => {
  res.json(db.getAllRooms().map(r=>({...r, isActive:activeGames.has(r.id)})));
});
app.post('/api/admin/rooms/:id/close', adminMiddleware, (req,res) => {
  broadcast(req.params.id,'room_closed',{message:'Sala encerrada pelo administrador.'});
  clearTurnTimer(req.params.id);
  const pi = gamePaused.get(req.params.id);
  if (pi) { clearTimeout(pi.timer); gamePaused.delete(req.params.id); }
  pauseVotes.delete(req.params.id);
  activeGames.delete(req.params.id);
  db.closeRoom(req.params.id);
  res.json({ok:true});
});
app.get('/api/admin/history', adminMiddleware, (req,res) => res.json(db.getGameHistory(50)));
app.get('/api/admin/online', adminMiddleware, (req,res) => {
  res.json(Array.from(onlinePlayers.entries()).map(([id,info])=>({id,...info})));
});

// ── CARD IMAGE ROUTES ──────────────────────────────────────────────────────────
// Rate limiter for card image reads (public endpoint)
const cardImageReadLimit = rateLimit({
  windowMs: 60_000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Muitas requisições. Aguarde um momento.' },
});
// Rate limiter for card image writes (admin-only upload/delete)
const cardImageWriteLimit = rateLimit({
  windowMs: 60_000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Muitas requisições. Aguarde um momento.' },
});

// Public: list current card images (returns which types have custom images)
app.get('/api/card-images', cardImageReadLimit, (req,res) => {
  const result = {};
  for (const type of VALID_CARD_TYPES) {
    const p = path.join(CARD_IMAGES_DIR, `${type}.png`);
    result[type] = fs.existsSync(p) ? `/card-images/${type}.png?v=${fs.statSync(p).mtimeMs}` : null;
  }
  res.json(result);
});

// Admin: upload a card image
app.post('/api/admin/card-images/:type', cardImageWriteLimit, adminMiddleware, (req, res, next) => {
  const type = req.params.type;
  if (!VALID_CARD_TYPES.includes(type)) return res.status(400).json({ error: 'Tipo inválido' });
  cardImageUpload.single('image')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'Nenhum arquivo enviado' });
    const url = `/card-images/${type}.png?v=${Date.now()}`;
    res.json({ ok: true, url });
  });
});

// Admin: delete a card image (revert to default)
app.delete('/api/admin/card-images/:type', cardImageWriteLimit, adminMiddleware, (req, res) => {
  const type = req.params.type;
  if (!VALID_CARD_TYPES.includes(type)) return res.status(400).json({ error: 'Tipo inválido' });
  const p = path.join(CARD_IMAGES_DIR, `${type}.png`);
  if (fs.existsSync(p)) fs.unlinkSync(p);
  res.json({ ok: true });
});

// ── BROADCAST ─────────────────────────────────────────────────────────────────
function broadcast(roomId, type, data, excludeId=null) {
  for (const [ws, info] of clientMap) {
    if (info.roomId===roomId && info.playerId!==excludeId && ws.readyState===WebSocket.OPEN)
      ws.send(JSON.stringify({type,...data}));
  }
}

function broadcastGameState(roomId, gOverride) {
  const g = gOverride || activeGames.get(roomId);
  if (!g) return;
  const startTime = gameStartTimes.get(roomId);
  const matchDuration = startTime ? Math.floor((Date.now() - startTime) / 1000) : 0;
  const pauseInfo = gamePaused.get(roomId);

  for (const [ws, info] of clientMap) {
    if (info.roomId===roomId && ws.readyState===WebSocket.OPEN) {
      const state = game.getStateForPlayer(g, info.playerId);
      // Timer info
      const timerInfo = turnTimers.get(roomId);
      if (timerInfo) {
        const elapsed = Date.now() - timerInfo.startedAt;
        const allowedMs = timerInfo.allowedMs || TURN_TIMEOUT_MS;
        if (pauseInfo) {
          // Frozen: show saved remaining time
          state.timerSeconds = Math.ceil((pauseInfo.savedRemainingMs || 0) / 1000);
        } else {
          state.timerSeconds = Math.max(0, Math.ceil((allowedMs - elapsed) / 1000));
        }
        state.timerTotalSeconds = Math.floor(allowedMs / 1000);
        state.timerPlayerId = timerInfo.playerId;
      } else {
        state.timerSeconds = null;
      }
      state.matchDuration = matchDuration;
      // Pause info
      state.paused = pauseInfo
        ? { secondsLeft: Math.max(0, Math.ceil((pauseInfo.until - Date.now()) / 1000)) }
        : null;
      const votes = pauseVotes.get(roomId);
      state.pauseVotes = votes
        ? { count: votes.size, needed: computePauseNeeded(g) }
        : null;
      ws.send(JSON.stringify({type:'game_state', state}));
    }
  }
}

function broadcastReveal(roomId, g) {
  if (!g.lastReveal) return;
  const { playerId, nick, card } = g.lastReveal;
  broadcast(roomId, 'notification', {
    nick,
    action: `✅ PROVOU [${card}]!`,
    type: 'reveal',
    playerId,
    card,
  });
  g.lastReveal = null;
}

// ── TURN TIMER ────────────────────────────────────────────────────────────────
const RESPOND_PHASES = ['block_or_contest', 'block', 'contest', 'contest_block'];

function autoPassTurn(roomId, playerId) {
  const gameState = activeGames.get(roomId);
  if (!gameState || gameState.phase === 'ended') return;
  const currId = getGameCurrentPlayerId(gameState);
  if (currId === playerId && (gameState.phase === 'action' || gameState.phase === 'forced_global_breach')) {
    if (gameState.phase === 'forced_global_breach') {
      const targets = game.getActivePlayers(gameState).filter(p => p.id !== playerId);
      if (targets.length > 0) {
        game.performAction(gameState, playerId, {type:'global_breach', targetId:targets[0].id});
      }
    } else {
      game.performAction(gameState, playerId, {type:'income'});
    }
    broadcast(roomId, 'notification', {
      nick: gameState.players.find(p=>p.id===playerId)?.nick||'?',
      action:'⏱️ Tempo esgotado — Renda automática',
      type:'timeout',
    });
  } else if (RESPOND_PHASES.includes(gameState.phase)) {
    // Intervention window expired — auto-pass all waiting players
    const waitingIds = [...gameState.waitingFor];
    let passed = false;
    for (const wid of waitingIds) {
      if (!gameState.waitingFor.includes(wid)) continue;
      const r = game.autoPassWaiting(gameState, wid);
      if (!r?.error) { checkGameEnd(roomId, gameState); passed = true; }
      if (!RESPOND_PHASES.includes(gameState.phase)) break;
    }
    if (passed) {
      broadcast(roomId, 'notification', {
        nick: '⏱️',
        action: 'Tempo de resposta esgotado — ação resolvida',
        type: 'timeout',
      });
    }
  } else if (gameState.phase === 'sniffer_choice') {
    // Sniffer choice timed out — auto-resolve with no swap (resolveSnifferChoice grants +₵1)
    const actorId = gameState.pendingAction?.actorId;
    if (actorId && gameState.waitingFor.includes(actorId)) {
      game.resolveSnifferChoice(gameState, actorId, { swap: false });
      broadcast(roomId, 'notification', {
        nick: '⏱️',
        action: 'Tempo de análise esgotado — otimização automática',
        type: 'timeout',
      });
    }
  } else {
    const result = game.autoPassWaiting(gameState, playerId);
    if (!result?.error) checkGameEnd(roomId, gameState);
  }
  checkGameEnd(roomId, gameState);
  turnTimers.delete(roomId);
  if (gameState.phase !== 'ended') {
    const nextId = getGameCurrentPlayerId(gameState);
    if (nextId) {
      const ms = RESPOND_PHASES.includes(gameState.phase) ? RESPOND_TIMEOUT_MS : TURN_TIMEOUT_MS;
      startTurnTimer(roomId, nextId, ms);
    }
    // If bots need to act next, schedule a bot tick
    if (botRooms.has(roomId)) scheduleBotTick(roomId);
  }
  broadcastGameState(roomId, gameState);
}

function startTurnTimer(roomId, playerId, allowedMs = TURN_TIMEOUT_MS) {
  clearTurnTimer(roomId);
  const startedAt = Date.now();
  const timer = setTimeout(() => autoPassTurn(roomId, playerId), allowedMs);
  turnTimers.set(roomId, {timer, startedAt, playerId, allowedMs});
}

function clearTurnTimer(roomId) {
  const t = turnTimers.get(roomId);
  if (t) { clearTimeout(t.timer); turnTimers.delete(roomId); }
}

// ── BOT VS PLAYER GAME ROOMS ──────────────────────────────────────────────────
const BOT_TICK_MS = 900; // delay between bot moves in player-vs-bot games

function scheduleBotTick(roomId) {
  const br = botRooms.get(roomId);
  if (!br) return;
  clearTimeout(br.tickTimer);
  br.tickTimer = setTimeout(() => botRoomTick(roomId), BOT_TICK_MS);
}

function botRoomTick(roomId) {
  const br = botRooms.get(roomId);
  if (!br) return;
  const g = activeGames.get(roomId);
  if (!g || g.phase === 'ended') { botRooms.delete(roomId); return; }

  const { bots, difficulty } = br;
  const isBotId = id => bots.some(b => b.id === id);
  let progress = false;

  try {
    if (g.phase === 'action' || g.phase === 'forced_global_breach') {
      const currId = g.players[g.currentPlayerIndex]?.id;
      if (currId && isBotId(currId)) {
        const actor = g.players.find(p => p.id === currId);
        if (actor && !actor.eliminated) {
          const action = botLogic.pickAction(g, actor, difficulty);
          const r = game.performAction(g, currId, action);
          if (r?.error) game.performAction(g, currId, { type: 'income' });
          broadcast(roomId, 'notification', {
            nick: actor.nick,
            action: getActionLabel(action.type, action.targetId, g),
            type: action.type,
            actorId: currId,
            targetId: action.targetId || null,
          });
          progress = true;
        }
      }
    } else if (['block_or_contest', 'block', 'contest'].includes(g.phase)) {
      for (const pid of [...g.waitingFor]) {
        if (!g.waitingFor.includes(pid) || !isBotId(pid)) continue;
        const resp = botLogic.pickResponse(g, pid, difficulty);
        const r = game.respondToAction(g, pid, resp);
        if (r?.error) game.respondToAction(g, pid, { type: 'pass' });
        if (resp.type === 'block') {
          broadcast(roomId, 'notification', {
            nick: g.players.find(p => p.id === pid)?.nick || '?',
            action: '🛡️ BLOQUEOU! [' + resp.card + ']',
            type: 'block',
            blockerId: pid,
            actorId: g.pendingAction?.actorId || null,
          });
        }
        progress = true;
        if (!['block_or_contest', 'block', 'contest'].includes(g.phase)) break;
      }
    } else if (g.phase === 'contest_block') {
      const actorId = g.pendingAction?.actorId;
      if (actorId && g.waitingFor.includes(actorId) && isBotId(actorId)) {
        const resp = botLogic.pickBlockResponse(difficulty, g, actorId);
        const r = game.respondToBlock(g, actorId, resp);
        if (r?.error) game.respondToBlock(g, actorId, { type: 'pass' });
        progress = true;
      }
    } else if (g.phase === 'sniffer_choice') {
      const actorId = g.pendingAction?.actorId;
      if (actorId && g.waitingFor.includes(actorId) && isBotId(actorId)) {
        const choice = botLogic.pickSnifferChoice(g, actorId, difficulty);
        game.resolveSnifferChoice(g, actorId, choice);
        progress = true;
      }
    }
  } catch (e) {
    console.error('[botRoom] tick error:', e.message);
  }

  if (progress) {
    broadcastReveal(roomId, g);
    clearTurnTimer(roomId);
    checkGameEnd(roomId, g);
    if (g.phase !== 'ended') {
      const nextId = getGameCurrentPlayerId(g);
      if (nextId) {
        const ms = RESPOND_PHASES.includes(g.phase) ? RESPOND_TIMEOUT_MS : TURN_TIMEOUT_MS;
        startTurnTimer(roomId, nextId, ms);
        if (isBotId(nextId)) scheduleBotTick(roomId);
      }
    } else {
      botRooms.delete(roomId);
    }
    broadcastGameState(roomId, g);
  } else if (g.phase !== 'ended') {
    // Still waiting on bots in a non-action phase — retry shortly
    const stillBotWaiting = g.waitingFor.some(id => isBotId(id));
    if (stillBotWaiting) scheduleBotTick(roomId);
  }
}

// ── SIMULATION ────────────────────────────────────────────────────────────────
const BOT_NICKS = ['Alpha','Beta','Gamma','Delta','Epsilon','Zeta'];
const SIM_SPEEDS = { slow: 2000, normal: 800, fast: 200 };
const SIM_CLEANUP_DELAY_MS = 60_000;  // keep finished simulation state visible for 60s
const SIM_MAX_STUCK_TICKS  = 8;       // force income after this many ticks with no progress

// Simple per-IP rate limiter for simulation endpoints (admin-only, extra safety)
const simRateLimit = rateLimit({
  windowMs: 60_000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Muitas requisições. Aguarde um momento.' },
});

function buildSimSpectatorState(simId) {
  const sim = simulatedGames.get(simId);
  if (!sim) return null;
  const g = sim.game;
  const currPlayer = g.players[g.currentPlayerIndex];
  return {
    type: 'sim_state',
    simId,
    phase: g.phase,
    turnNumber: g.turnNumber,
    currentPlayerId: currPlayer?.id || null,
    currentPlayerNick: currPlayer?.nick || '—',
    core: g.core,
    ddosAvailable: g.ddosAvailable,
    deckSize: g.deck.length,
    eliminatedCards: g.eliminatedCards || [],
    winner: g.winner ? g.players.find(p => p.id === g.winner)?.nick : null,
    log: g.log.slice(-40),
    elapsed: Math.floor((Date.now() - sim.startedAt) / 1000),
    running: sim.interval !== null,
    players: g.players.map(p => ({
      id: p.id,
      nick: p.nick,
      crypto: p.crypto,
      eliminated: p.eliminated,
      connected: p.connected,
      livesRevealed: p.livesRevealed,
      lives: p.lives,   // spectator can see all in simulation
      hand: p.hand,
      handCount: p.hand.length,
    })),
  };
}

function broadcastToSimSpectators(simId) {
  const spectators = simSpectators.get(simId);
  if (!spectators || spectators.size === 0) return;
  const state = buildSimSpectatorState(simId);
  if (!state) return;
  const msg = JSON.stringify(state);
  const stale = [];
  for (const ws of spectators) {
    if (ws.readyState === WebSocket.OPEN) ws.send(msg);
    else stale.push(ws);
  }
  stale.forEach(ws => spectators.delete(ws));
}

function simTick(simId) {
  const sim = simulatedGames.get(simId);
  if (!sim) return;
  const g = sim.game;

  if (g.phase === 'ended') {
    clearInterval(sim.interval);
    sim.interval = null;
    setTimeout(() => simulatedGames.delete(simId), SIM_CLEANUP_DELAY_MS);
    return;
  }

  const currId = g.players[g.currentPlayerIndex]?.id;
  let progress = false;

  try {
    if (g.phase === 'action' || g.phase === 'forced_global_breach') {
      const actor = g.players.find(p => p.id === currId);
      if (actor && !actor.eliminated) {
        const action = botLogic.pickAction(g, actor);
        const r = game.performAction(g, currId, action);
        if (r?.error) game.performAction(g, currId, { type: 'income' });
        progress = true;
      }

    } else if (['block_or_contest', 'block', 'contest'].includes(g.phase)) {
      const waiting = [...g.waitingFor];
      for (const pid of waiting) {
        if (!g.waitingFor.includes(pid)) continue; // already removed by earlier response
        const resp = botLogic.pickResponse(g, pid);
        const r = game.respondToAction(g, pid, resp);
        if (r?.error) game.respondToAction(g, pid, { type: 'pass' });
        progress = true;
        // If phase changed (block or contest fired), stop iterating — next tick handles it
        if (!['block_or_contest', 'block', 'contest'].includes(g.phase)) break;
      }

    } else if (g.phase === 'contest_block') {
      const actorId = g.pendingAction?.actorId;
      if (actorId && g.waitingFor.includes(actorId)) {
        const resp = botLogic.pickBlockResponse('normal', g, actorId);
        const r = game.respondToBlock(g, actorId, resp);
        if (r?.error) game.respondToBlock(g, actorId, { type: 'pass' });
        progress = true;
      }

    } else if (g.phase === 'sniffer_choice') {
      const actorId = g.pendingAction?.actorId;
      if (actorId && g.waitingFor.includes(actorId)) {
        const choice = botLogic.pickSnifferChoice(g, actorId);
        game.resolveSnifferChoice(g, actorId, choice);
        progress = true;
      }
    }

    if (progress) {
      sim.stuckCount = 0;
    } else {
      sim.stuckCount = (sim.stuckCount || 0) + 1;
      if (sim.stuckCount >= SIM_MAX_STUCK_TICKS && currId) {
        game.performAction(g, currId, { type: 'income' });
        sim.stuckCount = 0;
      }
    }
  } catch (e) {
    console.error('[sim] tick error:', e.message);
  }

  // Push state to any admin spectators watching this simulation
  broadcastToSimSpectators(simId);
}

// Start a new simulation
app.post('/api/admin/simulate/start', simRateLimit, adminMiddleware, (req, res) => {
  const botCount = Math.min(6, Math.max(2, parseInt(req.body.botCount) || 3));
  const speed = ['slow', 'normal', 'fast'].includes(req.body.speed) ? req.body.speed : 'normal';
  const simId = uuidv4();

  const bots = Array.from({ length: botCount }, (_, i) => ({
    id: `bot-${i}-${simId.slice(0, 6)}`,
    nick: `Bot_${BOT_NICKS[i]}`,
  }));

  const g = game.createGame(simId, bots);
  const intervalMs = SIM_SPEEDS[speed];
  const interval = setInterval(() => simTick(simId), intervalMs);
  simulatedGames.set(simId, { game: g, bots, interval, stuckCount: 0, startedAt: Date.now(), speed });

  res.json({ simId, bots: bots.map(b => b.nick), speed, intervalMs });
});

// Get current state of a simulation
app.get('/api/admin/simulate/:id', simRateLimit, adminMiddleware, (req, res) => {
  const sim = simulatedGames.get(req.params.id);
  if (!sim) return res.status(404).json({ error: 'Simulação não encontrada' });
  const g = sim.game;
  const currPlayer = g.players[g.currentPlayerIndex];
  res.json({
    simId: req.params.id,
    speed: sim.speed,
    elapsed: Math.floor((Date.now() - sim.startedAt) / 1000),
    running: sim.interval !== null,
    phase: g.phase,
    turnNumber: g.turnNumber,
    currentPlayerNick: currPlayer?.nick || '—',
    core: g.core,
    ddosAvailable: g.ddosAvailable,
    deckSize: g.deck.length,
    eliminatedCards: g.eliminatedCards || [],
    winner: g.winner ? g.players.find(p => p.id === g.winner)?.nick : null,
    log: g.log.slice(-25),
    players: g.players.map(p => ({
      nick: p.nick,
      crypto: p.crypto,
      eliminated: p.eliminated,
      livesRevealed: p.livesRevealed,
      lives: p.lives,          // show all in simulation
      hand: p.hand,
    })),
  });
});

// List all active simulations
app.get('/api/admin/simulate', simRateLimit, adminMiddleware, (req, res) => {
  const list = Array.from(simulatedGames.entries()).map(([id, sim]) => ({
    simId: id,
    speed: sim.speed,
    elapsed: Math.floor((Date.now() - sim.startedAt) / 1000),
    running: sim.interval !== null,
    phase: sim.game.phase,
    playerCount: sim.bots.length,
    winner: sim.game.winner
      ? sim.game.players.find(p => p.id === sim.game.winner)?.nick
      : null,
  }));
  res.json(list);
});

// Stop / delete a simulation
app.delete('/api/admin/simulate/:id', simRateLimit, adminMiddleware, (req, res) => {
  const sim = simulatedGames.get(req.params.id);
  if (!sim) return res.status(404).json({ error: 'Simulação não encontrada' });
  clearInterval(sim.interval);
  simulatedGames.delete(req.params.id);
  res.json({ ok: true });
});

// ── WEBSOCKET ─────────────────────────────────────────────────────────────────
wss.on('connection', (ws) => {
  ws.on('message', (raw) => {
    let msg; try { msg=JSON.parse(raw); } catch { return; }
    const {type, payload} = msg;

    switch (type) {

      case 'auth': {
        const decoded = verifyToken(payload?.token);
        if (!decoded) { ws.send(JSON.stringify({type:'error',message:'Token inválido. Faça login novamente.'})); return; }
        const player = db.getPlayer(decoded.id);
        if (!player) { ws.send(JSON.stringify({type:'error',message:'Conta não encontrada.'})); return; }
        if (player.banned) { ws.send(JSON.stringify({type:'banned'})); return; }
        clientMap.set(ws, {playerId:player.id, roomId:null});
        playerSockets.set(player.id, ws);
        onlinePlayers.set(player.id, {nick:player.nick, since:new Date().toISOString()});
        ws.send(JSON.stringify({type:'authenticated', player}));
        break;
      }

      case 'create_room': {
        const info = clientMap.get(ws);
        if (!info?.playerId) return;
        const {maxPlayers=6, password=null} = payload||{};
        const room = db.createRoom(info.playerId, maxPlayers, password||null);
        info.roomId = room.id;
        // Don't send password back
        const safeRoom = {...room, password:undefined};
        ws.send(JSON.stringify({type:'room_joined', room:safeRoom}));
        break;
      }

      case 'join_room': {
        const info = clientMap.get(ws);
        if (!info?.playerId) return;
        const roomData = db.getRoomByCode(payload.code);
        if (!roomData) { ws.send(JSON.stringify({type:'error',message:'Sala não encontrada'})); return; }
        const result = db.joinRoom(roomData.id, info.playerId, payload.password||null);
        if (result.error) { ws.send(JSON.stringify({type:'error',message:result.error})); return; }
        info.roomId = result.id;
        const safeRoom = {...result, password:undefined};
        ws.send(JSON.stringify({type:'room_joined', room:safeRoom}));
        broadcast(result.id, 'room_update', {room:{...result,password:undefined}}, info.playerId);
        break;
      }

      case 'leave_room': {
        const info = clientMap.get(ws);
        if (!info?.roomId) return;
        const updated = db.leaveRoom(info.roomId, info.playerId);
        if (updated) broadcast(updated.id,'room_update',{room:{...updated,password:undefined}});
        info.roomId = null;
        ws.send(JSON.stringify({type:'left_room'}));
        break;
      }

      case 'start_game': {
        const info = clientMap.get(ws);
        if (!info?.roomId) return;
        const room = db.getRoom(info.roomId);
        if (!room||room.host_id!==info.playerId) { ws.send(JSON.stringify({type:'error',message:'Apenas o host pode iniciar'})); return; }
        if (room.players.length<2) { ws.send(JSON.stringify({type:'error',message:'Mínimo 2 jogadores'})); return; }
        db.setRoomStatus(room.id,'playing');
        const g = game.createGame(room.id, room.players);
        activeGames.set(room.id, g);
        gameStartTimes.set(room.id, Date.now());
        broadcast(room.id,'game_started',{});
        // Start timer for first player, then broadcast with timer info included
        startTurnTimer(room.id, getGameCurrentPlayerId(g));
        broadcastGameState(room.id);
        break;
      }

      case 'play_vs_bots': {
        const info = clientMap.get(ws);
        if (!info?.playerId) return;
        const botCount = Math.min(5, Math.max(1, parseInt(payload?.botCount) || 1));
        const difficulty = ['easy','normal','hard'].includes(payload?.difficulty) ? payload.difficulty : 'normal';
        const diffLabel = { easy: '🟢', normal: '🟡', hard: '🔴' }[difficulty] || '';

        // Create bots (in-memory only — not stored in DB)
        const bots = Array.from({ length: botCount }, (_, i) => ({
          id: `bot-${i}-${Date.now().toString(36)}`,
          nick: `${diffLabel}Bot_${BOT_NICKS[i]}`,
        }));

        // Create a private room for the human
        const room = db.createRoom(info.playerId, botCount + 1, null);
        info.roomId = room.id;

        // Build full player list: human first, then bots
        const allPlayers = [...room.players, ...bots];

        // Start game immediately
        db.setRoomStatus(room.id, 'playing');
        const g = game.createGame(room.id, allPlayers);
        activeGames.set(room.id, g);
        gameStartTimes.set(room.id, Date.now());

        // Track bot room with difficulty
        botRooms.set(room.id, { bots, difficulty, tickTimer: null });

        // Notify human: room joined → game started
        const safeRoom = { ...room, players: allPlayers, password: undefined };
        ws.send(JSON.stringify({ type: 'room_joined', room: safeRoom }));
        ws.send(JSON.stringify({ type: 'game_started' }));
        const firstId = getGameCurrentPlayerId(g);
        if (firstId) {
          startTurnTimer(room.id, firstId);
          if (bots.some(b => b.id === firstId)) scheduleBotTick(room.id);
        }
        broadcastGameState(room.id);
        break;
      }

      case 'rematch': {
        const info = clientMap.get(ws);
        if (!info?.playerId) return;
        // Find the old room this player was in (by checking game history or just create new)
        const oldRoomId = payload?.roomId;
        if (!oldRoomId) return;
        // Create new room with same players list from old game
        const oldGame = payload?.players; // sent by client
        const newRoom = db.createRoom(info.playerId, oldGame?.length||6, null);
        info.roomId = newRoom.id;
        ws.send(JSON.stringify({type:'room_joined', room:{...newRoom,password:undefined}}));
        break;
      }

      case 'game_action': {
        const info = clientMap.get(ws);
        if (!info?.roomId) return;
        const g = activeGames.get(info.roomId);
        if (!g) return;
        const result = game.performAction(g, info.playerId, payload);
        if (result.error) { ws.send(JSON.stringify({type:'error',message:result.error})); return; }
        // Broadcast action notification to all
        broadcast(info.roomId,'notification',{
          nick: g.players.find(p=>p.id===info.playerId)?.nick||'?',
          action: getActionLabel(payload.type, payload.targetId, g),
          type: payload.type,
          actorId: info.playerId,
          targetId: payload.targetId||null,
        });
        clearTurnTimer(info.roomId);
        checkGameEnd(info.roomId, g);
        if (g.phase!=='ended') {
          const ms = RESPOND_PHASES.includes(g.phase) ? RESPOND_TIMEOUT_MS : TURN_TIMEOUT_MS;
          startTurnTimer(info.roomId, getGameCurrentPlayerId(g), ms);
        }
        broadcastGameState(info.roomId, g);
        if (g.phase!=='ended' && botRooms.has(info.roomId)) scheduleBotTick(info.roomId);
        break;
      }

      case 'game_respond': {
        const info = clientMap.get(ws);
        if (!info?.roomId) return;
        const g = activeGames.get(info.roomId);
        if (!g) return;
        const result = game.respondToAction(g, info.playerId, payload);
        if (result.error) { ws.send(JSON.stringify({type:'error',message:result.error})); return; }
        // Notify block
        if (payload.type==='block') {
          broadcast(info.roomId,'notification',{
            nick: g.players.find(p=>p.id===info.playerId)?.nick||'?',
            action: '🛡️ BLOQUEOU! ['+payload.card+']',
            type: 'block',
            blockerId: info.playerId,
            actorId: g.pendingAction?.actorId||null,
          });
        }
        broadcastReveal(info.roomId, g);
        clearTurnTimer(info.roomId);
        checkGameEnd(info.roomId, g);
        if (g.phase!=='ended') {
          const ms = RESPOND_PHASES.includes(g.phase) ? RESPOND_TIMEOUT_MS : TURN_TIMEOUT_MS;
          startTurnTimer(info.roomId, getGameCurrentPlayerId(g), ms);
        }
        broadcastGameState(info.roomId, g);
        if (g.phase!=='ended' && botRooms.has(info.roomId)) scheduleBotTick(info.roomId);
        break;
      }

      case 'game_respond_block': {
        const info = clientMap.get(ws);
        if (!info?.roomId) return;
        const g = activeGames.get(info.roomId);
        if (!g) return;
        const result = game.respondToBlock(g, info.playerId, payload);
        if (result.error) { ws.send(JSON.stringify({type:'error',message:result.error})); return; }
        broadcastReveal(info.roomId, g);
        clearTurnTimer(info.roomId);
        checkGameEnd(info.roomId, g);
        if (g.phase!=='ended') {
          const ms = RESPOND_PHASES.includes(g.phase) ? RESPOND_TIMEOUT_MS : TURN_TIMEOUT_MS;
          startTurnTimer(info.roomId, getGameCurrentPlayerId(g), ms);
        }
        broadcastGameState(info.roomId, g);
        if (g.phase!=='ended' && botRooms.has(info.roomId)) scheduleBotTick(info.roomId);
        break;
      }

      case 'sniffer_choice': {
        const info = clientMap.get(ws);
        if (!info?.roomId) return;
        const g = activeGames.get(info.roomId);
        if (!g) return;
        const result = game.resolveSnifferChoice(g, info.playerId, payload);
        if (result.error) { ws.send(JSON.stringify({type:'error',message:result.error})); return; }
        clearTurnTimer(info.roomId);
        if (g.phase!=='ended') startTurnTimer(info.roomId, getGameCurrentPlayerId(g));
        broadcastGameState(info.roomId);
        if (g.phase!=='ended' && botRooms.has(info.roomId)) scheduleBotTick(info.roomId);
        break;
      }

      case 'trigger_ddos': {
        const info = clientMap.get(ws);
        if (!info?.roomId) return;
        const g = activeGames.get(info.roomId);
        if (!g) return;
        const result = game.triggerDDoS(g, info.playerId);
        if (result.error) { ws.send(JSON.stringify({type:'error',message:result.error})); return; }
        clearTurnTimer(info.roomId);
        checkGameEnd(info.roomId, g);
        if (g.phase!=='ended') startTurnTimer(info.roomId, getGameCurrentPlayerId(g));
        broadcastGameState(info.roomId, g);
        if (g.phase!=='ended' && botRooms.has(info.roomId)) scheduleBotTick(info.roomId);
        break;
      }

      case 'extend_turn': {
        const info = clientMap.get(ws);
        if (!info?.roomId) return;
        const g = activeGames.get(info.roomId);
        if (!g || g.phase === 'ended') return;
        const currId = getGameCurrentPlayerId(g);
        if (currId !== info.playerId) { ws.send(JSON.stringify({type:'error',message:'Não é seu turno'})); return; }
        const player = g.players.find(p => p.id === info.playerId);
        if (!player || player.crypto < 1) {
          ws.send(JSON.stringify({type:'error',message:'Crypto insuficiente (₵1 para +30s)'})); return;
        }
        player.crypto -= 1;
        g.core.crypto += 1; // fee goes to core
        const timerInfo = turnTimers.get(info.roomId);
        if (timerInfo) {
          clearTimeout(timerInfo.timer);
          timerInfo.allowedMs += 30000;
          const elapsed = Date.now() - timerInfo.startedAt;
          const remaining = Math.max(1000, timerInfo.allowedMs - elapsed);
          const pid = timerInfo.playerId;
          timerInfo.timer = setTimeout(() => autoPassTurn(info.roomId, pid), remaining);
        }
        broadcast(info.roomId,'notification',{nick:player.nick,action:'⏱️ +30s no turno (₵1)',type:'timeout'});
        broadcastGameState(info.roomId);
        break;
      }

      case 'vote_pause': {
        const info = clientMap.get(ws);
        if (!info?.roomId) return;
        const g = activeGames.get(info.roomId);
        if (!g || g.phase === 'ended') return;
        if (gamePaused.get(info.roomId)) {
          ws.send(JSON.stringify({type:'error',message:'Jogo já está pausado'})); return;
        }
        const player = g.players.find(p => p.id === info.playerId);
        if (!player || player.eliminated) return;
        if (!pauseVotes.has(info.roomId)) pauseVotes.set(info.roomId, new Set());
        const votes = pauseVotes.get(info.roomId);
        votes.add(info.playerId);
        const needed = computePauseNeeded(g);
        broadcast(info.roomId,'pause_vote_update',{votes:votes.size,needed,total:game.getActivePlayers(g).length});
        if (votes.size >= needed) {
          pauseVotes.delete(info.roomId);
          // Freeze turn timer
          const timerInfo = turnTimers.get(info.roomId);
          let savedRemainingMs = 0;
          if (timerInfo) {
            clearTimeout(timerInfo.timer);
            const elapsed = Date.now() - timerInfo.startedAt;
            savedRemainingMs = Math.max(0, (timerInfo.allowedMs || TURN_TIMEOUT_MS) - elapsed);
          }
          const PAUSE_DURATION_MS = 30000;
          const until = Date.now() + PAUSE_DURATION_MS;
          const pauseTimer = setTimeout(() => {
            gamePaused.delete(info.roomId);
            broadcast(info.roomId,'game_resumed',{});
            // Resume turn timer with remaining time
            const ti = turnTimers.get(info.roomId);
            if (ti) {
            // Resume turn timer: backdate startedAt so that (allowedMs - elapsed) == savedRemainingMs
              ti.startedAt = Date.now() - ((ti.allowedMs || TURN_TIMEOUT_MS) - savedRemainingMs);
              const pid = ti.playerId;
              ti.timer = setTimeout(() => autoPassTurn(info.roomId, pid), Math.max(1000, savedRemainingMs));
            }
            broadcastGameState(info.roomId);
          }, PAUSE_DURATION_MS);
          gamePaused.set(info.roomId, {until, timer:pauseTimer, savedRemainingMs});
          broadcast(info.roomId,'game_paused',{duration:30});
          broadcastGameState(info.roomId);
        } else {
          broadcastGameState(info.roomId);
        }
        break;
      }

      case 'chat': {
        const info = clientMap.get(ws);
        if (!info?.roomId) return;
        const player = db.getPlayer(info.playerId);
        broadcast(info.roomId,'chat',{from:player?.nick||'?',text:(payload.text||'').slice(0,200)});
        break;
      }

      case 'spectate_sim': {
        // Admin observer attaches to a simulated game.
        // No auth token required for the WS message (admin already authenticated via HTTP
        // to start the sim — this is read-only broadcast).
        const sid = payload?.simId;
        if (!sid || !simulatedGames.has(sid)) {
          ws.send(JSON.stringify({type:'error',message:'Simulação não encontrada'}));
          return;
        }
        // Register this ws as a spectator for this sim
        if (!simSpectators.has(sid)) simSpectators.set(sid, new Set());
        simSpectators.get(sid).add(ws);
        // Track on the ws itself so we can clean up on close
        ws._watchingSimId = sid;
        // Immediately send current state
        const initState = buildSimSpectatorState(sid);
        if (initState) ws.send(JSON.stringify(initState));
        break;
      }
    }
  });

  ws.on('close', () => {
    const info = clientMap.get(ws);
    if (info) {
      onlinePlayers.delete(info.playerId);
      playerSockets.delete(info.playerId);
      if (info.roomId) {
        const g = activeGames.get(info.roomId);
        if (g) { const gp=g.players.find(p=>p.id===info.playerId); if(gp) gp.connected=false; broadcastGameState(info.roomId); }
        // Clean up bot room if the only human leaves
        const br = botRooms.get(info.roomId);
        if (br) { clearTimeout(br.tickTimer); botRooms.delete(info.roomId); }
      }
    }
    clientMap.delete(ws);
    // Clean up spectator registration
    if (ws._watchingSimId) {
      const sp = simSpectators.get(ws._watchingSimId);
      if (sp) sp.delete(ws);
    }
  });
});

function getActionLabel(type, targetId, g) {
  const target = targetId ? g.players.find(p=>p.id===targetId)?.nick : null;
  const labels = {
    income: '💰 Renda (+₵1)',
    foreign_aid: '📡 Ajuda Externa (+₵2)',
    global_breach: target ? `💥 GLOBAL BREACH → ${target}` : '💥 Global Breach',
    mining: '⛏️ Mineração [Admin]',
    injection: target ? `💉 Injeção [Trojan] → ${target}` : '💉 Injeção',
    intercept: target ? `🎣 Interceptação [Phisher] → ${target}` : '🎣 Interceptação',
    analysis: '🔍 Análise [Sniffer]',
  };
  return labels[type] || type;
}

function checkGameEnd(roomId, g) {
  if (g.phase==='ended'&&g.winner) {
    clearTurnTimer(roomId);
    const pi = gamePaused.get(roomId);
    if (pi) { clearTimeout(pi.timer); gamePaused.delete(roomId); }
    pauseVotes.delete(roomId);
    const startTime = gameStartTimes.get(roomId)||Date.now();
    const duration = Math.floor((Date.now()-startTime)/1000);
    // Only record stats for real (non-bot) players
    const br = botRooms.get(roomId);
    const botIds = new Set(br ? br.bots.map(b => b.id) : []);
    const humanPlayerIds = g.players.map(p => p.id).filter(id => !botIds.has(id));
    const winnerId = botIds.has(g.winner) ? null : g.winner;
    if (winnerId) {
      db.saveGameResult(roomId, winnerId, humanPlayerIds, duration);
    } else if (humanPlayerIds.length > 0) {
      // Bot won — still record game played for humans (no win credited)
      db.recordGamePlayed(humanPlayerIds);
    }
    db.setRoomStatus(roomId,'finished');
    activeGames.delete(roomId);
    gameStartTimes.delete(roomId);
    if (br) { clearTimeout(br.tickTimer); botRooms.delete(roomId); }
  }
}

const PORT = process.env.PORT;
if (!PORT) {
  console.error(
    '❌  Variável de ambiente PORT não definida.\n' +
    '    • Com PM2: edite ecosystem.config.js e defina env.PORT, depois: pm2 restart system-breach\n' +
    '    • Direto:  PORT=3000 node server.js'
  );
  process.exit(1);
}

db.init().then(() => {
  // Bind explicitly to 0.0.0.0 (IPv4) to avoid EOPNOTSUPP on servers
  // where IPv6 is disabled — without a host Node tries '::' (IPv6) first.
  server.listen(Number(PORT), '0.0.0.0', () =>
    console.log(`🔴 System Breach v4 on port ${PORT}`)
  );
}).catch(err => { console.error('DB init failed:', err); process.exit(1); });
