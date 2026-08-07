"use strict";

const express = require("express");
const path = require("path");
const fs = require("fs");
const { execFile } = require("child_process");
const QRCode = require("qrcode");
const whatsapp = require("./coletor");
const { configuracaoAzure } = require("./azure-ocr");
const {
    obterEstadoContaAzul,
    confirmarEmpresa,
    sincronizarCentrosCusto,
    criarCentroCusto,
    verificarDocumento,
    listarFila,
    agendarPreparacao,
    agendarConfirmacao,
    agendarLancamentoDireto,
    verificarLancamentoDireto,
    marcarConfirmacaoManualPiloto,
} = require("./envio-conta-azul");

const RAIZ = path.resolve(__dirname, "..");
const app = express();
const porta = Number(process.env.PORT || 3210);
app.use(express.json({ limit: "100kb" }));
app.use((req, res, next) => {
    if (req.path === "/" || /\.(?:html|js|css)$/i.test(req.path)) {
        res.setHeader("Cache-Control", "no-store, max-age=0");
    }
    next();
});
app.use(express.static(path.join(RAIZ, "public"), { etag: false, lastModified: false }));

function contagem(pasta) {
    const caminho = path.join(RAIZ, "dados", pasta);
    if (!fs.existsSync(caminho)) return 0;
    return fs.readdirSync(caminho).filter((nome) => /\.(jpe?g|png|bmp|pdf)$/i.test(nome)).length;
}

function azureConfigurado() {
    try { configuracaoAzure(); return true; } catch (_) { return false; }
}

function centrosCustoDisponiveis() {
    const arquivo = path.join(RAIZ, "configuracao", "centros_custo.json");
    if (!fs.existsSync(arquivo)) return [];
    try {
        const centros = JSON.parse(fs.readFileSync(arquivo, "utf8"));
        return Array.isArray(centros) ? centros
            .filter((centro) => centro && centro.id && centro.nome)
            .map((centro) => ({ id: String(centro.id), nome: String(centro.nome) })) : [];
    } catch (_) { return []; }
}

const pastasDocumentos = ["entrada", "simulacao", "revisao", "bloqueados", "erros", "enviados"];

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
    const filaContaAzul = new Map(listarFila().itens.map((item) => [item.base, item]));
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
                    conta_azul: dados.conta_azul || { status: "NAO_ENVIADO" },
                    envio_conta_azul: filaContaAzul.get(base) || null,
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
        filas: { entrada: contagem("entrada"), simulacao: contagem("simulacao"), revisao: contagem("revisao"), bloqueados: contagem("bloqueados"), erros: contagem("erros"), enviados: contagem("enviados") },
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
app.get("/api/centros-custo", (_req, res) => {
    res.json(centrosCustoDisponiveis());
});
app.get("/api/conta-azul/status", async (_req, res, next) => {
    try { res.json(await obterEstadoContaAzul()); } catch (erro) { next(erro); }
});
app.get("/api/conta-azul/fila", (_req, res) => {
    res.json(listarFila());
});
app.post("/api/conta-azul/empresa/confirmar", async (req, res, next) => {
    try {
        if (req.body?.confirmacao !== true) throw new Error("Confirmacao explicita da empresa obrigatoria.");
        res.json({ ok: true, empresa: await confirmarEmpresa(req.body.id_empresa) });
    } catch (erro) { next(erro); }
});
app.post("/api/centros-custo/sincronizar", async (req, res, next) => {
    try {
        if (req.body?.confirmacao !== true) throw new Error("Confirme a sincronizacao dos centros de custo.");
        const centros = await sincronizarCentrosCusto(req.body.id_empresa);
        res.json({ ok: true, centros });
    } catch (erro) { next(erro); }
});
app.post("/api/centros-custo", async (req, res, next) => {
    try {
        if (req.body?.confirmacao !== true) throw new Error("Confirme a criacao do centro de custo.");
        res.json({ ok: true, ...(await criarCentroCusto({
            nome: req.body.nome,
            codigo: req.body.codigo,
            idEmpresa: req.body.id_empresa,
        })) });
    } catch (erro) { next(erro); }
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
        const grupos = req.body.grupos.map((g) => ({
            id: String(g.id || ""),
            nome: String(g.nome || g.id || ""),
            centro_custo_id: String(g.centro_custo_id || ""),
        })).filter((g) => g.id.endsWith("@g.us"));
        whatsapp.salvarGrupos(grupos);
        execFile(process.execPath, [path.join(RAIZ, "ferramentas", "reprocessar_ocr_salvo.js")], {
            cwd: RAIZ,
            windowsHide: true,
        }, (erro, stdout) => {
            if (erro) console.error("Reprocessamento apos salvar grupos:", erro.message);
            else if (stdout.trim()) console.log(stdout.trim());
        });
        res.json({ ok: true, quantidade: grupos.length });
    } catch (erro) { next(erro); }
});

