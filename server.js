const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');
const bcrypt = require('bcrypt');
const fs = require('fs');
const nodemailer = require('nodemailer');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

const rooms = {};
const RECONNECT_TIMEOUT = 30000;
const USERS_FILE = path.join(__dirname, 'users.json');

const connectedUsers = {};
const passwordResetTokens = {};

// ==================== DATABASE ====================
function loadUsers() {
  try {
    if (fs.existsSync(USERS_FILE)) {
      const data = fs.readFileSync(USERS_FILE, 'utf8');
      return JSON.parse(data);
    }
  } catch (error) {
    console.error('[DB] Error loading users:', error);
  }
  return {};
}

function saveUsers(users) {
  try {
    fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2), 'utf8');
  } catch (error) {
    console.error('[DB] Error saving users:', error);
  }
}

let users = loadUsers();

// ==================== AUTH ENDPOINTS ====================
app.post('/api/register', async (req, res) => {
  const { username, password, email } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required' });
  }
  const normalizedUsername = username.toLowerCase();
  if (normalizedUsername.length < 3 || normalizedUsername.length > 20) {
    return res.status(400).json({ error: 'Username must be 3-20 characters' });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters' });
  }
  if (users[normalizedUsername]) {
    return res.status(400).json({ error: 'Username already exists' });
  }
  try {
    const hashedPassword = await bcrypt.hash(password, 10);
    users[normalizedUsername] = {
      password: hashedPassword,
      wins: 0, losses: 0, activeRoom: null,
      createdAt: new Date().toISOString(),
      email: email || null,
      friends: [], friendRequests: []
    };
    saveUsers(users);
    console.log(`[Auth] New user registered: ${normalizedUsername}`);
    res.json({ success: true, username: normalizedUsername });
  } catch (error) {
    console.error('[Auth] Registration error:', error);
    res.status(500).json({ error: 'Registration failed' });
  }
});

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required' });
  }
  const normalizedUsername = username.toLowerCase();
  const user = users[normalizedUsername];
  if (!user) {
    return res.status(401).json({ error: 'Invalid username or password' });
  }
  try {
    const validPassword = await bcrypt.compare(password, user.password);
    if (!validPassword) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }
    if (user.activeRoom && !rooms[user.activeRoom]) {
      user.activeRoom = null;
      saveUsers(users);
    }
    console.log(`[Auth] User logged in: ${normalizedUsername}`);
    res.json({
      success: true,
      username: normalizedUsername,
      stats: { wins: user.wins, losses: user.losses },
      activeRoom: user.activeRoom,
      email: user.email || null,
      needsEmail: !user.email
    });
  } catch (error) {
    console.error('[Auth] Login error:', error);
    res.status(500).json({ error: 'Login failed' });
  }
});

app.get('/api/user/:username', (req, res) => {
  const { username } = req.params;
  const normalizedUsername = username.toLowerCase();
  const user = users[normalizedUsername];
  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }
  if (user.activeRoom && !rooms[user.activeRoom]) {
    user.activeRoom = null;
    saveUsers(users);
  }
  res.json({
    username: normalizedUsername,
    stats: { wins: user.wins, losses: user.losses },
    activeRoom: user.activeRoom,
    email: user.email || null,
    needsEmail: !user.email
  });
});

app.get('/api/check-room/:roomCode', (req, res) => {
  res.json({ exists: !!rooms[req.params.roomCode] });
});

app.post('/api/clear-active-room', (req, res) => {
  const { username } = req.body;
  if (!username) return res.status(400).json({ error: 'Username is required' });
  const normalizedUsername = username.toLowerCase();
  if (users[normalizedUsername]) {
    users[normalizedUsername].activeRoom = null;
    saveUsers(users);
  }
  res.json({ success: true });
});

