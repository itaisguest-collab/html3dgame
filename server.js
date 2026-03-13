/**
 * 🚀 Buzz Solar Explorer — LAN Multiplayer Server (Socket.io)
 *
 * Setup:
 *   npm install express socket.io
 *   node server.js
 *
 * Players open: http://<YOUR-LAN-IP>:8765/buzz-solar-explorer.html
 */

const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const path = require('path');
const os = require('os');

const PORT = 8765;
const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname)));

// rooms[code] = { name, code, gameMode, players, level, wave, spawnList, aliveEnemyIds, waveEnding, dm }
const rooms = {};
const DM_MAX_PLAYERS = 5;
const DM_TIME_MS = 5 * 60 * 1000;
const DM_KILL_TARGET = 20;
const DM_START_COUNTDOWN_MS = 5000;

function roomGameMode(code, requestedMode) {
  if (requestedMode === 'dm') return 'dm';
  if (String(code || '').toLowerCase().startsWith('dm-')) return 'dm';
  return 'coop';
}

function makeDmState() {
  return {
    phase: 'waiting', // waiting | countdown | active | ended
    startedAt: null,
    endAt: null,
    countdownStartAt: null,
    winnerId: null,
    winnerName: null,
    ended: false,
    stats: {}
  };
}

function ensureDmPlayer(room, socketId, name) {
  if (!room.dm.stats[socketId]) {
    room.dm.stats[socketId] = { name: name || 'PLAYER', kills: 0, deaths: 0, score: 0 };
  } else {
    room.dm.stats[socketId].name = name || room.dm.stats[socketId].name;
  }
}

function dmRemainingMs(room) {
  if (!room || !room.dm) return 0;
  if (room.dm.phase === 'countdown' && room.dm.countdownStartAt) {
    return Math.max(0, DM_START_COUNTDOWN_MS - (Date.now() - room.dm.countdownStartAt));
  }
  if (room.dm.phase === 'active' && room.dm.endAt) {
    return Math.max(0, room.dm.endAt - Date.now());
  }
  return DM_TIME_MS;
}

function updateDmLifecycle(code) {
  const room = rooms[code];
  if (!room || room.gameMode !== 'dm' || room.dm.ended) return;
  const playerCount = roomPlayerCount(code);
  const now = Date.now();

  if (room.dm.phase === 'active') return;

  if (playerCount < 2) {
    room.dm.phase = 'waiting';
    room.dm.countdownStartAt = null;
    return;
  }

  if (room.dm.phase === 'waiting') {
    room.dm.phase = 'countdown';
    room.dm.countdownStartAt = now;
    return;
  }

  if (room.dm.phase === 'countdown' && room.dm.countdownStartAt && now - room.dm.countdownStartAt >= DM_START_COUNTDOWN_MS) {
    room.dm.phase = 'active';
    room.dm.startedAt = now;
    room.dm.endAt = now + DM_TIME_MS;
    room.dm.countdownStartAt = null;
  }
}

function dmLeaderboard(room) {
  return Object.entries(room.dm.stats)
    .map(([id, s]) => ({ id, name: s.name, kills: s.kills, deaths: s.deaths, score: s.score }))
    .sort((a, b) => (b.score - a.score) || (b.kills - a.kills) || (a.deaths - b.deaths) || a.name.localeCompare(b.name));
}

function emitDmState(code) {
  const room = rooms[code];
  if (!room || room.gameMode !== 'dm') return;
  const playerCount = roomPlayerCount(code);
  const playersNeeded = Math.max(0, 2 - playerCount);
  io.to(code).emit('dm_state', {
    active: room.dm.phase === 'active' && !room.dm.ended,
    phase: room.dm.ended ? 'ended' : room.dm.phase,
    remainingMs: dmRemainingMs(room),
    countdownMs: room.dm.phase === 'countdown' ? dmRemainingMs(room) : 0,
    playersNeeded,
    playerCount,
    killTarget: DM_KILL_TARGET,
    leaderboard: dmLeaderboard(room),
    winnerId: room.dm.winnerId,
    winnerName: room.dm.winnerName
  });
}

