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
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
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
    console.error('[DB] خطا در بارگذاری کاربران:', error);
  }
  return {};
}

function saveUsers(users) {
  try {
    fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2), 'utf8');
  } catch (error) {
    console.error('[DB] خطا در ذخیره کاربران:', error);
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
      wins: 0,
      losses: 0,
      activeRoom: null,
      createdAt: new Date().toISOString(),
      email: email ? email.toLowerCase() : null,
      friends: [],
      friendRequests: [],
      sentRequests: []
    };
    saveUsers(users);
    
    console.log(`[Auth] کاربر جدید ثبت‌نام کرد: ${normalizedUsername}`);
    res.json({ success: true, username: normalizedUsername });
  } catch (error) {
    console.error('[Auth] خطا در ثبت‌نام:', error);
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
    
    console.log(`[Auth] کاربر لاگین کرد: ${normalizedUsername}`);
    res.json({ 
      success: true, 
      username: normalizedUsername,
      stats: { wins: user.wins, losses: user.losses },
      activeRoom: user.activeRoom,
      email: user.email || null,
      hasEmail: !!user.email
    });
  } catch (error) {
    console.error('[Auth] خطا در لاگین:', error);
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
    hasEmail: !!user.email
  });
});

app.get('/api/check-room/:roomCode', (req, res) => {
  const { roomCode } = req.params;
  res.json({ exists: !!rooms[roomCode] });
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

app.post('/api/set-email', (req, res) => {
  const { username, email } = req.body;
  if (!username || !email) {
    return res.status(400).json({ error: 'Username and email are required' });
  }
  
  const normalizedUsername = username.toLowerCase();
  if (!users[normalizedUsername]) {
    return res.status(404).json({ error: 'User not found' });
  }
  
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) {
    return res.status(400).json({ error: 'Invalid email format' });
  }
  
  users[normalizedUsername].email = email.toLowerCase();
  saveUsers(users);
  
  console.log(`[Email] ایمیل برای ${normalizedUsername} ذخیره شد: ${email}`);
  res.json({ success: true, email: email.toLowerCase() });
});

app.post('/api/send-friend-request', (req, res) => {
  const { username, targetUsername } = req.body;
  if (!username || !targetUsername) {
    return res.status(400).json({ error: 'Username and targetUsername are required' });
  }
  
  const normalizedUsername = username.toLowerCase();
  const normalizedTarget = targetUsername.toLowerCase();
  
  if (normalizedUsername === normalizedTarget) {
    return res.status(400).json({ error: 'Cannot send request to yourself' });
  }
  
  if (!users[normalizedUsername] || !users[normalizedTarget]) {
    return res.status(404).json({ error: 'User not found' });
  }
  
  if (!users[normalizedTarget].friendRequests) {
    users[normalizedTarget].friendRequests = [];
  }
  if (!users[normalizedUsername].sentRequests) {
    users[normalizedUsername].sentRequests = [];
  }
  
  if (users[normalizedTarget].friends && users[normalizedTarget].friends.includes(normalizedUsername)) {
    return res.status(400).json({ error: 'Already friends' });
  }
  
  if (users[normalizedTarget].friendRequests.includes(normalizedUsername)) {
    return res.status(400).json({ error: 'Request already sent' });
  }
  
  users[normalizedTarget].friendRequests.push(normalizedUsername);
  users[normalizedUsername].sentRequests.push(normalizedTarget);
  saveUsers(users);
  
  if (connectedUsers[normalizedTarget]) {
    io.to(connectedUsers[normalizedTarget].socketId).emit('friend_request_notification', { 
      from: normalizedUsername 
    });
  }
  
  console.log(`[Friend Request] ${normalizedUsername} به ${normalizedTarget} درخواست فرستاد.`);
  res.json({ success: true });
});

app.get('/api/friend-requests/:username', (req, res) => {
  const normalizedUsername = req.params.username.toLowerCase();
  const user = users[normalizedUsername];
  
  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }
  
  const requests = user.friendRequests || [];
  const sentRequests = user.sentRequests || [];
  
  res.json({ 
    received: requests,
    sent: sentRequests
  });
});

