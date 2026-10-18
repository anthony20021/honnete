const $ = (id) => document.getElementById(id);
const proto = location.protocol === 'https:' ? 'wss' : 'ws';
const ws = new WebSocket(`${proto}://${location.host}`);
let state = null;
let draft = { choice: null, text: '' }; // brouillon local du répondeur

const send = (msg) => ws.send(JSON.stringify(msg));
const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const label = (c) => (c === 'truth' ? 'Vérité' : 'Mensonge');

$('name').value = localStorage.getItem('jh-name') || '';
$('joinBtn').onclick = join;
$('name').onkeydown = (e) => e.key === 'Enter' && join();
function join() {
  localStorage.setItem('jh-name', $('name').value);
  send({ type: 'join', name: $('name').value });
}

ws.onmessage = (e) => {
  const msg = JSON.parse(e.data);
  if (msg.type === 'full') return ($('fullMsg').hidden = false);
  if (msg.type === 'chatHistory') { $('chatLog').innerHTML = ''; return msg.messages.forEach(addChat); }
  if (msg.type === 'chat') return addChat(msg);
  if (msg.type !== 'state') return;
  if (!state || state.round !== msg.round || msg.phase === 'lobby') draft = { choice: null, text: '' };
  state = msg;
  render();
};
ws.onclose = () => { document.body.innerHTML = '<main><p>Connexion perdue. Recharge la page.</p></main>'; };

$('chatForm').onsubmit = (e) => {
  e.preventDefault();
  const text = $('chatInput').value.trim();
  if (text) send({ type: 'chat', text });
  $('chatInput').value = '';
};

function addChat({ from, text }) {
  const log = $('chatLog');
  const who = state && state.names[from] ? state.names[from] : `Joueur ${from}`;
  log.insertAdjacentHTML('beforeend', `<p><b>${esc(who)} :</b> ${esc(text)}</p>`);
  log.scrollTop = log.scrollHeight;
}

function render() {
  $('join').hidden = true;
  $('game').hidden = false;
  $('chat').hidden = false;
  const s = state, me = s.me, opp = 3 - me;
  const nm = (n) => esc(s.names[n] || '…');
  $('scores').innerHTML = [1, 2].map((n) => `<div>${nm(n)}${n === me ? ' (toi)' : ''}<b>${s.scores[n]}</b></div>`).join('');
  $('roundInfo').textContent = s.phase === 'lobby' || s.phase === 'end' ? '' : `Manche ${s.round} / ${s.totalRounds}`;
  $('question').textContent = s.question || '';
  const c = $('content');
  const iSpeak = s.speaker === me;

  if (s.phase === 'lobby') {
    $('question').textContent = '';
    c.innerHTML = '<p>En attente d’un deuxième joueur…</p>';
  } else if (s.phase === 'answering') {
    if (iSpeak) {
      c.innerHTML = `
        <p class="hint">Choisis en secret si tu dis la vérité ou si tu mens, puis réponds.</p>
        <div class="choice">
          <button class="truth ${draft.choice === 'truth' ? 'sel' : ''}" data-c="truth">Je dis la vérité</button>
          <button class="lie ${draft.choice === 'lie' ? 'sel' : ''}" data-c="lie">Je mens</button>
        </div>
        <textarea id="text" maxlength="300" placeholder="Ta réponse…">${esc(draft.text)}</textarea>
        <button id="send">Envoyer</button>`;
      c.querySelectorAll('[data-c]').forEach((b) => (b.onclick = () => { draft.choice = b.dataset.c; render(); }));
      $('text').oninput = (e) => { draft.text = e.target.value; };
      $('send').onclick = () => draft.choice && draft.text.trim() && send({ type: 'answer', choice: draft.choice, text: draft.text });
    } else {
      c.innerHTML = `<p>${nm(opp)} prépare sa réponse…</p>`;
    }
  } else if (s.phase === 'guessing') {
    const mine = iSpeak ? `<p class="hint">Tu as choisi : ${label(s.choice)}</p>` : '';
    c.innerHTML = `<div class="answer">${esc(s.answer)}</div>` + (iSpeak
      ? `${mine}<p>${nm(opp)} réfléchit…</p>`
      : `<p>${nm(opp)} dit-il la vérité ?</p>
         <button class="truth" id="gt">Vrai</button><button class="lie" id="gl">Menteur !</button>`);
    if (!iSpeak) {
      $('gt').onclick = () => send({ type: 'guess', verdict: 'truth' });
      $('gl').onclick = () => send({ type: 'guess', verdict: 'lie' });
    }
  } else if (s.phase === 'reveal') {
    const guesser = 3 - s.speaker;
    const winner = s.correct ? guesser : s.speaker;
    c.innerHTML = `
      <div class="answer">${esc(s.answer)}</div>
      <div class="result">C’était : <b>${label(s.choice)}</b><br>
        <span class="${winner === me ? 'ok' : 'ko'}">${s.correct ? 'Bien vu !' : 'Raté !'} Point pour ${nm(winner)}</span></div>
      <button id="next" ${s.ready.includes(me) ? 'disabled' : ''}>${s.round >= s.totalRounds ? 'Résultat final' : 'Manche suivante'}</button>`;
    $('next').onclick = () => send({ type: 'next' });
  } else if (s.phase === 'end') {
    $('question').textContent = 'Fin de la partie';
    const [a, b] = [s.scores[1], s.scores[2]];
    const win = a === b ? 'Égalité !' : `Victoire de ${a > b ? nm(1) : nm(2)} 🏆`;
    c.innerHTML = `<p class="result">${win}</p><button id="again">Rejouer</button>`;
    $('again').onclick = () => send({ type: 'restart' });
  }
}
