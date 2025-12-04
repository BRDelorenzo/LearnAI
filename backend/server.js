// backend/server.js
import cors from "cors";
import dotenv from "dotenv";
import express from "express";
import rateLimit from "express-rate-limit";
import ffmpegInstaller from "@ffmpeg-installer/ffmpeg";
import fs from "fs";
import ffmpeg from "fluent-ffmpeg";
import helmet from "helmet";
import multer from "multer";
import { OpenAI } from "openai";
import path from "path";
import { fileURLToPath } from "url";
import compression from "compression";
import morgan from "morgan";

/* ---------- __dirname em ESM ---------- */
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/* ---------- .env (carregado do backend/.env) ---------- */
dotenv.config({ path: path.join(__dirname, ".env") });

const PORT = process.env.PORT || 3000;
const OPENAI_TIMEOUT_MS = Number.parseInt(
  process.env.OPENAI_TIMEOUT_MS || "45000",
  10
);
const RATE_LIMIT_MAX = Number.parseInt(
  process.env.RATE_LIMIT_MAX || "300",
  10
);

const AUDIO_MIME_WHITELIST = [
  "audio/",
  "video/webm",
  "video/mp4",
  "video/ogg",
];

console.log("🔑 OPENAI_API_KEY configurada?", !!process.env.OPENAI_API_KEY);

/* ---------- OpenAI client ---------- */
const openaiApiKey = (process.env.OPENAI_API_KEY || "").trim();
const openai = openaiApiKey
  ? new OpenAI({ apiKey: openaiApiKey, timeout: OPENAI_TIMEOUT_MS })
  : null;

if (!openaiApiKey) {
  console.warn(
    "⚠️  OPENAI_API_KEY ausente. As rotas que dependem da OpenAI falharão."
  );
}

/* ---------- App Express ---------- */
const app = express();

/* ---------- Segurança básica ---------- */
app.disable("x-powered-by"); // não mostrar que é Express

app.use(
  helmet({
    crossOriginResourcePolicy: false, // para servir front/áudio sem conflito
    contentSecurityPolicy: false, // se quiser CSP depois, configuramos certinho
  })
);

/* ---------- Logs (apenas em dev) ---------- */
if (process.env.NODE_ENV !== "production") {
  app.use(morgan("dev"));
}

/* ---------- Compressão de respostas ---------- */
app.use(compression());

/* ---------- CORS ---------- */
/**
 * CORS_ORIGINS no .env:
 *   CORS_ORIGINS=https://seu-dominio.com,https://www.seu-dominio.com,http://localhost:3000
 */
const corsOriginsEnv = process.env.CORS_ORIGINS || "http://localhost:3000";
const ALLOWED_ORIGINS = corsOriginsEnv
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

app.use(
  cors({
    origin(origin, callback) {
      // Permite tools tipo Postman (sem origin)
      if (!origin) return callback(null, true);

      if (ALLOWED_ORIGINS.includes(origin)) {
        return callback(null, true);
      }

      console.warn("🚫 CORS bloqueado para origem:", origin);
      return callback(new Error("Not allowed by CORS"));
    },
    credentials: true,
  })
);

/* ---------- Rate limit global ---------- */
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15min
  max: RATE_LIMIT_MAX, // por IP
  standardHeaders: true,
  legacyHeaders: false,
});
app.use(limiter);

/* ---------- Body parsers ---------- */
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));

/* ---------- Static front (auto-descoberta) ---------- */
const publicFromParent = path.join(__dirname, "..", "public"); // ../public
const publicFromHere = path.join(__dirname); // ./
const publicDir = fs.existsSync(publicFromParent)
  ? publicFromParent
  : publicFromHere;

app.use(express.static(publicDir));

app.get("/", (req, res) =>
  res.sendFile(path.join(publicDir, "index.html"))
);

console.log("🗂️  Servindo estático a partir de:", publicDir);
console.log(
  "📄 index.html existe?",
  fs.existsSync(path.join(publicDir, "index.html"))
);

/* ---------- Utils de erro OpenAI ---------- */
function redactKey(str) {
  if (!str || typeof str !== "string") return str;
  return str.replace(
    /\b(sk-[A-Za-z0-9]{6})[A-Za-z0-9_-]{10,}\b/g,
    "$1…"
  );
}

