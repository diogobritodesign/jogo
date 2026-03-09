'use strict';
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcryptjs');

const DB_PATH = path.join(__dirname, '..', 'data', 'breach.db');
const dataDir = path.dirname(DB_PATH);
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

let db;

async function init() {
  const initSqlJs = require('sql.js');
  const SQL = await initSqlJs();
  db = fs.existsSync(DB_PATH) ? new SQL.Database(fs.readFileSync(DB_PATH)) : new SQL.Database();

  db.run(`
    CREATE TABLE IF NOT EXISTS players (
      id TEXT PRIMARY KEY,
      nick TEXT UNIQUE NOT NULL,
      nick_lower TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL DEFAULT '',
      role TEXT DEFAULT 'player',
      banned INTEGER DEFAULT 0,
      games_played INTEGER DEFAULT 0,
      games_won INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      last_seen TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS rooms (
      id TEXT PRIMARY KEY,
      code TEXT UNIQUE NOT NULL,
      host_id TEXT NOT NULL,
      status TEXT DEFAULT 'waiting',
      max_players INTEGER DEFAULT 6,
      password TEXT DEFAULT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS room_players (
      room_id TEXT, player_id TEXT,
      joined_at TEXT DEFAULT (datetime('now')),
      PRIMARY KEY (room_id, player_id)
    );
    CREATE TABLE IF NOT EXISTS game_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      room_id TEXT, winner_id TEXT, player_count INTEGER,
      duration_seconds INTEGER DEFAULT 0,
      players_json TEXT DEFAULT '[]',
      played_at TEXT DEFAULT (datetime('now'))
    );
  `);

  // Migrations
  const migrate = [
    "ALTER TABLE players ADD COLUMN password_hash TEXT DEFAULT ''",
    "ALTER TABLE players ADD COLUMN role TEXT DEFAULT 'player'",
    "ALTER TABLE players ADD COLUMN banned INTEGER DEFAULT 0",
    "ALTER TABLE players ADD COLUMN nick_lower TEXT",
    "ALTER TABLE rooms ADD COLUMN password TEXT DEFAULT NULL",
    "ALTER TABLE game_history ADD COLUMN duration_seconds INTEGER DEFAULT 0",
    "ALTER TABLE game_history ADD COLUMN players_json TEXT DEFAULT '[]'",
    "ALTER TABLE players ADD COLUMN avatar TEXT DEFAULT NULL",
  ];
  for (const sql of migrate) { try { db.run(sql); } catch(e) {} }
  db.run("UPDATE players SET nick_lower = LOWER(nick) WHERE nick_lower IS NULL");

  // Default admin
  const adminExists = get('SELECT id FROM players WHERE role = ?', ['admin']);
  if (!adminExists) {
    const hash = bcrypt.hashSync('admin123', 10);
    run('INSERT INTO players (id,nick,nick_lower,password_hash,role) VALUES (?,?,?,?,?)',
      [uuidv4(),'admin','admin',hash,'admin']);
    console.log('✅ Admin criado: nick=admin senha=admin123');
  }
  persist();
}

function persist() { try { fs.writeFileSync(DB_PATH, Buffer.from(db.export())); } catch(e) {} }
function run(sql, p=[]) { db.run(sql, p); persist(); }
function get(sql, p=[]) { const s=db.prepare(sql); s.bind(p); const r=s.step()?s.getAsObject():null; s.free(); return r; }
function all(sql, p=[]) { const s=db.prepare(sql); s.bind(p); const rows=[]; while(s.step()) rows.push(s.getAsObject()); s.free(); return rows; }

// ── AUTH ─────────────────────────────────────────────────────────────────────
async function registerPlayer(nick, password) {
  if (!nick||nick.length<2||nick.length>20) return {error:'Nick deve ter 2-20 caracteres'};
  if (!/^[a-zA-Z0-9_\-\.]+$/.test(nick)) return {error:'Nick: apenas letras, números, _ e -'};
  if (!password||password.length<4) return {error:'Senha deve ter no mínimo 4 caracteres'};
  const nickLower = nick.toLowerCase();
  if (get('SELECT id FROM players WHERE nick_lower=?',[nickLower])) return {error:'Nick já em uso'};
  const hash = bcrypt.hashSync(password, 10);
  const id = uuidv4();
  run('INSERT INTO players (id,nick,nick_lower,password_hash) VALUES (?,?,?,?)',[id,nick,nickLower,hash]);
  return get('SELECT id,nick,role,banned FROM players WHERE id=?',[id]);
}

