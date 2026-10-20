"use strict";

// =============================================================================
// ANEXOS DO ASSISTENTE (imagens, videos, PDFs, planilhas, textos)
// =============================================================================
//
// A tela manda cada arquivo em base64. Aqui ele e guardado em
// dados/assistente/anexos/<conversa>/ (para reaparecer no historico) e virado
// em blocos que o Claude entende:
//   - imagem  -> bloco image (reduzida com ffmpeg se passar de ~3,5 MB)
//   - PDF     -> bloco document
//   - video   -> ate 10 quadros (imagens) espalhados pela duracao + aviso de
//                que o audio nao e ouvido
//   - planilha (.xlsx) -> texto CSV por aba
//   - Word (.docx)     -> texto
//   - texto/CSV/JSON/codigo -> texto
// Outros formatos sao recusados com explicacao.
// =============================================================================

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { execFileSync } = require("child_process");

const RAIZ = path.resolve(__dirname, "..", "..");
const PASTA = path.join(RAIZ, "dados", "assistente", "anexos");

const MAX_ARQUIVOS = 10;
const MAX_BYTES = { imagem: 20 * 1024 * 1024, pdf: 30 * 1024 * 1024, video: 80 * 1024 * 1024, texto: 10 * 1024 * 1024 };
const MAX_IMAGEM_DIRETA = 3.5 * 1024 * 1024;
const MAX_CARACTERES = 120000;
const QUADROS_VIDEO = 10;

const EXT_TEXTO = new Set([".txt", ".csv", ".tsv", ".json", ".md", ".log", ".xml", ".html", ".htm", ".js", ".ts", ".py", ".sql", ".yaml", ".yml", ".ini", ".bat", ".ps1", ".css"]);
const EXT_IMAGEM = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".bmp": null, ".heic": null, ".heif": null };
const EXT_VIDEO = new Set([".mp4", ".mov", ".avi", ".mkv", ".webm", ".3gp", ".m4v", ".wmv"]);

function nomeSeguro(nome) {
    const limpo = path.basename(String(nome || "arquivo")).replace(/[^\w.\- ()À-ú]/g, "_").slice(-120);
    return limpo || "arquivo";
}

/** Classifica pelo tipo informado e pela extensao. */
function classificar(nome, tipo = "") {
    const ext = path.extname(nome).toLowerCase();
    const mime = String(tipo || "").toLowerCase();
    if (ext in EXT_IMAGEM || mime.startsWith("image/")) return "imagem";
    if (ext === ".pdf" || mime === "application/pdf") return "pdf";
    if (EXT_VIDEO.has(ext) || mime.startsWith("video/")) return "video";
    if (ext === ".xlsx") return "planilha";
    if (ext === ".docx") return "word";
    if (EXT_TEXTO.has(ext) || mime.startsWith("text/") || mime === "application/json") return "texto";
    return null;
}

/** ffmpeg: config, PATH ou a instalacao do winget. */
function localizarFfmpeg(programa = "ffmpeg") {
    const tentar = (caminho) => { try { execFileSync(caminho, ["-version"], { stdio: "ignore", windowsHide: true }); return true; } catch (_) { return false; } };
    if (tentar(programa)) return programa;
    const base = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "Microsoft", "WinGet", "Packages");
    try {
        for (const pacote of fs.readdirSync(base).filter((n) => /ffmpeg/i.test(n))) {
            for (const versao of fs.readdirSync(path.join(base, pacote))) {
                const exe = path.join(base, pacote, versao, "bin", `${programa}.exe`);
                if (fs.existsSync(exe)) return exe;
            }
        }
    } catch (_) { /* sem winget */ }
    return null;
}

function blocoImagem(caminho, mime) {
    return { type: "image", source: { type: "base64", media_type: mime, data: fs.readFileSync(caminho).toString("base64") } };
}

/** Imagem grande, BMP ou HEIC: converte para JPEG de ate 1600 px com ffmpeg. */
function imagemReduzida(caminho, temporaria) {
    const ffmpeg = localizarFfmpeg();
    if (!ffmpeg) throw new Error("imagem grande demais e o ffmpeg não está instalado para reduzi-la");
    const saida = path.join(temporaria, `${crypto.randomUUID()}.jpg`);
    execFileSync(ffmpeg, ["-loglevel", "error", "-y", "-i", caminho, "-vf", "scale='min(1600,iw)':-2", "-frames:v", "1", "-q:v", "4", saida], { windowsHide: true });
    return saida;
}