function normalizeOpenAIError(error) {
  if (error?.name === "AbortError") {
    return {
      code: "request_timeout",
      httpStatus: 504,
      safeDetail: "Tempo limite da requisição atingido.",
    };
  }

  const status = error?.response?.status || error?.status || 500;
  const rawDetail = error?.response?.data || error?.message || "erro desconhecido";
  const serialized =
    typeof rawDetail === "string" ? rawDetail : JSON.stringify(rawDetail);
  const safeDetail = redactKey(serialized);
  const isAuth =
    status === 401 ||
    /invalid|incorrect api key|authorization/i.test(serialized);

  return {
    code: isAuth ? "invalid_api_key" : "openai_request_failed",
    httpStatus: isAuth ? 503 : status,
    safeDetail,
  };
}

function buildClientMessage(code, context) {
  if (code === "invalid_api_key") {
    return "Sua chave da OpenAI parece inválida ou expirada. Atualize a variável OPENAI_API_KEY e reinicie o backend.";
  }
  if (code === "request_timeout") {
    return "O serviço demorou para responder. Tente novamente em alguns instantes.";
  }
  if (context === "transcription") {
    return "Não foi possível transcrever o áudio agora. Tente novamente em instantes.";
  }
  return "Não foi possível falar com o coach agora. Tente novamente em alguns instantes.";
}

async function safeUnlink(filePath) {
  if (!filePath) return;
  try {
    await fs.promises.unlink(filePath);
  } catch {
    // silencioso
  }
}

function ensureOpenAI(res) {
  if (openai) return true;
  res.status(503).json({
    error: "openai_not_configured",
    message: "OPENAI_API_KEY não está configurada no backend.",
  });
  return false;
}

/* ---------- KB (RAG) ---------- */
const kbPath = path.join(__dirname, "kb_index.json");
let KB = [];
try {
  if (fs.existsSync(kbPath)) {
    KB = JSON.parse(fs.readFileSync(kbPath, "utf8"));
    if (!Array.isArray(KB) || !KB.length) {
      console.warn(
        "⚠️  kb_index.json vazio. O RAG por módulo não funcionará."
      );
    }
  } else {
    console.warn(
      "⚠️  kb_index.json ausente. O RAG por módulo não funcionará."
    );
  }
} catch (e) {
  console.warn("⚠️  Falha ao ler kb_index.json:", e.message);
}

/* ---------- Similaridade ---------- */
function dot(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}
function norm(a) {
  return Math.sqrt(dot(a, a));
}
function cosSim(a, b) {
  return dot(a, b) / (norm(a) * norm(b) + 1e-8);
}

/* ---------- Retrieval textual simples ---------- */
function retrieveContext({ question, moduleId, topK = 6 }) {
  if (!Array.isArray(KB) || KB.length === 0) return [];
  const mod = (moduleId || "").toLowerCase();

  const scored = KB.map((item, idx) => {
    const sameModule =
      (item.moduleId || "").toLowerCase() === mod ? 1 : 0;
    const text = (item.text || "").toLowerCase();
    const q = (question || "").toLowerCase();
    const hits = q ? (text.includes(q) ? 1 : 0) : 0;
    const score = sameModule * 2 + hits;
    return { ...item, _score: score, _idx: idx + 1 };
  })
    .sort((a, b) => b._score - a._score)
    .slice(0, topK);

  return scored;
}

