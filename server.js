// ======================================================
// DRIVE CITY — سرور آنلاین (Socket.IO + Express)
// ======================================================

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const app = express();
app.use(express.json());
const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  transports: ['websocket', 'polling'],
  pingTimeout: 60000,
  pingInterval: 25000
});

// ======================================================
// رمز مالک
// ======================================================
const OWNER_PASSWORD = '1791';

// ======================================================
// ذخیره‌سازی در حافظه
// ======================================================
const players = {};
const playerIdToSocket = {};

// ======================================================
// مسیر فایل‌ها — اگه Disk روی /data داری، این رو نگه دار
// اگه نداری، به '__dirname' تغییر بده
// ======================================================
const DATA_DIR = fs.existsSync('/data') ? '/data' : __dirname;
const BANS_FILE = path.join(DATA_DIR, 'bans.json');
const PLAYERS_DB_FILE = path.join(DATA_DIR, 'players.json');

let bans = {};
let playersDB = {};

// ======================================================
// توابع بن
// ======================================================
function loadBans() {
  try {
    if (fs.existsSync(BANS_FILE)) {
      bans = JSON.parse(fs.readFileSync(BANS_FILE, 'utf8')) || {};
      console.log('[📂] بن‌ها لود شد:', Object.keys(bans).length);
    } else bans = {};
  } catch (e) { console.error('[!] loadBans:', e.message); bans = {}; }
}

function saveBans() {
  try {
    fs.writeFileSync(BANS_FILE, JSON.stringify(bans, null, 2), 'utf8');
  } catch (e) { console.error('[!] saveBans:', e.message); }
}

function isBanned(playerId) {
  if (!playerId) return null;
  const rec = bans[playerId];
  if (!rec) return null;
  if (rec.until === 0) return rec;
  if (Date.now() < rec.until) return rec;
  delete bans[playerId]; saveBans();
  return null;
}

function banPlayer(playerId, untilMs, reason) {
  bans[playerId] = { until: untilMs, reason: reason || 'نقض قوانین', bannedAt: Date.now() };
  saveBans();
  const socketId = playerIdToSocket[playerId];
  if (socketId) {
    const sock = io.sockets.sockets.get(socketId);
    if (sock) {
      sock.emit('youAreBanned', { until: untilMs, reason: reason || 'نقض قوانین' });
      setTimeout(() => sock.disconnect(true), 4000);
      console.log('[🚫] کیک آنلاین:', playerId);
    }
  }
}

function unbanPlayer(playerId) {
  if (bans[playerId]) { delete bans[playerId]; saveBans(); return true; }
  return false;
}

// ======================================================
// توابع لیست بازیکن‌ها
// ======================================================
function loadPlayersDB() {
  try {
    if (fs.existsSync(PLAYERS_DB_FILE)) {
      playersDB = JSON.parse(fs.readFileSync(PLAYERS_DB_FILE, 'utf8')) || {};
      console.log('[📂] بازیکن‌ها لود شد:', Object.keys(playersDB).length);
    } else playersDB = {};
  } catch (e) { console.error('[!] loadPlayersDB:', e.message); playersDB = {}; }
}

function savePlayersDB() {
  try {
    fs.writeFileSync(PLAYERS_DB_FILE, JSON.stringify(playersDB, null, 2), 'utf8');
  } catch (e) { console.error('[!] savePlayersDB:', e.message); }
}

function recordPlayer(playerId, name, hasBlueTick) {
  if (!playerId) return;
  const now = Date.now();
  if (playersDB[playerId]) {
    playersDB[playerId].name = name;
    playersDB[playerId].hasBlueTick = !!hasBlueTick;
    playersDB[playerId].lastSeen = now;
  } else {
    playersDB[playerId] = {
      playerId,
      name,
      hasBlueTick: !!hasBlueTick,
      firstSeen: now,
      lastSeen: now
    };
    console.log('[👤] بازیکن جدید:', name, '(', playerId, ')');
  }
  savePlayersDB();
}

// لود اولیه
loadBans();
loadPlayersDB();

// پاکسازی بن‌های منقضی هر ۱ دقیقه
setInterval(() => {
  const now = Date.now(); let changed = false;
  for (const pid in bans) {
    if (bans[pid].until !== 0 && now >= bans[pid].until) {
      delete bans[pid];
      changed = true;
    }
  }
  if (changed) saveBans();
}, 60000);

// ======================================================
// HTTP
// ======================================================
app.get('/', (req, res) => res.send('Drive City server is running ✅ — ' + new Date().toISOString()));
app.get('/health', (req, res) => res.json({
  ok: true,
  online: Object.keys(players).length,
  banned: Object.keys(bans).length,
  totalPlayers: Object.keys(playersDB).length,
  uptime: process.uptime()
}));