function finishDmIfNeeded(code) {
  const room = rooms[code];
  if (!room || room.gameMode !== 'dm' || room.dm.ended || room.dm.phase !== 'active') return;

  const top = dmLeaderboard(room)[0];
  const timedOut = dmRemainingMs(room) <= 0;
  const targetReached = !!top && top.kills >= DM_KILL_TARGET;
  if (!timedOut && !targetReached) return;

  room.dm.ended = true;
  room.dm.phase = 'ended';
  room.dm.winnerId = top ? top.id : null;
  room.dm.winnerName = top ? top.name : null;
  emitDmState(code);
  io.to(code).emit('dm_match_end', {
    winnerId: room.dm.winnerId,
    winnerName: room.dm.winnerName,
    leaderboard: dmLeaderboard(room)
  });
}

function makeWaveSpawnList(level, wave) {
  const count = 10 + (level - 1) * 5 + (wave - 1) * 4;
  const spawnList = [];
  for (let i = 0; i < count; i++) {
    const a = Math.random() * Math.PI * 2;
    const rr = 60 + Math.random() * 180;
    const y = (Math.random() - 0.5) * 50;
    spawnList.push({ x: Math.cos(a) * rr, y, z: Math.sin(a) * rr, isBoss: false, idx: i });
  }
  if (wave === 3) {
    spawnList.push({ x: (Math.random() - 0.5) * 80, y: 20, z: (Math.random() - 0.5) * 80, isBoss: true, idx: count });
  }
  return spawnList;
}

function setRoomWave(code, level, wave) {
  const room = rooms[code];
  if (!room) return;
  room.level = level;
  room.wave = wave;
  room.spawnList = makeWaveSpawnList(level, wave);
  room.aliveEnemyIds = new Set(room.spawnList.map(s => s.idx));
  room.waveEnding = false;
}

function broadcastWave(code) {
  const room = rooms[code];
  if (!room) return;
  io.to(code).emit('wave_data', {
    level: room.level,
    wave: room.wave,
    spawnList: room.spawnList
  });
  console.log(`[~] Wave ${room.level}-${room.wave} broadcast to room "${code}" (${room.spawnList.length} enemies)`);
}

function scheduleNextWave(code) {
  const room = rooms[code];
  if (!room || room.waveEnding) return;
  room.waveEnding = true;
  let nextLevel = room.level;
  let nextWave = room.wave + 1;
  if (nextWave > 3) {
    nextWave = 1;
    nextLevel += 1;
  }

  io.to(code).emit('wave_cleared', { level: nextLevel, wave: nextWave, delayMs: 3000 });

  setTimeout(() => {
    if (!rooms[code]) return;
    setRoomWave(code, nextLevel, nextWave);
    broadcastWave(code);
  }, 3000);
}

function roomPlayerCount(code) {
  return rooms[code] ? Object.keys(rooms[code].players).length : 0;
}

function broadcastRoomList() {
  const list = Object.values(rooms)
    .filter(r => roomPlayerCount(r.code) > 0 && (r.visibility || 'public') === 'public')
    .map(r => ({ name: r.name, code: r.code, players: roomPlayerCount(r.code), gameMode: r.gameMode }));
  io.emit('room_list', list);
}