app.post('/api/update-email', (req, res) => {
  const { username, email } = req.body;
  if (!username || !email) {
    return res.status(400).json({ error: 'Username and email are required' });
  }
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) {
    return res.status(400).json({ error: 'Invalid email format' });
  }
  const normalizedUsername = username.toLowerCase();
  if (!users[normalizedUsername]) {
    return res.status(404).json({ error: 'User not found' });
  }
  users[normalizedUsername].email = email.toLowerCase();
  saveUsers(users);
  console.log(`[Email] Email saved for ${normalizedUsername}: ${email}`);
  res.json({ success: true });
});

// ==================== FRIEND SYSTEM ====================
app.post('/api/send-friend-request', (req, res) => {
  const { username, friendUsername } = req.body;
  if (!username || !friendUsername) {
    return res.status(400).json({ error: 'Usernames required' });
  }
  const normalizedUser = username.toLowerCase();
  const normalizedFriend = friendUsername.toLowerCase();
  if (normalizedUser === normalizedFriend) {
    return res.status(400).json({ error: 'Cannot add yourself' });
  }
  if (!users[normalizedUser] || !users[normalizedFriend]) {
    return res.status(404).json({ error: 'User not found' });
  }
  users[normalizedUser].friends = users[normalizedUser].friends || [];
  users[normalizedFriend].friends = users[normalizedFriend].friends || [];
  users[normalizedFriend].friendRequests = users[normalizedFriend].friendRequests || [];
  if (users[normalizedUser].friends.includes(normalizedFriend)) {
    return res.status(400).json({ error: 'Already friends' });
  }
  if (users[normalizedFriend].friendRequests.includes(normalizedUser)) {
    return res.status(400).json({ error: 'Request already sent' });
  }
  users[normalizedFriend].friendRequests.push(normalizedUser);
  saveUsers(users);
  if (connectedUsers[normalizedFriend]) {
    io.to(connectedUsers[normalizedFriend].socketId).emit('friend_request_received', { from: normalizedUser });
  }
  console.log(`[Friends] ${normalizedUser} sent friend request to ${normalizedFriend}`);
  res.json({ success: true });
});

app.post('/api/handle-friend-request', (req, res) => {
  const { username, requestFrom, action } = req.body;
  if (!username || !requestFrom || !action) {
    return res.status(400).json({ error: 'Missing fields' });
  }
  const normalizedUser = username.toLowerCase();
  const normalizedFrom = requestFrom.toLowerCase();
  if (!users[normalizedUser]) {
    return res.status(404).json({ error: 'User not found' });
  }
  users[normalizedUser].friendRequests = users[normalizedUser].friendRequests || [];
  const reqIndex = users[normalizedUser].friendRequests.indexOf(normalizedFrom);
  if (reqIndex === -1) {
    return res.status(400).json({ error: 'Request not found' });
  }
  users[normalizedUser].friendRequests.splice(reqIndex, 1);
  if (action === 'accept') {
    users[normalizedUser].friends = users[normalizedUser].friends || [];
    users[normalizedFrom].friends = users[normalizedFrom].friends || [];
    if (!users[normalizedUser].friends.includes(normalizedFrom)) {
      users[normalizedUser].friends.push(normalizedFrom);
    }
    if (!users[normalizedFrom].friends.includes(normalizedUser)) {
      users[normalizedFrom].friends.push(normalizedUser);
    }
  }
  saveUsers(users);
  res.json({ success: true });
});

app.get('/api/friend-requests/:username', (req, res) => {
  const { username } = req.params;
  const normalizedUsername = username.toLowerCase();
  const user = users[normalizedUsername];
  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }
  res.json({ requests: user.friendRequests || [] });
});

app.get('/api/friends/:username', (req, res) => {
  const { username } = req.params;
  const normalizedUsername = username.toLowerCase();
  const user = users[normalizedUsername];
  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }
  const friends = (user.friends || []).map(f => {
    const status = connectedUsers[f] ? connectedUsers[f].status : 'offline';
    return { username: f, status };
  });
  res.json({ friends });
});

