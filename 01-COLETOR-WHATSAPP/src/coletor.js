"use strict";

const fs = require("fs");
const path = require("path");
const pino = require("pino");
const qrcode = require("qrcode-terminal");
const EventEmitter = require("events");
const { iniciarPipeline } = require("./pipeline");
const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    downloadMediaMessage,
} = require("@whiskeysockets/baileys");

const RAIZ = path.resolve(__dirname, "..");
const ARQUIVO_CONFIG = path.join(RAIZ, "config.json");
const ARQUIVO_CENTROS_CUSTO = path.join(RAIZ, "configuracao", "centros_custo.json");
const PASTA_SESSAO = path.join(RAIZ, ".baileys_sessao");
const logger = pino({ level: "silent" });
const extensoes = {
    "image/jpeg": ".jpg",
    "image/jpg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
};

function carregarConfig() {
    if (!fs.existsSync(ARQUIVO_CONFIG)) {
        throw new Error("config.json nao encontrado. Copie config.exemplo.json para config.json e ajuste os valores.");
    }
    const config = JSON.parse(fs.readFileSync(ARQUIVO_CONFIG, "utf8"));
    if (!Array.isArray(config.grupos_permitidos)) {
        throw new Error("config.json: 'grupos_permitidos' precisa ser uma lista.");
    }
    const pastaInformada = String(config.pasta_saida || "fotos_recebidas");
    config.pasta_saida = path.isAbsolute(pastaInformada)
        ? pastaInformada
        : path.join(RAIZ, pastaInformada);
    config.nomes_dos_grupos = config.nomes_dos_grupos || {};
    config.centros_custo_por_grupo = config.centros_custo_por_grupo || {};
    return config;
}

function carregarCentrosCusto() {
    if (!fs.existsSync(ARQUIVO_CENTROS_CUSTO)) return [];
    try {
        const centros = JSON.parse(fs.readFileSync(ARQUIVO_CENTROS_CUSTO, "utf8"));
        return Array.isArray(centros) ? centros.filter((centro) => centro && centro.id && centro.nome) : [];
    } catch (_) { return []; }
}

function centroCustoDoGrupo(idGrupo) {
    const idCentro = String(config.centros_custo_por_grupo[idGrupo] || "");
    if (!idCentro) return null;
    const centro = carregarCentrosCusto().find((item) => String(item.id) === idCentro);
    return centro ? { id: String(centro.id), nome: String(centro.nome) } : null;
}

