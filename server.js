const express = require('express');
const http = require('http');
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

const players = {};

io.on('connection', (socket) => {
  console.log('Player connected:', socket.id);
  players[socket.id] = { x: 0, y: 0, z: 0, rotation: 0, vehicleType: 'walking' };

  socket.on('playerMovement', (data) => {
    players[socket.id] = { ...data, id: socket.id };
    socket.broadcast.emit('playerMoved', players[socket.id]);
  });

  socket.on('disconnect', () => {
    delete players[socket.id];
    socket.broadcast.emit('playerDisconnected', socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('Server on ' + PORT));