function duracaoVideo(caminho) {
    const ffprobe = localizarFfmpeg("ffprobe");
    if (!ffprobe) return null;
    try {
        const saida = execFileSync(ffprobe, ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", caminho], { windowsHide: true }).toString().trim();
        const segundos = Number(saida);
        return Number.isFinite(segundos) && segundos > 0 ? segundos : null;
    } catch (_) { return null; }
}

/** Quadros espalhados pelo video (o Claude nao assiste video: ve fotos dele). */
function quadrosDoVideo(caminho, temporaria) {
    const ffmpeg = localizarFfmpeg();
    if (!ffmpeg) throw new Error("para ler vídeos é preciso o ffmpeg instalado");
    const duracao = duracaoVideo(caminho) || 10;
    const quantidade = Math.max(1, Math.min(QUADROS_VIDEO, Math.ceil(duracao / 2)));
    const quadros = [];
    for (let i = 0; i < quantidade; i += 1) {
        const instante = Math.min(duracao - 0.05, (duracao * (i + 0.5)) / quantidade);
        const saida = path.join(temporaria, `${crypto.randomUUID()}.jpg`);
        try {
            execFileSync(ffmpeg, ["-loglevel", "error", "-y", "-ss", instante.toFixed(2), "-i", caminho, "-frames:v", "1", "-vf", "scale='min(1024,iw)':-2", "-q:v", "5", saida], { windowsHide: true });
            if (fs.existsSync(saida)) quadros.push({ instante, caminho: saida });
        } catch (_) { /* quadro ilegivel: pula */ }
    }
    if (!quadros.length) throw new Error("não consegui extrair imagens deste vídeo");
    return { duracao, quadros };
}

async function textoDaPlanilha(caminho) {
    const ExcelJS = require("exceljs");
    const livro = new ExcelJS.Workbook();
    await livro.xlsx.readFile(caminho);
    const partes = [];
    for (const aba of livro.worksheets) {
        const linhas = [];
        aba.eachRow({ includeEmpty: false }, (linha) => {
            linhas.push(linha.values.slice(1).map((v) => {
                const valor = v && typeof v === "object" ? (v.text ?? v.result ?? (v instanceof Date ? v.toISOString().slice(0, 10) : JSON.stringify(v))) : v;
                const texto = String(valor ?? "");
                return /[;"\n]/.test(texto) ? `"${texto.replace(/"/g, '""')}"` : texto;
            }).join(";"));
        });
        partes.push(`### Aba "${aba.name}" (${linhas.length} linhas, separador ;)\n${linhas.join("\n")}`);
    }
    return partes.join("\n\n");
}

async function textoDoWord(caminho) {
    const JSZip = require("jszip");
    const zip = await JSZip.loadAsync(fs.readFileSync(caminho));
    const xml = await zip.file("word/document.xml")?.async("string");
    if (!xml) throw new Error("documento Word sem conteúdo legível");
    return xml.replace(/<\/w:p>/g, "\n").replace(/<w:tab\/>/g, "\t").replace(/<[^>]+>/g, "")
        .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&apos;/g, "'").trim();
}

function cortar(texto) {
    const s = String(texto || "");
    return s.length > MAX_CARACTERES ? `${s.slice(0, MAX_CARACTERES)}\n[… cortado: o arquivo tem ${s.length} caracteres, só os primeiros ${MAX_CARACTERES} foram lidos]` : s;
}

/**
 * Guarda os anexos e devolve { blocos, resumo }. `resumo` vai para o
 * historico (nome, tipo, tamanho, endereco para abrir).
 * @param {{nome:string, tipo?:string, dados:string}[]} lista — dados em base64
 */
async function preparar(lista, { conversaId, pasta = PASTA } = {}) {
    const anexos = Array.isArray(lista) ? lista : [];
    if (!anexos.length) return { blocos: [], resumo: [] };
    if (anexos.length > MAX_ARQUIVOS) throw new Error(`No máximo ${MAX_ARQUIVOS} arquivos por mensagem.`);
    const destino = path.join(pasta, String(conversaId || "sem-conversa"));
    fs.mkdirSync(destino, { recursive: true });
    const temporaria = fs.mkdtempSync(path.join(os.tmpdir(), "vmac-anexo-"));
    const blocos = [];
    const resumo = [];
    try {
        for (const anexo of anexos) {
            const nome = nomeSeguro(anexo?.nome);
            const classe = classificar(nome, anexo?.tipo);
            if (!classe) throw new Error(`"${nome}": formato não suportado. Envie imagem, vídeo, PDF, planilha .xlsx, Word .docx ou texto.`);
            const bytes = Buffer.from(String(anexo?.dados || "").replace(/^data:[^,]*,/, ""), "base64");
            if (!bytes.length) throw new Error(`"${nome}" chegou vazio.`);
            const limite = MAX_BYTES[classe] || MAX_BYTES.texto;
            if (bytes.length > limite) throw new Error(`"${nome}" tem ${(bytes.length / 1048576).toFixed(1)} MB; o limite para ${classe} é ${limite / 1048576} MB.`);
            const arquivo = `${Date.now()}_${crypto.randomBytes(3).toString("hex")}_${nome}`;
            const caminho = path.join(destino, arquivo);
            fs.writeFileSync(caminho, bytes);
            resumo.push({ nome, classe, tamanho: bytes.length, arquivo, conversa: String(conversaId || "sem-conversa") });
            const ext = path.extname(nome).toLowerCase();
            const titulo = { type: "text", text: `[Anexo: ${nome}]` };

            if (classe === "imagem") {
                const mime = EXT_IMAGEM[ext] || (String(anexo.tipo).startsWith("image/") ? anexo.tipo : null);
                const direto = mime && ["image/png", "image/jpeg", "image/gif", "image/webp"].includes(mime) && bytes.length <= MAX_IMAGEM_DIRETA;
                blocos.push(titulo, direto ? blocoImagem(caminho, mime) : blocoImagem(imagemReduzida(caminho, temporaria), "image/jpeg"));
            } else if (classe === "pdf") {
                blocos.push(titulo, { type: "document", source: { type: "base64", media_type: "application/pdf", data: bytes.toString("base64") } });
            } else if (classe === "video") {
                const { duracao, quadros } = quadrosDoVideo(caminho, temporaria);
                blocos.push({ type: "text", text: `[Anexo: vídeo ${nome}, ${Math.round(duracao)} s. Você não ouve o áudio nem assiste o vídeo: seguem ${quadros.length} quadros em ordem, com o instante de cada um.]` });
                for (const quadro of quadros) blocos.push({ type: "text", text: `Quadro em ${quadro.instante.toFixed(1)} s:` }, blocoImagem(quadro.caminho, "image/jpeg"));
            } else if (classe === "planilha") {
                blocos.push({ type: "text", text: `[Anexo: planilha ${nome}]\n${cortar(await textoDaPlanilha(caminho))}` });
            } else if (classe === "word") {
                blocos.push({ type: "text", text: `[Anexo: documento Word ${nome}]\n${cortar(await textoDoWord(caminho))}` });
            } else {
                blocos.push({ type: "text", text: `[Anexo: arquivo ${nome}]\n\`\`\`\n${cortar(bytes.toString("utf8"))}\n\`\`\`` });
            }
        }
    } finally {
        fs.rmSync(temporaria, { recursive: true, force: true });
    }
    return { blocos, resumo };
}

/** Caminho de um anexo salvo (so dentro da pasta de anexos). */
function caminhoDoAnexo(conversa, arquivo, pasta = PASTA) {
    if (!/^[\w-]+$/.test(String(conversa)) || path.basename(String(arquivo)) !== String(arquivo)) return null;
    const caminho = path.join(pasta, String(conversa), String(arquivo));
    return fs.existsSync(caminho) ? caminho : null;
}

module.exports = { preparar, classificar, caminhoDoAnexo, localizarFfmpeg, MAX_ARQUIVOS };