const config = carregarConfig();
let gruposPermitidos = new Set(config.grupos_permitidos);
const eventos = new EventEmitter();
const estado = { status: "parado", qr: null, erro: null, conectado_desde: null };
let socketAtual = null;
let deslogando = false;
const fotosRecentes = [];
const comentariosRecentes = [];
fs.mkdirSync(config.pasta_saida, { recursive: true });
async function encaminharParaContaAI(caminhoImagem, auditoria) {
    const numeroContaAI = config.numero_conta_ai || process.env.NUMERO_CONTA_AI;
    if (!numeroContaAI) return;
    if (!socketAtual || estado.status !== "conectado") {
        console.log("Conta AI WhatsApp: Socket desconectado ou indisponivel no momento. Nao foi possivel encaminhar.");
        return;
    }
    let jid = String(numeroContaAI).trim();
    if (!jid.endsWith("@s.whatsapp.net") && !jid.endsWith("@g.us")) {
        jid = `${jid.replace(/\D/g, "")}@s.whatsapp.net`;
    }

    try {
        console.log(`Conta AI WhatsApp: Encaminhando foto ${path.basename(caminhoImagem)} para ${jid}...`);
        const buffer = fs.readFileSync(caminhoImagem);
        const extensao = path.extname(caminhoImagem).toLowerCase();
        const mimetype = extensao === ".png" ? "image/png" : "image/jpeg";
        const legendaFoto = auditoria.conta_azul?.descricao_sugerida
            ? `Comprovante: ${auditoria.conta_azul.descricao_sugerida}`
            : "Comprovante de despesa";

        await socketAtual.sendMessage(jid, {
            image: buffer,
            mimetype,
            caption: legendaFoto,
        });
        console.log(`Conta AI WhatsApp: Foto enviada com sucesso para ${jid}.`);

        const partes = ["Nova Despesa:"];
        if (auditoria.classificacao?.categoria_nome) {
            partes.push(`- Categoria: ${auditoria.classificacao.categoria_nome}`);
        }
        if (auditoria.classificacao?.centro_custo_nome) {
            partes.push(`- Centro de Custo: ${auditoria.classificacao.centro_custo_nome}`);
        }
        if (auditoria.operador?.conta_informada) {
            partes.push(`- Forma de Pagamento: ${auditoria.operador.conta_informada}`);
        }
        if (auditoria.classificacao?.placa || auditoria.dados_abastecimento?.placa) {
            partes.push(`- Veículo / Placa: ${auditoria.classificacao.placa || auditoria.dados_abastecimento.placa}`);
        }
        if (auditoria.conta_azul?.descricao_sugerida) {
            partes.push(`- Descrição: ${auditoria.conta_azul.descricao_sugerida}`);
        }
        partes.push("\nPor favor, lance esta despesa utilizando exatamente os dados acima.");

        const textoComando = partes.join("\n");
        await new Promise((r) => setTimeout(r, 1500));
        await socketAtual.sendMessage(jid, { text: textoComando });
        console.log(`Conta AI WhatsApp: Instrucoes de comando enviadas em texto com sucesso para ${jid}.`);
    } catch (erro) {
        console.error("Conta AI WhatsApp: Erro ao encaminhar mensagem:", erro?.message || erro);
    }
}

iniciarPipeline(
    config.pasta_saida,
    { ...config.pipeline, aguardar_comentario_segundos: config.aguardar_comentario_segundos },
    encaminharParaContaAI
);

