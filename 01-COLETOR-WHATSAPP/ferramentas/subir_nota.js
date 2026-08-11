"use strict";

const fs = require("fs");
const path = require("path");

const RAIZ = path.resolve(__dirname, "..");
const PASTA_ENTRADA = path.join(RAIZ, "dados", "entrada");
const EXT_PERMITIDAS = new Set([".jpg", ".jpeg", ".png", ".bmp", ".pdf"]);

function usage() {
  console.log("Uso: node ferramentas/subir_nota.js <caminho_arquivo> [--legenda 'texto'] [--id_mensagem id] [--remetente nome] [--recebido_em_ms 169...]");
}

function parseArgs(argv) {
  const out = { arquivo: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (!out.arquivo && !a.startsWith("--")) { out.arquivo = a; continue; }
    if (a === "--legenda") { out.legenda = argv[++i]; continue; }
    if (a === "--id_mensagem") { out.id_mensagem = argv[++i]; continue; }
    if (a === "--remetente") { out.remetente = argv[++i]; continue; }
    if (a === "--recebido_em_ms") { out.recebido_em_ms = Number(argv[++i]); continue; }
    if (a === "--help" || a === "-h") { out.help = true; }
  }
  return out;
}

function randomSuffix() {
  return Math.random().toString(16).slice(2, 8);
}

function garantirPasta() { fs.mkdirSync(PASTA_ENTRADA, { recursive: true }); }

function main() {
  const args = parseArgs(process.argv);
  if (args.help || !args.arquivo) { usage(); process.exit(args.help ? 0 : 1); }
  const orig = path.resolve(args.arquivo);
  if (!fs.existsSync(orig)) { console.error(`Arquivo nao encontrado: ${orig}`); process.exitCode = 2; return; }
  const ext = path.extname(orig).toLowerCase();
  if (!EXT_PERMITIDAS.has(ext)) { console.error(`Extensão não suportada: ${ext}`); process.exitCode = 3; return; }

  garantirPasta();
  const agora = Date.now();
  const baseOrig = path.parse(orig).name;
  const destName = `${baseOrig.replace(/[^a-z0-9\-]/gi, "").slice(0,40)}_${agora}_${randomSuffix()}${ext}`;
  const destPath = path.join(PASTA_ENTRADA, destName);
  fs.copyFileSync(orig, destPath);

  const meta = {
    legenda: args.legenda || null,
    id_mensagem: args.id_mensagem || null,
    remetente: args.remetente || null,
    recebido_em_ms: args.recebido_em_ms || agora,
  };
  const metaPath = path.join(PASTA_ENTRADA, `${path.parse(destName).name}.json`);
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), "utf8");

  console.log(`Arquivo copiado para: ${destPath}`);
  console.log(`Metadados criados em: ${metaPath}`);
  console.log("Pronto: o pipeline vai processar o arquivo automaticamente em alguns segundos.");
}

if (require.main === module) main();