app.post("/api/conta-azul/despesas/preparar-lote", (req, res, next) => {
    try {
        if (req.body?.confirmacao !== "ENVIAR_PREVIAS") throw new Error("Confirmacao do envio das imagens obrigatoria.");
        res.json({ ok: true, ...agendarPreparacao(req.body.bases, req.body.id_empresa) });
    } catch (erro) { next(erro); }
});
app.post("/api/conta-azul/despesas/confirmar-lote", (req, res, next) => {
    try {
        if (req.body?.confirmacao !== "CRIAR_DESPESAS") throw new Error("Confirmacao da criacao das despesas obrigatoria.");
        const porBase = new Map(listarFila().itens.map((item) => [item.base, item]));
        const itens = (req.body.bases || []).map((base) => ({
            base,
            token: porBase.get(String(base))?.conta_azul?.token_confirmacao,
        }));
        res.json({ ok: true, ...agendarConfirmacao(itens, req.body.id_empresa) });
    } catch (erro) { next(erro); }
});
app.post("/api/conta-azul/despesas/:base/preparar", (req, res, next) => {
    try {
        if (req.body?.confirmacao !== "ENVIAR_PREVIA") throw new Error("Confirmacao do envio da imagem obrigatoria.");
        res.json({ ok: true, ...agendarPreparacao([req.params.base], req.body.id_empresa) });
    } catch (erro) { next(erro); }
});
app.post("/api/conta-azul/despesas/:base/confirmar", (req, res, next) => {
    try {
        if (req.body?.confirmacao !== "CRIAR_DESPESA") throw new Error("Confirmacao da criacao da despesa obrigatoria.");
        res.json({ ok: true, ...agendarConfirmacao([{
            base: req.params.base,
            token: req.body.token,
        }], req.body.id_empresa) });
    } catch (erro) { next(erro); }
});
app.post("/api/conta-azul/despesas/:base/verificar", async (req, res, next) => {
    try { res.json({ ok: true, conta_azul: await verificarDocumento(req.params.base, req.body?.id_empresa) }); }
    catch (erro) { next(erro); }
});
app.post("/api/conta-azul/despesas/:base/direto", async (req, res, next) => {
    try {
        if (req.body?.confirmacao !== "CRIAR_DIRETO_COM_PENDENCIAS") {
            throw new Error("Confirmacao explicita do lancamento direto assistido obrigatoria.");
        }
        res.json({ ok: true, ...(await agendarLancamentoDireto(req.params.base, {
            idEmpresa: req.body?.id_empresa,
            token: req.body?.token,
            idContaFinanceira: req.body?.id_conta_financeira,
        })) });
    } catch (erro) { next(erro); }
});
app.post("/api/conta-azul/despesas/:base/direto/verificar", async (req, res, next) => {
    try {
        if (req.body?.confirmacao !== "VERIFICAR_DIRETO_SEM_REENVIAR") {
            throw new Error("Confirmacao explicita da verificacao por protocolo obrigatoria.");
        }
        res.json({ ok: true, conta_azul: await verificarLancamentoDireto(req.params.base, req.body?.id_empresa) });
    } catch (erro) { next(erro); }
});
app.post("/api/conta-azul/despesas/:base/validar-no-erp", async (req, res, next) => {
    try {
        res.json({ ok: true, conta_azul: await marcarConfirmacaoManualPiloto(req.params.base, {
            idEmpresa: req.body?.id_empresa,
            eventoId: req.body?.evento_id,
            confirmadoPor: req.body?.confirmado_por,
            confirmacao: req.body?.confirmacao,
        }) });
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
