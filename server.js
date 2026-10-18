const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');
const { WebSocketServer } = require('ws');

const ROUNDS = Number(process.env.ROUNDS) || 10; // pair : chacun répond autant de fois
const QUESTIONS = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'questions.json'), 'utf8'));

// ---- App HTTP ----
const app = express();
app.use(express.static(path.join(__dirname, 'public')));
const httpServer = http.createServer(app);
const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, '0.0.0.0', () => console.log(`Serveur démarré : http://localhost:${PORT}`));

const wss = new WebSocketServer({ server: httpServer });

// ---- État (une seule salle, 2 joueurs) ----
// phases : lobby -> answering -> guessing -> reveal -> (answering ...) -> end
const room = {
  players: {}, // slot(1|2) -> { ws, name }
  phase: 'lobby',
  round: 0,
  speaker: 1,
  question: null,
  choice: null, // 'truth' | 'lie' (secret du répondeur)
  answer: '',
  verdict: null, // choix du devineur
  scores: { 1: 0, 2: 0 },
  ready: new Set(),
  used: new Set(),
  chat: [], // derniers messages { from, text }
};

const send = (ws, msg) => ws && ws.readyState === ws.OPEN && ws.send(JSON.stringify(msg));

function snapshot(slot) {
  const names = { 1: room.players[1]?.name || null, 2: room.players[2]?.name || null };
  const revealed = room.phase === 'reveal' || room.phase === 'end';
  return {
    type: 'state',
    me: slot,
    names,
    phase: room.phase,
    round: room.round,
    totalRounds: ROUNDS,
    speaker: room.speaker,
    question: room.question,
    answer: room.phase === 'guessing' || revealed ? room.answer : '',
    // le mensonge n'est connu que du répondeur avant la révélation
    choice: slot === room.speaker || revealed ? room.choice : null,
    verdict: room.verdict,
    correct: revealed && room.verdict ? room.verdict === room.choice : null,
    scores: room.scores,
    ready: [...room.ready],
  };
}

function broadcast() {
  for (const slot of [1, 2]) if (room.players[slot]) send(room.players[slot].ws, snapshot(slot));
}

function pickQuestion() {
  let pool = QUESTIONS.filter((q) => !room.used.has(q));
  if (pool.length === 0) { room.used.clear(); pool = QUESTIONS; }
  const q = pool[Math.floor(Math.random() * pool.length)];
  room.used.add(q);
  return q;
}

function startRound() {
  room.round += 1;
  room.speaker = room.round % 2 === 1 ? 1 : 2;
  room.question = pickQuestion();
  room.choice = null;
  room.answer = '';
  room.verdict = null;
  room.ready.clear();
  room.phase = 'answering';
}

function resetGame() {
  room.phase = 'lobby';
  room.round = 0;
  room.scores = { 1: 0, 2: 0 };
  room.used.clear();
  room.ready.clear();
  room.question = room.choice = room.verdict = null;
  room.answer = '';
}

function maybeStart() {
  if (room.phase === 'lobby' && room.players[1] && room.players[2]) startRound();
}

wss.on('connection', (ws) => {
  let slot = null;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'join') {
      if (slot) return;
      const free = [1, 2].find((s) => !room.players[s]);
      if (!free) return send(ws, { type: 'full' });
      slot = free;
      room.players[slot] = { ws, name: String(msg.name || '').trim().slice(0, 20) || `Joueur ${slot}` };
      maybeStart();
      send(ws, { type: 'chatHistory', messages: room.chat });
      return broadcast();
    }
    if (!slot) return;

    if (msg.type === 'chat') {
      const text = String(msg.text || '').trim().slice(0, 300);
      if (!text) return;
      const entry = { from: slot, text };
      room.chat.push(entry);
      if (room.chat.length > 50) room.chat.shift();
      for (const s of [1, 2]) if (room.players[s]) send(room.players[s].ws, { type: 'chat', ...entry });
      return;
    }

    if (msg.type === 'answer' && room.phase === 'answering' && slot === room.speaker) {
      if (msg.choice !== 'truth' && msg.choice !== 'lie') return;
      room.choice = msg.choice;
      room.answer = String(msg.text || '').trim().slice(0, 300);
      room.phase = 'guessing';
    } else if (msg.type === 'guess' && room.phase === 'guessing' && slot !== room.speaker) {
      if (msg.verdict !== 'truth' && msg.verdict !== 'lie') return;
      room.verdict = msg.verdict;
      // bien deviné -> point au devineur, sinon au répondeur
      room.scores[msg.verdict === room.choice ? slot : room.speaker] += 1;
      room.phase = 'reveal';
    } else if (msg.type === 'next' && room.phase === 'reveal') {
      room.ready.add(slot);
      if (room.ready.size === 2) {
        if (room.round >= ROUNDS) { room.phase = 'end'; room.ready.clear(); }
        else startRound();
      }
    } else if (msg.type === 'restart' && room.phase === 'end') {
      resetGame();
      maybeStart();
    }
    broadcast();
  });

  ws.on('close', () => {
    if (!slot || room.players[slot]?.ws !== ws) return;
    delete room.players[slot];
    if (!room.players[1] && !room.players[2]) room.chat = [];
    resetGame();
    broadcast();
  });
});