function limparNome(valor) {
    return String(valor || "")
        .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
        .replace(/[<>:"/\\|?*\x00-\x1F]/g, "_")
        .replace(/\s+/g, "_").replace(/_+/g, "_")
        .replace(/^_+|_+$/g, "").slice(0, 100);
}

function timestampNumero(valor) {
    if (typeof valor === "number") return valor;
    if (valor && typeof valor.toNumber === "function") return valor.toNumber();
    return Number(valor) || Math.floor(Date.now() / 1000);
}

function dataNome(timestamp) {
    const d = new Date(timestampNumero(timestamp) * 1000);
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}

function extrairImagem(message) {
    let atual = message;
    for (let i = 0; i < 5 && atual; i += 1) {
        if (atual.imageMessage) return atual.imageMessage;
        const envelope = atual.ephemeralMessage || atual.viewOnceMessage || atual.viewOnceMessageV2 || atual.documentWithCaptionMessage;
        atual = envelope?.message;
    }
    return null;
}

function extrairTexto(message) {
    let atual = message;
    for (let i = 0; i < 5 && atual; i += 1) {
        if (atual.conversation) return { texto: String(atual.conversation).trim(), citadoId: null };
        if (atual.extendedTextMessage?.text) return {
            texto: String(atual.extendedTextMessage.text).trim(),
            citadoId: atual.extendedTextMessage.contextInfo?.stanzaId || null,
        };
        const envelope = atual.ephemeralMessage || atual.viewOnceMessage || atual.viewOnceMessageV2;
        atual = envelope?.message;
    }
    return null;
}

function remetenteDaMensagem(chave) {
    return String(chave.participant || chave.remoteJid || "nao_identificado");
}

function limparRecentes() {
    const limite = Date.now() - Number(config.janela_associacao_comentario_segundos || 120) * 1000;
    while (fotosRecentes.length && fotosRecentes[0].timestampMs < limite) fotosRecentes.shift();
    while (comentariosRecentes.length && comentariosRecentes[0].timestampMs < limite) comentariosRecentes.shift();
}

function substituirLegendaTxt(caminho, legenda) {
    if (!fs.existsSync(caminho)) return;
    const conteudo = fs.readFileSync(caminho, "utf8");
    const marcador = "=== LEGENDA / COMENTARIO ===";
    const inicio = conteudo.indexOf(marcador);
    const novo = inicio >= 0 ? `${conteudo.slice(0, inicio)}${marcador}\n\n${legenda}\n` : `${conteudo}\n${marcador}\n\n${legenda}\n`;
    fs.writeFileSync(caminho, novo, "utf8");
}

function aplicarComentarioNaFoto(foto, texto, origem, idComentario) {
    const meta = JSON.parse(fs.readFileSync(foto.caminhoJson, "utf8"));
    if (meta.legenda) return false;
    meta.legenda = texto;
    meta.legenda_origem = origem;
    meta.id_mensagem_comentario = idComentario || null;
    meta.comentario_associado_em = new Date().toISOString();
    fs.writeFileSync(foto.caminhoJson, JSON.stringify(meta, null, 2), "utf8");
    substituirLegendaTxt(foto.caminhoTxt, texto);
    foto.temLegenda = true;
    console.log(`Comentario separado associado a foto ${foto.idMensagem}: ${texto}`);
    return true;
}

function registrarComentarioSeparado(idGrupo, remetente, idMensagem, timestampMs, texto, citadoId) {
    limparRecentes();
    const candidatas = fotosRecentes.filter((foto) => foto.idGrupo === idGrupo && foto.remetente === remetente && !foto.temLegenda && fs.existsSync(foto.caminhoJson));
    const foto = (citadoId && candidatas.find((item) => item.idMensagem === citadoId)) || candidatas.sort((a, b) => b.timestampMs - a.timestampMs)[0];
    if (foto && Math.abs(timestampMs - foto.timestampMs) <= Number(config.janela_associacao_comentario_segundos || 120) * 1000) {
        aplicarComentarioNaFoto(foto, texto, citadoId ? "resposta_a_foto" : "mensagem_seguinte", idMensagem);
        return;
    }
    comentariosRecentes.push({ idGrupo, remetente, idMensagem, timestampMs, texto, citadoId, usado: false });
}

function nomeGrupo(id) {
    return config.nomes_dos_grupos[id] || id || "grupo_nao_identificado";
}

function atualizarEstado(alteracoes) {
    Object.assign(estado, alteracoes);
    eventos.emit("estado", { ...estado });
}

function salvarGrupos(grupos) {
    config.grupos_permitidos = grupos.map((grupo) => grupo.id);
    config.nomes_dos_grupos = Object.fromEntries(grupos.map((grupo) => [grupo.id, grupo.nome]));
    const centrosValidos = new Set(carregarCentrosCusto().map((centro) => String(centro.id)));
    config.centros_custo_por_grupo = Object.fromEntries(grupos
        .filter((grupo) => grupo.centro_custo_id && centrosValidos.has(String(grupo.centro_custo_id)))
        .map((grupo) => [grupo.id, String(grupo.centro_custo_id)]));
    gruposPermitidos = new Set(config.grupos_permitidos);
    const persistido = JSON.parse(fs.readFileSync(ARQUIVO_CONFIG, "utf8"));
    persistido.grupos_permitidos = config.grupos_permitidos;
    persistido.nomes_dos_grupos = config.nomes_dos_grupos;
    persistido.centros_custo_por_grupo = config.centros_custo_por_grupo;
    fs.writeFileSync(ARQUIVO_CONFIG, JSON.stringify(persistido, null, 2) + "\n", "utf8");
}

async function listarGrupos() {
    if (!socketAtual || estado.status !== "conectado") throw new Error("WhatsApp ainda nao esta conectado.");
    const encontrados = await socketAtual.groupFetchAllParticipating();
    return Object.values(encontrados).map((grupo) => ({
        id: grupo.id, nome: grupo.subject || grupo.id, selecionado: gruposPermitidos.has(grupo.id),
        centro_custo_id: config.centros_custo_por_grupo[grupo.id] || "",
    })).sort((a, b) => a.nome.localeCompare(b.nome, "pt-BR"));
}

async function desconectar() {
    deslogando = true;
    atualizarEstado({ status: "desconectando", qr: null, erro: null });
    try { if (socketAtual) await socketAtual.logout(); } catch (_) { /* a sessao sera removida localmente */ }
    socketAtual = null;
    if (fs.existsSync(PASTA_SESSAO)) fs.rmSync(PASTA_SESSAO, { recursive: true, force: true });
    atualizarEstado({ status: "desconectado", conectado_desde: null });
    deslogando = false;
}

async function processar(socket, pacote) {
    try {
        const idGrupo = String(pacote.key?.remoteJid || "");
        if (!idGrupo.endsWith("@g.us") || !pacote.message) return;
        if (gruposPermitidos.size && !gruposPermitidos.has(idGrupo)) return;

        const timestamp = timestampNumero(pacote.messageTimestamp);
        const timestampMs = timestamp * 1000;
        const remetente = remetenteDaMensagem(pacote.key);
        const idMensagem = String(pacote.key.id || Date.now());
        const imagem = extrairImagem(pacote.message);
        if (!imagem) {
            const texto = extrairTexto(pacote.message);
            if (texto?.texto) registrarComentarioSeparado(idGrupo, remetente, idMensagem, timestampMs, texto.texto, texto.citadoId);
            return;
        }
        limparRecentes();
        let legenda = String(imagem.caption || "").trim();
        let legendaOrigem = legenda ? "legenda_da_foto" : null;
        if (!legenda) {
            const anterior = comentariosRecentes.filter((item) => !item.usado && item.idGrupo === idGrupo && item.remetente === remetente && timestampMs >= item.timestampMs)
                .sort((a, b) => b.timestampMs - a.timestampMs)[0];
            if (anterior && timestampMs - anterior.timestampMs <= Number(config.janela_associacao_comentario_segundos || 120) * 1000) {
                legenda = anterior.texto;
                legendaOrigem = "mensagem_anterior";
                anterior.usado = true;
            }
        }
        if (config.exigir_legenda && !legenda && !Number(config.aguardar_comentario_segundos || 0)) return;

        const mimetype = imagem.mimetype || "image/jpeg";
        const extensao = extensoes[mimetype];
        if (!extensao || (mimetype === "image/webp" && !config.aceitar_webp)) return;

        const base = [dataNome(timestamp), limparNome(nomeGrupo(idGrupo)), limparNome(remetente.replace(/@(s\.whatsapp\.net|lid)$/, "")), limparNome(idMensagem).slice(-24)].join("_");
        const caminhoImagem = path.join(config.pasta_saida, `${base}${extensao}`);
        if (fs.existsSync(caminhoImagem)) return;

        console.log(`Foto detectada em '${nomeGrupo(idGrupo)}'. Baixando...`);
        const buffer = await downloadMediaMessage(pacote, "buffer", {}, {
            logger,
            reuploadRequest: socket.updateMediaMessage,
        });
        if (!buffer) throw new Error("O WhatsApp nao forneceu os dados da imagem.");

        const dataTexto = new Date(timestamp * 1000).toLocaleString("pt-BR");
        const centroCustoPadrao = centroCustoDoGrupo(idGrupo);
        fs.writeFileSync(caminhoImagem, buffer);
        fs.writeFileSync(path.join(config.pasta_saida, `${base}.txt`), [
            "=== DADOS DO WHATSAPP ===", "", `Data: ${dataTexto}`,
            `Grupo: ${nomeGrupo(idGrupo)}`, `ID do grupo: ${idGrupo}`,
            `Centro de custo padrao do grupo: ${centroCustoPadrao?.nome || "Nao configurado"}`,
            `Remetente: ${remetente}`, `Enviada por mim: ${pacote.key.fromMe ? "Sim" : "Nao"}`,
            `ID da mensagem: ${idMensagem}`, "", "=== LEGENDA / COMENTARIO ===", "",
            legenda || "Sem legenda informada.", "",
        ].join("\n"), "utf8");
        fs.writeFileSync(path.join(config.pasta_saida, `${base}.json`), JSON.stringify({
            data: dataTexto, timestamp, grupo: nomeGrupo(idGrupo), id_grupo: idGrupo,
            remetente, enviada_por_mim: Boolean(pacote.key.fromMe), id_mensagem: idMensagem,
            legenda: legenda || null, legenda_origem: legendaOrigem, recebido_em_ms: timestampMs,
            centro_custo_padrao: centroCustoPadrao,
            arquivo_imagem: path.basename(caminhoImagem), mimetype,
        }, null, 2), "utf8");
        fotosRecentes.push({ idGrupo, remetente, idMensagem, timestampMs, caminhoJson: path.join(config.pasta_saida, `${base}.json`), caminhoTxt: path.join(config.pasta_saida, `${base}.txt`), temLegenda: Boolean(legenda) });
        console.log(`Foto salva: ${caminhoImagem}`);
    } catch (erro) {
        console.error("Erro ao processar mensagem:", erro?.message || erro);
    }
}

let reconectando = false;
async function iniciar() {
    if (socketAtual && ["conectando", "conectado", "aguardando_qr"].includes(estado.status)) return;
    deslogando = false;
    atualizarEstado({ status: "conectando", erro: null });
    const { state, saveCreds } = await useMultiFileAuthState(PASTA_SESSAO);
    const socket = makeWASocket({ auth: state, logger, browser: ["Coletor de Fotos", "Chrome", "1.0.0"], markOnlineOnConnect: false, syncFullHistory: false });
    socketAtual = socket;
    socket.ev.on("creds.update", saveCreds);
    socket.ev.on("messages.upsert", async ({ messages, type }) => {
        if (type !== "notify") return;
        for (const mensagem of messages) await processar(socket, mensagem);
    });
    socket.ev.on("connection.update", ({ connection, lastDisconnect, qr }) => {
        if (qr) {
            atualizarEstado({ status: "aguardando_qr", qr, erro: null });
            console.log("\nEscaneie o QR Code em WhatsApp > Aparelhos conectados > Conectar aparelho:\n");
            qrcode.generate(qr, { small: true });
        }
        if (connection === "open") {
            reconectando = false;
            atualizarEstado({ status: "conectado", qr: null, conectado_desde: new Date().toISOString(), erro: null });
            console.log(`\nCOLETOR ATIVO\nPasta de saida: ${config.pasta_saida}\nAguardando novas fotos...\n`);
        }
        if (connection === "close" && !reconectando) {
            socketAtual = null;
            const codigo = lastDisconnect?.error?.output?.statusCode || lastDisconnect?.error?.statusCode;
            if (deslogando || codigo === DisconnectReason.loggedOut) {
                if (fs.existsSync(PASTA_SESSAO)) fs.rmSync(PASTA_SESSAO, { recursive: true, force: true });
                atualizarEstado({ status: "desconectado", qr: null, conectado_desde: null });
                console.error("Sessao desconectada pelo WhatsApp. Clique em Conectar para gerar um novo QR Code.");
            } else {
                reconectando = true;
                atualizarEstado({ status: "reconectando", qr: null });
                console.log("Conexao perdida. Reconectando em 3 segundos...");
                setTimeout(() => iniciar().catch(console.error), 3000);
            }
        }
    });
}

if (require.main === module) {
    iniciar().catch((erro) => {
        atualizarEstado({ status: "erro", erro: erro.message });
        console.error("Falha ao iniciar:", erro?.stack || erro);
        process.exitCode = 1;
    });
}

module.exports = {
    iniciar, desconectar, listarGrupos, salvarGrupos,
    obterEstado: () => ({ ...estado }), eventos,
    obterConfiguracao: () => ({
        grupos_permitidos: [...gruposPermitidos],
        nomes_dos_grupos: { ...config.nomes_dos_grupos },
        centros_custo_por_grupo: { ...config.centros_custo_por_grupo },
    }),
};