// ==================== FORGOT PASSWORD ====================
app.post('/api/forgot-password', async (req, res) => {
  const { username } = req.body;
  if (!username) {
    return res.status(400).json({ error: 'Username is required' });
  }
  const normalizedUsername = username.toLowerCase();
  const user = users[normalizedUsername];
  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }
  if (!user.email) {
    return res.status(400).json({ error: 'No email registered' });
  }
  const code = Math.floor(100000 + Math.random() * 900000).toString();
  passwordResetTokens[normalizedUsername] = {
    code,
    expiresAt: Date.now() + 10 * 60 * 1000,
    email: user.email
  };
  try {
    if (!process.env.GMAIL_USER || !process.env.GMAIL_APP_PASSWORD) {
      throw new Error('Email not configured');
    }
    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: process.env.GMAIL_USER,
        pass: process.env.GMAIL_APP_PASSWORD
      }
    });
    await transporter.sendMail({
      from: `"Chips Game" <${process.env.GMAIL_USER}>`,
      to: user.email,
      subject: 'Password Reset Code',
      html: `<div style="font-family: Arial; text-align: center;"><h2>Chips Game</h2><p>Your code:</p><h1>${code}</h1><p>Expires in 10 minutes.</p></div>`
    });
    console.log(`[Email] Reset code sent to ${user.email}`);
    res.json({ success: true });
  } catch (error) {
    console.error('[Email] Send error:', error);
    res.status(500).json({ error: 'Failed to send email' });
  }
});

app.post('/api/reset-password', async (req, res) => {
  const { username, code, newPassword } = req.body;
  if (!username || !code || !newPassword) {
    return res.status(400).json({ error: 'All fields required' });
  }
  const normalizedUsername = username.toLowerCase();
  const token = passwordResetTokens[normalizedUsername];
  if (!token || Date.now() > token.expiresAt || token.code !== code) {
    return res.status(400).json({ error: 'Invalid or expired code' });
  }
  if (newPassword.length < 6) {
    return res.status(400).json({ error: 'Password too short' });
  }
  try {
    users[normalizedUsername].password = await bcrypt.hash(newPassword, 10);
    saveUsers(users);
    delete passwordResetTokens[normalizedUsername];
    console.log(`[Auth] Password reset for ${normalizedUsername}`);
    res.json({ success: true });
  } catch (error) {
    console.error('[Auth] Reset error:', error);
    res.status(500).json({ error: 'Failed to reset' });
  }
});

// ==================== SOCKET.IO HELPERS ====================
function generateRoomCode() {
  return Math.random().toString(36).substring(2, 7).toUpperCase();
}

function findPlayerByUsername(room, username) {
  return room.players.find(p => p.username === username);
}

function broadcastPlayersList(room) {
  io.to(room.code).emit('update_players_list', {
    players: room.players.map(p => ({
      id: p.id,
      username: p.username,
      ready: p.ready,
      isOwner: p.username === room.owner
    })),
    owner: room.owner
  });
}

function emitToRoom(room, event, data) {
  room.players.forEach(p => {
    io.to(p.id).emit(event, data);
  });
}

function updateFriendStatus(username, status) {
  if (connectedUsers[username]) {
    connectedUsers[username].status = status;
    const user = users[username];
    if (user && user.friends) {
      user.friends.forEach(friend => {
        if (connectedUsers[friend]) {
          io.to(connectedUsers[friend].socketId).emit('friend_status_update', { username, status });
        }
      });
    }
  }
}

