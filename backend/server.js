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

  // Converter para WAV
  try {
    await new Promise((resolve, reject) => {
      ffmpeg(originalPath)
        .toFormat("wav")
        .on("error", (err) => {
          console.error("Erro ao converter para WAV:", err);
          reject(err);
        })
        .on("end", () => {
          console.log(`Arquivo convertido para WAV: ${convertedPath}`);
          resolve();
        })
        .save(convertedPath);
    });
  } catch (err) {
    fs.unlinkSync(originalPath);
    return res.status(500).json({ error: "Falha na conversão de áudio." });
  }

  // Transcrever com OpenAI
  try {
    const response = await openai.audio.transcriptions.create({
      file: fs.createReadStream(convertedPath),
      model: "whisper-1",
      language: "pt"
    });

    // Limpar arquivos temporários
    fs.unlinkSync(originalPath);
    fs.unlinkSync(convertedPath);

    res.json({ transcricao: response.text });
  } catch (err) {
    console.error(err);
    fs.unlinkSync(originalPath);
    if (fs.existsSync(convertedPath)) fs.unlinkSync(convertedPath);
    res.status(500).json({ error: "Erro ao transcrever o áudio." });
  }
});

app.listen(3000, () => console.log("Servidor rodando na porta 3000"));
