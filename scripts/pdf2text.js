// learnai/scripts/pdf2text.js
import fs from "fs";
import path from "path";
import { createRequire } from "module";
const require = createRequire(import.meta.url);

const pdfModule = require("pdf-parse");
const pdf = pdfModule.default || pdfModule; // <-- aqui está o pulo do gato

const modulesDir = "./conteudos";     // cada subpasta = módulo
const outputDir  = "./conteudos_txt";

if (!fs.existsSync(modulesDir)) {
  console.error("❌ Pasta ./conteudos não encontrada. Crie ./conteudos/<module-X> e coloque os PDFs.");
  process.exit(1);
}
if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

const modules = fs.readdirSync(modulesDir).filter(name => {
  const full = path.join(modulesDir, name);
  return fs.statSync(full).isDirectory();
});

for (const mod of modules) {
  const modPath = path.join(modulesDir, mod);
  const outPath = path.join(outputDir, mod);
  if (!fs.existsSync(outPath)) fs.mkdirSync(outPath, { recursive: true });

  const pdfs = fs.readdirSync(modPath).filter(f => f.toLowerCase().endsWith(".pdf"));
  if (!pdfs.length) {
    console.log(`(i) Sem PDFs em ${modPath}, pulando…`);
    continue;
  }

  for (const pdfFile of pdfs) {
    const inFile  = path.join(modPath, pdfFile);
    const outFile = path.join(outPath, pdfFile.replace(/\.pdf$/i, ".txt"));
    try {
      const dataBuffer = fs.readFileSync(inFile); // binário
      const data = await pdf(dataBuffer);

      // limpeza básica
      let text = (data.text || "")
        .replace(/\s{2,}/g, " ")  // espaços duplicados
        .replace(/\n{2,}/g, "\n") // quebras duplicadas
        .trim();

      fs.writeFileSync(outFile, text, "utf8");
      console.log("✔️ extraído:", path.relative(process.cwd(), inFile), "→", path.relative(process.cwd(), outFile));
    } catch (err) {
      console.error("❌ Falha ao processar", inFile, "\n   ", err?.message || err);
    }
  }
}
console.log("✅ Concluído.");
