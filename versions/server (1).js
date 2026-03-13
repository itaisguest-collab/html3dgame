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

// Serve game files from same folder
app.use(express.static(path.join(__dirname)));

// ── Room state ─────────────────────────────────────────────
// rooms[code] = { name, code, players: { socketId: {nm,x,y,z,ya,mo,hp} } }
const rooms = {};

function roomPlayerCount(code) {
  return rooms[code] ? Object.keys(rooms[code].players).length : 0;
}

function broadcastRoomList() {
  const list = Object.values(rooms)
    .filter(r => roomPlayerCount(r.code) > 0)
    .map(r => ({ name: r.name, code: r.code, players: roomPlayerCount(r.code) }));
  io.emit('room_list', list);
}

// ── Socket events ──────────────────────────────────────────
io.on('connection', socket => {
  let currentRoom = null;
  let playerName = '???';

  socket.on('join_room', ({ code, name, playerName: nm }) => {
    currentRoom = code;
    playerName = nm || 'BUZZ';

    if (!rooms[code]) rooms[code] = { name: name || code, code, players: {} };
    rooms[code].players[socket.id] = { nm: playerName, x: 0, y: 18, z: -130, ya: 0, mo: 1, hp: 100 };

    socket.join(code);

    // Send this player the current state of everyone else already in room
    const others = {};
    Object.entries(rooms[code].players).forEach(([id, data]) => {
      if (id !== socket.id) others[id] = data;
    });
    socket.emit('room_joined', { roomCode: code, others });

    // Tell everyone else a new player arrived
    socket.to(code).emit('player_joined', { id: socket.id, data: rooms[code].players[socket.id] });

    broadcastRoomList();
    console.log(`[+] ${playerName} joined "${code}" (${roomPlayerCount(code)} players total)`);
  });

  // Relay player position/state to everyone else in room
  socket.on('state', data => {
    if (!currentRoom || !rooms[currentRoom]) return;
    const entry = { ...data, nm: playerName };
    rooms[currentRoom].players[socket.id] = entry;
    socket.to(currentRoom).emit('player_state', { id: socket.id, data: entry });
  });

  // Relay shoot event to others in room
  socket.on('shoot', data => {
    if (!currentRoom) return;
    socket.to(currentRoom).emit('net_shoot', { id: socket.id, ...data });
  });

  // Relay PVP hit
  socket.on('pvp_hit', data => {
    if (!currentRoom) return;
    socket.to(currentRoom).emit('net_pvp_hit', { dmg: data.dmg });
  });

  // Room list request
  socket.on('list_rooms', () => {
    const list = Object.values(rooms)
      .filter(r => roomPlayerCount(r.code) > 0)
      .map(r => ({ name: r.name, code: r.code, players: roomPlayerCount(r.code) }));
    socket.emit('room_list', list);
  });

  socket.on('disconnect', () => {
    if (currentRoom && rooms[currentRoom]) {
      delete rooms[currentRoom].players[socket.id];
      io.to(currentRoom).emit('player_left', { id: socket.id });
      if (roomPlayerCount(currentRoom) === 0) delete rooms[currentRoom];
      broadcastRoomList();
      console.log(`[-] ${playerName} left "${currentRoom}"`);
    }
  });
});

// ── Start ──────────────────────────────────────────────────
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
  console.log(`  🌐 Players open: http://${lanIP}:${PORT}/buzz-solar-explorer.html`);
  console.log('  🎮 Waiting for players...\n');
});
