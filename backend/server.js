// backend/server.js
import compression from 'compression';
import cors from 'cors';
import dotenv from 'dotenv';
import express from 'express';
import rateLimit from 'express-rate-limit';
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';
import fs from 'fs';
import ffmpeg from 'fluent-ffmpeg';
import helmet from 'helmet';
import multer from 'multer';
import { OpenAI } from 'openai';
import path from 'path';
import { fileURLToPath } from 'url';

// __dirname em ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const OPENAI_TIMEOUT_MS = Number.parseInt(process.env.OPENAI_TIMEOUT_MS || '45000', 10);
const AUDIO_MIME_WHITELIST = [
  'audio/',
  'video/webm',
  'video/mp4',
  'video/ogg'
];
const RATE_LIMIT_MAX = Number.parseInt(process.env.RATE_LIMIT_MAX || '300', 10);

// carrega .env especificamente de backend/.env
dotenv.config({ path: path.join(__dirname, '.env') });

console.log('🔑 OPENAI_API_KEY configurada?', Boolean(process.env.OPENAI_API_KEY));

// depois disso você cria o app e o cliente:
const app = express();


const PORT       = process.env.PORT || 3000;

/* ---------- Segurança e performance ---------- */
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: RATE_LIMIT_MAX,
  standardHeaders: true,
  legacyHeaders: false
});
app.use(limiter);
app.use(helmet({ crossOriginResourcePolicy: false }));
app.use(compression());

/* ---------- CORS (opcional por .env) ---------- */
const ALLOWED_ORIGINS = (process.env.CORS_ORIGINS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);
if (ALLOWED_ORIGINS.length) {
  app.use(cors({ origin: ALLOWED_ORIGINS }));
}

/* ---------- Middlewares ---------- */
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

/* ---------- Static front (auto-descoberta) ---------- */
const publicFromParent = path.join(__dirname, '..', 'public'); // ../public
const publicFromHere   = path.join(__dirname);                  // ./
const publicDir        = fs.existsSync(publicFromParent) ? publicFromParent : publicFromHere;

app.use(express.static(publicDir));
app.get('/', (req, res) => res.sendFile(path.join(publicDir, 'index.html')));

console.log('🗂️  Servindo estático a partir de:', publicDir);
console.log('📄 index.html existe?', fs.existsSync(path.join(publicDir, 'index.html')));

/* ---------- OpenAI client ---------- */
const openaiApiKey = (process.env.OPENAI_API_KEY || '').trim();
if (!openaiApiKey) {
  console.warn('⚠️  OPENAI_API_KEY ausente. As rotas que dependem da OpenAI falharão.');
}
const openai = openaiApiKey ? new OpenAI({ apiKey: openaiApiKey, timeout: OPENAI_TIMEOUT_MS }) : null;

/* ---------- FFmpeg ---------- */
ffmpeg.setFfmpegPath(ffmpegInstaller.path);

/* ---------- Utils para erros ---------- */
function redactKey(str) {
  if (!str || typeof str !== 'string') return str;
  return str.replace(/\b(sk-[A-Za-z0-9]{6})[A-Za-z0-9_-]{10,}\b/g, '$1…');
}
function normalizeOpenAIError(error) {
  if (error?.name === 'AbortError') {
    return { code: 'request_timeout', httpStatus: 504, safeDetail: 'Tempo limite da requisição atingido.' };
  }
  const status     = error?.response?.status || error?.status || 500;
  const rawDetail  = error?.response?.data || error?.message || 'erro desconhecido';
  const serialized = typeof rawDetail === 'string' ? rawDetail : JSON.stringify(rawDetail);
  const safeDetail = redactKey(serialized);
  const isAuth     = status === 401 || /invalid|incorrect api key|authorization/i.test(serialized);
  return {
    code: isAuth ? 'invalid_api_key' : 'openai_request_failed',
    httpStatus: isAuth ? 503 : status,
    safeDetail
  };
}
function buildClientMessage(code, context) {
  if (code === 'invalid_api_key') {
    return 'Sua chave da OpenAI parece inválida ou expirada. Atualize a variável OPENAI_API_KEY e reinicie o backend.';
  }
  if (code === 'request_timeout') {
    return 'O serviço demorou para responder. Tente novamente em alguns instantes.';
  }
  if (context === 'transcription') {
    return 'Não foi possível transcrever o áudio agora. Tente novamente em instantes.';
  }
  return 'Não foi possível falar com o coach agora. Tente novamente em alguns instantes.';
}