io.on('connection', socket => {
  let currentRoom = null;
  let playerName = '???';

  socket.on('join_room', ({ code, name, playerName: nm, gameMode: requestedMode, visibility: requestedVisibility }) => {
    playerName = nm || 'BUZZ';
    const mode = roomGameMode(code, requestedMode);
    const visibility = requestedVisibility === 'private' ? 'private' : 'public';

    if (!rooms[code]) {
      rooms[code] = {
        name: name || code,
        code,
        visibility,
        gameMode: mode,
        players: {},
        level: 1,
        wave: 1,
        spawnList: [],
        aliveEnemyIds: new Set(),
        waveEnding: false,
        dm: mode === 'dm' ? makeDmState() : null
      };
    }

    const room = rooms[code];
    if (room.gameMode === 'dm' && roomPlayerCount(code) >= DM_MAX_PLAYERS) {
      socket.emit('room_full', { code, maxPlayers: DM_MAX_PLAYERS, gameMode: 'dm' });
      return;
    }

    currentRoom = code;

    rooms[code].players[socket.id] = { nm: playerName, x: 0, y: 18, z: -130, ya: 0, mo: 1, hp: 100 };
    if (room.gameMode === 'dm') ensureDmPlayer(room, socket.id, playerName);

    socket.join(code);

    // Send existing players + current wave data so late joiners sync perfectly
    const others = {};
    Object.entries(rooms[code].players).forEach(([id, data]) => {
      if (id !== socket.id) others[id] = data;
    });
    socket.emit('room_joined', {
      roomCode: code,
      others,
      visibility: rooms[code].visibility || 'public',
      gameMode: rooms[code].gameMode,
      level: rooms[code].level,
      wave: rooms[code].wave,
      spawnList: rooms[code].spawnList,
      dm: rooms[code].gameMode === 'dm' ? {
        active: rooms[code].dm.phase === 'active' && !rooms[code].dm.ended,
        phase: rooms[code].dm.ended ? 'ended' : rooms[code].dm.phase,
        remainingMs: dmRemainingMs(rooms[code]),
        countdownMs: rooms[code].dm.phase === 'countdown' ? dmRemainingMs(rooms[code]) : 0,
        playersNeeded: Math.max(0, 2 - roomPlayerCount(code)),
        playerCount: roomPlayerCount(code),
        killTarget: DM_KILL_TARGET,
        leaderboard: dmLeaderboard(rooms[code]),
        winnerId: rooms[code].dm.winnerId,
        winnerName: rooms[code].dm.winnerName
      } : null
    });

    socket.to(code).emit('player_joined', { id: socket.id, data: rooms[code].players[socket.id] });
    if (room.gameMode === 'dm') {
      updateDmLifecycle(code);
      emitDmState(code);
    }
    broadcastRoomList();
    console.log(`[+] ${playerName} joined "${code}" (${roomPlayerCount(code)} players)`);
  });

  // Player state
  socket.on('state', data => {
    if (!currentRoom || !rooms[currentRoom]) return;
    const entry = { ...data, nm: playerName };
    rooms[currentRoom].players[socket.id] = entry;
    socket.to(currentRoom).emit('player_state', { id: socket.id, data: entry });
  });

  // Room list
  socket.on('list_rooms', () => {
    const list = Object.values(rooms)
      .filter(r => roomPlayerCount(r.code) > 0 && (r.visibility || 'public') === 'public')
      .map(r => ({ name: r.name, code: r.code, players: roomPlayerCount(r.code), gameMode: r.gameMode }));
    socket.emit('room_list', list);
  });

  // Shoot relay
  socket.on('shoot', data => {
    if (!currentRoom) return;
    socket.to(currentRoom).emit('net_shoot', { id: socket.id, ...data });
  });

  // PVP hit relay
  socket.on('pvp_hit', data => {
    if (!currentRoom || !rooms[currentRoom]) return;
    const room = rooms[currentRoom];

    if (room.gameMode !== 'dm') {
      socket.to(currentRoom).emit('net_pvp_hit', { dmg: data.dmg });
      return;
    }

    if (room.dm.ended || room.dm.phase !== 'active') return;
    const attackerId = data.attackerId || socket.id;
    const targetId = data.targetId;
    const dmg = Math.max(0, Number(data.dmg) || 0);
    if (!targetId || !room.players[targetId] || !room.players[attackerId] || targetId === attackerId) return;

    const target = room.players[targetId];
    target.hp = Math.max(0, (target.hp ?? 100) - dmg);
    io.to(targetId).emit('net_pvp_hit', { dmg, attackerId });

    if (target.hp <= 0) {
      target.hp = 100;
      if (room.dm.stats[targetId]) room.dm.stats[targetId].deaths += 1;
      if (room.dm.stats[attackerId]) {
        room.dm.stats[attackerId].kills += 1;
        room.dm.stats[attackerId].score = room.dm.stats[attackerId].kills * 100 - room.dm.stats[attackerId].deaths * 25;
      }
      io.to(currentRoom).emit('dm_kill', {
        attackerId,
        attackerName: room.dm.stats[attackerId] ? room.dm.stats[attackerId].name : 'PLAYER',
        victimId: targetId,
        victimName: room.dm.stats[targetId] ? room.dm.stats[targetId].name : 'PLAYER'
      });
      io.to(targetId).emit('dm_force_respawn', {
        x: (Math.random() - 0.5) * 180,
        y: 18,
        z: (Math.random() - 0.5) * 180
      });
      emitDmState(currentRoom);
      finishDmIfNeeded(currentRoom);
    }
  });

  // Enemy kill relay + wave progression
  socket.on('enemy_kill', ({ idx }) => {
    if (!currentRoom || !rooms[currentRoom]) return;
    const room = rooms[currentRoom];
    if (room.gameMode === 'dm') return;
    if (room.aliveEnemyIds.has(idx)) {
      room.aliveEnemyIds.delete(idx);
    }
    socket.to(currentRoom).emit('enemy_kill', { idx });

    if (room.aliveEnemyIds.size === 0 && room.spawnList.length > 0) {
      scheduleNextWave(currentRoom);
    }
  });

  // Clients request the authoritative room wave from server.
  socket.on('request_wave', ({ level, wave } = {}) => {
    if (!currentRoom || !rooms[currentRoom]) return;
    const room = rooms[currentRoom];
    if (room.gameMode === 'dm') {
      socket.emit('wave_data', { level: 0, wave: 0, spawnList: [] });
      return;
    }

    // If a wave already exists, return it to the requester to keep sync.
    if (room.spawnList.length > 0 && room.level === level && room.wave === wave) {
      socket.emit('wave_data', { level: room.level, wave: room.wave, spawnList: room.spawnList });
      return;
    }

    setRoomWave(currentRoom, level || room.level || 1, wave || room.wave || 1);
    broadcastWave(currentRoom);
  });

  socket.on('disconnect', () => {
    if (currentRoom && rooms[currentRoom]) {
      const room = rooms[currentRoom];
      if (room.gameMode === 'dm' && room.dm && room.dm.stats[socket.id]) {
        delete room.dm.stats[socket.id];
      }
      delete rooms[currentRoom].players[socket.id];
      io.to(currentRoom).emit('player_left', { id: socket.id });
      if (roomPlayerCount(currentRoom) === 0) delete rooms[currentRoom];
      else if (room.gameMode === 'dm') {
        updateDmLifecycle(currentRoom);
        emitDmState(currentRoom);
        finishDmIfNeeded(currentRoom);
      }
      broadcastRoomList();
      console.log(`[-] ${playerName} left "${currentRoom}"`);
    }
  });
});

setInterval(() => {
  Object.keys(rooms).forEach(code => {
    if (rooms[code].gameMode === 'dm') {
      updateDmLifecycle(code);
      emitDmState(code);
      finishDmIfNeeded(code);
    }
  });
}, 1000);

httpServer.listen(PORT, '0.0.0.0', () => {
  const nets = os.networkInterfaces();
  let lanIP = 'localhost';
  for (const iface of Object.values(nets)) {
    for (const net of iface) {
      if (net.family === 'IPv4' && !net.internal) { lanIP = net.address; break; }
    }
    if (lanIP !== 'localhost') break;
  }
  console.log('\n  🚀 BUZZ SOLAR EXPLORER — LAN SERVER');
  console.log('  =====================================');
  console.log(`  ✅ Running on port ${PORT}`);
  console.log(`  🌐 Players open: http://${lanIP}:${PORT}`);
  console.log('  🎮 Waiting for players...\n');
});
