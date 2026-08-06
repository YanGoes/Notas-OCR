"use strict";

const express = require("express");
const path = require("path");
const fs = require("fs");
const { execFile } = require("child_process");
const QRCode = require("qrcode");
const whatsapp = require("./coletor");
const { configuracaoAzure } = require("./azure-ocr");

const RAIZ = path.resolve(__dirname, "..");
const app = express();
const porta = Number(process.env.PORT || 3210);
app.use(express.json({ limit: "100kb" }));
app.use(express.static(path.join(RAIZ, "public")));

function contagem(pasta) {
    const caminho = path.join(RAIZ, "dados", pasta);
    if (!fs.existsSync(caminho)) return 0;
    return fs.readdirSync(caminho).filter((nome) => /\.(jpe?g|png|bmp|pdf)$/i.test(nome)).length;
}

function azureConfigurado() {
    try { configuracaoAzure(); return true; } catch (_) { return false; }
}

const pastasDocumentos = ["entrada", "simulacao", "revisao", "bloqueados", "erros"];

function localizarImagem(nomeBase) {
    for (const pasta of pastasDocumentos) {
        const diretorio = path.join(RAIZ, "dados", pasta);
        if (!fs.existsSync(diretorio)) continue;
        const nome = fs.readdirSync(diretorio).find((arquivo) => path.parse(arquivo).name === nomeBase && /\.(jpe?g|png|bmp|pdf)$/i.test(arquivo));
        if (nome) return { caminho: path.join(diretorio, nome), pasta, nome };
    }
    return null;
}

function dataLocalIso(valor) {
    const data = new Date(valor);
    if (Number.isNaN(data.getTime())) return "";
    const parte = (numero) => String(numero).padStart(2, "0");
    return `${data.getFullYear()}-${parte(data.getMonth() + 1)}-${parte(data.getDate())}`;
}

function documentosRecentes(dataFiltro = "") {
    const auditoria = path.join(RAIZ, "dados", "auditoria");
    const resultados = [];
    if (fs.existsSync(auditoria)) {
        for (const nome of fs.readdirSync(auditoria).filter((n) => n.endsWith(".json") && n !== "indice-duplicidade.json" && !n.endsWith("_erro.json"))) {
            try {
                const dados = JSON.parse(fs.readFileSync(path.join(auditoria, nome), "utf8"));
                const base = path.parse(dados.arquivo_imagem || nome).name;
                const imagem = localizarImagem(base);
                resultados.push({
                    base, arquivo: dados.arquivo_imagem, status: imagem?.pasta || "auditoria",
                    imagem_url: imagem ? `/api/documentos/${encodeURIComponent(base)}/imagem` : null,
                    legenda: dados.legenda_original, recebido_em: dados.recebido_em || dados.processado_em,
                    ocr: dados.ocr || {}, classificacao: dados.classificacao || {}, aprendizado: dados.aprendizado_historico || null, validacoes: dados.validacoes || {},
                });
            } catch (_) { /* ignora JSON incompleto */ }
        }
    }
    const entrada = path.join(RAIZ, "dados", "entrada");
    if (fs.existsSync(entrada)) {
        for (const nome of fs.readdirSync(entrada).filter((n) => /\.(jpe?g|png|bmp|pdf)$/i.test(n))) {
            const base = path.parse(nome).name;
            if (resultados.some((item) => item.base === base)) continue;
            const metaPath = path.join(entrada, `${base}.json`);
            const meta = fs.existsSync(metaPath) ? JSON.parse(fs.readFileSync(metaPath, "utf8")) : {};
            resultados.push({ base, arquivo: nome, status: "entrada", imagem_url: `/api/documentos/${encodeURIComponent(base)}/imagem`, legenda: meta.legenda || null, recebido_em: meta.timestamp ? new Date(Number(meta.timestamp) * 1000).toISOString() : new Date(fs.statSync(path.join(entrada, nome)).mtimeMs).toISOString(), ocr: {}, classificacao: {}, validacoes: { motivos: ["Processamento em andamento."] } });
        }
    }
    return resultados
        .filter((item) => !dataFiltro || dataLocalIso(item.recebido_em) === dataFiltro)
        .sort((a, b) => String(b.recebido_em).localeCompare(String(a.recebido_em))).slice(0, 200);
}

app.get("/api/status", async (_req, res) => {
    const estado = whatsapp.obterEstado();
    let qrImagem = null;
    if (estado.qr) qrImagem = await QRCode.toDataURL(estado.qr, { width: 320, margin: 1, errorCorrectionLevel: "M" });
    res.json({
        whatsapp: { ...estado, qr: undefined, qr_imagem: qrImagem },
        azure: { configurado: azureConfigurado() },
        grupos: whatsapp.obterConfiguracao(),
        filas: { entrada: contagem("entrada"), simulacao: contagem("simulacao"), revisao: contagem("revisao"), bloqueados: contagem("bloqueados"), erros: contagem("erros") },
    });
});

app.post("/api/whatsapp/conectar", async (_req, res, next) => {
    try { await whatsapp.iniciar(); res.json({ ok: true }); } catch (erro) { next(erro); }
});
app.post("/api/whatsapp/desconectar", async (_req, res, next) => {
    try { await whatsapp.desconectar(); res.json({ ok: true }); } catch (erro) { next(erro); }
});
app.get("/api/grupos", async (_req, res, next) => {
    try { res.json(await whatsapp.listarGrupos()); } catch (erro) { next(erro); }
});
app.get("/api/documentos", (req, res) => {
    const data = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.data || "")) ? String(req.query.data) : "";
    res.json(documentosRecentes(data));
});
app.get("/api/documentos/:base/imagem", (req, res, next) => {
    try {
        const base = String(req.params.base || "");
        if (!base || path.basename(base) !== base) throw new Error("Nome de documento invalido.");
        const imagem = localizarImagem(base);
        if (!imagem) return res.status(404).json({ erro: "Imagem nao encontrada." });
        res.setHeader("Cache-Control", "no-store");
        return res.sendFile(imagem.caminho);
    } catch (erro) { return next(erro); }
});
app.put("/api/grupos", (req, res, next) => {
    try {
        if (!Array.isArray(req.body?.grupos)) throw new Error("Lista de grupos invalida.");
        const grupos = req.body.grupos.map((g) => ({ id: String(g.id || ""), nome: String(g.nome || g.id || "") })).filter((g) => g.id.endsWith("@g.us"));
        whatsapp.salvarGrupos(grupos);
        res.json({ ok: true, quantidade: grupos.length });
    } catch (erro) { next(erro); }
});

app.use((erro, _req, res, _next) => res.status(400).json({ erro: erro.message || "Erro inesperado." }));
app.get("*splat", (_req, res) => res.sendFile(path.join(RAIZ, "public", "index.html")));

app.listen(porta, "127.0.0.1", () => {
    const url = `http://127.0.0.1:${porta}`;
    console.log(`\nPainel aberto em ${url}\n`);
    whatsapp.iniciar().catch((erro) => console.error("WhatsApp:", erro.message));
    if (process.platform === "win32" && process.env.NAO_ABRIR_NAVEGADOR !== "1") execFile("explorer.exe", [url], () => {});
});
