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

ffmpeg.setFfmpegPath(ffmpegInstaller.path);

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
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

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
    console.error('❌ Erro na transcrição:', e?.response?.data || e.message);
    res.status(500).json({ error: 'Erro ao transcrever o áudio.' });
  } finally {
    try { fs.unlinkSync(wavPath); } catch {}
  }
});

/* ---------- Listen único ---------- */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Servidor rodando na porta ${PORT}`);
  console.log(`🌐 Abra: http://localhost:${PORT}`);
});