// ==================== SOCKET.IO MAIN ====================
io.on('connection', (socket) => {
  console.log(`[+] User connected: ${socket.id}`);

  // 🔥 User logged in notification
  socket.on('user_logged_in', ({ username }) => {
    connectedUsers[username] = { socketId: socket.id, status: 'main' };
    socket.username = username;
    const user = users[username];
    if (user && user.friends) {
      user.friends.forEach(friend => {
        if (connectedUsers[friend]) {
          io.to(connectedUsers[friend].socketId).emit('friend_status_update', { username, status: 'main' });
        }
      });
    }
    console.log(`[Friends] ${username} online (Main)`);
  });

  // 🔥 Chip preview
  socket.on('chip_preview', ({ chipIndex }) => {
    const room = rooms[socket.roomCode];
    if (!room || room.state !== 'PLAYING') return;
    const opponent = room.players.find(p => p.id !== socket.id);
    if (opponent) {
      io.to(opponent.id).emit('opponent_chip_preview', { chipIndex, playerId: socket.id });
    }
  });

  socket.on('chip_preview_cleared', () => {
    const room = rooms[socket.roomCode];
    if (!room) return;
    const opponent = room.players.find(p => p.id !== socket.id);
    if (opponent) {
      io.to(opponent.id).emit('opponent_chip_preview_cleared', { playerId: socket.id });
    }
  });

  // 🔥 Invite friend
  socket.on('invite_friend', ({ friendUsername }) => {
    const normalizedFriend = friendUsername.toLowerCase();
    if (connectedUsers[normalizedFriend] && socket.roomCode) {
      io.to(connectedUsers[normalizedFriend].socketId).emit('friend_invite', {
        from: socket.username,
        roomCode: socket.roomCode
      });
      console.log(`[Invite] ${socket.username} invited ${normalizedFriend} to room ${socket.roomCode}`);
    }
  });

  // ==================== RECONNECT ====================
  socket.on('reconnect_to_game', ({ roomCode, username }) => {
    const room = rooms[roomCode];
    if (!room) {
      if (users[username]) {
        users[username].activeRoom = null;
        saveUsers(users);
      }
      return socket.emit('reconnect_failed', { message: 'Lobby not found' });
    }

    const player = findPlayerByUsername(room, username);
    if (!player) {
      if (users[username]) {
        users[username].activeRoom = null;
        saveUsers(users);
      }
      return socket.emit('reconnect_failed', { message: 'Not in this lobby' });
    }

    const oldSocketId = player.id;
    player.id = socket.id;

    if (room.health[oldSocketId] !== undefined) {
      room.health[socket.id] = room.health[oldSocketId];
      delete room.health[oldSocketId];
    }
    if (room.eatenChips[oldSocketId] !== undefined) {
      room.eatenChips[socket.id] = room.eatenChips[oldSocketId];
      delete room.eatenChips[oldSocketId];
    } else {
      room.eatenChips[socket.id] = [];
    }
    if (room.poisons[oldSocketId] !== undefined) {
      room.poisons[socket.id] = room.poisons[oldSocketId];
      delete room.poisons[oldSocketId];
    }

    if (room.currentTurn === oldSocketId) {
      room.currentTurn = socket.id;
    }

    socket.join(roomCode);
    socket.roomCode = roomCode;
    socket.playerIndex = room.players.findIndex(p => p.id === socket.id);
    socket.username = username;

    console.log(`[Reconnect] ${username} reconnected to room ${roomCode}`);

    if (room.reconnectTimeout) {
      clearTimeout(room.reconnectTimeout);
      room.reconnectTimeout = null;
    }

    socket.to(roomCode).emit('opponent_reconnected', { username });

    // 🔥 FIX: آپدیت poisonStartTime قبل از محاسبه timeLeft
    let restoredTimeLeft = 30;
    if (room.state === 'POISON_PHASE' && room.poisonPaused) {
      const elapsedBeforePause = (room.poisonPausedAt - room.poisonStartTime) / 1000;
      restoredTimeLeft = Math.max(0, Math.ceil(room.poisonDuration - elapsedBeforePause));

      // آپدیت poisonStartTime قبل از هر محاسبه دیگه
      room.poisonStartTime = Date.now() - (elapsedBeforePause * 1000);
      room.poisonPaused = false;
      room.poisonPausedAt = null;

      // حالا به User1 بگو resume کنه
      socket.to(roomCode).emit('resume_poison_timer', { timeLeft: restoredTimeLeft });
      console.log(`[Timer] Poison timer resumed with ${restoredTimeLeft}s`);
    } else if (room.state === 'POISON_PHASE' && room.poisonStartTime) {
      const elapsed = (Date.now() - room.poisonStartTime) / 1000;
      restoredTimeLeft = Math.max(0, Math.ceil(room.poisonDuration - elapsed));
    }

    broadcastPlayersList(room);

    const currentTurnPlayer = room.players.find(p => p.id === room.currentTurn);

    socket.emit('game_state_restored', {
      state: room.state,
      players: room.players.map(p => ({
        id: p.id,
        username: p.username,
        ready: p.ready,
        isOwner: p.username === room.owner
      })),
      owner: room.owner,
      myHealth: room.health[socket.id] || 3,
      currentTurnUsername: currentTurnPlayer ? currentTurnPlayer.username : null,
      myEatenChips: room.eatenChips[socket.id] || [],
      roomCode: room.code,
      myUsername: username,
      timeLeft: restoredTimeLeft
    });
  });

  // ==================== ROOM MANAGEMENT ====================
  socket.on('create_room', (username) => {
    if (users[username] && users[username].activeRoom) {
      users[username].activeRoom = null;
      saveUsers(users);
    }
    const roomCode = generateRoomCode();
    rooms[roomCode] = {
      code: roomCode,
      owner: username,
      players: [{ id: socket.id, username: username, ready: false }],
      state: 'LOBBY',
      poisons: {},
      health: {},
      eatenChips: {},
      currentTurn: null,
      timerInterval: null,
      playAgainVotes: {},
      reconnectTimeout: null,
      poisonStartTime: null,
      poisonDuration: 30,
      poisonPaused: false,
      poisonPausedAt: null
    };

    socket.join(roomCode);
    socket.roomCode = roomCode;
    socket.playerIndex = 0;
    socket.username = username;

    if (users[username]) {
      users[username].activeRoom = roomCode;
      saveUsers(users);
    }

    updateFriendStatus(username, 'room');

    console.log(`[Room] Room ${roomCode} created by ${username}`);
    socket.emit('room_created', { roomCode, playerIndex: 0, owner: username });
    broadcastPlayersList(rooms[roomCode]);
  });

  socket.on('join_room', ({ roomCode, username }) => {
    const room = rooms[roomCode];
    if (!room) {
      return socket.emit('error', { message: 'Lobby not found' });
    }
    if (room.players.length >= 2) {
      return socket.emit('error', { message: 'Lobby is full' });
    }

    if (users[username] && users[username].activeRoom && users[username].activeRoom !== roomCode) {
      const oldRoom = rooms[users[username].activeRoom];
      if (oldRoom) {
        const oldPlayerIndex = oldRoom.players.findIndex(p => p.username === username);
        if (oldPlayerIndex !== -1) {
          oldRoom.players.splice(oldPlayerIndex, 1);
          if (oldRoom.players.length === 0) {
            delete rooms[users[username].activeRoom];
          } else {
            io.to(users[username].activeRoom).emit('player_left', { username });
            broadcastPlayersList(oldRoom);
            if (oldRoom.owner === username && oldRoom.players.length > 0) {
              oldRoom.owner = oldRoom.players[0].username;
              broadcastPlayersList(oldRoom);
            }
          }
        }
      }
      users[username].activeRoom = null;
      saveUsers(users);
    }

    if (socket.roomCode && rooms[socket.roomCode]) {
      const oldRoom = rooms[socket.roomCode];
      const oldPlayerIndex = oldRoom.players.findIndex(p => p.id === socket.id);
      if (oldPlayerIndex !== -1) {
        oldRoom.players.splice(oldPlayerIndex, 1);
        socket.leave(socket.roomCode);
        if (oldRoom.players.length === 0) {
          delete rooms[socket.roomCode];
        } else {
          io.to(socket.roomCode).emit('player_left', { username });
          broadcastPlayersList(oldRoom);
        }
      }
    }

    room.players.push({ id: socket.id, username: username, ready: false });
    socket.join(roomCode);
    socket.roomCode = roomCode;
    socket.playerIndex = room.players.findIndex(p => p.id === socket.id);
    socket.username = username;

    if (users[username]) {
      users[username].activeRoom = roomCode;
      saveUsers(users);
    }

    updateFriendStatus(username, 'room');

    console.log(`[Room] ${username} joined room ${roomCode}`);

    emitToRoom(room, 'player_joined', {
      players: room.players.map(p => ({ id: p.id, username: p.username })),
      owner: room.owner
    });

    broadcastPlayersList(room);
  });

  socket.on('player_ready', () => {
    const room = rooms[socket.roomCode];
    if (!room) return;
    const player = room.players.find(p => p.id === socket.id);
    if (player) player.ready = !player.ready;
    console.log(`[Ready] ${player.username} ready: ${player.ready}`);
    broadcastPlayersList(room);
  });

  socket.on('start_game', () => {
    const room = rooms[socket.roomCode];
    if (!room) return;
    console.log(`[Start Game] Request from ${socket.username}. Owner: ${room.owner}, Players: ${room.players.length}`);

    if (room.owner !== socket.username) {
      return socket.emit('error', { message: 'Only owner can start' });
    }
    if (room.players.length !== 2 || !room.players.every(p => p.ready)) {
      return socket.emit('error', { message: 'Both players must be ready' });
    }

    room.state = 'POISON_PHASE';
    room.poisonStartTime = Date.now();
    room.poisonDuration = 30;
    room.poisons = {};
    room.poisonPaused = false;
    room.poisonPausedAt = null;
    console.log(`[Game] ${room.owner} started the game`);

    emitToRoom(room, 'start_poison_phase', { duration: 30 });
    console.log(`[Game] start_poison_phase sent to ${room.players.length} players`);
  });

  socket.on('submit_poisons', ({ poisonedChips }) => {
    const room = rooms[socket.roomCode];
    if (!room || room.state !== 'POISON_PHASE') return;
    room.poisons[socket.id] = poisonedChips;
    console.log(`[Poison] Player ${socket.id} submitted poisons. Count: ${Object.keys(room.poisons).length}`);

    if (Object.keys(room.poisons).length === 2) {
      startCoinToss(room);
    }
  });

  socket.on('poison_time_up', () => {
    const room = rooms[socket.roomCode];
    if (!room || room.state !== 'POISON_PHASE') return;

    room.players.forEach(p => {
      if (!room.poisons[p.id]) {
        const allChips = [0, 1, 2, 3, 4, 5, 6, 7, 8];
        const randomPoisons = [];
        for (let i = 0; i < 3; i++) {
          const randIndex = Math.floor(Math.random() * allChips.length);
          randomPoisons.push(allChips.splice(randIndex, 1)[0]);
        }
        room.poisons[p.id] = randomPoisons;
      }
    });

    startCoinToss(room);
  });

  function startCoinToss(room) {
    room.state = 'COIN_TOSS';
    emitToRoom(room, 'start_coin_toss', {});

    setTimeout(() => {
      if (!rooms[room.code]) return;
      const firstPlayerIndex = Math.random() < 0.5 ? 0 : 1;
      room.currentTurn = room.players[firstPlayerIndex].id;
      room.state = 'PLAYING';

      room.health = {};
      room.eatenChips = {};
      room.poisonStartTime = null;
      room.players.forEach(p => {
        room.health[p.id] = 3;
        room.eatenChips[p.id] = [];
      });

      emitToRoom(room, 'coin_toss_result', {
        firstPlayerId: room.currentTurn,
        firstPlayerName: room.players[firstPlayerIndex].username,
        firstPlayerIndex: firstPlayerIndex
      });
    }, 3000);
  }

  socket.on('eat_chip', ({ chipIndex }) => {
    const room = rooms[socket.roomCode];
    if (!room || room.state !== 'PLAYING') return;
    if (room.currentTurn !== socket.id) return;

    if (!room.eatenChips[socket.id]) room.eatenChips[socket.id] = [];
    if (room.eatenChips[socket.id].includes(chipIndex)) return;

    const opponent = room.players.find(p => p.id !== socket.id);
    const opponentPoisons = room.poisons[opponent.id];
    const isPoisoned = opponentPoisons.includes(chipIndex);

    room.eatenChips[socket.id].push(chipIndex);

    emitToRoom(room, 'chip_eaten', {
      chipIndex,
      playerId: socket.id,
      isPoisoned,
      message: isPoisoned ? 'You Got Poisened!' : 'You Are Safe!'
    });

    if (isPoisoned) {
      room.health[socket.id]--;

      if (room.health[socket.id] <= 0) {
        room.state = 'GAME_OVER';

        const winner = opponent.username;
        const loser = room.players.find(p => p.id === socket.id).username;

        if (users[winner]) { users[winner].wins++; users[winner].activeRoom = null; }
        if (users[loser]) { users[loser].losses++; users[loser].activeRoom = null; }
        saveUsers(users);

        emitToRoom(room, 'game_over', {
          winnerId: opponent.id,
          winnerName: winner,
          loserId: socket.id,
          loserName: loser
        });
        return;
      }
    }

    room.currentTurn = opponent.id;
    emitToRoom(room, 'turn_changed', { nextPlayerId: opponent.id });
  });

  socket.on('play_again', () => {
    const room = rooms[socket.roomCode];
    if (!room || room.state !== 'GAME_OVER') return;

    room.playAgainVotes[socket.id] = true;
    const votesCount = Object.keys(room.playAgainVotes).length;
    emitToRoom(room, 'play_again_update', { votesCount });

    if (votesCount === 2) {
      room.state = 'POISON_PHASE';
      room.poisons = {};
      room.health = {};
      room.eatenChips = {};
      room.playAgainVotes = {};
      room.currentTurn = null;
      room.poisonStartTime = Date.now();
      room.poisonDuration = 30;

      room.players.forEach(p => {
        if (users[p.username]) {
          users[p.username].activeRoom = room.code;
        }
      });
      saveUsers(users);

      emitToRoom(room, 'restart_game', {});
    }
  });

  socket.on('leave_room', () => {
    if (!socket.roomCode || !rooms[socket.roomCode] || !socket.username) return;

    const room = rooms[socket.roomCode];
    const playerIndex = room.players.findIndex(p => p.id === socket.id);
    if (playerIndex === -1) return;

    const leavingPlayer = room.players[playerIndex];
    console.log(`[Leave] ${leavingPlayer.username} left room ${room.code}`);

    room.players.splice(playerIndex, 1);
    socket.leave(room.code);

    if (users[socket.username]) {
      users[socket.username].activeRoom = null;
      saveUsers(users);
    }

    socket.roomCode = null;
    socket.playerIndex = -1;

    updateFriendStatus(socket.username, 'main');

    if (room.players.length === 0) {
      delete rooms[room.code];
    } else {
      socket.to(room.code).emit('player_left', { username: leavingPlayer.username });
      broadcastPlayersList(room);

      if (room.owner === leavingPlayer.username && room.players.length > 0) {
        room.owner = room.players[0].username;
        broadcastPlayersList(room);
      }
    }
  });

  socket.on('abandon_match', () => {
    if (socket.username && users[socket.username]) {
      const oldRoom = users[socket.username].activeRoom;
      users[socket.username].activeRoom = null;
      users[socket.username].losses++;
      saveUsers(users);

      if (oldRoom && rooms[oldRoom]) {
        const room = rooms[oldRoom];
        const opponent = room.players.find(p => p.username !== socket.username);
        if (opponent) {
          if (users[opponent.username]) {
            users[opponent.username].wins++;
            users[opponent.username].activeRoom = null;
            saveUsers(users);
          }
          io.to(oldRoom).emit('opponent_abandoned', {
            username: socket.username,
            message: `${socket.username} abandoned the match. You win!`
          });
          room.state = 'GAME_OVER';
        }
      }
      socket.emit('match_abandoned', { success: true });
    }
  });

  socket.on('abandon_match_during_game', () => {
    const room = rooms[socket.roomCode];
    if (!room || room.state !== 'PLAYING') return;

    const player = room.players.find(p => p.id === socket.id);
    if (!player) return;

    if (users[player.username]) {
      users[player.username].losses++;
      users[player.username].activeRoom = null;
      saveUsers(users);
    }

    const opponent = room.players.find(p => p.id !== socket.id);
    if (opponent) {
      if (users[opponent.username]) {
        users[opponent.username].wins++;
        users[opponent.username].activeRoom = null;
        saveUsers(users);
      }
      emitToRoom(room, 'game_over', {
        winnerId: opponent.id,
        winnerName: opponent.username,
        loserId: socket.id,
        loserName: player.username
      });
    }
    room.state = 'GAME_OVER';
  });

  socket.on('disconnect', () => {
    console.log(`[-] User disconnected: ${socket.id}`);

    if (socket.username) {
      const user = users[socket.username];
      if (user && user.friends) {
        user.friends.forEach(friend => {
          if (connectedUsers[friend]) {
            io.to(connectedUsers[friend].socketId).emit('friend_status_update', {
              username: socket.username,
              status: 'offline'
            });
          }
        });
      }
      delete connectedUsers[socket.username];
    }

    if (!socket.roomCode || !rooms[socket.roomCode]) return;

    const room = rooms[socket.roomCode];
    const player = room.players.find(p => p.id === socket.id);
    if (!player) return;

    console.log(`[Disconnect] ${player.username} disconnected from room ${room.code}. State: ${room.state}`);

    if (room.state === 'LOBBY') {
      const playerIndex = room.players.findIndex(p => p.id === socket.id);
      if (playerIndex !== -1) {
        room.players.splice(playerIndex, 1);
      }

      if (users[player.username]) {
        users[player.username].activeRoom = null;
        saveUsers(users);
      }

      if (room.players.length === 0) {
        delete rooms[socket.roomCode];
      } else {
        socket.to(room.code).emit('player_left', { username: player.username });
        broadcastPlayersList(room);

        if (room.owner === player.username && room.players.length > 0) {
          room.owner = room.players[0].username;
          broadcastPlayersList(room);
        }
      }
      return;
    }

    if (room.state !== 'GAME_OVER') {
      if (room.state === 'POISON_PHASE') {
        room.poisonPaused = true;
        room.poisonPausedAt = Date.now();
        socket.to(room.code).emit('pause_poison_timer');
      }

      if (room.state === 'COIN_TOSS') {
        socket.to(room.code).emit('pause_coin_timer');
      }

      socket.to(room.code).emit('start_disconnect_timer', {
        disconnectedUsername: player.username,
        timeout: RECONNECT_TIMEOUT / 1000
      });

      socket.emit('start_disconnect_timer', {
        disconnectedUsername: player.username,
        timeout: RECONNECT_TIMEOUT / 1000,
        isYou: true
      });

      room.reconnectTimeout = setTimeout(() => {
        const opponent = room.players.find(p => p.id !== socket.id);

        if (opponent) {
          io.to(room.code).emit('opponent_lost', {
            message: `${player.username} disconnected and didn't return. You win!`
          });
          if (users[opponent.username]) {
            users[opponent.username].wins++;
            users[opponent.username].activeRoom = null;
            saveUsers(users);
          }
        }

        if (users[player.username]) {
          users[player.username].losses++;
          users[player.username].activeRoom = null;
          saveUsers(users);
        }

        delete rooms[socket.roomCode];
      }, RECONNECT_TIMEOUT);
    } else {
      socket.to(room.code).emit('opponent_disconnected', {
        username: player.username,
        timeout: 0
      });

      if (users[player.username]) {
        users[player.username].activeRoom = null;
        saveUsers(users);
      }

      delete rooms[socket.roomCode];
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📁 Users file: ${USERS_FILE}`);
});