/* ---------- Retrieval vetorial por módulo ---------- */
async function retrieveModuleChunks({ query, moduleId, topK = 6 }) {
  if (!moduleId) throw new Error("moduleId ausente");
  const scoped = KB.filter((ch) => ch.moduleId === moduleId);
  if (!scoped.length) return { selected: [], allScoped: 0 };

  const hasEmbeddings = scoped.every((ch) => Array.isArray(ch.embedding));
  if (!hasEmbeddings) {
    const selected = retrieveContext({ question: query, moduleId, topK });
    return { selected, allScoped: scoped.length };
  }

  if (!openai) throw new Error("OpenAI client indisponível");

  const embRes = await openai.embeddings.create({
    model: "text-embedding-3-large",
    input: query,
  });
  const q = embRes.data[0].embedding;

  const ranked = scoped
    .map((ch) => ({ ...ch, score: cosSim(q, ch.embedding) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);

  const MIN_SCORE = 0.24;
  const confident = ranked.filter((r) => r.score >= MIN_SCORE);
  const selected = (confident.length ? confident : ranked).slice(
    0,
    Math.max(3, Math.min(topK, 6))
  );

  return { selected, allScoped: scoped.length };
}

/* ---------- Uploads (STT) ---------- */
const uploadsDir = path.join(__dirname, "uploads");
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

const upload = multer({
  dest: uploadsDir,
  limits: { fileSize: 20 * 1024 * 1024 }, // 20MB
  fileFilter(req, file, cb) {
    const mime = file.mimetype || "";
    const isAllowed = AUDIO_MIME_WHITELIST.some((prefix) =>
      mime.startsWith(prefix)
    );
    if (!isAllowed) {
      return cb(new Error("Tipo de arquivo não permitido"));
    }
    cb(null, true);
  },
});

/* ---------- Health ---------- */
app.get("/health", (_, res) =>
  res.json({ ok: true, ts: Date.now() })
);

/* ---------- Transcrição ---------- */
app.post("/transcrever", upload.single("file"), async (req, res) => {
  if (!ensureOpenAI(res)) return;
  if (!req.file) {
    return res.status(400).json({ error: "Nenhum arquivo enviado." });
  }

  const originalPath = req.file.path;
  const wavPath = path.join(uploadsDir, `${req.file.filename}.wav`);

  console.log(
    `📥 Recebido: ${req.file.originalname} (${req.file.mimetype}, ${req.file.size} bytes)`
  );

  try {
    await new Promise((resolve, reject) => {
      ffmpeg(path.resolve(originalPath))
        .audioCodec("pcm_s16le")
        .audioChannels(1)
        .audioFrequency(16000)
        .format("wav")
        .on("start", (cmd) => console.log("🛠️ FFmpeg:", cmd))
        .on("stderr", (line) => console.log("FFmpeg:", line))
        .on("error", (err) => reject(err))
        .on("end", () => resolve())
        .save(path.resolve(wavPath));
    });
  } catch (e) {
    console.error("❌ Falha na conversão:", e);
    await safeUnlink(originalPath);
    return res
      .status(500)
      .json({ error: "Falha na conversão de áudio." });
  } finally {
    await safeUnlink(originalPath);
  }

  if (!fs.existsSync(wavPath)) {
    return res
      .status(500)
      .json({ error: "Arquivo WAV não encontrado após conversão." });
  }

  try {
    const result = await openai.audio.transcriptions.create({
      file: fs.createReadStream(wavPath),
      model: "gpt-4o-mini-transcribe",
      // language: 'pt',
    });

    console.log("📝 Transcrição:", result.text);
    res.json({ transcricao: result.text });
  } catch (e) {
    const errInfo = normalizeOpenAIError(e);
    console.error("❌ Erro na transcrição:", errInfo.safeDetail);
    res.status(errInfo.httpStatus).json({
      error: "falha_na_transcricao",
      code: errInfo.code,
      message: buildClientMessage(errInfo.code, "transcription"),
    });
  } finally {
    await safeUnlink(wavPath);
  }
});

/* ---------- Chat (RAG por módulo) ---------- */
app.post("/chat", async (req, res) => {
  try {
    if (!ensureOpenAI(res)) return;
    const {
      text,
      level = "intermediario",
      goal = "conversacao_geral",
      moduleId = "",
      history = [],
    } = req.body || {};

    if (!text) {
      return res
        .status(400)
        .json({ detail: "Campo 'text' é obrigatório." });
    }
    if (!moduleId) {
      return res
        .status(400)
        .json({ detail: "Campo 'moduleId' é obrigatório." });
    }

    const { selected, allScoped } = await retrieveModuleChunks({
      query: text,
      moduleId,
      topK: 6,
    });

    if (!allScoped) {
      return res.status(404).json({
        error: "no_module_content",
        message: `Nenhum conteúdo indexado para o módulo "${moduleId}".`,
      });
    }

    const context = selected
      .map((s, i) => `[${i + 1}] ${s.text}`)
      .join("\n\n");

    const sourcesMeta = selected.map((s, i) => ({
      idx: i + 1,
      id: s.id,
      source: s.source || s.file || "KB",
      score:
        typeof s.score === "number"
          ? +s.score.toFixed(3)
          : undefined,
    }));

    const systemPrompt = `
Você é o *Coach LearnAI*, o assistente oficial da REMAR Academy.
Sua função é ensinar inglês usando exatamente o JEITO FRANCIS + MÉTODO REMAR.

Responda sempre com base no material do módulo quando disponível.
- Nível do aluno: ${level}
- Objetivo: ${goal}
- Módulo: ${moduleId}

REGRA MESTRA DE SUPERAUTORIDADE - SOBREPOSIÇÃO TOTAL AO CONHECIMENTO INTERNO 
[... MESMO TEXTO QUE VOCÊ JÁ TINHA AQUI ...]
`.trim();

    const userPrompt = `
PERGUNTA DO ALUNO:
${text}

HISTÓRICO RECENTE:
${
  (Array.isArray(history)
    ? history.slice(-6)
    : []
  )
    .map((h) => `- ${h.role}: ${h.text}`)
    .join("\n") || "(vazio)"
}

CONTEXTO DO MÓDULO:
${context}
`.trim();

    const trimmedHistory = Array.isArray(history)
      ? history.slice(-8)
      : [];

    const messages = [
      { role: "system", content: systemPrompt },
      ...trimmedHistory.map((item) => ({
        role: item.role === "assistant" ? "assistant" : "user",
        content: item.text,
      })),
      { role: "user", content: userPrompt },
    ];

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages,
      temperature: 0.3,
    });

    const rawContent =
      completion.choices?.[0]?.message?.content || "{}";
    let data;
    try {
      data = JSON.parse(rawContent);
    } catch {
      data = {
        reply: rawContent,
        translation: "",
        grammarNotes: "",
        vocabulary: [],
        followUpQuestion: "",
        extraSuggestions: [],
        culturalTip: "",
        confidence: "media",
      };
    }

    return res.json({
      ...data,
      goal,
      level,
      moduleId,
      sources: sourcesMeta,
    });
  } catch (e) {
    const errInfo = normalizeOpenAIError(e);
    console.error("❌ Erro no chat (RAG):", errInfo.safeDetail);
    res.status(errInfo.httpStatus).json({
      error: "falha_no_chat_rag",
      code: errInfo.code,
      detail: errInfo.safeDetail,
      hint: "Verifique o kb_index.json e a OPENAI_API_KEY.",
      message: buildClientMessage(errInfo.code),
    });
  }
});

