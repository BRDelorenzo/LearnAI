// backend/server.js
import 'dotenv/config'; // mantém o ;
import express from 'express';
import multer from 'multer';
import cors from 'cors';
import { OpenAI } from 'openai';
import fs from 'fs';
import path from 'path';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';
import { fileURLToPath } from 'url';


const raw = process.env.OPENAI_API_KEY || '';
const trimmed = raw.trim();

if (!trimmed) {
  console.warn('⚠️  OPENAI_API_KEY ausente. As rotas que dependem da OpenAI falharão.');
}

const openai = new OpenAI({
  apiKey: trimmed
});

ffmpeg.setFfmpegPath(ffmpegInstaller.path);

const normalizeOpenAIError = (error) => {
  const status = error?.response?.status || 500;
  const rawDetail = error?.response?.data || error?.message || 'erro desconhecido';
  const serialized = typeof rawDetail === 'string' ? rawDetail : JSON.stringify(rawDetail);
  const safeDetail = redactKey(serialized);
  const isAuth = status === 401 || /incorrect api key/i.test(serialized);
  return {
    code: isAuth ? 'invalid_api_key' : 'openai_request_failed',
    httpStatus: isAuth ? 503 : status,
    safeDetail
  };
};

const buildClientMessage = (code, context) => {
  if (code === 'invalid_api_key') {
    return 'Sua chave da OpenAI parece inválida ou expirada. Atualize a variável OPENAI_API_KEY e reinicie o backend.';
  }
  if (context === 'transcription') {
    return 'Não foi possível transcrever o áudio agora. Tente novamente em instantes.';
  }
  return 'Não foi possível falar com o coach agora. Tente novamente em alguns instantes.';
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

/* ---------- Static front (auto-descoberta) ---------- */
const publicFromParent = path.join(__dirname, '..', 'public'); // Opção A (recomendada): ../public/index.html
const publicFromHere   = path.join(__dirname);                  // Opção B: ./index.html (ao lado do server.js)

// escolhe a pasta que existir
const publicDir = fs.existsSync(publicFromParent) ? publicFromParent : publicFromHere;

// serve arquivos estáticos e responde GET /
app.use(express.static(publicDir));
app.get('/', (req, res) => {
  res.sendFile(path.join(publicDir, 'index.html'));
});
console.log('🗂️  Servindo estático a partir de:', publicDir);
console.log('📄 index.html existe?', fs.existsSync(path.join(publicDir, 'index.html')));

/* ---------- Middlewares gerais ---------- */
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

/* ---------- CORS (apenas se configurar ORIGINS no .env) ---------- */
const ALLOWED_ORIGINS = (process.env.CORS_ORIGINS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

if (ALLOWED_ORIGINS.length) {
  app.use(cors({ origin: ALLOWED_ORIGINS }));
}

/* ---------- Upload dir ---------- */
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

/* ---------- Multer ---------- */
const upload = multer({
  dest: uploadsDir,
  limits: { fileSize: 20 * 1024 * 1024 } // 20MB
});

/* ---------- OpenAI ---------- */
//const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/* ---------- Health ---------- */
app.get('/health', (_, res) => res.json({ ok: true, ts: Date.now() }));

/* ---------- Transcrição ---------- */
app.post('/transcrever', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Nenhum arquivo enviado.' });

  const originalPath = req.file.path;
  const wavPath = path.join(uploadsDir, `${req.file.filename}.wav`);

  console.log(`📥 Recebido: ${req.file.originalname} (${req.file.mimetype}, ${req.file.size} bytes)`);

  // Converte para WAV 16kHz mono
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

  // Chama a API de STT
  try {
    const result = await openai.audio.transcriptions.create({
      file: fs.createReadStream(wavPath),
      model: 'gpt-4o-mini-transcribe',
      // language: 'pt', // opcional
      // prompt: 'Vocabulário e nomes próprios usados no seu app...', // opcional
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


// Texto → resposta da OpenAI
app.post('/chat', express.json(), async (req, res) => {
  const {
    text,
    goal = 'conversacao_geral',
    level = 'intermediario',
    history = [],
    feedbackSignals = []
  } = req.body || {};

  if (!text) {
    return res.status(400).json({ error: 'texto ausente' });
  }

  const goalLabelMap = {
    conversacao_geral: 'Conversação geral',
    viagens: 'Inglês para viagens',
    entrevistas: 'Inglês para entrevistas de emprego',
    exames: 'Preparação para exames (ex.: TOEFL, IELTS)',
    negocios: 'Inglês corporativo e negócios'
  };

  const levelLabelMap = {
    iniciante: 'iniciante',
    intermediario: 'intermediário',
    avancado: 'avançado'
  };

  const goalLabel = goalLabelMap[goal] || goal;
  const levelLabel = levelLabelMap[level] || level;

  const systemPrompt = `Você é um coach de inglês paciente e encorajador. Adapte sua resposta ao objetivo do estudante (${goalLabel}) e ao nível declarado (${levelLabel}).
Responda sempre em JSON válido seguindo exatamente este schema:
{
  "reply": "resposta principal em inglês",
  "translation": "tradução em português da resposta principal",
  "grammarNotes": "dicas claras sobre gramática/vocabulário utilizados",
  "vocabulary": [
    { "term": "palavra/frase", "meaning": "explicação em português", "example": "frase curta em inglês" }
  ],
  "followUpQuestion": "pergunta curta para manter a conversa alinhada ao objetivo",
  "extraSuggestions": ["outras abordagens ou tarefas de estudo"],
  "culturalTip": "contexto cultural ou sugestão motivacional",
  "confidence": "baixa|media|alta"
}
Utilize linguagem simples e incentive o aluno. Considere sinais de feedback do usuário: ${JSON.stringify(feedbackSignals || []).slice(0, 600)}.`;

  const trimmedHistory = Array.isArray(history) ? history.slice(-8) : [];
  const messages = [
    { role: 'system', content: systemPrompt },
    ...trimmedHistory.map(item => ({ role: item.role === 'assistant' ? 'assistant' : 'user', content: item.text })),
    { role: 'user', content: text }
  ];

  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages,
      temperature: 0.4,
      response_format: { type: 'json_object' }
    });

    const rawContent = completion.choices?.[0]?.message?.content || '{}';
    let data;
    try {
      data = JSON.parse(rawContent);
    } catch (parseErr) {
      console.warn('⚠️  Falha ao parsear JSON do modelo, retornando fallback.', parseErr);
      data = { reply: rawContent };
    }

    res.json({
      ...data,
      goal,
      level
    });
  } catch (e) {
    const status = e?.response?.status || 500;
    const detail = e?.response?.data || e.message || 'erro desconhecido';
    console.error('❌ Erro no chat:', detail);
    res.status(status).json({
      error: 'falha no chat',
      detail,
      hint: 'Verifique sua chave da OpenAI e tente novamente.'
    });
  }
});

/* ---------- Listen único ---------- */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Servidor rodando na porta ${PORT}`);
  console.log(`🌐 Abra: http://localhost:${PORT}`);
});