async function loginPlayer(nick, password) {
  const player = get('SELECT * FROM players WHERE nick_lower=?',[nick.toLowerCase()]);
  if (!player) return {error:'Nick ou senha incorretos'};
  if (player.banned) return {error:'Conta banida. Contate o administrador.'};
  if (!bcrypt.compareSync(password, player.password_hash)) return {error:'Nick ou senha incorretos'};
  run("UPDATE players SET last_seen=datetime('now') WHERE id=?",[player.id]);
  return {id:player.id,nick:player.nick,role:player.role};
}

async function changePassword(playerId, oldPassword, newPassword) {
  if (!newPassword||newPassword.length<4) return {error:'Nova senha deve ter no mínimo 4 caracteres'};
  const player = get('SELECT * FROM players WHERE id=?',[playerId]);
  if (!player) return {error:'Jogador não encontrado'};
  if (!bcrypt.compareSync(oldPassword, player.password_hash)) return {error:'Senha atual incorreta'};
  run('UPDATE players SET password_hash=? WHERE id=?',[bcrypt.hashSync(newPassword,10),playerId]);
  return {ok:true};
}

async function adminResetPassword(targetId, newPassword) {
  if (!newPassword||newPassword.length<4) return {error:'Senha muito curta'};
  run('UPDATE players SET password_hash=? WHERE id=?',[bcrypt.hashSync(newPassword,10),targetId]);
  return {ok:true};
}

// ── PLAYERS ──────────────────────────────────────────────────────────────────
function getPlayer(id) { return get('SELECT id,nick,role,banned,games_played,games_won,avatar,last_seen,created_at FROM players WHERE id=?',[id]); }
function getPublicProfile(id) { return get('SELECT id,nick,games_played,games_won,avatar,created_at FROM players WHERE id=?',[id]); }
function getAllPlayers() { return all('SELECT id,nick,role,banned,games_played,games_won,last_seen,created_at FROM players ORDER BY created_at DESC'); }
function banPlayer(id, banned) { run('UPDATE players SET banned=? WHERE id=?',[banned?1:0,id]); return {ok:true}; }
function deletePlayer(id) { run('DELETE FROM room_players WHERE player_id=?',[id]); run('DELETE FROM players WHERE id=?',[id]); return {ok:true}; }
function getLeaderboard() { return all("SELECT nick,games_won,games_played,avatar FROM players WHERE role!=? ORDER BY games_won DESC,games_played DESC LIMIT 20",['admin']); }
function getPlayerAvatar(id) { const r = get('SELECT avatar FROM players WHERE id=?',[id]); return r?.avatar || null; }
function updateAvatar(id, avatarBase64) { run('UPDATE players SET avatar=? WHERE id=?',[avatarBase64,id]); return {ok:true}; }
function changeNick(playerId, newNick) {
  if (!newNick||newNick.length<2||newNick.length>20) return {error:'Nick deve ter 2-20 caracteres'};
  if (!/^[a-zA-Z0-9_\-\.]+$/.test(newNick)) return {error:'Nick: apenas letras, números, _ e -'};
  const nickLower = newNick.toLowerCase();
  const existing = get('SELECT id FROM players WHERE nick_lower=? AND id!=?',[nickLower,playerId]);
  if (existing) return {error:'Nick já em uso'};
  run('UPDATE players SET nick=?,nick_lower=? WHERE id=?',[newNick,nickLower,playerId]);
  return {ok:true,nick:newNick};
}
function recordWin(pid) { run('UPDATE players SET games_won=games_won+1,games_played=games_played+1 WHERE id=?',[pid]); }
function recordGamePlayed(pids) { for(const id of pids) run('UPDATE players SET games_played=games_played+1 WHERE id=?',[id]); }

// ── PLAYER HISTORY ───────────────────────────────────────────────────────────
function getPlayerHistory(playerId, limit=10) {
  return all(`SELECT gh.*, p.nick as winner_nick FROM game_history gh
    LEFT JOIN players p ON gh.winner_id=p.id
    WHERE gh.players_json LIKE ? ORDER BY gh.played_at DESC LIMIT ?`,
    ['%'+playerId+'%', limit]);
}

