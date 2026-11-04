// ======================================================
// DRIVE CITY — سرور آنلاین (Socket.IO + Express)
// ======================================================

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  },
  transports: ['websocket', 'polling'],
  pingTimeout: 60000,
  pingInterval: 25000
});

// ======================================================
// ذخیره‌سازی در حافظه
// ======================================================

// socket.id → اطلاعات بازیکن
const players = {};

// myPlayerID (شناسه ۸ رقمی) → socket.id
const playerIdToSocket = {};

// ======================================================
// HTTP
// ======================================================

app.get('/', (req, res) => {
  res.send('Drive City server is running ✅ — ' + new Date().toISOString());
});

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    online: Object.keys(players).length,
    uptime: process.uptime()
  });
});

// ======================================================
// Socket.IO
// ======================================================

io.on('connection', (socket) => {
  console.log('[+] اتصال:', socket.id, '| آنلاین:', Object.keys(players).length + 1);

  players[socket.id] = {
    id: socket.id,
    playerId: null,
    name: 'ناشناس',
    hasBlueTick: false,
    x: 0, y: 0, z: 0,
    rotation: 0,
    vehicleType: 'walking',
    skin: 'boy',
    lastSeen: Date.now()
  };

  // ------------------------------------------------------
  // ۱) ثبت اطلاعات بازیکن (شناسه، اسم و تیک آبی)
  // ------------------------------------------------------
  socket.on('setPlayerInfo', (data) => {
    if (!players[socket.id] || !data) return;

    const playerId = String(data.id || '').slice(0, 16);
    const name = String(data.name || 'ناشناس').slice(0, 15);

    if (!playerId) return;

    if (playerIdToSocket[playerId] && playerIdToSocket[playerId] !== socket.id) {
      delete playerIdToSocket[playerId];
    }

    players[socket.id].playerId = playerId;
    players[socket.id].name = name;
    if (typeof data.hasBlueTick === 'boolean') {
      players[socket.id].hasBlueTick = data.hasBlueTick;
    }
    playerIdToSocket[playerId] = socket.id;

    console.log('[i] ثبت بازیکن:', name, '| شناسه:', playerId);

    socket.broadcast.emit('systemMessage', name + ' وارد بازی شد');
  });

  // ------------------------------------------------------
  // ۲) ارسال لیست بازیکن‌های موجود به تازه‌وارد
  // ------------------------------------------------------
  const currentPlayers = {};
  for (const id in players) {
    if (id !== socket.id) currentPlayers[id] = players[id];
  }
  socket.emit('currentPlayers', currentPlayers);
  socket.broadcast.emit('newPlayer', socket.id);

  // ------------------------------------------------------
  // ۳) حرکت بازیکن
  // ------------------------------------------------------
  socket.on('playerMovement', (data) => {
    if (!players[socket.id] || !data) return;

    const p = players[socket.id];
    p.x = Number(data.x) || 0;
    p.y = Number(data.y) || 0;
    p.z = Number(data.z) || 0;
    p.rotation = Number(data.rotation) || 0;
    p.vehicleType = data.vehicleType || 'walking';
    p.skin = data.skin || 'boy';
    if (typeof data.name === 'string' && data.name.trim()) {
      p.name = data.name.slice(0, 15);
    }
    if (typeof data.hasBlueTick === 'boolean') {
      p.hasBlueTick = data.hasBlueTick;
    }
    p.lastSeen = Date.now();

    socket.broadcast.emit('playerMoved', {
      id: socket.id,
      playerId: p.playerId,
      name: p.name,
      hasBlueTick: p.hasBlueTick,
      x: p.x,
      y: p.y,
      z: p.z,
      rotation: p.rotation,
      vehicleType: p.vehicleType,
      skin: p.skin
    });
  });

  // ------------------------------------------------------
  // ۴) انتقال سکه
  // ------------------------------------------------------
  socket.on('transferCoins', (data) => {
    if (!data) return;

    const fromId = String(data.fromId || '');
    const toId = String(data.toId || '');
    const amount = Math.floor(Number(data.amount));

    if (!fromId || !toId || !amount || amount <= 0) {
      return socket.emit('transferResult', { success: false, message: 'اطلاعات انتقال نامعتبر است' });
    }
    if (fromId === toId) {
      return socket.emit('transferResult', { success: false, message: 'نمی‌تونی به خودت سکه بدی' });
    }
    if (amount < 100) {
      return socket.emit('transferResult', { success: false, message: 'حداقل انتقال ۱۰۰ سکه است' });
    }
    if (amount > 10000000) {
      return socket.emit('transferResult', { success: false, message: 'حداکثر ۱۰,۰۰۰,۰۰۰ سکه است' });
    }
    if (players[socket.id]?.playerId !== fromId) {
      return socket.emit('transferResult', { success: false, message: 'شناسه فرستنده هم‌خوانی ندارد' });
    }

    const targetSocketId = playerIdToSocket[toId];
    if (!targetSocketId) {
      return socket.emit('transferResult', { success: false, message: 'گیرنده آنلاین نیست' });
    }

    const senderName = players[socket.id]?.name || data.fromName || 'بازیکن';

    io.to(targetSocketId).emit('receiveCoins', {
      fromId,
      fromName: senderName,
      toId,
      amount
    });

    socket.emit('transferResult', { success: true, amount, toId, message: 'انتقال انجام شد' });

    console.log('[💸]', senderName, '→', toId, ':', amount, 'سکه');
  });

  // ------------------------------------------------------
  // ۵) چت
  // ------------------------------------------------------
  socket.on('chatMessage', (data) => {
    if (!data || typeof data.text !== 'string') return;
    const text = data.text.trim().slice(0, 120);
    if (!text) return;

    const p = players[socket.id];
    const name = (p?.name || data.name || 'ناشناس').slice(0, 15);
    const hasBlueTick = !!(p?.hasBlueTick);

    io.emit('chatMessage', {
      id: p?.playerId || data.id || socket.id,
      name,
      text,
      hasBlueTick,
      time: Date.now()
    });

    console.log('[💬]', name, ':', text);
  });

  // ------------------------------------------------------
  // ۶) قطع اتصال
  // ------------------------------------------------------
  socket.on('disconnect', (reason) => {
    const p = players[socket.id];
    if (p?.playerId && playerIdToSocket[p.playerId] === socket.id) {
      delete playerIdToSocket[p.playerId];
    }
    delete players[socket.id];

    io.emit('playerDisconnected', socket.id);
    console.log('[-] قطع:', socket.id, '| دلیل:', reason, '| آنلاین:', Object.keys(players).length);
  });
});

// ======================================================
// پاکسازی بازیکن‌های راکد
// ======================================================
setInterval(() => {
  const now = Date.now();
  for (const id in players) {
    if (now - players[id].lastSeen > 120000) {
      const p = players[id];
      if (p.playerId && playerIdToSocket[p.playerId] === id) {
        delete playerIdToSocket[p.playerId];
      }
      delete players[id];
      io.emit('playerDisconnected', id);
      console.log('[x] پاکسازی بازیکن راکد:', id);
    }
  }
}, 30000);

// ======================================================
// شروع سرور
// ======================================================
server.listen(PORT, '0.0.0.0', () => {
  console.log('🚀 Drive City server listening on port', PORT);
});
