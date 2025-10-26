import express from "express";
import multer from "multer";
import cors from "cors";
import { OpenAI } from "openai";
import fs from "fs";
import ffmpeg from "fluent-ffmpeg";
import path from "path";

const app = express();
app.use(cors());
const upload = multer({ dest: "uploads/" });

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

app.post("/transcrever", upload.single("file"), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "Nenhum arquivo enviado." });
  }

  const originalPath = req.file.path;
  const convertedPath = path.join("uploads", `${req.file.filename}.wav`);

  console.log(`MIME type recebido: ${req.file.mimetype}`);
  console.log(`Arquivo salvo em: ${originalPath}`);

  // Converter para WAV (com logs e caminho absoluto)
try {
  await new Promise((resolve, reject) => {
    const absoluteInput = path.resolve(originalPath);
    const absoluteOutput = path.resolve("uploads", `${req.file.filename}.wav`);

    console.log(`🎧 Iniciando conversão: ${absoluteInput} -> ${absoluteOutput}`);

    ffmpeg(absoluteInput)
      .inputOptions(["-y"]) // sobrescrever sem perguntar
      .audioCodec("pcm_s16le")
      .audioFrequency(16000) // whisper funciona melhor com 16kHz
      .format("wav")
      .on("start", (cmd) => console.log("Comando FFmpeg:", cmd))
      .on("stderr", (line) => console.log("FFmpeg:", line))
      .on("error", (err) => {
        console.error("❌ Erro ao converter:", err.message);
        reject(err);
      })
      .on("end", () => {
        console.log(`✅ Conversão concluída: ${absoluteOutput}`);
        resolve();
      })
      .save(absoluteOutput);
  });
} catch (err) {
  console.error("Erro na etapa de conversão:", err);
  fs.unlinkSync(originalPath);
  return res.status(500).json({ error: "Falha na conversão de áudio." });
}

console.log("🔑 OPENAI_API_KEY:", process.env.OPENAI_API_KEY?.slice(0,4) + "…");
if (!fs.existsSync(convertedPath)) {
  fs.unlinkSync(originalPath);
  return res.status(500).json({ error: "Arquivo WAV não encontrado após conversão." });
}
  // Transcrever com OpenAI
  try {
    const response = await openai.audio.transcriptions.create({
      file: fs.createReadStream(convertedPath),
      model: "whisper-1",
      language: "pt"
    });
    console.log("📝 Transcrição concluída:", response.text);
    // Limpar arquivos temporários
    fs.unlinkSync(originalPath);
    //fs.unlinkSync(convertedPath);

    res.json({ transcricao: response.text });
  } catch (err) {
    console.error(err);
    fs.unlinkSync(originalPath);
    if (fs.existsSync(convertedPath)) fs.unlinkSync(convertedPath);
    res.status(500).json({ error: "Erro ao transcrever o áudio." });
  }
  
});

app.listen(3000, () => console.log("Servidor rodando na porta 3000"));


const uploadsDir = path.join(process.cwd(), "uploads");
console.log("📁 Verificando pasta uploads:", uploadsDir);
console.log("📂 Existe?", fs.existsSync(uploadsDir));
console.log("📑 Conteúdo:", fs.existsSync(uploadsDir) ? fs.readdirSync(uploadsDir) : "Pasta não encontrada");

console.log("🔑 OPENAI_API_KEY:", process.env.OPENAI_API_KEY?.slice(0,4) + "…");