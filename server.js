// ======================================================
// DRIVE CITY — سرور آنلاین (نسخه ۳)
// اکانت‌ها ذخیره می‌شن، ماشین‌های پارک‌شده و آیتم‌های روی زمین برای همه دیده می‌شن
// ======================================================
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const OWNER_PASSWORD = process.env.OWNER_PASSWORD || '1791';
const GOLD_PASSWORD = process.env.GOLD_PASSWORD || '5538';   // رمز پک طلایی
const ITEM_LIFETIME_MS = 5 * 60 * 1000;   // آیتم روی زمین چند دقیقه بمونه
const MAX_DROPPED_ITEMS = 300;
const ITEM_TYPES = ['carrot', 'cabbage', 'onion', 'egg', 'gem', 'shell', 'necklace'];
const PARKABLE_CARS = ['simple', 'tesla', 'challenger', 'cb1300', 'minibus'];

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
// ذخیره‌سازی دائمی (MongoDB Atlas) — بدون MONGODB_URI روی فایل (موقت)
// ======================================================
const { MongoClient } = require('mongodb');
const MONGODB_URI = process.env.MONGODB_URI || '';
const DATA_DIR = fs.existsSync('/data') ? '/data' : __dirname;
let kvCol = null;
const savers = [];

function readJson(file, fallback) {
  try {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8')) || fallback;
  } catch (e) { console.error('خطا در خوندن', file, e.message); }
  return fallback;
}

async function initStorage() {
  if (!MONGODB_URI) {
    console.warn('⚠️ MONGODB_URI تنظیم نشده! داده‌ها روی فایل ذخیره می‌شن و با ری‌استارت رندر پاک می‌شن.');
    return;
  }
  const client = new MongoClient(MONGODB_URI, { serverSelectionTimeoutMS: 20000 });
  await client.connect();
  kvCol = client.db(process.env.MONGODB_DB || 'drivecity').collection('kv');
  console.log('✅ به MongoDB وصل شد (ذخیره‌سازی دائمی)');
}

async function loadBlob(name, fallback) {
  if (kvCol) {
    const doc = await kvCol.findOne({ _id: name });
    if (doc && typeof doc.json === 'string') return JSON.parse(doc.json) || fallback;
  }
  return readJson(path.join(DATA_DIR, name + '.json'), fallback);
}

function makeSaver(name, getData) {
  let timer = null, chain = Promise.resolve();
  const write = () => {
    chain = chain.then(async () => {
      try {
        const json = JSON.stringify(getData());
        if (kvCol) await kvCol.replaceOne({ _id: name }, { _id: name, json, updatedAt: new Date() }, { upsert: true });
        else fs.writeFileSync(path.join(DATA_DIR, name + '.json'), json, 'utf8');
      } catch (e) { console.error('خطا در ذخیره', name, e.message); }
    });
    return chain;
  };
  savers.push(() => { if (timer) { clearTimeout(timer); timer = null; } return write(); });
  return () => {
    if (timer) return;
    timer = setTimeout(() => { timer = null; write(); }, 1500);
  };
}
async function flushAll() { await Promise.all(savers.map(f => f())); }
process.on('SIGTERM', () => { flushAll().finally(() => process.exit(0)); });
process.on('SIGINT', () => { flushAll().finally(() => process.exit(0)); });

let bans = {}, playersDB = {}, jailedPlayers = {}, usersDB = {};
// تا وقتی دیتا کامل لود نشده، هیچی ذخیره نمی‌شه (جلوگیری از پاک شدن دیتای قبلی)
let saveBans = () => {}, savePlayersDB = () => {}, saveJails = () => {}, saveUsers = () => {};

// ======================================================
// حافظه‌ی لحظه‌ای
// ======================================================
const players = {};            // socket.id -> اطلاعات بازیکن
const playerIdToSocket = {};   // playerId -> socket.id
const droppedItems = {};       // آیتم‌های روی زمین
const parkedCars = {};         // playerId -> ماشین پارک‌شده