app.post('/api/accept-friend-request', (req, res) => {
  const { username, fromUsername } = req.body;
  if (!username || !fromUsername) {
    return res.status(400).json({ error: 'Username and fromUsername are required' });
  }
  
  const normalizedUsername = username.toLowerCase();
  const normalizedFrom = fromUsername.toLowerCase();
  
  if (!users[normalizedUsername] || !users[normalizedFrom]) {
    return res.status(404).json({ error: 'User not found' });
  }
  
  if (!users[normalizedUsername].friends) {
    users[normalizedUsername].friends = [];
  }
  if (!users[normalizedFrom].friends) {
    users[normalizedFrom].friends = [];
  }
  if (!users[normalizedUsername].friendRequests) {
    users[normalizedUsername].friendRequests = [];
  }
  if (!users[normalizedFrom].sentRequests) {
    users[normalizedFrom].sentRequests = [];
  }
  
  if (!users[normalizedUsername].friendRequests.includes(normalizedFrom)) {
    return res.status(400).json({ error: 'No request found' });
  }
  
  users[normalizedUsername].friends.push(normalizedFrom);
  users[normalizedFrom].friends.push(normalizedUsername);
  
  users[normalizedUsername].friendRequests = users[normalizedUsername].friendRequests.filter(u => u !== normalizedFrom);
  users[normalizedFrom].sentRequests = users[normalizedFrom].sentRequests.filter(u => u !== normalizedUsername);
  
  saveUsers(users);
  
  if (connectedUsers[normalizedFrom]) {
    io.to(connectedUsers[normalizedFrom].socketId).emit('friend_request_accepted_notification', { 
      username: normalizedUsername 
    });
  }
  
  console.log(`[Friend Request] ${normalizedUsername} درخواست ${normalizedFrom} رو قبول کرد.`);
  res.json({ success: true });
});