// ── STATS ─────────────────────────────────────────────────────────────────────
function getStats() {
  return {
    totalPlayers: get("SELECT COUNT(*) as c FROM players WHERE role!=?",['admin'])?.c || 0,
    totalGames: get('SELECT COUNT(*) as c FROM game_history')?.c || 0,
    todayGames: get("SELECT COUNT(*) as c FROM game_history WHERE played_at>=date('now')")?.c || 0,
    weekGames: get("SELECT COUNT(*) as c FROM game_history WHERE played_at>=date('now','-7 days')")?.c || 0,
    activeRooms: get("SELECT COUNT(*) as c FROM rooms WHERE status!='finished'")?.c || 0,
  };
}
function getGameHistory(limit=20) {
  return all(`SELECT gh.*,p.nick as winner_nick FROM game_history gh LEFT JOIN players p ON gh.winner_id=p.id ORDER BY gh.played_at DESC LIMIT ?`,[limit]);
}

// ── ROOMS ─────────────────────────────────────────────────────────────────────
function generateRoomCode() {
  const c='ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; let code='';
  for(let i=0;i<5;i++) code+=c[Math.floor(Math.random()*c.length)];
  return code;
}
function createRoom(hostId, maxPlayers=6, password=null) {
  let code, attempts=0;
  do { code=generateRoomCode(); attempts++; } while(get('SELECT id FROM rooms WHERE code=?',[code])&&attempts<10);
  const id=uuidv4();
  run('INSERT INTO rooms (id,code,host_id,max_players,password) VALUES (?,?,?,?,?)',[id,code,hostId,maxPlayers,password||null]);
  run('INSERT INTO room_players (room_id,player_id) VALUES (?,?)',[id,hostId]);
  return getRoom(id);
}
function getRoom(roomId) {
  const room=get('SELECT * FROM rooms WHERE id=?',[roomId]);
  if(!room) return null;
  room.players=all('SELECT p.id,p.nick,p.avatar FROM room_players rp JOIN players p ON rp.player_id=p.id WHERE rp.room_id=?',[roomId]);
  room.hasPassword=!!room.password;
  return room;
}
function getAllRooms() {
  return all("SELECT * FROM rooms WHERE status!='finished' ORDER BY created_at DESC").map(r=>{
    r.players=all('SELECT p.id,p.nick,p.avatar FROM room_players rp JOIN players p ON rp.player_id=p.id WHERE rp.room_id=?',[r.id]);
    r.hasPassword=!!r.password; return r;
  });
}
function getRoomByCode(code) { const r=get('SELECT * FROM rooms WHERE code=?',[code.toUpperCase()]); return r?getRoom(r.id):null; }
function joinRoom(roomId, playerId, password=null) {
  const room=getRoom(roomId);
  if(!room) return {error:'Sala não encontrada'};
  if(room.status!=='waiting') return {error:'Partida já iniciada'};
  if(room.players.length>=room.max_players) return {error:'Sala cheia'};
  if(room.players.find(p=>p.id===playerId)) return {error:'Já na sala'};
  if(room.password && room.password!==password) return {error:'Senha da sala incorreta'};
  run('INSERT OR IGNORE INTO room_players (room_id,player_id) VALUES (?,?)',[roomId,playerId]);
  return getRoom(roomId);
}
function leaveRoom(roomId, playerId) {
  run('DELETE FROM room_players WHERE room_id=? AND player_id=?',[roomId,playerId]);
  const room=getRoom(roomId);
  if(!room) return null;
  if(room.players.length===0){run('DELETE FROM rooms WHERE id=?',[roomId]);return null;}
  if(room.host_id===playerId) run('UPDATE rooms SET host_id=? WHERE id=?',[room.players[0].id,roomId]);
  return getRoom(roomId);
}
function closeRoom(roomId) { run("UPDATE rooms SET status='finished' WHERE id=?",[roomId]); run('DELETE FROM room_players WHERE room_id=?',[roomId]); return {ok:true}; }
function setRoomStatus(roomId, status) { run('UPDATE rooms SET status=? WHERE id=?',[status,roomId]); }
function saveGameResult(roomId, winnerId, playerIds, durationSeconds=0) {
  run('INSERT INTO game_history (room_id,winner_id,player_count,duration_seconds,players_json) VALUES (?,?,?,?,?)',
    [roomId,winnerId,playerIds.length,durationSeconds,JSON.stringify(playerIds)]);
  recordWin(winnerId);
  recordGamePlayed(playerIds);
}

module.exports = {
  init,
  registerPlayer, loginPlayer, changePassword, adminResetPassword, changeNick,
  getPlayer, getPublicProfile, getAllPlayers, banPlayer, deletePlayer,
  getLeaderboard, recordWin, recordGamePlayed, getPlayerHistory,
  getPlayerAvatar, updateAvatar,
  getStats, getGameHistory,
  createRoom, getRoom, getAllRooms, getRoomByCode, joinRoom, leaveRoom, closeRoom, setRoomStatus, saveGameResult,
};
