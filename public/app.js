
const API_BASE_URL = ''; 


const DEFAULT_SETTINGS = { goal: 'conversacao_geral', level: 'intermediario', moduleId: '1 - Destravando para avancar' };
const GOAL_SUGGESTIONS = {
  'conversacao_geral': ['Em quais temas você pode me ajudar?']
};
const WELCOME_MESSAGE = `Olá! Eu sou a sua professora de inglês no estilo Fran. Selecione o módulo em que você está no canto superior direito ou me mande sua dúvida. Eu te explico tudo do jeito claro, simples e prático, igual a Fran faz nas aulas, até você realmente falar inglês.`;
const REQUEST_TIMEOUT_MS = 45000;

const chatEl = document.getElementById('chat');
const textInput = document.getElementById('textInput');
const sendBtn = document.getElementById('sendBtn');
const micBtn = document.getElementById('micBtn');
const vuFill = document.getElementById('vuFill');
const statusEl = document.getElementById('status');
const chipsEl = document.getElementById('chips');
const historyList = document.getElementById('historyList');
const sidebar = document.getElementById('sidebar');
const hamb = document.getElementById('hamb');
const newThreadBtn = document.getElementById('newThreadBtn');
const newThreadBtnMobile = document.getElementById('newThreadBtnMobile');
const sessionTitleEl = document.getElementById('sessionTitle');
const renameBtn = document.getElementById('renameBtn');
const favoriteBtn = document.getElementById('favoriteBtn');
const goalTabs = document.getElementById('goalTabs');
const levelSelect = document.getElementById('levelSelect');
const progressSessionsEl = document.getElementById('progressSessions');
const progressMessagesEl = document.getElementById('progressMessages');
const progressWordsEl = document.getElementById('progressWords');
const progressStreakEl = document.getElementById('progressStreak');
const audioPreview = document.getElementById('audioPreview');
const audioTranscriptEl = document.getElementById('audioTranscript');
const audioMetaEl = document.getElementById('audioMeta');
const audioSendBtn = document.getElementById('audioSendBtn');
const audioRetryBtn = document.getElementById('audioRetryBtn');
const audioDiscardBtn = document.getElementById('audioDiscardBtn');
const clearHistoryBtn = document.getElementById('clearHistoryBtn');
const moduleSelect = document.getElementById('moduleSelect');
const sidebarOverlay = document.getElementById('sidebarOverlay');