async function safeUnlink(filePath) {
  if (!filePath) return;
  try { await fs.promises.unlink(filePath); } catch {}
}

async function callWithTimeout(action, timeoutMs = OPENAI_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await action(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

function ensureOpenAI(res) {
  if (openai) return true;
  res.status(503).json({
    error: 'openai_not_configured',
    message: 'OPENAI_API_KEY não está configurada no backend.'
  });
  return false;
}

/* ---------- KB (RAG) ---------- */
const kbPath = path.join(__dirname, 'kb_index.json');
let KB = [];
try {
  if (fs.existsSync(kbPath)) {
    KB = JSON.parse(fs.readFileSync(kbPath, 'utf8'));
    if (!Array.isArray(KB) || !KB.length) {
      console.warn('⚠️  kb_index.json vazio. O RAG por módulo não funcionará.');
    }
  } else {
    console.warn('⚠️  kb_index.json ausente. O RAG por módulo não funcionará.');
  }
} catch (e) {
  console.warn('⚠️  Falha ao ler kb_index.json:', e.message);
}

/* ---------- Similaridade ---------- */
function dot(a, b) { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; }
function norm(a)   { return Math.sqrt(dot(a, a)); }
function cosSim(a, b) { return dot(a, b) / (norm(a) * norm(b) + 1e-8); }

/* ---------- Retrieval simples por módulo ---------- */
// busca textual simples (fallback rápido)
function retrieveContext({ question, moduleId, topK = 6 }) {
  if (!Array.isArray(KB) || KB.length === 0) return [];
  const mod = (moduleId || '').toLowerCase();

  const scored = KB.map((item, idx) => {
    const sameModule = (item.moduleId || '').toLowerCase() === mod ? 1 : 0;
    const text = (item.text || '').toLowerCase();
    const q    = (question || '').toLowerCase();
    const hits = q ? (text.includes(q) ? 1 : 0) : 0;
    const score = sameModule * 2 + hits;
    return { ...item, _score: score, _idx: idx + 1 };
  })
  .sort((a, b) => b._score - a._score)
  .slice(0, topK);

  return scored;
}

// retrieval vetorial (se embeddings estiverem no KB)
async function retrieveModuleChunks({ query, moduleId, topK = 6 }) {
  if (!moduleId) throw new Error('moduleId ausente');
  const scoped = KB.filter(ch => ch.moduleId === moduleId);
  if (!scoped.length) return { selected: [], allScoped: 0 };

  // se faltar embedding no KB, cai no retrieveContext textual
  const hasEmbeddings = scoped.every(ch => Array.isArray(ch.embedding));
  if (!hasEmbeddings) {
    const selected = retrieveContext({ question: query, moduleId, topK });
    return { selected, allScoped: scoped.length };
  }

  // embedding da consulta
  if (!openai) throw new Error('OpenAI client indisponível');
  const embRes = await callWithTimeout(signal => openai.embeddings.create({
    model: 'text-embedding-3-large',
    input: query,
    signal
  }));
  const q = embRes.data[0].embedding;

  // rank
  const ranked = scoped
    .map(ch => ({ ...ch, score: cosSim(q, ch.embedding) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);

  const MIN_SCORE = 0.24;
  const confident = ranked.filter(r => r.score >= MIN_SCORE);
  const selected  = (confident.length ? confident : ranked).slice(0, Math.max(3, Math.min(topK, 6)));

  return { selected, allScoped: scoped.length };
}

/* ---------- Uploads (STT) ---------- */
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

const upload = multer({
  dest: uploadsDir,
  limits: { fileSize: 20 * 1024 * 1024 } // 20MB
});

/* ---------- Health ---------- */
app.get('/health', (_, res) => res.json({ ok: true, ts: Date.now() }));



/* ---------- Transcrição ---------- */
app.post('/transcrever', upload.single('file'), async (req, res) => {
  if (!ensureOpenAI(res)) return;
  if (!req.file) return res.status(400).json({ error: 'Nenhum arquivo enviado.' });

  const originalPath = req.file.path;
  const wavPath = path.join(uploadsDir, `${req.file.filename}.wav`);

  console.log(`📥 Recebido: ${req.file.originalname} (${req.file.mimetype}, ${req.file.size} bytes)`);

  const mime = req.file.mimetype || '';
  const isAllowed = AUDIO_MIME_WHITELIST.some(prefix => mime.startsWith(prefix));
  if (!isAllowed) {
    await safeUnlink(originalPath);
    return res.status(400).json({
      error: 'tipo_invalido',
      message: 'Envie um arquivo de áudio válido (wav, webm, m4a, ogg).'
    });
  }

  try {
    await new Promise((resolve, reject) => {
      ffmpeg(path.resolve(originalPath))
        .audioCodec('pcm_s16le')
        .audioChannels(1)
        .audioFrequency(16000)
        .format('wav')
        .on('start', cmd => console.log('🛠️ FFmpeg:', cmd))
        .on('stderr', line => console.log('FFmpeg:', line))
        .on('error', err => reject(err))
        .on('end', () => resolve())
        .save(path.resolve(wavPath));
    });
  } catch (e) {
    console.error('❌ Falha na conversão:', e);
    await safeUnlink(originalPath);
    return res.status(500).json({ error: 'Falha na conversão de áudio.' });
  } finally {
    await safeUnlink(originalPath);
  }

  if (!fs.existsSync(wavPath)) {
    return res.status(500).json({ error: 'Arquivo WAV não encontrado após conversão.' });
  }

  try {
    const result = await callWithTimeout(signal => openai.audio.transcriptions.create({
      file: fs.createReadStream(wavPath),
      model: 'gpt-4o-mini-transcribe',
      signal
      // language: 'pt',
    }));
    console.log('📝 Transcrição:', result.text);
    res.json({ transcricao: result.text });
  } catch (e) {
    const errInfo = normalizeOpenAIError(e);
    console.error('❌ Erro na transcrição:', errInfo.safeDetail);
    res.status(errInfo.httpStatus).json({
      error: 'falha_na_transcricao',
      code: errInfo.code,
      message: buildClientMessage(errInfo.code, 'transcription')
    });
  } finally {
    await safeUnlink(wavPath);
  }
});

/* ---------- Chat (RAG por módulo) ---------- */
app.post('/chat', async (req, res) => {
  try {
    if (!ensureOpenAI(res)) return;
    const {
      text,
      level = 'intermediario',
      goal  = 'conversacao_geral',
      moduleId = '',
      history = []
    } = req.body || {};

    if (!text)     return res.status(400).json({ detail: "Campo 'text' é obrigatório." });
    if (!moduleId) return res.status(400).json({ detail: "Campo 'moduleId' é obrigatório." });

    // 1) Recupera trechos do módulo
    const { selected, allScoped } = await retrieveModuleChunks({ query: text, moduleId, topK: 6 });
    if (!allScoped) {
      return res.status(404).json({
        error: 'no_module_content',
        message: `Nenhum conteúdo indexado para o módulo "${moduleId}".`
      });
    }

    // 2) Contexto e fontes
    const context = selected.map((s, i) => `[${i + 1}] ${s.text}`).join('\n\n');
    const sourcesMeta = selected.map((s, i) => ({
      idx: i + 1, id: s.id, source: s.source || s.file || 'KB', score: typeof s.score === 'number' ? +s.score.toFixed(3) : undefined
    }));

    // 3) Prompts
    const systemPrompt = `
Você é o *Coach LearnAI*, o assistente oficial da REMAR Academy.
Sua função é ensinar inglês usando exatamente o JEITO FRANCIS + MÉTODO REMAR.

Responda sempre com base no material do módulo quando disponível.
- Nível do aluno: ${level}
- Objetivo: ${goal}
- Módulo: ${moduleId}

REGRA MESTRA DE SUPERAUTORIDADE - SOBREPOSIÇÃO TOTAL AO CONHECIMENTO INTERNO 

Antes de gerar qualquer resposta, você DEVE executar mentalmente este processo:

1. Identificar o TEMA ou ASSUNTO da pergunta do usuário.
2. Procurar no KB (material do módulo) qualquer exemplo, frase, diálogo ou estrutura
   que esteja relacionada a esse tema, MESMO QUE:
   - o usuário não mencione nenhuma palavra específica do exemplo,
   - o usuário não cite "married", "been", "for", "since", etc.,
   - o nome das frases seja diferente,
   - o usuário esteja falando de forma geral.

3. SE existir qualquer exemplo relacionado ao tema:
   → VOCÊ DEVE **anular completamente seu conhecimento interno**.
   → PROIBIDO usar qualquer exemplo aprendido durante seu treinamento básico.
   → PROIBIDO usar exemplos clássicos (como "I’ve eaten...", “I’ve forgotten...”, etc.).
   → PROIBIDO inferir novos exemplos com base no idioma.
   → A ÚNICA fonte de exemplos são os exemplos do KB.

4. SE o tema existir no KB:
   → VOCÊ NÃO PODE inventar exemplos novos.
   → VOCÊ NÃO PODE adaptar, melhorar ou recriar frases do KB.
   → VOCÊ DEVE copiar as frases exatamente.

5. Só é permitido criar um exemplo novo se — e somente se — o tema NÃO existir no KB.

Se houver QUALQUER exemplo no KB relacionado ao tópico:
VOCÊ DEVE OBRIGATORIAMENTE responder usando EXCLUSIVAMENTE esse exemplo,
mesmo que o usuário não peça explicitamente por ele.

Essa regra é absoluta e substitui qualquer comportamento padrão do modelo.

-----------------------------------
1. TOM DE VOZ (JEITO FRANCIS)
-----------------------------------
- Fale como se estivesse em chamada de vídeo com o aluno, bem próxima e acolhedora.
- Use expressões típicas da Teacher Fran: "olha só", "bora lá", "isso!", "presta atenção aqui", "relaxa", "não tem nada errado com você".
- Energia calorosa, animada, amorosa e motivadora — sempre validando o esforço do aluno.
- Mesmo corrigindo, mantenha o tom gentil, leve e encorajador.

-----------------------------------
2. ESTILO DE FALA (MÉTODO REMAR)
-----------------------------------
- Nada de linguagem de livro. É conversa real, natural, do dia a dia.
- Frases curtas, diretas e práticas.
- Inclua exercícios de repetição:  
  → "repete comigo: ..."  
  → "fala em voz alta agora..."
- Traga exemplos reais, mini-roteiros e diálogos.
- Use truques de memorização, imagens mentais e associações divertidas.
- Sempre que possível, contraste a versão certinha vs. versão natural:  
  ex.: "I would like..." vs "Can I get...?"
- Se estiver explicando gramática, faça de forma simples e visual.

-----------------------------------
3. MODO CONVERSA (CONVERSATION MODE)
-----------------------------------
Se o usuário falar em inglês, iniciar um diálogo ou parecer estar praticando conversação, você deve automaticamente entrar no *Conversation Mode*:

Durante o modo conversa:
- Responda como em um diálogo real, natural e curto.
- Continue a conversa como se estivesse em chamada de vídeo.
- NO FINAL da resposta, entregue uma seção chamada **"coachFeedback"** com:
  - 1 correção suave
  - 1 dica rápida
  - 1 explicação simples
  - 1 sugestão melhorada da frase do aluno usando EXATAMENTE os exemplos do módulo

-----------------------------------
4. REGRAS DE FORMATO (OBRIGATÓRIO)
-----------------------------------
A resposta DEVE SEMPRE seguir exatamente este JSON:

{
  "reply": "...",
  "translation": "...",
  "Extra Example": [
    { "term": "...", "translation": "...", "tip": "..." }
  ],
  "coachFeedback": {
      "correction": "...",
      "tip": "...",
      "explanation": "...",
      "improvedExample": "..."
  }
}

Obrigatório:
- "reply": mensagem principal no JEITO FRANCIS, divertida, acolhedora e baseada nos EXEMPLOS DO MÓDULO.
- "translation": tradução completa da reply.
- "Extra Example": pelo menos 2 exemplos extras.
- "coachFeedback": só usar se o aluno escreveu algo; se o usuário não praticou, pode deixar vazio ou nulo.
- Sempre que usar material do módulo que vier no contexto, cite como [#n].

-----------------------------------
5. FUNÇÃO PRINCIPAL DO AGENTE
-----------------------------------
Ensinar inglês de forma acolhedora e prática usando:
- os exemplos reais do módulo (OBRIGATÓRIO SE EXISTIREM),
- o JEITO FRANCIS,
- o ritmo do MÉTODO REMAR,
- explicações claras, simples e leves,
- incentivo constante,
- treino oral ("fala comigo agora...").

Nunca fale de forma robótica.  
Nunca quebre o formato JSON.  
Nunca invente frases fora dos exemplos quando o módulo já oferece frases prontas.
`.trim();

    const userPrompt = `
PERGUNTA DO ALUNO:
${text}

HISTÓRICO RECENTE:
${(Array.isArray(history) ? history.slice(-6) : []).map(h => `- ${h.role}: ${h.text}`).join('\n') || '(vazio)'}

CONTEXTO DO MÓDULO (cite [n] ao usar):
${context}
`.trim();

    // 4) Histórico resumido
    const trimmedHistory = Array.isArray(history) ? history.slice(-8) : [];
    const messages = [
      { role: 'system', content: systemPrompt },
      ...trimmedHistory.map(item => ({
        role: item.role === 'assistant' ? 'assistant' : 'user',
        content: item.text
      })),
      { role: 'user', content: userPrompt }
    ];

    // 5) Chamada ao modelo
    const completion = await callWithTimeout(signal => openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages,
      temperature: 0.3,
      signal
      // sem response_format
    }));

    const rawContent = completion.choices?.[0]?.message?.content || '{}';
    let data;
    try { data = JSON.parse(rawContent); }
    catch {
      data = {
        reply: rawContent,
        translation: '',
        grammarNotes: '',
        vocabulary: [],
        followUpQuestion: '',
        extraSuggestions: [],
        culturalTip: '',
        confidence: 'media'
      };
    }

    // 6) Resposta para o front
    return res.json({
      ...data,
      goal, level, moduleId,
      sources: sourcesMeta
    });
  } catch (e) {
    const errInfo = normalizeOpenAIError(e);
    console.error('❌ Erro no chat (RAG):', errInfo.safeDetail);
    res.status(errInfo.httpStatus).json({
      error: 'falha_no_chat_rag',
      code: errInfo.code,
      detail: errInfo.safeDetail,
      hint: 'Verifique o kb_index.json e a OPENAI_API_KEY.',
      message: buildClientMessage(errInfo.code)
    });
  }
});

/* ---------- TTS (texto -> fala) ---------- */
app.post('/tts', async (req, res) => {
  try {
    if (!ensureOpenAI(res)) return;
    const { text } = req.body || {};

    if (!text || typeof text !== 'string') {
      return res.status(400).json({ error: "Campo 'text' é obrigatório." });
    }

    // 1) Chama o modelo de TTS
    const speechResponse = await callWithTimeout(signal => openai.audio.speech.create({
      model: 'gpt-4o-mini-tts', // ou o modelo que você tiver habilitado
      voice: 'alloy',
      format: 'mp3',
      input: text,
      signal
    }));

    // 2) Converte para Buffer
    const audioBuffer = Buffer.from(await speechResponse.arrayBuffer());

    // 3) Envia o áudio pro front
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Content-Length', audioBuffer.length);
    res.send(audioBuffer);
  } catch (e) {
    const errInfo = normalizeOpenAIError(e);
    console.error('❌ Erro no TTS:', errInfo.safeDetail);
    res.status(errInfo.httpStatus).json({
      error: 'falha_no_tts',
      code: errInfo.code,
      detail: errInfo.safeDetail,
      message: 'Não foi possível gerar o áudio da resposta agora.'
    });
  }
});


/* ---------- Fallback SPA ---------- */
app.use((_req, res) => {
  res.sendFile(path.join(publicDir, 'index.html'));
});

/* ---------- Listen único ---------- */
app.listen(PORT, () => {
  console.log(KB?.length ? `📚 KB carregado com ${KB.length} chunks` : '⚠️  kb_index.json vazio ou ausente. O RAG por módulo não funcionará.');
  console.log(`🚀 Servidor rodando na porta ${PORT}`);
  console.log(`🌐 Abra: http://localhost:${PORT}`);
});
