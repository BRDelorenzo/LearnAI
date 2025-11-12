// learnai/scripts/indexar.js
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

// 1) Carrega .env da raiz do projeto, mesmo rodando de /scripts
import dotenv from "dotenv";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, "..", "backend/.env") });

// 2) Conferência amigável da chave
if (!process.env.OPENAI_API_KEY || !process.env.OPENAI_API_KEY.trim()) {
  console.error("❌ OPENAI_API_KEY ausente. Coloque no arquivo .env na raiz do projeto ou defina no ambiente.");
  console.error("   Exemplo (PowerShell):  $env:OPENAI_API_KEY='sk-proj-...' ; node indexar.js");
  process.exit(1);
}

// 3) Agora podemos importar e usar o SDK
import { OpenAI } from "openai";
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Pastas de entrada (TXTs extraídos) e saída (índice)
const TXT_ROOT = path.join(__dirname, "..", "scripts/conteudos_txt");
const OUT_FILE = path.join(__dirname, "..", "kb_index.json");

// --- util: varre pastas/módulos ---
function walkModules(root) {
  if (!fs.existsSync(root)) throw new Error(`Pasta não encontrada: ${root}`);
  const modules = fs.readdirSync(root).filter(name => {
    const full = path.join(root, name);
    return fs.statSync(full).isDirectory();
  });
  return modules.map(m => ({
    moduleId: m, // usa o nome da pasta como moduleId (ex.: "1 - Destravando para avancar")
    dir: path.join(root, m)
  }));
}

// --- util: carrega todos .txt por módulo ---
function loadTxtFiles(dir) {
  return fs.readdirSync(dir)
    .filter(f => f.toLowerCase().endsWith(".txt"))
    .map(f => ({
      source: f,
      text: fs.readFileSync(path.join(dir, f), "utf8")
    }));
}

// --- chunk: respeitando parágrafos (≈900–1200 chars) ---
function chunkByParagraphs(text, max = 1100) {
  const paras = (text || "").split(/\n{1,}/);
  const chunks = [];
  let buf = "";
  for (const p of paras) {
    // se o parágrafo sozinho já for muito grande, faz hard-split
    if (p.length > max) {
      if (buf.trim()) { chunks.push(buf.trim()); buf = ""; }
      for (let i = 0; i < p.length; i += max) {
        chunks.push(p.slice(i, i + max).trim());
      }
      continue;
    }
    if ((buf + "\n" + p).length > max) {
      if (buf.trim()) chunks.push(buf.trim());
      buf = p;
    } else {
      buf += (buf ? "\n" : "") + p;
    }
  }
  if (buf.trim()) chunks.push(buf.trim());
  return chunks.filter(Boolean);
}

// --- gera embeddings em lotes para eficiência ---
async function embedBatch(texts, batchSize = 64) {
  const out = [];
  for (let i = 0; i < texts.length; i += batchSize) {
    const slice = texts.slice(i, i + batchSize);
    const resp = await openai.embeddings.create({
      model: "text-embedding-3-large",
      input: slice
    });
    resp.data.forEach(d => out.push(d.embedding));
    process.stdout.write(`\r   → embeddings ${Math.min(i + slice.length, texts.length)}/${texts.length}`);
  }
  process.stdout.write("\n");
  return out;
}

async function main() {
  console.log("🔎 Varredura:", TXT_ROOT);
  const mods = walkModules(TXT_ROOT);
  if (!mods.length) {
    console.error("Nenhum módulo encontrado em conteudos_txt/");
    process.exit(1);
  }

  const allItems = [];

  for (const mod of mods) {
    console.log(`\n📚 Módulo: ${mod.moduleId}`);
    const files = loadTxtFiles(mod.dir);
    if (!files.length) {
      console.log("  (i) Sem .txt neste módulo, pulando.");
      continue;
    }

    // 1) Chunks com metadados
    const chunks = [];
    files.forEach(({ source, text }) => {
      const parts = chunkByParagraphs(text, 1100); // ajuste se quiser menor/maior
      parts.forEach((t, i) => {
        chunks.push({
          id: `${mod.moduleId}::${source}::${i}`,
          moduleId: mod.moduleId,
          source: `${source}#${i}`,
          text: t
        });
      });
    });

    if (!chunks.length) {
      console.log("  (i) Nada para indexar (textos vazios?)");
      continue;
    }

    console.log(`  → ${files.length} arquivos, ${chunks.length} chunks`);
    // 2) Embeddings
    const embeddings = await embedBatch(chunks.map(c => c.text));
    chunks.forEach((c, idx) => c.embedding = embeddings[idx]);

    // 3) Agrega saída
    allItems.push(...chunks);
  }

  // 4) Salva índice
  fs.writeFileSync(OUT_FILE, JSON.stringify(allItems), "utf8");
  console.log(`\n✅ Índice salvo em ${OUT_FILE}`);
  console.log(`   Total de chunks: ${allItems.length}`);
}

main().catch(err => {
  console.error("\n❌ Falha na indexação:", err?.message || err);
  process.exit(1);
});
