// ======================================================
// DRIVE CITY — سرور آنلاین (نسخه کامل)
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

const OWNER_PASSWORD = '1791';

// ======================================================
// ذخیره‌سازی در حافظه
// ======================================================
const players = {};
const playerIdToSocket = {};
const jailedPlayers = {}; 
const droppedItems = {}; 

// ======================================================
// مسیر فایل‌ها
// ======================================================
const DATA_DIR = fs.existsSync('/data') ? '/data' : __dirname;
const BANS_FILE = path.join(DATA_DIR, 'bans.json');
const PLAYERS_DB_FILE = path.join(DATA_DIR, 'players.json');
const JAIL_FILE = path.join(DATA_DIR, 'jail.json');

let bans = {};
let playersDB = {};

// ======================================================
// توابع ذخیره و لود
// ======================================================
function loadBans() {
  try { if (fs.existsSync(BANS_FILE)) bans = JSON.parse(fs.readFileSync(BANS_FILE, 'utf8')) || {}; } catch (e) {}
}
function saveBans() {
  try { fs.writeFileSync(BANS_FILE, JSON.stringify(bans, null, 2), 'utf8'); } catch (e) {}
}
function loadJails() {
  try { if (fs.existsSync(JAIL_FILE)) Object.assign(jailedPlayers, JSON.parse(fs.readFileSync(JAIL_FILE, 'utf8')) || {}); } catch (e) {}
}
function saveJails() {
  try { fs.writeFileSync(JAIL_FILE, JSON.stringify(jailedPlayers, null, 2), 'utf8'); } catch (e) {}
}
function loadPlayersDB() {
  try { if (fs.existsSync(PLAYERS_DB_FILE)) playersDB = JSON.parse(fs.readFileSync(PLAYERS_DB_FILE, 'utf8')) || {}; } catch (e) {}
}
function savePlayersDB() {
  try { fs.writeFileSync(PLAYERS_DB_FILE, JSON.stringify(playersDB, null, 2), 'utf8'); } catch (e) {}
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
  
  if (playersDB[playerId]) {
    playersDB[playerId].coins = 0;
    savePlayersDB();
  }

  const socketId = playerIdToSocket[playerId];
  if (socketId) {
    const sock = io.sockets.sockets.get(socketId);
    if (sock) {
      sock.emit('youAreBanned', { until: untilMs, reason: reason || 'نقض قوانین', resetCoins: true });
      setTimeout(() => sock.disconnect(true), 4000);
    }
  }
}

function unbanPlayer(playerId) {
  const existed = !!bans[playerId];
  if (existed) { delete bans[playerId]; saveBans(); }
  const socketId = playerIdToSocket[playerId];
  if (socketId) {
    const sock = io.sockets.sockets.get(socketId);
    if (sock) sock.emit('youAreUnbanned', { playerId });
  }
  return existed;
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
      playerId, name,
      hasBlueTick: !!hasBlueTick,
      coins: 0, diamonds: 0,
      inventory: { carrot: 0, cabbage: 0, onion: 0, egg: 0, gem: 0, shell: 0, necklace: 0 },
      firstSeen: now, lastSeen: now
    };
  }
  savePlayersDB();
}

loadBans();
loadPlayersDB();
loadJails();

setInterval(() => {
  const now = Date.now(); let changed = false;
  for (const pid in bans) {
    if (bans[pid].until !== 0 && now >= bans[pid].until) {
      delete bans[pid]; changed = true;
    }
  }
  if (changed) saveBans();
}, 60000);

// ======================================================
// HTTP Routes
// ======================================================
app.get('/', (req, res) => res.send('Drive City server is running ✅'));

app.get('/checkBan/:playerId', (req, res) => {
  const playerId = String(req.params.playerId || '').trim();
  if (!playerId) return res.json({ banned: false });
  const ban = isBanned(playerId);
  if (ban) return res.json({ banned: true, until: ban.until, reason: ban.reason || '' });
  res.json({ banned: false });
});

