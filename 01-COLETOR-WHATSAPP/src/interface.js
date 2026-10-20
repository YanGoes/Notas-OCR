"use strict";

const express = require("express");
const path = require("path");
const fs = require("fs");
const { execFile } = require("child_process");
const QRCode = require("qrcode");
const whatsapp = require("./coletor");
const notificacoes = require("./notificacoes");
const { lancarDespesa } = require("./lancamento-direto");
const { configuracaoAzure } = require("./azure-ocr");
const { criarRotas: criarRotasCentral } = require("./central/rotas");
const {
    obterEstadoContaAzul,
    confirmarEmpresa,
    sincronizarCentrosCusto,
    criarCentroCusto,
    verificarDocumento,
    listarFila,
    agendarPreparacao,
    agendarConfirmacao,
    marcarConfirmacaoManualPiloto,
} = require("./envio-conta-azul");

const RAIZ = path.resolve(__dirname, "..");
const app = express();
const porta = Number(process.env.PORT || 3211);
// O upload manual manda a foto em base64 (fotos de celular passam de 5 MB);
// as demais rotas continuam com limite pequeno.
app.use("/api/documentos/upload", express.json({ limit: "15mb" }));
// Anexos do assistente (imagens, videos, PDFs) tambem vao em base64.
app.use("/api/central/assistente/enviar", express.json({ limit: "150mb" }));
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

/**
 * Comprovante vindo do WhatsApp so aparece no painel se for de um grupo
 * marcado ou da conversa privada de uma pessoa liberada. Envio manual pelo
 * painel sempre aparece.
 */
function filtroDeOrigem() {
    const configuracao = whatsapp.obterConfiguracao();
    const grupos = new Set(configuracao.grupos_permitidos || []);
    const contatos = new Set(configuracao.contatos_permitidos || []);
    let identificar = null;
    const cache = new Map();
    return (grupoId, origem) => {
        const id = String(grupoId || "");
        if (origem && origem !== "whatsapp" && !id) return true;
        if (!id || id === "manual") return true;
        if (id.endsWith("@g.us")) return grupos.has(id);
        if (!/@(s\.whatsapp\.net|lid)$/.test(id) || !contatos.size) return false;
        if (cache.has(id)) return cache.get(id);
        try {
            if (!identificar) {
                const cadastros = require("./central/cadastros");
                const cad = cadastros.carregar();
                const db = require("./central/banco").banco();
                const vinculos = new Map(db.prepare("SELECT whatsapp_id, pessoa_id FROM remetentes_vinculados").all().map((l) => [l.whatsapp_id, l.pessoa_id]));
                identificar = (jid) => cadastros.identificarPessoa(cad, jid, { vinculos });
            }
            const achada = identificar(id);
            const permitido = achada.status === "IDENTIFICADA" && contatos.has(achada.pessoa.id);
            cache.set(id, permitido);
            return permitido;
        } catch (_) { return false; }
    };
}