let mediaRecorder, chunks = [], mime = '', audioContext, analyser, monitorInterval, rmsSmooth = 0, recordStartedAt = null, countdownTimer = null;
let currentThreadId = null;
let ttsAudio = null;              // áudio atual
let currentTtsMessageId = null;   // id da mensagem atual em reprodução
let currentTtsBtn = null;         // botão associado a essa mensagem
function loadSettings() {
  try { return JSON.parse(localStorage.getItem('learnai-settings') || '{}'); } catch { return {}; }
}
function saveSettings(settings) { localStorage.setItem('learnai-settings', JSON.stringify(settings)); }
function loadThreads() {
  try {
    const stored = JSON.parse(localStorage.getItem('learnai-threads') || '{}');
    Object.values(stored).forEach(t => {
      t.messages = Array.isArray(t.messages) ? t.messages : [];
      t.messages.forEach(m => {
        if (!m.id) m.id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2,6)}`;
      });
      if (!t.createdAt) t.createdAt = Date.now();
    });
    return stored;
  } catch {
    return {};
  }
}
function saveThreads(obj) { localStorage.setItem('learnai-threads', JSON.stringify(obj)); }
function loadLastThreadId() { return localStorage.getItem('learnai-last-thread') || null; }
function setLastThreadId(id) { localStorage.setItem('learnai-last-thread', id); }
function loadFeedbackLog() {
  try { return JSON.parse(localStorage.getItem('learnai-feedback') || '[]'); } catch { return []; }
}
function saveFeedbackLog(arr) { localStorage.setItem('learnai-feedback', JSON.stringify(arr)); }

let settings = { ...DEFAULT_SETTINGS, ...loadSettings() };
let threads = loadThreads();
let feedbackLog = loadFeedbackLog();

if (!GOAL_SUGGESTIONS[settings.goal]) {
  settings.goal = DEFAULT_SETTINGS.goal;
  saveSettings(settings);
}

function setStatus(msg) {
  statusEl.textContent = msg;
}

async function requestWithTimeout(url, options = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error('O servidor demorou para responder. Tente novamente.');
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

const MAX_INPUT_HEIGHT = 200;

function autoGrow(el) {
  // deixa o navegador calcular o scrollHeight real
  el.style.height = 'auto';

  const newHeight = Math.min(MAX_INPUT_HEIGHT, el.scrollHeight);
  el.style.height = newHeight + 'px';

  // Só mostra scrollbar interna se o conteúdo passar do limite
  if (el.scrollHeight > MAX_INPUT_HEIGHT) {
    el.style.overflowY = 'auto';
  } else {
    el.style.overflowY = 'hidden';
  }
}

function escapeHTML(str = '') {
  return str.replace(/[&<>"']/g, ch => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[ch]));
}
function formatText(str = '') {
  return escapeHTML(str).replace(/\n/g, '<br />');
}
function countWords(str = '') {
  return (str.trim().match(/\b\w+\b/g) || []).length;
}


function typeWriter(el, fullText = '', onDone = null) {
  if (!fullText) {
    el.innerHTML = '';
    if (onDone) onDone();
    return;
  }

  const total = fullText.length;
  let index = 0;

  // Velocidade adaptativa: textos muito longos andam aos "pedaços"
  const baseDelay = 18; // ms
  const stepSize = total > 1200 ? 3 : total > 600 ? 2 : 1;

  function step() {
    index += stepSize;
    const sliced = fullText.slice(0, index);
    el.innerHTML = formatText(sliced);
    chatEl.scrollTop = chatEl.scrollHeight;

    if (index < total) {
      setTimeout(step, baseDelay);
    } else {
      if (onDone) onDone();
    }
  }

  step();
}

function newId() { return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`; }

function ensureCurrentThread() {
  if (currentThreadId && threads[currentThreadId]) return currentThreadId;
  const id = newId();
  threads[id] = { id, title: 'Nova conversa', messages: [], createdAt: Date.now(), favorite: false };
  saveThreads(threads); setLastThreadId(id);
  currentThreadId = id;
  return id;
}

function renderProgress() {
  const all = Object.values(threads);
  const sessions = all.length;
  let messages = 0;
  let words = 0;
  const days = new Set();
  all.forEach(t => {
    messages += t.messages.length;
    t.messages.filter(m => m.role === 'assistant').forEach(m => {
      words += countWords(m.text || '');
    });
    if (t.createdAt) {
      days.add(new Date(t.createdAt).toDateString());
    }
  });
  progressSessionsEl.textContent = sessions;
  progressMessagesEl.textContent = messages;
  progressWordsEl.textContent = words;
  progressStreakEl.textContent = days.size;
}

function renderChips() {
  chipsEl.innerHTML = '';

  const suggestions = GOAL_SUGGESTIONS[settings.goal] || [];

  if (!suggestions.length) {
    const empty = document.createElement('div');
    empty.className = 'chip';
    empty.innerHTML =
      '<strong>Sem sugestões</strong><span>Altere o objetivo para ver novas ideias.</span>';
    chipsEl.appendChild(empty);
    return;
  }

  suggestions.forEach(text => {
    const chip = document.createElement('button');
    chip.className = 'chip';
    chip.type = 'button';
    chip.innerHTML = `
      <strong>${escapeHTML(text)}</strong>
      <span>${escapeHTML('Clique para usar essa frase')}</span>
    `;
    chip.addEventListener('click', () => {
      textInput.value = text;
      autoGrow(textInput);
      textInput.focus();
    });
    chipsEl.appendChild(chip);
  });
}

function renderGoalTabs() {
  if (!goalTabs) return;
  goalTabs.innerHTML = '';
  GOAL_OPTIONS.forEach(option => {
    const btn = document.createElement('button');
    const active = option.id === settings.goal;
    btn.type = 'button';
    btn.className = `goal-tab${active ? ' active' : ''}`;
    btn.textContent = option.label;
    btn.setAttribute('aria-pressed', active ? 'true' : 'false');
    btn.addEventListener('click', () => {
      if (settings.goal === option.id) return;
      settings.goal = option.id;
      saveSettings(settings);
      renderGoalTabs();
      renderChips();
    });
    goalTabs.appendChild(btn);
  });
}

const GOAL_OPTIONS = [
  { id: 'conversacao_geral', label: 'Conversação' },
  { id: 'viagens',           label: 'Viagens' },
  { id: 'entrevistas',       label: 'Entrevistas' },
  { id: 'exames',            label: 'Exames' },
  { id: 'negocios',          label: 'Negócios' }
];

function chipsVisible(visible) {
  chipsEl.classList.toggle('hidden', !visible);
}

function renderHistory() {
  historyList.innerHTML = '';

  const ids = Object.keys(threads).sort(
    (a, b) => (threads[b].createdAt || 0) - (threads[a].createdAt || 0)
  );

  if (!ids.length) {
    historyList.innerHTML = '<div class="empty">Sem conversas ainda.</div>';
    return;
  }

  ids.forEach(id => {
    const t = threads[id];
    const item = document.createElement('div');
    item.className = 'hist-item';

    const openBtn = document.createElement('button');
    openBtn.type = 'button';
    openBtn.className = 'hist-open' + (id === currentThreadId ? ' active' : '');

    const title = (t.title && t.title.trim()) || 'Nova conversa';
    const safeTitle = escapeHTML(title);

    openBtn.innerHTML = `
      <div class="title">
        <span class="title-text">${safeTitle}</span>
        <button type="button" class="hist-delete" title="Excluir conversa">🗑</button>
      </div>
      <div class="meta">
        <span>${t.messages.length} mensagem${t.messages.length === 1 ? '' : 's'}</span>
        <span>${t.messages.length ? new Date(t.createdAt).toLocaleDateString() : ''}</span>
      </div>
    `;

    // Clique no card abre a conversa
    openBtn.addEventListener('click', () => openThread(id));

    // Clique na lixeira apaga APENAS essa conversa
    const delBtn = openBtn.querySelector('.hist-delete');
    delBtn.addEventListener('click', (e) => {
      e.stopPropagation(); // não dispara o openThread
      if (confirm('Tem certeza que deseja excluir esta conversa?')) {
        deleteThread(id);
      }
    });

    item.appendChild(openBtn);
    historyList.appendChild(item);
  });
}

function deleteThread(id) {
  if (!threads[id]) return;

  const isCurrent = id === currentThreadId;
  delete threads[id];
  saveThreads(threads);

  const remainingIds = Object.keys(threads);
  if (!remainingIds.length) {
    currentThreadId = null;
    ensureCurrentThread();
  } else if (isCurrent) {
    // se apagou a conversa aberta, abre a mais recente
    currentThreadId = remainingIds.sort(
      (a, b) => (threads[b].createdAt || 0) - (threads[a].createdAt || 0)
    )[0];
  }

  setLastThreadId(currentThreadId);
  renderHistory();
  openThread(currentThreadId);
  renderProgress();
  setStatus('Conversa excluída.');
}
function clearHistory() {
  const hasThreads = Object.keys(threads).length > 0;
  if (!hasThreads) return;
  if (!confirm('Tem certeza de que deseja excluir todo o histórico de conversas?')) return;
  threads = {};
  saveThreads(threads);
  localStorage.removeItem('learnai-last-thread');
  currentThreadId = null;
  ensureCurrentThread();
  renderHistory();
  openThread(currentThreadId);
  renderProgress();
  setStatus('Histórico removido. Uma nova conversa foi iniciada.');
}

function renderThreadMessages(thread) {
  chatEl.innerHTML = '';
  thread.messages.forEach(msg => {
    if (msg.role === 'assistant') {
      // terceiro parâmetro = temporary = true → sem animação
      renderAssistantMessage(msg, false, true);
    } else {
      renderUserMessage(msg, false);
    }
  });
  chatEl.scrollTop = chatEl.scrollHeight;
  updateSessionMeta();
  chipsVisible(thread.messages.length === 0);
  if (thread.messages.length === 0) {
    renderWelcome();
  }
}
function renderWelcome() {
  const welcome = {
    id: 'welcome',
    role: 'assistant',
    text: WELCOME_MESSAGE,
    meta: {
      translation: 'Esta é uma tradução automática caso prefira ler em português.',
      grammarNotes: 'Aproveite para praticar e responda em inglês, mesmo que com frases curtas.',
      vocabulary: [
        { term: 'coach', meaning: 'treinador(a), mentor(a)', example: 'This app acts as your personal coach.' }
      ],
      followUpQuestion: 'What do you want to practice today?',
      extraSuggestions: ['Escolha um objetivo na barra superior.', 'Teste uma das sugestões rápidas.'],
      culturalTip: 'Pequenas rotinas diárias constroem fluência!'
    }
  };
  renderMessage(welcome, false, true);
}

function renderMessage(message, save = true, temporary = false) {
  if (message.role === 'assistant') {
    renderAssistantMessage(message, save, temporary);
  } else {
    renderUserMessage(message, save);
  }
}

function renderUserMessage(message, save = true) {
  const div = document.createElement('div');
  div.className = 'msg me';
  div.setAttribute('data-id', message.id);
  div.innerHTML = `<div>${formatText(message.text)}</div>`;
  chatEl.appendChild(div);
  chatEl.scrollTop = chatEl.scrollHeight;
  if (save) {
    pushMsgToThread(currentThreadId, message);
  }
}



function renderAssistantMessage(message, save = true, temporary = false) {
  const div = document.createElement('div');
  div.className = 'msg bot';
  if (temporary) div.setAttribute('data-temporary', 'true');
  div.setAttribute('data-id', message.id || 'temp');

  const meta = message.meta || {};
  const confidenceColor =
    meta.confidence === 'baixa'
      ? 'var(--danger)'
      : meta.confidence === 'media'
      ? 'var(--warning)'
      : 'var(--accent)';

  const sourcesHtml =
    Array.isArray(meta.sources) && meta.sources.length
      ? `<div style="opacity:.85;font-size:.8rem;display:flex;flex-wrap:wrap;gap:6px">
           <span style="color:var(--muted)">Fontes:</span>
           ${meta.sources
             .map(
               (s) =>
                 `<span class="pill" title="${escapeHTML(
                   s.source
                 )}" style="padding:4px 8px">${s.idx}</span>`
             )
             .join('')}
         </div>`
      : '';

  const rawReplyText = message.text || meta.reply || '';

  div.innerHTML = `
    <div class="label">Coach LearnAI</div>
    <div class="reply-text"></div>
    ${
      meta.translation
        ? `<div class="translation"><strong>Tradução:</strong><br>${formatText(
            meta.translation
          )}</div>`
        : ''
    }
    ${
      meta.culturalTip
        ? `<div><span class="tag">
             <span class="dot" style="background:${confidenceColor}"></span>
             ${escapeHTML(meta.confidence ? `confiança ${meta.confidence}` : 'dica')}
           </span><br>${formatText(meta.culturalTip)}</div>`
        : ''
    }
    ${sourcesHtml}
    ${
      temporary
        ? ''
        : `<div class="actions" role="group" aria-label="Ações desta resposta">
             <button type="button"
                     data-action="tts"
                     data-play-label="🔊 Ouvir resposta">
               🔊 Ouvir resposta
             </button>
           </div>`
    }
  `;

  // Só adiciona listeners quando NÃO for mensagem "temporária" (ex: histórico)
  if (!temporary) {
    // (se um dia você quiser feedback tipo “entendi/tenho dúvida”, já tá preparado)
    div.querySelectorAll('.actions button[data-feedback]').forEach((btn) => {
      btn.addEventListener('click', () => {
        registerFeedback(message.id, btn.dataset.feedback);
        btn.classList.add('active');
        setTimeout(() => btn.classList.remove('active'), 1200);
      });
    });

    // Botão de TTS ("Ouvir resposta" / pause)
    const ttsBtn = div.querySelector('.actions button[data-action="tts"]');
    if (ttsBtn) {
      ttsBtn.addEventListener('click', () => {
        playTTSForMessage(message, ttsBtn);
      });
    }
  }

  // Adiciona a mensagem no chat
  chatEl.appendChild(div);
  chatEl.scrollTop = chatEl.scrollHeight;

  if (!temporary) {
    // Mensagens novas: efeito de digitação
    const replyEl = div.querySelector('.reply-text');
    if (replyEl) {
      typeWriter(replyEl, rawReplyText || '', () => {
        chatEl.scrollTop = chatEl.scrollHeight;
      });
    } else if (rawReplyText) {
      // fallback, se por algum motivo não achar o reply-text
      div.insertAdjacentHTML(
        'afterbegin',
        `<div>${formatText(rawReplyText)}</div>`
      );
    }
  } else {
    // Histórico (temporary=true): mostra o texto direto, sem animação
    const replyEl = div.querySelector('.reply-text');
    if (replyEl) {
      replyEl.innerHTML = formatText(rawReplyText || '');
    }
  }

  if (save && !temporary) {
    pushMsgToThread(currentThreadId, message);
  }
}

function pushMsgToThread(id, msg) {
  if (!id || !threads[id]) return;
  const thread = threads[id];
  const exists = thread.messages.find(m => m.id === msg.id);
  if (exists) return;
  thread.messages.push(msg);
  if (!thread.title && msg.role === 'user') thread.title = msg.text.slice(0, 40) || 'Nova conversa';
  threads[id] = thread;
  saveThreads(threads);
  renderHistory();
  renderProgress();
}

function openThread(id) {
  if (!threads[id]) return;
  currentThreadId = id;
  setLastThreadId(id);
  renderHistory();
  renderThreadMessages(threads[id]);

  // Em telas pequenas, fecha o menu LATERAL E o overlay
  if (window.innerWidth < 980) {
    if (typeof setSidebarOpen === 'function') {
      setSidebarOpen(false);
    } else {
      // fallback caso ainda não exista a função
      sidebar.classList.remove('open');
      sidebarOverlay?.classList.remove('visible');
    }
  }
}

function updateSessionMeta() {
  const thread = threads[currentThreadId];
  if (!thread) return;
  sessionTitleEl.textContent = thread.title || 'Nova conversa';
  favoriteBtn.setAttribute('aria-pressed', thread.favorite ? 'true' : 'false');
  favoriteBtn.textContent = thread.favorite ? '★ Favorita' : '☆ Favorita';
}

function renameCurrentThread() {
  const thread = threads[currentThreadId];
  if (!thread) return;
  const next = prompt('Novo título para esta conversa:', thread.title || 'Nova conversa');
  if (next) {
    thread.title = next.trim();
    threads[currentThreadId] = thread;
    saveThreads(threads);
    updateSessionMeta();
    renderHistory();
  }
}

function toggleFavorite() {
  const thread = threads[currentThreadId];
  if (!thread) return;
  thread.favorite = !thread.favorite;
  threads[currentThreadId] = thread;
  saveThreads(threads);
  updateSessionMeta();
  renderHistory();
}

function newThread() {
  const id = newId();
  threads[id] = { id, title: 'Nova conversa', messages: [], createdAt: Date.now(), favorite: false };
  saveThreads(threads);
  currentThreadId = id;
  setLastThreadId(id);
  renderHistory();
  renderThreadMessages(threads[id]);
  setStatus('Nova conversa iniciada. Use uma sugestão ou digite sua pergunta.');
}

function getHistoryForRequest(id) {
  const thread = threads[id];
  if (!thread) return [];
  return thread.messages.slice(-6).map(m => ({ role: m.role, text: m.meta?.reply || m.text }));
}

function getRecentFeedback() {
  return feedbackLog.slice(-5);
}

async function sendText({ textOverride = null, source = 'text' } = {}) {
  const raw = textOverride !== null ? textOverride : textInput.value;
  const text = raw.trim();
  if (!text) return;

  ensureCurrentThread();
  const message = { id: newId(), role: 'user', text, createdAt: Date.now(), meta: { source } };
  renderUserMessage(message);
  chipsVisible(false);
  if (textOverride === null) {
    textInput.value = '';
    autoGrow(textInput);
  }
  setStatus('Enviando sua mensagem para o coach…');


  const payload = {
    text,
    goal: settings.goal,
    level: settings.level,
    moduleId: settings.moduleId, // <-- NOVO
    history: getHistoryForRequest(currentThreadId),
    feedbackSignals: getRecentFeedback()
  };

  try {
    const res = await requestWithTimeout(API_BASE_URL + '/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.detail || `Servidor respondeu ${res.status}`);
    }
    const data = await res.json();
    const assistantMessage = {
      id: newId(),
      role: 'assistant',
      text: data.reply || data.text || '(sem resposta)',
      createdAt: Date.now(),
      meta: {
        reply: data.reply,
        translation: data.translation,
        grammarNotes: data.grammarNotes,
        vocabulary: data.vocabulary,
        followUpQuestion: data.followUpQuestion,
        extraSuggestions: data.extraSuggestions,
        culturalTip: data.culturalTip,
        confidence: data.confidence,
        goal: data.goal,
        level: data.level,
        sources: data.sources || [] //<-- novo
      }
    };
    renderAssistantMessage(assistantMessage);
    setStatus('Pronto. Continue praticando!');
  } catch (err) {
    console.error(err);
    const errorMessage = {
      id: newId(),
      role: 'assistant',
      text: 'Não consegui falar com o coach agora. Verifique sua conexão e tente novamente em instantes.',
      createdAt: Date.now(),
      meta: {
        translation: err.message,
        extraSuggestions: ['Você pode revisar mensagens anteriores enquanto aguarda.', 'Copie sua pergunta para não perder o conteúdo.'],
        culturalTip: 'Mesmo quando a tecnologia falha, pequenos intervalos ajudam a consolidar o aprendizado.',
        confidence: 'baixa'
      }
    };
    renderAssistantMessage(errorMessage);
    setStatus('Erro ao enviar. Aguarde um momento e tente outra vez.');
  }
}

function registerFeedback(messageId, value) {
  feedbackLog.push({ id: messageId, value, ts: Date.now() });
  feedbackLog = feedbackLog.slice(-50);
  saveFeedbackLog(feedbackLog);
}

async function playTTSForMessage(message, btn) {
  const text = (message.meta?.reply || message.text || '').trim();
  if (!text) {
    setStatus('Não há texto para ler em voz alta.');
    return;
  }

  const playLabel = btn.dataset.playLabel || '🔊 Ouvir resposta';
  const pauseLabel = '⏸️ Pausar áudio';

  // Se já estamos tocando ESTA mensagem, então clicar = PAUSAR
  if (ttsAudio && !ttsAudio.paused && currentTtsMessageId === message.id) {
    ttsAudio.pause();
    btn.textContent = playLabel;
    setStatus('Áudio pausado. Clique de novo para continuar.');
    return;
  }

  // Se temos áudio pausado da mesma mensagem, clicar = RETOMAR
  if (ttsAudio && ttsAudio.paused && currentTtsMessageId === message.id && message.meta?.ttsUrl) {
    ttsAudio.play().catch(err => {
      console.error(err);
      setStatus('Não consegui retomar o áudio.');
    });
    btn.textContent = pauseLabel;
    setStatus('Reproduzindo a resposta em inglês.');
    return;
  }

  // Se vamos começar um novo áudio, reseta o botão anterior
  if (currentTtsBtn && currentTtsBtn !== btn) {
    const prevLabel = currentTtsBtn.dataset.playLabel || '🔊 Ouvir resposta';
    currentTtsBtn.textContent = prevLabel;
  }

  const originalLabel = playLabel;
  currentTtsBtn = btn;
  currentTtsMessageId = message.id;

  try {
    btn.disabled = true;
    btn.textContent = '🔊 Gerando áudio…';
    setStatus('Gerando áudio da resposta…');

    // Se já temos uma URL em cache, não chama o backend de novo
    let url = message.meta?.ttsUrl;
    if (!url) {
      const res = await requestWithTimeout('/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text })
      });

      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        throw new Error(`Erro TTS: ${res.status} ${errText}`);
      }

      const blob = await res.blob();
      url = URL.createObjectURL(blob);
      if (!message.meta) message.meta = {};
      message.meta.ttsUrl = url;  // cache p/ futuros plays
    }

    // Para não ficar vários áudios tocando
    if (ttsAudio) {
      ttsAudio.pause();
    }

    ttsAudio = new Audio(message.meta.ttsUrl);
    ttsAudio.play().catch(err => {
      console.error(err);
      setStatus('Não consegui reproduzir o áudio.');
    });

    ttsAudio.onended = () => {
      btn.disabled = false;
      btn.textContent = originalLabel;
      currentTtsMessageId = null;
      currentTtsBtn = null;
      setStatus('Áudio finalizado.');
    };

    btn.disabled = false;
    btn.textContent = pauseLabel;
    setStatus('Reproduzindo a resposta em inglês.');
  } catch (err) {
    console.error(err);
    btn.disabled = false;
    btn.textContent = originalLabel;
    setStatus('Não consegui gerar o áudio da resposta.');
  }
}

function pickMime() {
  const c = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/ogg', 'audio/mp4;codecs=aac', 'audio/mp4', 'audio/wav'];
  for (const m of c) { if (MediaRecorder.isTypeSupported?.(m)) return m; }
  return '';
}

async function runCountdown(seconds) {
  for (let remaining = seconds; remaining > 0; remaining -= 1) {
    setStatus(`Iniciando gravação em ${remaining}…`);
    await new Promise(resolve => { countdownTimer = setTimeout(resolve, 900); });
  }
  countdownTimer = null;
}

micBtn.addEventListener('click', async () => {
  if (mediaRecorder && mediaRecorder.state === 'recording') {
    stopRecording('Parando gravação…');
  } else {
    await startRecording();
  }
});

async function startRecording() {
  try {
    await runCountdown(3);
    setStatus('Preparando microfone…');
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    mime = pickMime();
    mediaRecorder = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
    chunks = [];
    mediaRecorder.ondataavailable = e => e.data?.size && chunks.push(e.data);
    mediaRecorder.onstop = onStop;
    mediaRecorder.start();
    recordStartedAt = Date.now();
    micBtn.classList.add('rec');
    setStatus('🎤 Gravando… fale normalmente, eu paro se ficar em silêncio.');
    startSilenceDetection(stream);
  } catch (err) {
    console.error(err);
    setStatus('Não foi possível acessar o microfone. Verifique as permissões.');
  }
}

function startSilenceDetection(stream) {
  audioContext = new (window.AudioContext || window.webkitAudioContext)();
  const src = audioContext.createMediaStreamSource(stream);
  analyser = audioContext.createAnalyser(); analyser.fftSize = 2048;
  src.connect(analyser);
  const buf = new Float32Array(analyser.fftSize);
  let since = performance.now();
  const SILENCE = { TH: 0.01, DUR: 2200, PROBE: 120, VU_SMOOTH: 0.85, VU_GAIN: 35 };

  monitorInterval = setInterval(() => {
    analyser.getFloatTimeDomainData(buf);
    let sum = 0; for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
    const rms = Math.sqrt(sum / buf.length);
    rmsSmooth = SILENCE.VU_SMOOTH * rmsSmooth + (1 - SILENCE.VU_SMOOTH) * rms;
    const pct = Math.max(0, Math.min(100, rmsSmooth * 100 * SILENCE.VU_GAIN));
    vuFill.style.width = pct + '%';

    if (rms < SILENCE.TH) {
      if (performance.now() - since >= SILENCE.DUR) stopRecording('Silêncio detectado, finalizando…');
    } else {
      since = performance.now();
    }
  }, SILENCE.PROBE);
}

function stopRecording(msg = 'Parando…') {
  try {
    if (mediaRecorder?.state === 'recording') mediaRecorder.stop();
    mediaRecorder?.stream?.getTracks().forEach(t => t.stop());
  } catch {}
  micBtn.classList.remove('rec');
  setStatus(msg);
  clearInterval(monitorInterval); monitorInterval = null;
  if (countdownTimer) clearTimeout(countdownTimer);
  try { audioContext?.close(); } catch {}
  analyser = null; vuFill.style.width = '0%'; rmsSmooth = 0;
}

async function onStop() {
  const blob = new Blob(chunks, { type: mime || 'audio/webm' });
  const ext = blob.type.includes('ogg') ? 'ogg' : blob.type.includes('webm') ? 'webm' : blob.type.includes('mp4') ? 'm4a' : 'wav';
  const form = new FormData(); form.append('file', blob, 'gravacao.' + ext);

  const durationSec = recordStartedAt ? Math.max(1, Math.round((Date.now() - recordStartedAt) / 1000)) : null;
  setStatus('Transcrevendo seu áudio…');
  try {
    const res = await requestWithTimeout(API_BASE_URL + '/transcrever', { method: 'POST', body: form });
    if (!res.ok) throw new Error(`Erro ${res.status}`);
    const data = await res.json();
    const text = data.transcricao || data.transcript || '';
    showAudioPreview(text, durationSec);
    setStatus('Transcrição pronta! Revise antes de enviar.');
  } catch (err) {
    console.error(err);
    setStatus('Não consegui transcrever. Tente novamente ou ajuste o ambiente.');
  }
};


audioDiscardBtn.addEventListener('click', () => {
  hideAudioPreview();
  setStatus('Transcrição descartada. Grave outra vez quando quiser.');
});


textInput.addEventListener('focus', () => chipsVisible(false));

renameBtn.addEventListener('click', renameCurrentThread);
favoriteBtn.addEventListener('click', toggleFavorite);
newThreadBtn.addEventListener('click', newThread);
newThreadBtnMobile.addEventListener('click', newThread);


levelSelect?.addEventListener('change', () => {
  settings.level = levelSelect.value;
  saveSettings(settings);
  renderChips();
});
clearHistoryBtn?.addEventListener('click', clearHistory);

moduleSelect?.addEventListener('change', () => {
  settings.moduleId = moduleSelect.value;
  saveSettings(settings);
  setStatus(`Módulo selecionado: ${settings.moduleId}`);
});

function bootstrap() {
  if (moduleSelect) {
  // se houver módulo salvo nas settings, aplica; senão usa o primeiro do select
  const firstOption = moduleSelect.options[0]?.value || '';
  moduleSelect.value = settings.moduleId || firstOption;
  settings.moduleId = moduleSelect.value || '1 - Destravando para avancar';
  saveSettings(settings);
}
  if (levelSelect) levelSelect.value = settings.level;
  renderGoalTabs();
  currentThreadId = loadLastThreadId();
  ensureCurrentThread();
  renderHistory();
  openThread(currentThreadId);
  renderProgress();
  renderChips();
  autoGrow(textInput);
}

function showAudioPreview(text, duration) {
  audioTranscriptEl.value = text;
  audioMetaEl.textContent = duration ? `Duração aproximada: ${duration}s` : '';
  audioPreview.classList.remove('hidden');
  audioTranscriptEl.focus();
}

function hideAudioPreview() {
  audioPreview.classList.add('hidden');
  audioTranscriptEl.value = '';
  audioMetaEl.textContent = '';
}

audioSendBtn.addEventListener('click', () => {
  const text = audioTranscriptEl.value.trim();
  hideAudioPreview();
  if (text) {
    sendText({ textOverride: text, source: 'audio' });
  } else {
    setStatus('Transcrição vazia. Grave novamente.');
  }
});

audioRetryBtn.addEventListener('click', async () => {
  hideAudioPreview();
  await startRecording();
});


sendBtn.addEventListener('click', () => sendText());
textInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendText();
  }
});
textInput.addEventListener('input', () => autoGrow(textInput));
textInput.addEventListener('blur', () => {
  const thread = threads[currentThreadId];
  if (thread && thread.messages.length === 0) chipsVisible(true);
});


function setSidebarOpen(isOpen) {
  if (isOpen) {
    sidebar.classList.add('open');
    sidebarOverlay?.classList.add('visible');
  } else {
    sidebar.classList.remove('open');
    sidebarOverlay?.classList.remove('visible');
  }
}

// Clique no hambúrguer: abre/fecha menu
hamb?.addEventListener('click', () => {
  const willOpen = !sidebar.classList.contains('open');
  setSidebarOpen(willOpen);
});

// Clique no overlay (área verde): fecha menu
sidebarOverlay?.addEventListener('click', () => {
  setSidebarOpen(false);
});

// Se a tela voltar a ficar grande, reseta tudo
window.addEventListener('resize', () => {
  if (window.innerWidth > 980) {
    setSidebarOpen(false);
  }
});

bootstrap();