// ======================================================
// Socket.IO
// ======================================================
io.on('connection', (socket) => {
  players[socket.id] = {
    id: socket.id, playerId: null, name: 'ناشناس', hasBlueTick: false,
    x: 0, y: 0, z: 0, rotation: 0, vehicleType: 'walking', skin: 'boy', lastSeen: Date.now(),
    parkedCarType: null, parkedCarX: 0, parkedCarZ: 0, parkedCarRot: 0 // 👈 اضافه شدن اطلاعات ماشین پارک شده
  };

  socket.on('setPlayerInfo', (data) => {
    if (!players[socket.id] || !data) return;
    const playerId = String(data.id || '').slice(0, 16);
    const name = String(data.name || 'ناشناس').slice(0, 15);
    if (!playerId) return;

    const ban = isBanned(playerId);
    if (ban) {
      socket.emit('youAreBanned', { until: ban.until, reason: ban.reason });
      setTimeout(() => socket.disconnect(true), 4000);
      return;
    }

    if (playerIdToSocket[playerId] && playerIdToSocket[playerId] !== socket.id) {
      delete playerIdToSocket[playerId];
    }

    recordPlayer(playerId, name, data.hasBlueTick);

    players[socket.id].playerId = playerId;
    players[socket.id].name = name;
    if (typeof data.hasBlueTick === 'boolean') players[socket.id].hasBlueTick = data.hasBlueTick;
    playerIdToSocket[playerId] = socket.id;

    const pData = playersDB[playerId];
    socket.emit('updateCoins', { coins: pData.coins || 0 });
    socket.emit('updateDiamonds', { diamonds: pData.diamonds || 0 });
    socket.emit('updateInventory', { inventory: pData.inventory }); 

    const currentPlayers = {};
    for (const id in players) {
      if (id !== socket.id && players[id].playerId) {
        currentPlayers[id] = players[id];
      }
    }
    socket.emit('currentPlayers', currentPlayers);
    socket.broadcast.emit('newPlayer', socket.id);
    socket.broadcast.emit('systemMessage', name + ' وارد بازی شد');
  });

  socket.on('syncCoins', (data) => {
    const p = players[socket.id];
    if (!p || !p.playerId) return;
    const newCoins = parseInt(data.coins);
    if (isNaN(newCoins) || newCoins < 0) return;
    if (playersDB[p.playerId]) {
      playersDB[p.playerId].coins = newCoins;
      savePlayersDB();
    }
  });

  socket.on('syncDiamonds', (data) => {
    const p = players[socket.id];
    if (!p || !p.playerId) return;
    const newDiamonds = parseInt(data.diamonds);
    if (isNaN(newDiamonds) || newDiamonds < 0) return;
    if (playersDB[p.playerId]) {
      playersDB[p.playerId].diamonds = newDiamonds;
      savePlayersDB();
    }
  });

  // 👇 رویداد جدید برای ذخیره ماشین پارک شده
  socket.on('parkCar', (data) => {
    const p = players[socket.id];
    if (!p) return;
    p.parkedCarType = data.type;
    p.parkedCarX = data.x;
    p.parkedCarZ = data.z;
    p.parkedCarRot = data.rot;
  });

  socket.on('playerMovement', (data) => {
    if (!players[socket.id] || !data) return;
    const p = players[socket.id];
    if (!p.playerId) return;

    const ban = isBanned(p.playerId);
    if (ban) {
      socket.emit('youAreBanned', { until: ban.until, reason: ban.reason });
      setTimeout(() => socket.disconnect(true), 3000);
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
      vehicleType: p.vehicleType, skin: p.skin,
      parkedCarType: p.parkedCarType, // 👈 ارسال ماشین پارک شده
      parkedCarX: p.parkedCarX,
      parkedCarZ: p.parkedCarZ,
      parkedCarRot: p.parkedCarRot
    });
  });

  socket.on('transferCoins', (data) => {
    if (!data) return;
    const senderP = players[socket.id];
    const fromId = String(data.fromId || '');
    const toId = String(data.toId || '');
    const amount = Math.floor(Number(data.amount));

    if (!fromId || !toId || !amount || amount <= 0) return socket.emit('transferResult', { success: false, message: 'اطلاعات نامعتبر' });
    if (fromId === toId) return socket.emit('transferResult', { success: false, message: 'به خودت؟!' });
    if (amount < 100) return socket.emit('transferResult', { success: false, message: 'حداقل ۱۰۰ سکه' });
    if (senderP?.playerId !== fromId) return socket.emit('transferResult', { success: false, message: 'شناسه فرستنده ناهمخوان' });

    const targetSocketId = playerIdToSocket[toId];
    if (!targetSocketId) return socket.emit('transferResult', { success: false, message: 'گیرنده آنلاین نیست' });

    const senderName = senderP?.name || data.fromName || 'بازیکن';
    
    if (playersDB[fromId]) playersDB[fromId].coins = (playersDB[fromId].coins || 0) - amount;
    if (playersDB[toId]) playersDB[toId].coins = (playersDB[toId].coins || 0) + amount;
    savePlayersDB();

    io.to(targetSocketId).emit('receiveCoins', { fromId, fromName: senderName, toId, amount });
    socket.emit('transferResult', { success: true, amount, toId, message: 'انتقال انجام شد' });
  });

  socket.on('buyChest', () => {
    const p = players[socket.id];
    if (!p || !p.playerId) return;
    const pData = playersDB[p.playerId];
    if (!pData) return;

    const CHEST_COST = 100;
    if (pData.diamonds < CHEST_COST) return socket.emit('chestError', { message: '❌ الماس کافی نداری!' });

    pData.diamonds -= CHEST_COST;
    savePlayersDB();

    const coinsReward = Math.floor(Math.random() * 900) + 100;
    const diamondsReward = Math.floor(Math.random() * 90) + 10;
    
    pData.coins += coinsReward;
    pData.diamonds += diamondsReward;
    savePlayersDB();

    socket.emit('chestResult', {
      success: true, coins: pData.coins, diamonds: pData.diamonds,
      coinsReward: coinsReward, diamondsReward: diamondsReward
    });
  });

  socket.on('dropItem', (data) => {
    const p = players[socket.id];
    if (!p || !p.playerId) return;
    const itemType = data.itemType;

    if (!playersDB[p.playerId] || !playersDB[p.playerId].inventory) return;
    const currentCount = playersDB[p.playerId].inventory[itemType] || 0;
    if (currentCount <= 0) return;

    playersDB[p.playerId].inventory[itemType] = currentCount - 1;
    savePlayersDB();

    const itemId = 'item_' + Date.now() + '_' + Math.floor(Math.random() * 1000);
    const newItem = { id: itemId, type: itemType, x: data.x, z: data.z, dropperId: p.playerId, createdAt: Date.now() };
    droppedItems[itemId] = newItem;

    io.emit('itemDropped', newItem); // 👈 به همه بازیکن‌ها بگو

    setTimeout(() => {
      if (droppedItems[itemId]) {
        delete droppedItems[itemId];
        io.emit('itemPickedUp', { id: itemId });
      }
    }, 30000);
  });

  socket.on('pickupItem', (data) => {
    const p = players[socket.id];
    if (!p || !p.playerId) return;
    const item = droppedItems[data.id];
    if (!item) return;

    delete droppedItems[data.id];
    io.emit('itemPickedUp', { id: data.id, pickerId: p.playerId });
    
    if (!playersDB[p.playerId].inventory) playersDB[p.playerId].inventory = {};
    playersDB[p.playerId].inventory[item.type] = (playersDB[p.playerId].inventory[item.type] || 0) + 1;
    savePlayersDB();

    socket.emit('itemPicked', { type: item.type });
  });

  socket.on('chatMessage', (data) => {
    if (!data || typeof data.text !== 'string') return;
    const text = data.text.trim().slice(0, 120);
    if (!text) return;
    const p = players[socket.id];
    const name = (p?.name || data.name || 'ناشناس').slice(0, 15);
    io.emit('chatMessage', {
      id: p?.playerId || data.id || socket.id, name, text,
      hasBlueTick: !!(p?.hasBlueTick), time: Date.now()
    });
  });

  socket.on('policeGetOnlinePlayers', () => {
    const list = [];
    const p = players[socket.id];
    if (!p || !p.playerId) return;

    for (const sid in players) {
      const target = players[sid];
      if (!target.playerId) continue;
      const isMe = (target.playerId === p.playerId);
      const jail = jailedPlayers[target.playerId];
      const isJailed = jail && (jail.until === 0 || Date.now() < jail.until);
      list.push({ playerId: target.playerId, name: target.name, hasBlueTick: target.hasBlueTick, isMe: isMe, jailed: isJailed });
    }
    socket.emit('policeOnlinePlayersList', { list });
  });

  socket.on('policeJailPlayer', (data) => {
    const p = players[socket.id];
    if (!p || p.skin !== 'police') return;
    const targetId = String(data.targetId || '');
    const minutes = Number(data.durationMinutes) || 3;
    if (!targetId) return;

    const until = Date.now() + minutes * 60 * 1000;
    jailedPlayers[targetId] = { until };
    saveJails();

    const targetSocketId = playerIdToSocket[targetId];
    if (targetSocketId) {
      io.to(targetSocketId).emit('youAreJailed', { until, jailPos: { x: -80, z: -38 } });
      socket.emit('policeJailResult', { success: true, message: '✅ بازیکن زندانی شد' });
    } else {
      socket.emit('policeJailResult', { success: false, message: '❌ بازیکن آنلاین نیست' });
    }
  });

  socket.on('checkJailStatus', () => {
    const p = players[socket.id];
    if (!p || !p.playerId) return;
    const jail = jailedPlayers[p.playerId];
    if (jail && (jail.until === 0 || Date.now() < jail.until)) {
      socket.emit('youAreJailed', { until: jail.until, jailPos: { x: -80, z: -38 } });
    }
  });

  // ======================================================
  // ادمین
  // ======================================================
  socket.on('adminBan', (data) => {
    if (!data) return;
    const { password, targetId, durationMinutes, reason } = data;
    if (password !== OWNER_PASSWORD) return socket.emit('adminBanResult', { success: false, message: '❌ رمز مالک اشتباه' });
    const pid = String(targetId || '').trim();
    if (!pid) return socket.emit('adminBanResult', { success: false, message: '❌ شناسه خالی' });
    const minutes = Number(durationMinutes);
    if (isNaN(minutes) || minutes < 0) return socket.emit('adminBanResult', { success: false, message: '❌ مدت نامعتبر' });

    const until = minutes === 0 ? 0 : Date.now() + minutes * 60 * 1000;
    banPlayer(pid, until, reason || 'نقض قوانین');
    const targetOnline = !!playerIdToSocket[pid];
    socket.emit('adminBanResult', {
      success: true,
      message: minutes === 0 ? `✅ ${pid} برای همیشه بن شد` : `✅ ${pid} برای ${minutes} دقیقه بن شد`,
      targetId: pid, until, wasOnline: targetOnline
    });
  });

  socket.on('adminUnban', (data) => {
    if (!data) return;
    const { password, targetId } = data;
    if (password !== OWNER_PASSWORD) return socket.emit('adminUnbanResult', { success: false, message: '❌ رمز مالک اشتباه' });
    const pid = String(targetId || '').trim();
    if (!pid) return socket.emit('adminUnbanResult', { success: false, message: '❌ شناسه خالی' });
    const existed = unbanPlayer(pid);
    socket.emit('adminUnbanResult', {
      success: true, message: existed ? `✅ بن ${pid} برداشته شد` : `⚠️ ${pid} اصلاً بن نبود`, targetId: pid
    });
  });

  socket.on('adminGetBans', (data) => {
    if (!data || data.password !== OWNER_PASSWORD) return socket.emit('adminBansList', { success: false, list: [] });
    const now = Date.now();
    const list = Object.keys(bans).map(pid => {
      const b = bans[pid];
      return {
        playerId: pid, until: b.until,
        remainingMs: b.until === 0 ? -1 : Math.max(0, b.until - now),
        reason: b.reason, bannedAt: b.bannedAt, online: !!playerIdToSocket[pid]
      };
    });
    socket.emit('adminBansList', { success: true, list });
  });

  socket.on('adminGetAllPlayers', (data) => {
    if (!data || data.password !== OWNER_PASSWORD) return socket.emit('adminAllPlayersList', { success: false, list: [] });
    const list = Object.keys(playersDB).map(pid => {
      const p = playersDB[pid];
      return {
        playerId: pid, name: p.name, hasBlueTick: !!p.hasBlueTick,
        coins: p.coins || 0, firstSeen: p.firstSeen, lastSeen: p.lastSeen,
        online: !!playerIdToSocket[pid]
      };
    });
    list.sort((a, b) => (a.online !== b.online) ? (a.online ? -1 : 1) : (b.lastSeen - a.lastSeen));
    socket.emit('adminAllPlayersList', { success: true, list });
  });

  socket.on('disconnect', (reason) => {
    const p = players[socket.id];
    if (p?.playerId && playerIdToSocket[p.playerId] === socket.id) delete playerIdToSocket[p.playerId];
    delete players[socket.id];
    io.emit('playerDisconnected', socket.id);
  });
});

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
  
  let jailChanged = false;
  for (const pid in jailedPlayers) {
    if (jailedPlayers[pid].until !== 0 && now >= jailedPlayers[pid].until) {
      delete jailedPlayers[pid]; jailChanged = true;
      const sid = playerIdToSocket[pid];
      if (sid) io.to(sid).emit('youAreFreed');
    }
  }
  if (jailChanged) saveJails();
}, 30000);

server.listen(PORT, '0.0.0.0', () => console.log('🚀 Drive City on port', PORT));