app.post('/api/reject-friend-request', (req, res) => {
  const { username, fromUsername } = req.body;
  if (!username || !fromUsername) {
    return res.status(400).json({ error: 'Username and fromUsername are required' });
  }
  
  const normalizedUsername = username.toLowerCase();
  const normalizedFrom = fromUsername.toLowerCase();
  
  if (!users[normalizedUsername] || !users[normalizedFrom]) {
    return res.status(404).json({ error: 'User not found' });
  }
  
  if (!users[normalizedUsername].friendRequests) {
    users[normalizedUsername].friendRequests = [];
  }
  if (!users[normalizedFrom].sentRequests) {
    users[normalizedFrom].sentRequests = [];
  }
  
  users[normalizedUsername].friendRequests = users[normalizedUsername].friendRequests.filter(u => u !== normalizedFrom);
  users[normalizedFrom].sentRequests = users[normalizedFrom].sentRequests.filter(u => u !== normalizedUsername);
  
  saveUsers(users);
  
  console.log(`[Friend Request] ${normalizedUsername} درخواست ${normalizedFrom} رو رد کرد.`);
  res.json({ success: true });
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
    return res.status(400).json({ error: 'No email registered for this account' });
  }
  
  const code = Math.floor(100000 + Math.random() * 900000).toString();
  passwordResetTokens[normalizedUsername] = {
    code,
    expiresAt: Date.now() + 10 * 60 * 1000,
    email: user.email
  };
  
  try {
    if (!process.env.GMAIL_USER || !process.env.GMAIL_APP_PASSWORD) {
      throw new Error('Gmail credentials not configured');
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
      subject: 'Password Reset Code - Chips Game',
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 500px; margin: 0 auto; padding: 20px;">
          <h2 style="color: #667eea;">Chips Game - Password Reset</h2>
          <p>Hello <strong>${normalizedUsername}</strong>,</p>
          <p>Your password reset code is:</p>
          <div style="background: #f0f0f0; padding: 20px; text-align: center; font-size: 24px; font-weight: bold; letter-spacing: 5px; margin: 20px 0; border-radius: 10px;">
            ${code}
          </div>
          <p>This code will expire in <strong>10 minutes</strong>.</p>
        </div>
      `
    });
    
    console.log(`[Email] کد ریست برای ${normalizedUsername} ارسال شد به ${user.email}`);
    res.json({ success: true, message: 'Reset code sent to your email' });
  } catch (error) {
    console.error('[Email] خطا در ارسال ایمیل:', error);
    res.status(500).json({ error: 'Failed to send email' });
  }
});

app.post('/api/reset-password', async (req, res) => {
  const { username, code, newPassword } = req.body;
  if (!username || !code || !newPassword) {
    return res.status(400).json({ error: 'All fields are required' });
  }
  
  const normalizedUsername = username.toLowerCase();
  const token = passwordResetTokens[normalizedUsername];
  
  if (!token) {
    return res.status(400).json({ error: 'Invalid or expired code' });
  }
  
  if (Date.now() > token.expiresAt) {
    delete passwordResetTokens[normalizedUsername];
    return res.status(400).json({ error: 'Code expired' });
  }
  
  if (token.code !== code) {
    return res.status(400).json({ error: 'Invalid code' });
  }
  
  if (newPassword.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters' });
  }
  
  try {
    const hashedPassword = await bcrypt.hash(newPassword, 10);
    users[normalizedUsername].password = hashedPassword;
    saveUsers(users);
    
    delete passwordResetTokens[normalizedUsername];
    
    console.log(`[Auth] رمز عبور ${normalizedUsername} تغییر کرد.`);
    res.json({ success: true, message: 'Password reset successfully' });
  } catch (error) {
    console.error('[Auth] خطا در تغییر رمز:', error);
    res.status(500).json({ error: 'Failed to reset password' });
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
          io.to(connectedUsers[friend].socketId).emit('friend_status_update', { 
            username, 
            status 
          });
        }
      });
    }
  }
}

// ==================== SOCKET.IO MAIN ====================

io.on('connection', (socket) => {
  console.log(`[+] کاربر متصل شد: ${socket.id}`);

  socket.on('user_logged_in', ({ username }) => {
    connectedUsers[username] = { socketId: socket.id, status: 'main' };
    socket.username = username;
    
    const user = users[username];
    if (user && user.friends) {
      user.friends.forEach(friend => {
        if (connectedUsers[friend]) {
          io.to(connectedUsers[friend].socketId).emit('friend_status_update', { 
            username, 
            status: 'main' 
          });
        }
      });
    }
    
    console.log(`[Friends] ${username} آنلاین شد`);
  });

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

  socket.on('invite_friend', ({ friendUsername }) => {
    const normalizedFriend = friendUsername.toLowerCase();
    if (connectedUsers[normalizedFriend]) {
      io.to(connectedUsers[normalizedFriend].socketId).emit('friend_invite', { 
        from: socket.username, 
        roomCode: socket.roomCode 
      });
      console.log(`[Invite] ${socket.username} دعوت فرستاد به ${normalizedFriend}`);
    }
  });

  socket.on('reconnect_to_game', ({ roomCode, username }) => {
    const room = rooms[roomCode];
    if (!room) {
      if (users[username]) {
        users[username].activeRoom = null;
        saveUsers(users);
      }
      return socket.emit('reconnect_failed', { message: 'لابی وجود ندارد!' });
    }

    const player = findPlayerByUsername(room, username);
    if (!player) {
      if (users[username]) {
        users[username].activeRoom = null;
        saveUsers(users);
      }
      return socket.emit('reconnect_failed', { message: 'شما در این لابی نیستید!' });
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

    console.log(`[Reconnect] ${username} به لابی ${roomCode} برگشت.`);

    if (room.reconnectTimeout) {
      clearTimeout(room.reconnectTimeout);
      room.reconnectTimeout = null;
    }

    socket.to(roomCode).emit('opponent_reconnected', { username });
    
    if (room.state === 'POISON_PHASE' && room.poisonPaused) {
      const elapsedBeforePause = (room.poisonPausedAt - room.poisonStartTime) / 1000;
      const timeLeft = Math.max(0, Math.ceil(room.poisonDuration - elapsedBeforePause));
      socket.to(roomCode).emit('resume_poison_timer', { timeLeft });
      room.poisonStartTime = Date.now() - (elapsedBeforePause * 1000);
      room.poisonPaused = false;
      room.poisonPausedAt = null;
    }
    
    broadcastPlayersList(room);

    const currentTurnPlayer = room.players.find(p => p.id === room.currentTurn);
    
    let timeLeft = 30;
    if (room.state === 'POISON_PHASE' && room.poisonStartTime) {
      const elapsed = (Date.now() - room.poisonStartTime) / 1000;
      timeLeft = Math.max(0, Math.ceil(room.poisonDuration - elapsed));
    }
    
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
      timeLeft: timeLeft
    });
  });

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
    
    console.log(`[Room] لابی ${roomCode} توسط ${username} ساخته شد.`);
    socket.emit('room_created', { roomCode, playerIndex: 0, owner: username });
    
    broadcastPlayersList(rooms[roomCode]);
  });

  socket.on('join_room', ({ roomCode, username }) => {
    const room = rooms[roomCode];
    if (!room) {
      return socket.emit('error', { message: 'چنین لابی وجود ندارد!' });
    }
    if (room.players.length >= 2) {
      return socket.emit('error', { message: 'لابی پر است!' });
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

    console.log(`[Room] ${username} به لابی ${roomCode} جوین شد.`);
    
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

    console.log(`[Ready] پلیر ${player.username} وضعیت ready: ${player.ready}`);
    broadcastPlayersList(room);
  });

  socket.on('start_game', () => {
    const room = rooms[socket.roomCode];
    if (!room) return;
    
    console.log(`[Start Game] درخواست شروع بازی از ${socket.username}`);
    
    if (room.owner !== socket.username) {
      return socket.emit('error', { message: 'فقط صاحب لابی می‌تواند بازی را شروع کند!' });
    }
    
    if (room.players.length !== 2 || !room.players.every(p => p.ready)) {
      return socket.emit('error', { message: 'هر دو بازیکن باید آماده باشند!' });
    }
    
    room.state = 'POISON_PHASE';
    room.poisonStartTime = Date.now();
    room.poisonDuration = 30;
    room.poisons = {};
    room.poisonPaused = false;
    room.poisonPausedAt = null;
    console.log(`[Game] ${room.owner} بازی رو شروع کرد.`);
    
    emitToRoom(room, 'start_poison_phase', { duration: 30 });
  });

  socket.on('submit_poisons', ({ poisonedChips }) => {
    const room = rooms[socket.roomCode];
    if (!room || room.state !== 'POISON_PHASE') return;

    room.poisons[socket.id] = poisonedChips;

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
    console.log(`[Leave] ${leavingPlayer.username} از لابی ${room.code} خارج شد.`);
    
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
            message: `${socket.username} بازی را ترک کرد. شما برنده شدید!`
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
    console.log(`[-] کاربر قطع شد: ${socket.id}`);
    
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
    
    console.log(`[Disconnect] ${player.username} از لابی ${room.code} قطع شد.`);
    
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
            message: `${player.username} قطع شد و برنگشت. شما برنده شدید!` 
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
  console.log(`🚀 سرور بازی با موفقیت روی پورت ${PORT} اجرا شد.`);
  console.log(`📁 فایل کاربران: ${USERS_FILE}`);
});