// ======================================================
// Socket.IO
// ======================================================
io.on('connection', (socket) => {
  console.log('[+] اتصال:', socket.id, '| آنلاین:', Object.keys(players).length + 1);
  players[socket.id] = {
    id: socket.id, playerId: null, name: 'ناشناس', hasBlueTick: false,
    x: 0, y: 0, z: 0, rotation: 0,
    vehicleType: 'walking', skin: 'boy', lastSeen: Date.now()
  };

  // ================ ثبت اطلاعات بازیکن ================
  socket.on('setPlayerInfo', (data) => {
    if (!players[socket.id] || !data) return;
    const playerId = String(data.id || '').slice(0, 16);
    const name = String(data.name || 'ناشناس').slice(0, 15);
    if (!playerId) return;

    // چک بن
    const ban = isBanned(playerId);
    if (ban) {
      console.log('[🚫] ورود رد شد:', playerId);
      socket.emit('youAreBanned', { until: ban.until, reason: ban.reason });
      setTimeout(() => socket.disconnect(true), 4000);
      return;
    }

    if (playerIdToSocket[playerId] && playerIdToSocket[playerId] !== socket.id) {
      delete playerIdToSocket[playerId];
    }

    // ✅ ثبت در دیتابیس بازیکن‌ها
    recordPlayer(playerId, name, data.hasBlueTick);

    players[socket.id].playerId = playerId;
    players[socket.id].name = name;
    if (typeof data.hasBlueTick === 'boolean') players[socket.id].hasBlueTick = data.hasBlueTick;
    playerIdToSocket[playerId] = socket.id;
    console.log('[i] ثبت:', name, '| شناسه:', playerId);
    socket.broadcast.emit('systemMessage', name + ' وارد بازی شد');
  });

  // لیست بازیکن‌های فعلی
  const currentPlayers = {};
  for (const id in players) if (id !== socket.id) currentPlayers[id] = players[id];
  socket.emit('currentPlayers', currentPlayers);
  socket.broadcast.emit('newPlayer', socket.id);

  // ================ حرکت ================
  socket.on('playerMovement', (data) => {
    if (!players[socket.id] || !data) return;
    const p = players[socket.id];

    if (p.playerId && isBanned(p.playerId)) {
      const ban = isBanned(p.playerId);
      socket.emit('youAreBanned', { until: ban.until, reason: ban.reason });
      setTimeout(() => socket.disconnect(true), 4000);
      return;
    }

    p.x = Number(data.x) || 0;
    p.y = Number(data.y) || 0;
    p.z = Number(data.z) || 0;
    p.rotation = Number(data.rotation) || 0;
    p.vehicleType = data.vehicleType || 'walking';
    p.skin = data.skin || 'boy';
    if (typeof data.name === 'string' && data.name.trim()) p.name = data.name.slice(0, 15);
    if (typeof data.hasBlueTick === 'boolean') p.hasBlueTick = data.hasBlueTick;
    p.lastSeen = Date.now();

    socket.broadcast.emit('playerMoved', {
      id: socket.id, playerId: p.playerId, name: p.name, hasBlueTick: p.hasBlueTick,
      x: p.x, y: p.y, z: p.z, rotation: p.rotation,
      vehicleType: p.vehicleType, skin: p.skin
    });
  });

  // ================ انتقال سکه ================
  socket.on('transferCoins', (data) => {
    if (!data) return;
    const fromId = String(data.fromId || '');
    const toId = String(data.toId || '');
    const amount = Math.floor(Number(data.amount));
    if (!fromId || !toId || !amount || amount <= 0)
      return socket.emit('transferResult', { success: false, message: 'اطلاعات نامعتبر' });
    if (fromId === toId)
      return socket.emit('transferResult', { success: false, message: 'به خودت؟!' });
    if (amount < 100)
      return socket.emit('transferResult', { success: false, message: 'حداقل ۱۰۰ سکه' });
    if (amount > 10000000)
      return socket.emit('transferResult', { success: false, message: 'حداکثر ۱۰ میلیون' });
    if (players[socket.id]?.playerId !== fromId)
      return socket.emit('transferResult', { success: false, message: 'شناسه فرستنده ناهمخوان' });

    const targetSocketId = playerIdToSocket[toId];
    if (!targetSocketId)
      return socket.emit('transferResult', { success: false, message: 'گیرنده آنلاین نیست' });

    const senderName = players[socket.id]?.name || data.fromName || 'بازیکن';
    io.to(targetSocketId).emit('receiveCoins', { fromId, fromName: senderName, toId, amount });
    socket.emit('transferResult', { success: true, amount, toId, message: 'انتقال انجام شد' });
  });

  // ================ چت ================
  socket.on('chatMessage', (data) => {
    if (!data || typeof data.text !== 'string') return;
    const text = data.text.trim().slice(0, 120);
    if (!text) return;
    const p = players[socket.id];
    const name = (p?.name || data.name || 'ناشناس').slice(0, 15);
    io.emit('chatMessage', {
      id: p?.playerId || data.id || socket.id,
      name, text,
      hasBlueTick: !!(p?.hasBlueTick),
      time: Date.now()
    });
  });

  // ================ ادمین: بن ================
  socket.on('adminBan', (data) => {
    if (!data) return;
    const { password, targetId, durationMinutes, reason } = data;
    if (password !== OWNER_PASSWORD)
      return socket.emit('adminBanResult', { success: false, message: '❌ رمز مالک اشتباه' });
    const pid = String(targetId || '').trim();
    if (!pid)
      return socket.emit('adminBanResult', { success: false, message: '❌ شناسه خالی' });
    const minutes = Number(durationMinutes);
    if (isNaN(minutes) || minutes < 0)
      return socket.emit('adminBanResult', { success: false, message: '❌ مدت نامعتبر' });

    const until = minutes === 0 ? 0 : Date.now() + minutes * 60 * 1000;
    banPlayer(pid, until, reason || 'نقض قوانین');
    const targetOnline = !!playerIdToSocket[pid];
    socket.emit('adminBanResult', {
      success: true,
      message: minutes === 0 ? `✅ ${pid} برای همیشه بن شد` : `✅ ${pid} برای ${minutes} دقیقه بن شد`,
      targetId: pid, until, wasOnline: targetOnline
    });
    console.log('[🚫]', pid, '|', minutes === 0 ? 'دائمی' : minutes + ' دقیقه');
  });

  // ================ ادمین: آنبن ================
  socket.on('adminUnban', (data) => {
    if (!data) return;
    const { password, targetId } = data;
    if (password !== OWNER_PASSWORD)
      return socket.emit('adminUnbanResult', { success: false, message: '❌ رمز مالک اشتباه' });
    const pid = String(targetId || '').trim();
    if (!pid)
      return socket.emit('adminUnbanResult', { success: false, message: '❌ شناسه خالی' });

    const existed = unbanPlayer(pid);
    socket.emit('adminUnbanResult', {
      success: true,
      message: existed ? `✅ بن ${pid} برداشته شد` : `⚠️ ${pid} اصلاً بن نبود`,
      targetId: pid
    });
  });

  // ================ ادمین: لیست بن‌ها ================
  socket.on('adminGetBans', (data) => {
    if (!data || data.password !== OWNER_PASSWORD)
      return socket.emit('adminBansList', { success: false, list: [] });
    const now = Date.now();
    const list = Object.keys(bans).map(pid => {
      const b = bans[pid];
      return {
        playerId: pid, until: b.until,
        remainingMs: b.until === 0 ? -1 : Math.max(0, b.until - now),
        reason: b.reason, bannedAt: b.bannedAt,
        online: !!playerIdToSocket[pid]
      };
    });
    socket.emit('adminBansList', { success: true, list });
  });

  // ================ ادمین: لیست همه بازیکن‌ها ================
  socket.on('adminGetAllPlayers', (data) => {
    if (!data || data.password !== OWNER_PASSWORD)
      return socket.emit('adminAllPlayersList', { success: false, list: [] });

    const list = Object.keys(playersDB).map(pid => {
      const p = playersDB[pid];
      return {
        playerId: pid,
        name: p.name,
        hasBlueTick: !!p.hasBlueTick,
        firstSeen: p.firstSeen,
        lastSeen: p.lastSeen,
        online: !!playerIdToSocket[pid]
      };
    });

    list.sort((a, b) => {
      if (a.online !== b.online) return a.online ? -1 : 1;
      return b.lastSeen - a.lastSeen;
    });

    socket.emit('adminAllPlayersList', { success: true, list });
  });

  // ================ قطع اتصال ================
  socket.on('disconnect', (reason) => {
    const p = players[socket.id];
    if (p?.playerId && playerIdToSocket[p.playerId] === socket.id)
      delete playerIdToSocket[p.playerId];
    delete players[socket.id];
    io.emit('playerDisconnected', socket.id);
    console.log('[-] قطع:', socket.id, '|', reason);
  });
});

// پاکسازی بازیکن‌های راکد
setInterval(() => {
  const now = Date.now();
  for (const id in players) {
    if (now - players[id].lastSeen > 120000) {
      const p = players[id];
      if (p.playerId && playerIdToSocket[p.playerId] === id) delete playerIdToSocket[p.playerId];
      delete players[id];
      io.emit('playerDisconnected', id);
    }
  }
}, 30000);

server.listen(PORT, '0.0.0.0', () => console.log('🚀 Drive City on port', PORT));
