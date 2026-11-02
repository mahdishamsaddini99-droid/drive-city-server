const express = require('express');
const http = require('http');
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

const players = {}; // بازیکن‌های آنلاین
const playerData = {}; // اطلاعات بازیکن‌ها با شناسه یکتا

io.on('connection', (socket) => {
  console.log('Player connected:', socket.id);
  
  // ثبت اطلاعات بازیکن (اسم و شناسه)
  socket.on('setPlayerInfo', (info) => {
    if(!info.id || !info.name) return;
    socket.playerId = info.id;
    socket.playerName = info.name;
    
    if(!playerData[info.id]) {
      playerData[info.id] = { name: info.name, coins: 0, socketId: socket.id };
    } else {
      playerData[info.id].socketId = socket.id;
    }
    
    console.log(`👤 ${info.name} (${info.id}) وصل شد`);
    socket.emit('currentPlayers', players);
  });

  socket.on('playerMovement', (data) => {
    players[socket.id] = { ...data, id: socket.id };
    socket.broadcast.emit('playerMoved', players[socket.id]);
    socket.emit('playerMoved', players[socket.id]);
  });

  // انتقال سکه
  socket.on('transferCoins', (data) => {
    const { fromId, fromName, toId, amount } = data;
    
    console.log(`💰 تلاش انتقال: ${fromName} (${fromId}) → ${toId} : ${amount} سکه`);
    
    // اعتبارسنجی
    if(!fromId || !toId || !amount || amount <= 0) {
      socket.emit('transferResult', { success: false, message: 'اطلاعات نامعتبر' });
      return;
    }
    
    if(fromId === toId) {
      socket.emit('transferResult', { success: false, message: 'نمی‌تونی به خودت بفرستی' });
      return;
    }
    
    if(amount > 500000) {
      socket.emit('transferResult', { success: false, message: 'حداکثر ۵۰۰,۰۰۰ سکه در هر انتقال' });
      return;
    }
    
    // اضافه کردن به گیرنده
    if(!playerData[toId]) {
      playerData[toId] = { name: 'ناشناس', coins: 0, socketId: null };
    }
    playerData[toId].coins += amount;
    
    // اطلاع به فرستنده
    socket.emit('transferResult', { success: true, amount: amount });
    
    // اطلاع به گیرنده (اگه آنلاین باشه)
    const receiverSocketId = playerData[toId].socketId;
    if(receiverSocketId) {
      io.to(receiverSocketId).emit('receiveCoins', {
        toId: toId,
        amount: amount,
        fromName: fromName || 'یه بازیکن'
      });
    }
    
    console.log(`✅ انتقال انجام شد. موجودی ${toId}: ${playerData[toId].coins}`);
  });

  socket.on('disconnect', () => {
    console.log('Player disconnected:', socket.id);
    delete players[socket.id];
    socket.broadcast.emit('playerDisconnected', socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('Server on ' + PORT));