// ======================================================
// اکانت
// ======================================================
function hashPassword(pw, salt) {
  return crypto.scryptSync(String(pw), salt, 32).toString('hex');
}
function checkPassword(user, pw) {
  const a = Buffer.from(hashPassword(pw, user.salt), 'hex');
  const b = Buffer.from(user.hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function newPlayerId() {
  const used = new Set(Object.values(usersDB).map(u => u.playerId));
  let id;
  do { id = String(Math.floor(10000000 + Math.random() * 90000000)); }
  while (used.has(id) || playersDB[id]);
  return id;
}

// ======================================================
// بن
// ======================================================
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
  if (playersDB[playerId]) { playersDB[playerId].coins = 0; savePlayersDB(); }
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
  if (!playerId) return false;
  let created = false;
  const now = Date.now();
  if (playersDB[playerId]) {
    playersDB[playerId].name = name;
    if (typeof hasBlueTick === 'boolean') playersDB[playerId].hasBlueTick = hasBlueTick;
    playersDB[playerId].lastSeen = now;
  } else {
    created = true;
    playersDB[playerId] = {
      playerId, name,
      hasBlueTick: !!hasBlueTick,
      coins: 0, diamonds: 0,
      inventory: { carrot: 0, cabbage: 0, onion: 0, egg: 0, gem: 0, shell: 0, necklace: 0 },
      firstSeen: now, lastSeen: now
    };
  }
  savePlayersDB();
  return created;
}

setInterval(() => {
  const now = Date.now(); let changed = false;
  for (const pid in bans) {
    if (bans[pid].until !== 0 && now >= bans[pid].until) { delete bans[pid]; changed = true; }
  }
  if (changed) saveBans();
}, 60000);

// ======================================================
// آیتم‌ها و ماشین‌های پارک‌شده
// ======================================================
function removeItem(id, pickerId, type) {
  if (!droppedItems[id]) return false;
  delete droppedItems[id];
  io.emit('itemPickedUp', { id, pickerId, type });
  return true;
}

let goldFails = [];
function goldPwOk(pw) {
  const now = Date.now();
  goldFails = goldFails.filter(t => now - t < 60000);
  if (goldFails.length >= 8) return false;
  if (pw === GOLD_PASSWORD) return true;
  goldFails.push(now);
  return false;
}

function isDriving(vehicleType) {
  return !!vehicleType && vehicleType !== 'walking' && vehicleType !== 'jetski';
}

function removePlayer(sid) {
  const p = players[sid];
  if (!p) return;
  if (p.playerId && playerIdToSocket[p.playerId] === sid) {
    delete playerIdToSocket[p.playerId];
    if (parkedCars[p.playerId]) {
      delete parkedCars[p.playerId];
      io.emit('carUnparked', { ownerId: p.playerId });
    }
  }
  delete players[sid];
  io.emit('playerDisconnected', sid);
}

// ثبت بازیکن روی سوکت (هم از لاگین، هم از setPlayerInfo)
function registerPlayer(socket, playerId, name, hasBlueTick, sendState) {
  const p = players[socket.id];
  if (!p) return false;

  const ban = isBanned(playerId);
  if (ban) {
    socket.emit('youAreBanned', { until: ban.until, reason: ban.reason });
    setTimeout(() => socket.disconnect(true), 4000);
    return false;
  }

  if (playerIdToSocket[playerId] && playerIdToSocket[playerId] !== socket.id) {
    delete playerIdToSocket[playerId];
  }

  const created = recordPlayer(playerId, name, hasBlueTick);

  const first = p.playerId !== playerId;
  p.playerId = playerId;
  p.name = name;
  if (typeof hasBlueTick === 'boolean') p.hasBlueTick = hasBlueTick;
  playerIdToSocket[playerId] = socket.id;

  const pData = playersDB[playerId];
  p.goldName = !!pData.goldName;
  socket.emit('goldStatus', { gold: p.goldName });
  if (sendState && !created) {   // بازیکن جدید: سکه‌ی خودش توی گوشیه، با صفر جایگزین نمی‌شه
    socket.emit('updateCoins', { coins: pData.coins || 0 });
    socket.emit('updateDiamonds', { diamonds: pData.diamonds || 0 });
    socket.emit('updateInventory', { inventory: pData.inventory });
    p.syncLockUntil = Date.now() + 4000;   // چند ثانیه‌ی اول، سکه‌ی کهنه‌ی گوشی روی سرور نوشته نشه
  }

  const currentPlayers = {};
  for (const id in players) {
    if (id !== socket.id && players[id].playerId) currentPlayers[id] = players[id];
  }
  socket.emit('currentPlayers', currentPlayers);
  socket.emit('parkedCars', Object.values(parkedCars));
  socket.emit('currentItems', Object.values(droppedItems));

  if (first) {
    socket.broadcast.emit('newPlayer', socket.id);
    socket.broadcast.emit('systemMessage', name + ' وارد بازی شد');
  }
  return true;
}

// ======================================================
// HTTP
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
    x: 0, y: 0, z: 0, rotation: 0, vehicleType: 'walking', skin: 'boy',
    lastSeen: Date.now(), lastDropAt: 0
  };

  // ---------- اکانت ----------
  socket.on('accountLogin', (data) => {
    if (!data) return;
    const username = String(data.username || '').trim().slice(0, 15);
    const password = String(data.password || '');
    if (username.length < 2) return socket.emit('accountError', 'نام کاربری خیلی کوتاهه');
    if (password.length < 4 || password.length > 64) return socket.emit('accountError', 'رمز باید حداقل ۴ حرف باشه');

    let user = usersDB[username];
    if (user) {
      if (!checkPassword(user, password)) return socket.emit('accountError', 'رمز عبور اشتباه است!');
    } else {
      const salt = crypto.randomBytes(16).toString('hex');
      user = usersDB[username] = {
        salt, hash: hashPassword(password, salt),
        playerId: newPlayerId(), createdAt: Date.now()
      };
      saveUsers();
    }
    socket.emit('accountSuccess', { username, playerId: user.playerId });
    registerPlayer(socket, user.playerId, username, undefined, false);
  });

  socket.on('setPlayerInfo', (data) => {
    if (!players[socket.id] || !data) return;
    const playerId = String(data.id || '').slice(0, 16);
    const name = String(data.name || 'ناشناس').slice(0, 15);
    if (!playerId) return;
    registerPlayer(socket, playerId, name, data.hasBlueTick, !data.keepLocal);
  });

  // ---------- سکه و الماس ----------
  socket.on('syncCoins', (data) => {
    const p = players[socket.id];
    if (!p || !p.playerId || !data) return;
    if (Date.now() < (p.syncLockUntil || 0)) return;
    const newCoins = parseInt(data.coins);
    if (isNaN(newCoins) || newCoins < 0) return;
    if (playersDB[p.playerId]) { playersDB[p.playerId].coins = newCoins; savePlayersDB(); }
  });

  socket.on('syncDiamonds', (data) => {
    const p = players[socket.id];
    if (!p || !p.playerId || !data) return;
    if (Date.now() < (p.syncLockUntil || 0)) return;
    const newDiamonds = parseInt(data.diamonds);
    if (isNaN(newDiamonds) || newDiamonds < 0) return;
    if (playersDB[p.playerId]) { playersDB[p.playerId].diamonds = newDiamonds; savePlayersDB(); }
  });

  // ---------- ماشین پارک‌شده ----------
  socket.on('parkCar', (data) => {
    const p = players[socket.id];
    if (!p || !p.playerId || !data) return;
    const type = String(data.type || '');
    if (!PARKABLE_CARS.includes(type)) return;   // جت‌اسکی پارک نمی‌شه
    const x = Number(data.x), z = Number(data.z), rot = Number(data.rot);
    if (![x, z, rot].every(Number.isFinite)) return;
    const car = { ownerId: p.playerId, type, x, z, rot };
    parkedCars[p.playerId] = car;
    socket.broadcast.emit('carParked', car);
  });

  // ---------- حرکت ----------
  socket.on('playerMovement', (data) => {
    const p = players[socket.id];
    if (!p || !data || !p.playerId) return;

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
    p.vehicleType = String(data.vehicleType || 'walking');
    p.skin = String(data.skin || 'boy');
    if (typeof data.name === 'string' && data.name.trim()) p.name = data.name.slice(0, 15);
    if (typeof data.hasBlueTick === 'boolean') p.hasBlueTick = data.hasBlueTick;
    p.lastSeen = Date.now();

    // وقتی دوباره سوار ماشینش شد، ماشین پارک‌شده برداشته می‌شه
    if (isDriving(p.vehicleType) && parkedCars[p.playerId]) {
      delete parkedCars[p.playerId];
      socket.broadcast.emit('carUnparked', { ownerId: p.playerId });
    }

    socket.broadcast.emit('playerMoved', {
      id: socket.id, playerId: p.playerId, name: p.name, hasBlueTick: p.hasBlueTick,
      x: p.x, y: p.y, z: p.z, rotation: p.rotation,
      vehicleType: p.vehicleType, skin: p.skin, goldName: !!p.goldName
    });
  });

  // ---------- انتقال سکه ----------
  socket.on('transferCoins', (data) => {
    if (!data) return;
    const senderP = players[socket.id];
    const fromId = String(data.fromId || '');
    const toId = String(data.toId || '');
    const amount = Math.floor(Number(data.amount));

    if (!fromId || !toId || !amount || amount <= 0) return socket.emit('transferResult', { success: false, message: 'اطلاعات نامعتبر' });
    if (fromId === toId) return socket.emit('transferResult', { success: false, message: 'به خودت؟!' });
    if (amount < 100) return socket.emit('transferResult', { success: false, message: 'حداقل ۱۰۰ سکه' });
    if (!senderP || senderP.playerId !== fromId) return socket.emit('transferResult', { success: false, message: 'شناسه فرستنده ناهمخوان' });

    const targetSocketId = playerIdToSocket[toId];
    if (!targetSocketId) return socket.emit('transferResult', { success: false, message: 'گیرنده آنلاین نیست' });

    const senderName = senderP.name || data.fromName || 'بازیکن';
    if (playersDB[fromId]) playersDB[fromId].coins = (playersDB[fromId].coins || 0) - amount;
    if (playersDB[toId]) playersDB[toId].coins = (playersDB[toId].coins || 0) + amount;
    savePlayersDB();

    io.to(targetSocketId).emit('receiveCoins', { fromId, fromName: senderName, toId, amount });
    socket.emit('transferResult', { success: true, amount, toId, message: 'انتقال انجام شد' });
  });

  // ---------- صندوق ----------
  socket.on('buyChest', () => {
    const p = players[socket.id];
    if (!p || !p.playerId) return;
    const pData = playersDB[p.playerId];
    if (!pData) return;

    const CHEST_COST = 100;
    if ((pData.diamonds || 0) < CHEST_COST) return socket.emit('chestError', { message: '❌ الماس کافی نداری!' });

    pData.diamonds -= CHEST_COST;
    const coinsReward = Math.floor(Math.random() * 900) + 100;
    const diamondsReward = Math.floor(Math.random() * 90) + 10;
    pData.coins = (pData.coins || 0) + coinsReward;
    pData.diamonds += diamondsReward;
    savePlayersDB();

    socket.emit('chestResult', {
      success: true, coins: pData.coins, diamonds: pData.diamonds,
      coinsReward, diamondsReward
    });
  });

  // ---------- آیتم‌های روی زمین ----------
  socket.on('dropItem', (data) => {
    const p = players[socket.id];
    if (!p || !p.playerId || !data) return;
    const itemType = String(data.itemType || '');
    if (!ITEM_TYPES.includes(itemType)) return;
    const x = Number(data.x), z = Number(data.z);
    if (!Number.isFinite(x) || !Number.isFinite(z)) return;

    const now = Date.now();
    if (now - p.lastDropAt < 300) return;
    p.lastDropAt = now;

    // موجودی سرور فقط برای آمار، جلوی انداختن رو نمی‌گیره (موجودی توی بازی نگه‌داری می‌شه)
    const inv = playersDB[p.playerId] && playersDB[p.playerId].inventory;
    if (inv && inv[itemType] > 0) { inv[itemType]--; savePlayersDB(); }

    const ids = Object.keys(droppedItems);
    if (ids.length >= MAX_DROPPED_ITEMS) removeItem(ids[0]);

    const id = 'item_' + now + '_' + crypto.randomBytes(3).toString('hex');
    const item = { id, type: itemType, x, z, dropperId: p.playerId, createdAt: now };
    droppedItems[id] = item;
    io.emit('itemDropped', item);

    setTimeout(() => removeItem(id), ITEM_LIFETIME_MS);
  });

  socket.on('pickupItem', (data) => {
    const p = players[socket.id];
    if (!p || !p.playerId || !data) return;
    const item = droppedItems[data.id];
    if (!item) return;
    if (Math.hypot(p.x - item.x, p.z - item.z) > 10) return;   // باید نزدیکش باشی

    removeItem(item.id, p.playerId, item.type);

    const pdb = playersDB[p.playerId];
    if (pdb) {
      pdb.inventory = pdb.inventory || {};
      pdb.inventory[item.type] = (pdb.inventory[item.type] || 0) + 1;
      savePlayersDB();
    }
    socket.emit('itemPicked', { type: item.type });
  });

  // ---------- چت ----------
  socket.on('chatMessage', (data) => {
    if (!data || typeof data.text !== 'string') return;
    const text = data.text.trim().slice(0, 120);
    if (!text) return;
    const p = players[socket.id];
    const name = String((p && p.name) || data.name || 'ناشناس').slice(0, 15);
    io.emit('chatMessage', {
      id: (p && p.playerId) || data.id || socket.id, name, text,
      hasBlueTick: !!(p && p.hasBlueTick), goldName: !!(p && p.goldName), time: Date.now()
    });
  });

  // ---------- پلیس ----------
  socket.on('policeGetOnlinePlayers', () => {
    const p = players[socket.id];
    if (!p || !p.playerId) return;
    const list = [];
    for (const sid in players) {
      const target = players[sid];
      if (!target.playerId) continue;
      const jail = jailedPlayers[target.playerId];
      const isJailed = !!jail && (jail.until === 0 || Date.now() < jail.until);
      list.push({
        playerId: target.playerId, name: target.name, hasBlueTick: target.hasBlueTick,
        isMe: target.playerId === p.playerId, jailed: isJailed
      });
    }
    socket.emit('policeOnlinePlayersList', { list });
  });

  socket.on('policeJailPlayer', (data) => {
    const p = players[socket.id];
    if (!p || p.skin !== 'police' || !data) return;
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

  // ---------- پک طلایی (اسم طلایی) ----------
  socket.on('adminGoldAuth', (data) => {
    socket.emit('adminGoldAuthResult', { ok: !!data && goldPwOk(data.password) });
  });

  socket.on('adminSetGold', (data) => {
    if (!data || !goldPwOk(data.password)) return socket.emit('adminGoldResult', { success: false, message: '❌ رمز اشتباه' });
    const pid = String(data.targetId || '').trim();
    if (!pid) return socket.emit('adminGoldResult', { success: false, message: '❌ شناسه خالی' });
    const rec = playersDB[pid];
    if (!rec) return socket.emit('adminGoldResult', { success: false, message: '❌ بازیکنی با این شناسه پیدا نشد' });

    const gold = !!data.gold;
    rec.goldName = gold;
    savePlayersDB();

    const sid = playerIdToSocket[pid];
    if (sid && players[sid]) {
      players[sid].goldName = gold;
      io.to(sid).emit('goldChanged', { playerId: pid, gold });
    }
    socket.emit('adminGoldResult', {
      success: true, gold,
      message: gold ? `✅ اسم «${rec.name}» طلایی شد` : `✅ پک طلایی «${rec.name}» برداشته شد`
    });
  });

  // ---------- ادمین ----------
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
    socket.emit('adminBanResult', {
      success: true,
      message: minutes === 0 ? `✅ ${pid} برای همیشه بن شد` : `✅ ${pid} برای ${minutes} دقیقه بن شد`,
      targetId: pid, until, wasOnline: !!playerIdToSocket[pid]
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

  socket.on('disconnect', () => removePlayer(socket.id));
});

// پاکسازی بازیکن‌های ساکت و آزاد کردن زندانی‌ها
setInterval(() => {
  const now = Date.now();
  for (const id in players) {
    if (now - players[id].lastSeen > 120000) removePlayer(id);
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

(async () => {
  await initStorage();
  bans = await loadBlob('bans', {});
  playersDB = await loadBlob('players', {});
  jailedPlayers = await loadBlob('jail', {});
  usersDB = await loadBlob('users', {});
  saveBans = makeSaver('bans', () => bans);
  savePlayersDB = makeSaver('players', () => playersDB);
  saveJails = makeSaver('jail', () => jailedPlayers);
  saveUsers = makeSaver('users', () => usersDB);
  saveBans(); savePlayersDB(); saveJails(); saveUsers();   // اگه دیتای فایل بود، منتقل بشه
  console.log('📦 بازیکن‌ها:', Object.keys(playersDB).length, '| اکانت‌ها:', Object.keys(usersDB).length);
  server.listen(PORT, '0.0.0.0', () => console.log('🚀 Drive City on port', PORT));
})().catch(e => {
  console.error('❌ راه‌اندازی ناموفق (سرور عمداً بالا نمیاد تا دیتا پاک نشه):', e);
  process.exit(1);
});