function documentosRecentes(dataFiltro = "") {
    const permitido = filtroDeOrigem();
    const auditoria = path.join(RAIZ, "dados", "auditoria");
    const resultados = [];
    const filaContaAzul = new Map(listarFila().itens.map((item) => [item.base, item]));
    if (fs.existsSync(auditoria)) {
        for (const nome of fs.readdirSync(auditoria).filter((n) => n.endsWith(".json") && n !== "indice-duplicidade.json" && !n.endsWith("_erro.json"))) {
            try {
                const dados = JSON.parse(fs.readFileSync(path.join(auditoria, nome), "utf8"));
                if (!permitido(dados.grupo_id, dados.origem)) continue;
                const base = path.parse(dados.arquivo_imagem || nome).name;
                const imagem = localizarImagem(base);
                resultados.push({
                    base, arquivo: dados.arquivo_imagem, status: imagem?.pasta || "auditoria",
                    imagem_url: imagem ? `/api/documentos/${encodeURIComponent(base)}/imagem` : null,
                    legenda: dados.legenda_original, recebido_em: dados.recebido_em || dados.processado_em,
                    ocr: dados.ocr || {}, classificacao: dados.classificacao || {}, aprendizado: dados.aprendizado_historico || null, validacoes: dados.validacoes || {},
                    conta_azul: dados.conta_azul || { status: "NAO_ENVIADO" },
                    encaminhamento_whatsapp: dados.encaminhamento_whatsapp || null,
                    lancamento_direto: dados.lancamento_direto || null,
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
            if (!permitido(meta.id_grupo, meta.id_grupo ? "whatsapp" : "manual")) continue;
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

app.post("/api/documentos/upload", (req, res, next) => {
    try {
        const { arquivo_base64, nome_arquivo, legenda } = req.body || {};
        if (!arquivo_base64 || !nome_arquivo) throw new Error("Arquivo ou nome ausente.");
        const buffer = Buffer.from(arquivo_base64.replace(/^data:[^;]+;base64,/, ""), "base64");
        const ext = path.extname(nome_arquivo).toLowerCase();
        if (![".jpg", ".jpeg", ".png", ".bmp", ".pdf"].includes(ext)) throw new Error("Extensao nao suportada.");

        const entrada = path.join(RAIZ, "dados", "entrada");
        fs.mkdirSync(entrada, { recursive: true });
        const agora = Date.now();
        const baseLimpa = path.parse(nome_arquivo).name.replace(/[^a-z0-9_-]/gi, "_").slice(0, 40);
        const nomeFinal = `manual_${agora}_${baseLimpa}${ext}`;
        const caminhoImagem = path.join(entrada, nomeFinal);
        fs.writeFileSync(caminhoImagem, buffer);
        fs.writeFileSync(path.join(entrada, `manual_${agora}_${baseLimpa}.json`), JSON.stringify({
            legenda: legenda || null,
            remetente: "Upload Manual Web",
            id_mensagem: `manual-${agora}`,
            recebido_em_ms: agora,
        }, null, 2), "utf8");

        res.json({ ok: true, mensagem: "Arquivo enviado com sucesso para processamento!" });
    } catch (erro) { next(erro); }
});

app.post("/api/documentos/:base/encaminhar-conta-ai", async (req, res, next) => {
    try {
        const base = String(req.params.base || "");
        const imagem = localizarImagem(base);
        if (!imagem) throw new Error("Imagem nao encontrada.");
        const auditoriaPath = path.join(RAIZ, "dados", "auditoria", `${base}.json`);
        const auditoria = fs.existsSync(auditoriaPath) ? JSON.parse(fs.readFileSync(auditoriaPath, "utf8")) : {};
        if (auditoria.validacoes?.bloqueado) {
            throw new Error("Documento bloqueado por duplicidade ou fora do escopo; o encaminhamento nao e permitido.");
        }
        await whatsapp.encaminharParaContaAI(imagem.caminho, auditoria);
        res.json({ ok: true, mensagem: "Comprovante e instrucoes encaminhados ao Conta AI no WhatsApp." });
    } catch (erro) { next(erro); }
});

app.post("/api/documentos/:base/lancar-direto", async (req, res, next) => {
    try {
        const base = String(req.params.base || "");
        if (!base || path.basename(base) !== base) throw new Error("Nome de documento invalido.");
        // Criar despesa altera o Conta Azul e nao tem desfazer: exige confirmacao explicita.
        const simular = req.body?.confirmacao !== "LANCAR_NO_CONTA_AZUL";
        const resultado = await lancarDespesa(base, { dryRun: simular });

        if (resultado.impedimentos?.length) {
            return res.status(400).json({ erro: `Nao e possivel lancar: ${resultado.impedimentos.join(" ")}` });
        }
        if (resultado.erro) return res.status(400).json({ erro: resultado.erro, ...resultado });

        const mensagem = simular
            ? `Simulacao: a despesa seria criada com categoria e centro de custo preenchidos (R$ ${resultado.payload.valor}).`
            : `Despesa criada no Conta Azul${resultado.lancamento_id ? ` (id ${resultado.lancamento_id})` : ""}.`;
        return res.json({ ok: true, mensagem, ...resultado });
    } catch (erro) { return next(erro); }
});

app.post("/api/whatsapp/codigo", async (req, res, next) => {
    try {
        const codigo = await whatsapp.solicitarCodigoPareamento(req.body?.numero);
        res.json({ ok: true, codigo });
    } catch (erro) { next(erro); }
});

app.get("/api/notificacoes", (_req, res) => {
    res.json({ itens: notificacoes.listar(), nao_lidas: notificacoes.contarNaoLidas() });
});

app.post("/api/notificacoes/lidas", (req, res, next) => {
    try {
        const naoLidas = notificacoes.marcarLida(req.body?.id ? String(req.body.id) : null);
        res.json({ ok: true, nao_lidas: naoLidas });
    } catch (erro) { next(erro); }
});

app.post("/api/documentos/encaminhar-todos-conta-ai", async (req, res, next) => {
    try {
        const documentos = documentosRecentes();
        // Nunca reenvia o que ja foi encaminhado ou lancado: isso duplicaria despesa.
        const simulacao = documentos.filter((d) => d.status === "simulacao"
            && d.encaminhamento_whatsapp?.status !== "ENVIADO"
            && d.lancamento_direto?.status !== "CRIADO");
        if (!simulacao.length) throw new Error("Nenhum comprovante pronto e ainda nao enviado na fila de simulação.");
        let contagem = 0;
        for (const doc of simulacao) {
            const imagem = localizarImagem(doc.base);
            if (imagem) {
                const auditoriaPath = path.join(RAIZ, "dados", "auditoria", `${doc.base}.json`);
                const auditoria = fs.existsSync(auditoriaPath) ? JSON.parse(fs.readFileSync(auditoriaPath, "utf8")) : {};
                await whatsapp.encaminharParaContaAI(imagem.caminho, auditoria);
                contagem++;
                await new Promise((r) => setTimeout(r, 2000));
            }
        }
        res.json({ ok: true, quantidade: contagem, mensagem: `${contagem} comprovante(s) encaminhado(s) ao Conta AI no WhatsApp.` });
    } catch (erro) { next(erro); }
});
// Conversas no privado: pessoas do cadastro (telefone so com os 4 ultimos digitos).
function listarContatos() {
    const permitidos = new Set(whatsapp.obterConfiguracao().contatos_permitidos || []);
    return require("./central/cadastros").carregar().pessoas.map((pessoa) => ({
        id: pessoa.id, nome: pessoa.nome, papel: pessoa.papel || null,
        telefone_final: pessoa.telefone ? String(pessoa.telefone).slice(-4) : null, permitido: permitidos.has(pessoa.id),
    })).sort((a, b) => a.nome.localeCompare(b.nome, "pt-BR"));
}
app.get("/api/contatos", (_req, res, next) => {
    try { res.json(listarContatos()); } catch (erro) { next(erro); }
});
app.put("/api/contatos", (req, res, next) => {
    try {
        if (!Array.isArray(req.body?.ids)) throw new Error("Lista de contatos invalida.");
        const existentes = new Set(listarContatos().map((pessoa) => pessoa.id));
        whatsapp.salvarContatos(req.body.ids.map(String).filter((id) => existentes.has(id)));
        res.json({ ok: true, contatos: listarContatos() });
    } catch (erro) { next(erro); }
});
app.post("/api/contatos/:id/historico", async (req, res, next) => {
    try { res.json(await whatsapp.buscarHistoricoPrivado(String(req.params.id || ""))); } catch (erro) { next(erro); }
});
app.post("/api/contatos/pessoa", (req, res, next) => {
    try {
        const pessoa = require("./central/cadastros").adicionarPessoa(req.body || {});
        // Ja libera o privado de quem acabou de ser cadastrado aqui.
        whatsapp.salvarContatos([...(whatsapp.obterConfiguracao().contatos_permitidos || []), pessoa.id]);
        res.json({ ok: true, pessoa, contatos: listarContatos() });
    } catch (erro) { erro.status = 400; next(erro); }
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

// Central de revisao (previas, correcoes e treino). Painel em /central.html.
app.use("/api/central", criarRotasCentral({ identificarRemetentes: () => whatsapp.identificarRemetentes(), contaConectada: () => whatsapp.contaConectada() }));

app.use((erro, _req, res, _next) => res.status(400).json({ erro: erro.message || "Erro inesperado." }));
app.get("*splat", (_req, res) => res.sendFile(path.join(RAIZ, "public", "index.html")));

// Trava de instancia unica do WHATSAPP, independente da porta: duas copias
// usando a mesma sessao derrubam uma a outra (o WhatsApp avisa "conexao
// substituida"). A segunda copia se recusa a subir e diz qual esta aberta.
const ARQUIVO_TRAVA = path.join(RAIZ, "dados", "whatsapp-instancia.lock");
function processoVivo(pid) {
    try { process.kill(pid, 0); return true; } catch (erro) { return erro.code === "EPERM"; }
}
if (process.env.NAO_CONECTAR_WHATSAPP !== "1") {
    try {
        const trava = JSON.parse(fs.readFileSync(ARQUIVO_TRAVA, "utf8"));
        if (trava.pid && trava.pid !== process.pid && processoVivo(trava.pid)) {
            console.error(`\nO programa JA ESTA COLETANDO o WhatsApp nesta maquina (painel http://127.0.0.1:${trava.porta}, aberto em ${trava.desde}).`
                + "\nUse a janela que ja esta aberta. Duas copias ao mesmo tempo derrubam a conexao uma da outra.\n");
            process.exit(1);
        }
    } catch (_) { /* sem trava ou trava antiga: segue */ }
    fs.mkdirSync(path.dirname(ARQUIVO_TRAVA), { recursive: true });
    fs.writeFileSync(ARQUIVO_TRAVA, JSON.stringify({ pid: process.pid, porta, desde: new Date().toISOString() }), "utf8");
    const liberar = () => {
        try { if (JSON.parse(fs.readFileSync(ARQUIVO_TRAVA, "utf8")).pid === process.pid) fs.rmSync(ARQUIVO_TRAVA, { force: true }); } catch (_) { /* ja liberada */ }
    };
    process.on("exit", liberar);
    for (const sinal of ["SIGINT", "SIGTERM", "SIGBREAK"]) process.on(sinal, () => { liberar(); process.exit(0); });
}

const servidor = app.listen(porta, "127.0.0.1", () => {
    const url = `http://127.0.0.1:${porta}`;
    console.log(`\nPainel aberto em ${url}\n`);
    // NAO_CONECTAR_WHATSAPP=1 sobe o painel sem abrir conexao com o WhatsApp.
    // Serve para testes e diagnosticos: duas conexoes simultaneas usando a
    // mesma pasta de sessao fazem o WhatsApp recusar o pareamento.
    if (process.env.NAO_CONECTAR_WHATSAPP === "1") {
        console.log("Modo diagnostico: o WhatsApp NAO sera conectado nesta execucao.\n");
    } else {
        whatsapp.iniciar().catch((erro) => console.error("WhatsApp:", erro.message));
    }
    if (process.platform === "win32" && process.env.NAO_ABRIR_NAVEGADOR !== "1") execFile("explorer.exe", [url], () => {});
    // Copia diaria do banco da Central e dos cadastros (dados/backups, 14 dias).
    require("./backup").agendarBackups(() => require("./central/banco").banco());
    // Fotos das notas aprovadas para o Drive (central.arquivo_drive), a cada 10 min.
    require("./central/arquivo-drive").agendar(() => require("./central/banco").banco(), () => require("./central/cadastros").carregar());
});

// Trava de instancia unica. Duas copias abertas ao mesmo tempo compartilham a
// mesma pasta de sessao e abrem conexoes simultaneas com o WhatsApp — e o
// WhatsApp recusa o pareamento ("Nao foi possivel conectar o dispositivo").
servidor.on("error", (erro) => {
    if (erro.code === "EADDRINUSE") {
        console.error(
            `\nO programa JA ESTA ABERTO nesta maquina (porta ${porta} em uso).`
            + `\nUse a janela que ja esta aberta, ou o icone na bandeja do Windows,`
            + `\nem vez de abrir uma segunda copia.`
            + `\n\nSe voce acha que a copia anterior travou, feche-a pelo icone da bandeja`
            + `\n(botao direito > encerrar) e abra o programa novamente.\n`
        );
    } else {
        console.error(`\nNao consegui abrir o painel: ${erro.message}\n`);
    }
    process.exit(1);
});
