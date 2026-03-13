/**
 * 🚀 Buzz Solar Explorer — LAN Multiplayer Server
 * 
 * Requirements: Node.js (v14+)
 * 
 * Setup:
 *   1. npm install gun express
 *   2. node server.js
 * 
 * Then open the game HTML on any device on your LAN — it auto-connects!
 * Share your LAN IP (shown below) with friends so they can open the game too.
 */

const express = require('express');
const Gun = require('gun');
const path = require('path');
const os = require('os');

const PORT = 8765;
const app = express();

// Serve the game HTML file directly (optional — place game HTML next to server.js)
app.use(express.static(path.join(__dirname)));

// Required for GUN
app.use(Gun.serve);

const server = app.listen(PORT, '0.0.0.0', () => {
  // Find LAN IP
  const nets = os.networkInterfaces();
  let lanIP = 'localhost';
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) {
        lanIP = net.address;
        break;
      }
    }
    if (lanIP !== 'localhost') break;
  }

  console.log('\n🚀 ====================================');
  console.log('   BUZZ SOLAR EXPLORER — LAN SERVER');
  console.log('   ====================================');
  console.log(`\n✅ GUN relay running on port ${PORT}`);
  console.log(`\n🌐 Share this address with LAN players:`);
  console.log(`   http://${lanIP}:${PORT}`);
  console.log(`\n📁 Put the game HTML file next to server.js`);
  console.log(`   then players open: http://${lanIP}:${PORT}/buzz-solar-explorer.html`);
  console.log('\n   (or just open the HTML directly — it auto-connects)');
  console.log('\n🎮 Waiting for players...\n');
});

// Attach GUN to the server
const gun = Gun({ web: server, localStorage: false, radisk: false });

// Log connections (optional)
let playerCount = 0;
server.on('upgrade', (req) => {
  if (req.url === '/gun') {
    playerCount++;
    console.log(`👤 Player connected (${playerCount} active)`);
  }
});
