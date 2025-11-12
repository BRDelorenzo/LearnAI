// backend/server.js
import 'dotenv/config';
import express from 'express';
import multer from 'multer';
import cors from 'cors';
import { OpenAI } from 'openai';
import fs from 'fs';
import path from 'path';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';
import { fileURLToPath } from 'url';

/* ---------- Boot ---------- */
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const PORT       = process.env.PORT || 3000;

/* ---------- App ---------- */
const app = express();

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
const openai = new OpenAI({ apiKey: openaiApiKey });

/* ---------- FFmpeg ---------- */
ffmpeg.setFfmpegPath(ffmpegInstaller.path);

/* ---------- Utils para erros ---------- */
function redactKey(str) {
  if (!str || typeof str !== 'string') return str;
  return str.replace(/\b(sk-[A-Za-z0-9]{6})[A-Za-z0-9_-]{10,}\b/g, '$1…');
}
function normalizeOpenAIError(error) {
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
  if (context === 'transcription') {
    return 'Não foi possível transcrever o áudio agora. Tente novamente em instantes.';
  }
  return 'Não foi possível falar com o coach agora. Tente novamente em alguns instantes.';
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
  const embRes = await openai.embeddings.create({
    model: 'text-embedding-3-large',
    input: query
  });
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
  if (!req.file) return res.status(400).json({ error: 'Nenhum arquivo enviado.' });

  const originalPath = req.file.path;
  const wavPath = path.join(uploadsDir, `${req.file.filename}.wav`);

  console.log(`📥 Recebido: ${req.file.originalname} (${req.file.mimetype}, ${req.file.size} bytes)`);

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
    try { fs.unlinkSync(originalPath); } catch {}
    return res.status(500).json({ error: 'Falha na conversão de áudio.' });
  } finally {
    try { fs.unlinkSync(originalPath); } catch {}
  }

  if (!fs.existsSync(wavPath)) {
    return res.status(500).json({ error: 'Arquivo WAV não encontrado após conversão.' });
  }

  try {
    const result = await openai.audio.transcriptions.create({
      file: fs.createReadStream(wavPath),
      model: 'gpt-4o-mini-transcribe',
      // language: 'pt',
    });
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
    try { fs.unlinkSync(wavPath); } catch {}
  }
});

/* ---------- Chat (RAG por módulo) ---------- */
app.post('/chat', async (req, res) => {
  try {
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
Você é o Coach LearnAI. Responda com base no material do módulo quando disponível.
- Nível do aluno: ${level}
- Objetivo: ${goal}
- Módulo: ${moduleId}
- Quando usar o material recuperado (abaixo), cite-o como [#n] sem links.
- Traga explicação curta, exemplos e uma pergunta de continuação.
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
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages,
      temperature: 0.3,
      response_format: { type: 'json_object' }
    });

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
      hint: 'Verifique o kb_index.json e a OPENAI_API_KEY.'
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