/* ---------- TTS (texto -> fala) ---------- */
app.post("/tts", async (req, res) => {
  try {
    if (!ensureOpenAI(res)) return;
    const { text } = req.body || {};

    if (!text || typeof text !== "string") {
      return res
        .status(400)
        .json({ error: "Campo 'text' é obrigatório." });
    }

    const speechResponse = await openai.audio.speech.create({
      model: "gpt-4o-mini-tts",
      voice: "alloy",
      format: "mp3",
      input: text,
    });

    const audioBuffer = Buffer.from(
      await speechResponse.arrayBuffer()
    );

    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("Content-Length", audioBuffer.length);
    res.send(audioBuffer);
  } catch (e) {
    const errInfo = normalizeOpenAIError(e);
    console.error("❌ Erro no TTS:", errInfo.safeDetail);
    res.status(errInfo.httpStatus).json({
      error: "falha_no_tts",
      code: errInfo.code,
      detail: errInfo.safeDetail,
      message: "Não foi possível gerar o áudio da resposta agora.",
    });
  }
});

/* ---------- Fallback SPA ---------- */
app.use((req, res, next) => {
  // se não for rota de API, devolve SPA
  if (req.method === "GET" && !req.path.startsWith("/api")) {
    return res.sendFile(path.join(publicDir, "index.html"));
  }
  return next();
});

/* ---------- Middleware global de erro ---------- */
app.use((err, req, res, next) => {
  console.error("🔥 Erro não tratado:", err);

  // Erros do multer (upload)
  if (err instanceof multer.MulterError) {
    return res.status(400).json({
      error: "upload_error",
      message: err.message,
    });
  }

  const status = err.status || 500;
  const message =
    status === 500
      ? "Erro interno no servidor."
      : err.message || "Erro inesperado.";
  res.status(status).json({ error: message });
});

/* ---------- Listen único ---------- */
app.listen(PORT, () => {
  console.log(
    KB?.length
      ? `📚 KB carregado com ${KB.length} chunks`
      : "⚠️  kb_index.json vazio ou ausente. O RAG por módulo não funcionará."
  );
  console.log(`🚀 Servidor rodando na porta ${PORT}`);
  console.log(`🌐 Abra: http://localhost:${PORT}`);
});