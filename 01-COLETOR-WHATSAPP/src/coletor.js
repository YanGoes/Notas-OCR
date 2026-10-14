"use strict";

const fs = require("fs");
const path = require("path");
const pino = require("pino");
const qrcode = require("qrcode-terminal");
const EventEmitter = require("events");
const { iniciarPipeline } = require("./pipeline");
const { normalizar } = require("./legenda");
const { concluirDocumento } = require("./conclusao-automatica");
const notificacoes = require("./notificacoes");
const { arquivar } = require("./arquivo-drive");
const conexao = require("./whatsapp-conexao");
const baileys = require("@whiskeysockets/baileys");
const {
    default: makeWASocket,
    useMultiFileAuthState,
    downloadMediaMessage,
    Browsers,
} = require("@whiskeysockets/baileys");

const RAIZ = path.resolve(__dirname, "..");
const ARQUIVO_CONFIG = path.join(RAIZ, "config.json");
const ARQUIVO_CENTROS_CUSTO = path.join(RAIZ, "configuracao", "centros_custo.json");
const PASTA_SESSAO = path.join(RAIZ, ".baileys_sessao");
// Ultimo momento em que a coleta estava funcionando. Ao religar, as mensagens
// que chegaram com o programa desligado (o WhatsApp entrega como "append")
// sao lidas a partir daqui. Antes eram descartadas: foi assim que a orientacao
// da Vanessa de 13/10 22:22 se perdeu.
const ARQUIVO_ATIVIDADE = path.join(RAIZ, "dados", "coleta-ultima-atividade.json");
const ATRASO_MAXIMO_MS = 7 * 24 * 3600 * 1000;
const FOLGA_MS = 10 * 60 * 1000;

function lerUltimaAtividade() {
    try { return Number(JSON.parse(fs.readFileSync(ARQUIVO_ATIVIDADE, "utf8")).em_ms) || null; } catch (_) { return null; }
}
const retomarDesdeMs = (() => {
    const ultima = lerUltimaAtividade();
    const limite = Date.now() - ATRASO_MAXIMO_MS;
    return ultima ? Math.max(ultima - FOLGA_MS, limite) : Date.now() - 24 * 3600 * 1000;
})();
function registrarAtividade() {
    try {
        fs.mkdirSync(path.dirname(ARQUIVO_ATIVIDADE), { recursive: true });
        fs.writeFileSync(ARQUIVO_ATIVIDADE, JSON.stringify({ em: new Date().toISOString(), em_ms: Date.now() }), "utf8");
    } catch (_) { /* so serve para a proxima retomada */ }
}

/** Mensagem atrasada (entregue ao religar) que ainda nao foi lida? */
function mensagemAtrasadaParaLer(mensagem) {
    const quando = timestampNumero(mensagem?.messageTimestamp) * 1000;
    return quando >= retomarDesdeMs && quando <= Date.now() + 60 * 1000;
}
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

// ---------------------------------------------------------------------------
// Comando de centro de custo pelo proprio WhatsApp
// ---------------------------------------------------------------------------
// Como todas as notas chegam por um unico grupo e o projeto muda com o tempo,
// o operador troca o centro de custo vigente mandando uma mensagem no grupo,
// sem precisar abrir o painel. Usa prefixo explicito (#centro / #projeto) para
// nunca ser confundido com um comentario de foto.
const COMANDO_CENTRO = /^\s*#\s*(?:centro(?:\s*de\s*custo)?|projeto|cc)\b\s*:?\s*(.*)$/i;

function resolverCentroCustoPorTexto(texto) {
    const alvo = normalizar(texto);
    if (!alvo) return null;
    const centros = carregarCentrosCusto();
    return centros.find((centro) => normalizar(centro.nome) === alvo)
        || centros.find((centro) => (centro.apelidos || []).some((apelido) => normalizar(apelido) === alvo))
        || centros.find((centro) => alvo.length >= 3 && normalizar(centro.nome).includes(alvo))
        || null;
}

function definirCentroCustoDoGrupo(idGrupo, centro) {
    config.centros_custo_por_grupo[idGrupo] = String(centro.id);
    const persistido = JSON.parse(fs.readFileSync(ARQUIVO_CONFIG, "utf8"));
    persistido.centros_custo_por_grupo = { ...(persistido.centros_custo_por_grupo || {}), [idGrupo]: String(centro.id) };
    fs.writeFileSync(ARQUIVO_CONFIG, JSON.stringify(persistido, null, 2) + "\n", "utf8");
}

async function tratarComandoCentroCusto(socket, idGrupo, texto) {
    const achado = String(texto || "").match(COMANDO_CENTRO);
    if (!achado) return false;

    const pedido = String(achado[1] || "").trim();
    const atual = centroCustoDoGrupo(idGrupo);
    const responder = async (mensagem) => {
        try { await socket.sendMessage(idGrupo, { text: mensagem }); }
        catch (erro) { console.error("Nao consegui responder o comando no grupo:", erro?.message || erro); }
    };

    if (!pedido) {
        const centros = carregarCentrosCusto();
        const lista = centros.slice(0, 25).map((centro) => `• ${centro.nome}`).join("\n");
        await responder(
            `Centro de custo atual: *${atual?.nome || "nenhum"}*\n\n`
            + `Para trocar, envie:\n#centro NOME DO PROJETO\n\n`
            + (lista ? `Disponiveis:\n${lista}` : "Nenhum centro de custo sincronizado ainda. Use o painel para sincronizar.")
        );
        return true;
    }

    const centro = resolverCentroCustoPorTexto(pedido);
    if (!centro) {
        await responder(`Nao encontrei o centro de custo "${pedido}".\n\nEnvie *#centro* (sem nome) para ver a lista disponivel.`);
        return true;
    }

    definirCentroCustoDoGrupo(idGrupo, centro);
    console.log(`Centro de custo do grupo '${nomeGrupo(idGrupo)}' alterado para '${centro.nome}'.`);
    await responder(`✅ Centro de custo agora e *${centro.nome}*.\nVale para as proximas fotos enviadas neste grupo.`);
    return true;
}

const config = carregarConfig();
let gruposPermitidos = new Set(config.grupos_permitidos);
// Pessoas do cadastro cujas conversas no PRIVADO tambem sao lidas (ids de pessoas.json).
let contatosPermitidos = new Set(Array.isArray(config.contatos_permitidos) ? config.contatos_permitidos : []);
const nomesPrivados = new Map();
// Mensagem mais antiga conhecida de cada conversa privada liberada: e o ponto
// de partida para pedir ao celular as mensagens ANTERIORES (historico sob
// demanda). Fica gravado para valer depois de religar.
const ARQUIVO_ANCORAS = path.join(RAIZ, "dados", "privado-ancoras.json");
const ancorasPrivado = (() => { try { return new Map(Object.entries(JSON.parse(fs.readFileSync(ARQUIVO_ANCORAS, "utf8")))); } catch (_) { return new Map(); } })();
let historicoPedido = null; // { chats:Set, ate:ms }

function guardarAncora(pessoaId, chave, timestampMs) {
    const atual = ancorasPrivado.get(pessoaId);
    if (atual && atual.timestampMs <= timestampMs) return;
    ancorasPrivado.set(pessoaId, { key: { remoteJid: chave.remoteJid, id: chave.id, fromMe: Boolean(chave.fromMe) }, timestampMs });
    try { fs.writeFileSync(ARQUIVO_ANCORAS, JSON.stringify(Object.fromEntries(ancorasPrivado), null, 2), "utf8"); } catch (_) { /* so atalho */ }
}
const eventos = new EventEmitter();
const estado = { status: "parado", qr: null, erro: null, conectado_desde: null, codigo_pareamento: null };
let socketAtual = null;
let deslogando = false;
const fotosRecentes = [];
const comentariosRecentes = [];
fs.mkdirSync(config.pasta_saida, { recursive: true });
/**
 * Dispara a conclusao automatica depois que a foto chegou ao Conta AI:
 * espera ele criar o lancamento, complementa o que faltou e avisa o operador
 * no proprio grupo. Nao bloqueia o envio — roda em segundo plano.
 */
function agendarConclusaoAutomatica(caminhoImagem, auditoria) {
    // Le o config na hora: mudar config.json passa a valer sem reiniciar o programa.
    let opcoes = config.conclusao_automatica || {};
    try { opcoes = JSON.parse(fs.readFileSync(ARQUIVO_CONFIG, "utf8")).conclusao_automatica || opcoes; } catch (_) {}
    if (!opcoes.habilitada) return;

    const base = path.parse(caminhoImagem).name;
    const idGrupo = auditoria?.grupo_id || null;
    const atrasoMs = Math.max(0, Number(opcoes.aguardar_segundos ?? 60)) * 1000;
    const simular = opcoes.simular !== false;

    console.log(`Conclusao automatica agendada para ${base} em ${atrasoMs / 1000}s${simular ? " (modo simulacao)" : ""}.`);

    setTimeout(() => {
        concluirDocumento(base, {
            simular,
            retry: {
                tentativas: Number(opcoes.tentativas || 6),
                intervaloInicialMs: Number(opcoes.intervalo_inicial_ms || 15000),
            },
            notificar: idGrupo
                ? async (texto) => {
                    if (!socketAtual || estado.status !== "conectado") {
                        console.log(`Conclusao automatica (sem WhatsApp conectado):\n${texto}`);
                        return;
                    }
                    try { await socketAtual.sendMessage(idGrupo, { text: texto }); }
                    catch (erro) { console.error("Nao consegui enviar a notificacao:", erro?.message || erro); }
                }
                : async (texto) => console.log(`Conclusao automatica:\n${texto}`),
        }).catch((erro) => console.error(`Conclusao automatica falhou para ${base}:`, erro?.message || erro));
    }, atrasoMs);
}

/** Le o config do disco, para mudancas valerem sem reiniciar o programa. */
function configAtual() {
    try { return JSON.parse(fs.readFileSync(ARQUIVO_CONFIG, "utf8")); }
    catch (_) { return config; }
}

/**
 * Cria a despesa no Conta Azul automaticamente, com categoria e centro de
 * custo — sem depender do Conta AI, que nao preenche esses campos.
 *
 * So dispara para nota totalmente aprovada. Nota em revisao humana espera
 * uma pessoa: e justamente o caso em que alguma informacao esta incerta.
 */
async function lancarAutomaticamente(caminhoImagem, auditoria) {
    const opcoes = configAtual().lancamento_automatico || {};
    if (!opcoes.habilitado) return;

    if (auditoria?.validacoes?.bloqueado || auditoria?.validacoes?.revisao_necessaria) {
        console.log(`Lancamento automatico: ${path.basename(caminhoImagem)} precisa de revisao humana; nao sera lancado.`);
        return;
    }

    const base = path.parse(caminhoImagem).name;
    const simular = opcoes.simular === true;
    const { lancarDespesa } = require("./lancamento-direto");

    try {
        const resultado = await lancarDespesa(base, { simular, dryRun: simular });
        // Em simulacao nao avisa o grupo: antes mandava "Nao consegui lancar —
        // motivo desconhecido" para cada nota, o que confundia os operadores.
        if (resultado.simulado) {
            console.log(`Lancamento automatico (simulacao): ${base} seria lancado com R$ ${resultado.payload?.valor}.`);
            return;
        }
        const texto = resultado.criado
            ? `✅ *Despesa lancada no Conta Azul*\n\n`
                + `📄 ${auditoria.ocr?.fornecedor || "Fornecedor nao identificado"} — R$ ${Number(auditoria.ocr?.valor || 0).toFixed(2)}\n`
                + `📅 ${auditoria.ocr?.data}\n`
                + `🏷️ Categoria: ${auditoria.classificacao?.categoria_nome}\n`
                + `🏗️ Centro de custo: ${auditoria.classificacao?.centro_custo_nome}\n`
                + `${auditoria.forma_pagamento?.codigo ? `💳 Pagamento: ${auditoria.forma_pagamento.codigo}\n` : ""}`
                + `\n_${auditoria.arquivo_imagem || base}_`
            : `⚠️ *Nao consegui lancar esta despesa*\n\n`
                + `📄 ${auditoria.ocr?.fornecedor || "-"} — R$ ${Number(auditoria.ocr?.valor || 0).toFixed(2)}\n\n`
                + `*Motivo:* ${resultado.erro || (resultado.impedimentos || []).join(" ") || "desconhecido"}\n`
                + `\n_${auditoria.arquivo_imagem || base}_`;

        notificacoes.registrar({
            titulo: resultado.criado ? "Despesa lancada no Conta Azul" : "Nao consegui lancar esta despesa",
            texto,
            nivel: resultado.criado ? "sucesso" : "atencao",
            base,
            pendencias: resultado.criado ? [] : (resultado.impedimentos || []),
        });

        const idGrupo = auditoria?.grupo_id;
        if (idGrupo && socketAtual && estado.status === "conectado") {
            try { await socketAtual.sendMessage(idGrupo, { text: texto }); }
            catch (erro) { console.error("Nao consegui avisar no grupo:", erro?.message || erro); }
        }
    } catch (erro) {
        console.error(`Lancamento automatico falhou para ${base}:`, erro?.message || erro);
    }
}

/**
 * Ponto unico de decisao do que acontece depois que uma nota e processada.
 * Cada acao tem sua propria chave no config.json.
 */
async function aposProcessar(caminhoImagem, auditoria) {
    const cfg = configAtual();

    // Arquiva a foto no Drive da empresa (copia; o original fica local).
    const drive = arquivar(caminhoImagem, auditoria, cfg.arquivo_drive || {});
    if (drive.arquivado && !drive.jaExistia) {
        console.log(`Drive: comprovante arquivado em ${drive.pasta_relativa}`);
    } else if (drive.erro) {
        console.error(`Drive: nao consegui arquivar — ${drive.erro}`);
        notificacoes.registrar({
            titulo: "Nao consegui arquivar a foto no Drive",
            texto: `A despesa segue normalmente, mas a foto nao foi copiada para o Drive.\n\nMotivo: ${drive.erro}`,
            nivel: "atencao",
            base: path.parse(caminhoImagem).name,
        });
    }

    if (cfg.pipeline?.encaminhar_automaticamente_conta_ai) {
        try { await encaminharParaContaAI(caminhoImagem, auditoria); }
        catch (erro) { console.error("Encaminhamento automatico falhou:", erro?.message || erro); }
    }
    await lancarAutomaticamente(caminhoImagem, auditoria);
}

async function encaminharParaContaAI(caminhoImagem, auditoria) {
    const numeroContaAI = config.numero_conta_ai || process.env.NUMERO_CONTA_AI;
    if (!numeroContaAI) {
        throw new Error("Número do Conta AI não configurado em config.json ('numero_conta_ai').");
    }
    if (!socketAtual || estado.status !== "conectado") {
        throw new Error("WhatsApp não está conectado. Conecte o WhatsApp no painel antes de encaminhar.");
    }
    let digitos = String(numeroContaAI).replace(/\D/g, "");
    if (digitos.length === 10 || digitos.length === 11) {
        digitos = `55${digitos}`;
    }
    let jid = String(numeroContaAI).trim();
    if (!jid.endsWith("@s.whatsapp.net") && !jid.endsWith("@g.us")) {
        jid = `${digitos}@s.whatsapp.net`;
    }

    const baseName = path.parse(caminhoImagem).name;
    const auditoriaPath = path.join(RAIZ, "dados", "auditoria", `${baseName}.json`);

    try {
        console.log(`Conta AI WhatsApp: Encaminhando foto ${path.basename(caminhoImagem)} para ${jid}...`);
        const buffer = fs.readFileSync(caminhoImagem);
        const extensao = path.extname(caminhoImagem).toLowerCase();
        const mimetype = extensao === ".png" ? "image/png" : "image/jpeg";
        const legendaFoto = auditoria?.conta_azul?.descricao_sugerida
            ? `Comprovante: ${auditoria.conta_azul.descricao_sugerida}`
            : "Comprovante de despesa";

        await socketAtual.sendMessage(jid, {
            image: buffer,
            mimetype,
            caption: legendaFoto,
        });
        console.log(`Conta AI WhatsApp: Foto enviada com sucesso para ${jid}.`);

        const partes = ["Nova Despesa:"];
        if (auditoria?.classificacao?.categoria_nome) {
            partes.push(`- Categoria: ${auditoria.classificacao.categoria_nome}`);
        }
        if (auditoria?.classificacao?.centro_custo_nome) {
            partes.push(`- Centro de Custo: ${auditoria.classificacao.centro_custo_nome}`);
        }
        if (auditoria?.operador?.conta_informada) {
            partes.push(`- Forma de Pagamento: ${auditoria.operador.conta_informada}`);
        }
        if (auditoria?.classificacao?.placa || auditoria?.dados_abastecimento?.placa) {
            partes.push(`- Veículo / Placa: ${auditoria.classificacao.placa || auditoria.dados_abastecimento.placa}`);
        }
        if (auditoria?.conta_azul?.descricao_sugerida) {
            partes.push(`- Descrição: ${auditoria.conta_azul.descricao_sugerida}`);
        }
        partes.push("\nPor favor, lance esta despesa utilizando exatamente os dados acima.");

        const textoComando = partes.join("\n");
        await new Promise((r) => setTimeout(r, 1500));
        await socketAtual.sendMessage(jid, { text: textoComando });
        console.log(`Conta AI WhatsApp: Instrucoes de comando enviadas em texto com sucesso para ${jid}.`);

        if (fs.existsSync(auditoriaPath)) {
            try {
                const aud = JSON.parse(fs.readFileSync(auditoriaPath, "utf8"));
                aud.encaminhamento_whatsapp = {
                    status: "ENVIADO",
                    enviado_em: new Date().toISOString(),
                    destino: jid,
                    erro: null,
                };
                fs.writeFileSync(auditoriaPath, JSON.stringify(aud, null, 2), "utf8");
            } catch (_) {}
        }
        agendarConclusaoAutomatica(caminhoImagem, auditoria);
        return { ok: true, mensagem: `✅ Comprovante enviado com sucesso para o Conta AI (${jid})!` };
    } catch (erro) {
        console.error("Conta AI WhatsApp: Erro ao encaminhar mensagem:", erro?.message || erro);
        if (fs.existsSync(auditoriaPath)) {
            try {
                const aud = JSON.parse(fs.readFileSync(auditoriaPath, "utf8"));
                aud.encaminhamento_whatsapp = {
                    status: "ERRO",
                    tentado_em: new Date().toISOString(),
                    destino: jid,
                    erro: erro?.message || String(erro),
                };
                fs.writeFileSync(auditoriaPath, JSON.stringify(aud, null, 2), "utf8");
            } catch (_) {}
        }
        throw new Error(`❌ Falha ao enviar para o Conta AI via WhatsApp: ${erro?.message || erro}`);
    }
}

// ---------------------------------------------------------------------------
// Central VMac: registra mensagens e gera previas no banco (dados/central.db).
// Desligavel em config.json com "central": { "habilitada": false }.
// ---------------------------------------------------------------------------
function centralHabilitada() {
    return configAtual().central?.habilitada !== false;
}

function central() {
    const { banco } = require("./central/banco");
    return { db: banco(), cad: require("./central/cadastros").carregar(), orquestrador: require("./central/orquestrador") };
}

function registrarNaCentral(entrada) {
    if (!centralHabilitada()) return null;
    const { db, cad, orquestrador } = central();
    const resultado = orquestrador.processarFoto(db, cad, entrada);
    console.log(`Central: ${entrada.arquivo} -> ${resultado.repetida ? "foto repetida (sem despesa nova)" : `${resultado.despesas.length} previa(s)`}.`);
    return resultado;
}

function registrarTextoNaCentral(msg) {
    if (!centralHabilitada()) return;
    try {
        const { db, cad, orquestrador } = central();
        const resultado = orquestrador.processarMensagemTexto(db, cad, msg);
        const intencao = resultado.interpretacao?.intencao;
        if (intencao && !["CONVERSA_IRRELEVANTE", "CONFIRMACAO"].includes(intencao)) {
            console.log(`Central: mensagem de ${msg.remetenteNome || msg.remetenteId} entendida como ${intencao}.`);
        }
    } catch (erro) {
        console.error("Central: nao consegui registrar a mensagem:", erro?.message || erro);
    }
}

iniciarPipeline(
    config.pasta_saida,
    { ...config.pipeline, aguardar_comentario_segundos: config.aguardar_comentario_segundos, registrarNaCentral },
    aposProcessar
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

/**
 * O WhatsApp as vezes manda o telefone junto do codigo interno (LID) do
 * remetente. Se o telefone for de alguem do cadastro, o vinculo fica gravado
 * e as notas dessa pessoa ja chegam com o nome certo.
 */
function vincularPeloTelefoneDaMensagem(remetente, chave) {
    if (!centralHabilitada() || !String(remetente).endsWith("@lid")) return;
    const telefone = chave.participantAlt || chave.participantPn || chave.senderPn;
    if (!telefone) return;
    try {
        const { db, cad } = central();
        const vinculo = require("./central/identificacao-whatsapp").vincularPorTelefone(db, cad, remetente, telefone);
        if (vinculo) console.log(`Central: remetente reconhecido pelo telefone: ${vinculo.pessoa} (${vinculo.regeradas} previa(s) refeita(s)).`);
    } catch (erro) { console.error("Central: nao consegui vincular pelo telefone:", erro?.message || erro); }
}

/**
 * Pergunta ao WhatsApp o telefone de cada remetente ainda desconhecido (tabela
 * LID -> telefone da sessao) e vincula quem estiver no cadastro de pessoas.
 */
/** Numero e codigo interno (LID) da conta conectada, so os digitos. */
function contaConectada() {
    const usuario = socketAtual?.user;
    if (!usuario) return null;
    const digitos = (jid) => String(jid || "").split("@")[0].split(":")[0] || null;
    return { telefone: digitos(usuario.id), lid: digitos(usuario.lid) };
}

async function identificarRemetentes() {
    if (!centralHabilitada()) return { verificados: 0, vinculados: [], sem_telefone: 0, fora_do_cadastro: 0 };
    const mapa = socketAtual?.signalRepository?.lidMapping;
    if (!socketAtual || estado.status !== "conectado" || !mapa?.getPNForLID) throw new Error("Conecte o WhatsApp para buscar os contatos.");
    const { db, cad } = central();
    const resultado = await require("./central/identificacao-whatsapp").identificarDesconhecidos(db, cad, (lid) => mapa.getPNForLID(lid));
    for (const item of resultado.vinculados) console.log(`Central: ${item.notas} nota(s) agora sao de ${item.pessoa}.`);
    return resultado;
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
    return config.nomes_dos_grupos[id] || nomesPrivados.get(id) || id || "grupo_nao_identificado";
}

/**
 * De quem e uma conversa no privado: pelo telefone/codigo do WhatsApp
 * (vinculos ja confirmados) ou perguntando ao WhatsApp o telefone do LID.
 */
async function pessoaDaConversaPrivada(chave) {
    if (!centralHabilitada()) return null;
    const { db, cad } = central();
    const cadastros = require("./central/cadastros");
    const vinculos = new Map(db.prepare("SELECT whatsapp_id, pessoa_id FROM remetentes_vinculados").all().map((linha) => [linha.whatsapp_id, linha.pessoa_id]));
    const jids = [chave.remoteJid, chave.remoteJidAlt, chave.senderPn, chave.participantAlt].filter(Boolean).map(String);
    for (const jid of jids) {
        const achada = cadastros.identificarPessoa(cad, jid, { vinculos });
        if (achada.status === "IDENTIFICADA") return achada.pessoa;
    }
    const lid = jids.find((jid) => jid.endsWith("@lid"));
    const mapa = socketAtual?.signalRepository?.lidMapping;
    if (!lid || !mapa?.getPNForLID) return null;
    const telefone = await Promise.resolve(mapa.getPNForLID(lid)).catch(() => null);
    if (!telefone) return null;
    const achada = cadastros.identificarPessoa(cad, String(telefone));
    if (achada.status !== "IDENTIFICADA") return null;
    try { require("./central/identificacao-whatsapp").vincularPorTelefone(db, cad, lid, String(telefone)); } catch (_) { /* vinculo e so atalho */ }
    return achada.pessoa;
}

/**
 * Pede ao celular as mensagens anteriores da conversa privada de uma pessoa
 * liberada (ate 50). Elas chegam pelo evento de historico e passam pelos
 * mesmos filtros; repetidas sao ignoradas.
 */
async function buscarHistoricoPrivado(pessoaId, quantidade = 50) {
    if (!socketAtual || estado.status !== "conectado") throw new Error("Conecte o WhatsApp primeiro.");
    if (!contatosPermitidos.has(pessoaId)) throw new Error("Marque e salve essa pessoa na lista antes de buscar.");
    const ancora = ancorasPrivado.get(pessoaId);
    if (!ancora) throw new Error("Ainda não conheço nenhuma mensagem dessa conversa. Mande (ou peça para a pessoa mandar) uma mensagem qualquer no privado e tente de novo.");
    historicoPedido = { chats: new Set([ancora.key.remoteJid]), ate: Date.now() + 3 * 60 * 1000 };
    await socketAtual.fetchMessageHistory(Math.min(Number(quantidade) || 50, 50), ancora.key, ancora.timestampMs);
    conexao.registrarLog("historico_privado_pedido", { pessoa: pessoaId, quantidade });
    return { pedido: true, mensagem: "Pedido enviado ao celular. As mensagens anteriores aparecem em até 1 minuto (o celular precisa estar com internet)." };
}

function salvarContatos(ids) {
    config.contatos_permitidos = [...new Set((ids || []).map(String).filter(Boolean))];
    contatosPermitidos = new Set(config.contatos_permitidos);
    const persistido = JSON.parse(fs.readFileSync(ARQUIVO_CONFIG, "utf8"));
    persistido.contatos_permitidos = config.contatos_permitidos;
    fs.writeFileSync(ARQUIVO_CONFIG, JSON.stringify(persistido, null, 2) + "\n", "utf8");
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

const esperar = (ms) => new Promise((resolver) => setTimeout(resolver, ms));

/**
 * Alternativa ao QR Code: gera um codigo de 8 caracteres para o operador
 * digitar em "WhatsApp > Aparelhos conectados > Conectar com numero de
 * telefone". Costuma funcionar quando a leitura do QR e recusada.
 *
 * @param {string} numero — com DDI e DDD, ex.: 5531999998888
 * @returns {Promise<string>} o codigo de pareamento
 */
async function solicitarCodigoPareamento(numero) {
    const digitos = String(numero || "").replace(/\D/g, "");
    if (digitos.length < 12 || digitos.length > 13) {
        throw new Error("Informe o numero com DDI e DDD, sem espacos. Exemplo: 5531999998888.");
    }
    if (estado.status === "conectado") {
        throw new Error("O WhatsApp ja esta conectado neste computador.");
    }

    if (!socketAtual || !["conectando", "aguardando_qr", "aguardando_codigo"].includes(estado.status)) {
        await iniciar();
        await esperar(3000);
    }
    if (!socketAtual) throw new Error("Nao consegui iniciar a conexao com o WhatsApp. Tente novamente.");
    if (socketAtual.authState?.creds?.registered) {
        throw new Error("Esta sessao ja esta registrada. Use 'Sair do WhatsApp' antes de parear de novo.");
    }

    const codigo = await socketAtual.requestPairingCode(digitos);
    atualizarEstado({ status: "aguardando_codigo", codigo_pareamento: codigo, erro: null });
    console.log(`Codigo de pareamento gerado: ${codigo}`);
    return codigo;
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
        if (!pacote.message) return;
        const ehGrupo = idGrupo.endsWith("@g.us");
        if (ehGrupo) {
            // So grupos marcados no painel. Nenhum marcado = nenhum processado (antes,
            // lista vazia processava TODOS os grupos do numero e gastava o Azure).
            if (!gruposPermitidos.has(idGrupo)) return;
        } else if (/@(s\.whatsapp\.net|lid)$/.test(idGrupo)) {
            // Conversa no PRIVADO: so de pessoas liberadas no painel, e nunca o que
            // a propria conta escreveu (suas respostas ao operador nao sao notas).
            if (!contatosPermitidos.size) return;
            const pessoa = await pessoaDaConversaPrivada(pacote.key);
            if (!pessoa || !contatosPermitidos.has(pessoa.id)) return;
            guardarAncora(pessoa.id, pacote.key, timestampNumero(pacote.messageTimestamp) * 1000);
            if (pacote.key.fromMe) return;
            nomesPrivados.set(idGrupo, `Privado - ${pessoa.nome}`);
        } else {
            return;
        }

        const timestamp = timestampNumero(pacote.messageTimestamp);
        const timestampMs = timestamp * 1000;
        const remetente = remetenteDaMensagem(pacote.key);
        vincularPeloTelefoneDaMensagem(remetente, pacote.key);
        // Nome que aparece no WhatsApp: e o que permite identificar de qual
        // operador de campo e a nota (o remetente vem como um id opaco @lid).
        const nomeRemetente = String(pacote.pushName || "").trim();
        const idMensagem = String(pacote.key.id || Date.now());
        const imagem = extrairImagem(pacote.message);
        if (!imagem) {
            const texto = extrairTexto(pacote.message);
            if (!texto?.texto) return;
            registrarTextoNaCentral({
                grupoId: idGrupo, mensagemId: idMensagem, remetenteId: remetente, remetenteNome: nomeRemetente,
                enviadaEm: new Date(timestampMs).toISOString(), texto: texto.texto, citadoId: texto.citadoId,
            });
            if (ehGrupo && await tratarComandoCentroCusto(socket, idGrupo, texto.texto)) return;
            registrarComentarioSeparado(idGrupo, remetente, idMensagem, timestampMs, texto.texto, texto.citadoId);
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
            `Remetente: ${nomeRemetente ? nomeRemetente + " (" + remetente + ")" : remetente}`, `Enviada por mim: ${pacote.key.fromMe ? "Sim" : "Nao"}`,
            `ID da mensagem: ${idMensagem}`, "", "=== LEGENDA / COMENTARIO ===", "",
            legenda || "Sem legenda informada.", "",
        ].join("\n"), "utf8");
        fs.writeFileSync(path.join(config.pasta_saida, `${base}.json`), JSON.stringify({
            data: dataTexto, timestamp, grupo: nomeGrupo(idGrupo), id_grupo: idGrupo,
            remetente, remetente_nome: nomeRemetente || null, enviada_por_mim: Boolean(pacote.key.fromMe), id_mensagem: idMensagem,
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
let tentativasReconexao = 0;
let qrSeguidos = 0;
async function iniciar() {
    if (socketAtual && ["conectando", "conectado", "aguardando_qr", "aguardando_codigo"].includes(estado.status)) return;
    // Conectar clicado pela pessoa (nao e reconexao automatica): conta de QR recomeca.
    if (["desconectado", "erro"].includes(estado.status)) qrSeguidos = 0;
    deslogando = false;
    atualizarEstado({ status: "conectando", erro: null });
    const { state, saveCreds } = await useMultiFileAuthState(PASTA_SESSAO);

    // Versao do WhatsApp Web: a do SITE do WhatsApp (a lista do Baileys fica
    // defasada e o celular recusa o vinculo). Ver src/whatsapp-conexao.js.
    const { versao, origem: origemVersao } = await conexao.versaoWhatsAppWeb(baileys);
    conexao.registrarLog("iniciando", { versao: versao?.join("."), origem: origemVersao, sessao_registrada: Boolean(state.creds?.registered || state.creds?.me?.id) });
    console.log(`WhatsApp Web versao ${versao ? versao.join(".") : "embutida"} (${origemVersao}).`);

    const socket = makeWASocket({
        auth: state,
        logger,
        version: versao,
        // Identificador padrao de navegador. Nomes customizados vinham sendo
        // recusados pelo WhatsApp no momento de vincular o aparelho.
        browser: Browsers.macOS("Desktop"),
        markOnlineOnConnect: false,
        syncFullHistory: false,
    });
    socketAtual = socket;
    socket.ev.on("creds.update", saveCreds);
    socket.ev.on("messages.upsert", async ({ messages, type }) => {
        // "notify" = chegou agora; "append" = entregue ao religar (so as que
        // chegaram enquanto o programa estava parado). Repetidas sao ignoradas
        // adiante (mesmo id de mensagem / mesmo arquivo de foto).
        const lista = type === "notify" ? messages : type === "append" ? messages.filter(mensagemAtrasadaParaLer) : [];
        if (type === "append" && lista.length) conexao.registrarLog("mensagens_atrasadas", { quantidade: lista.length });
        for (const mensagem of lista) await processar(socket, mensagem);
    });
    // Historico pedido sob demanda (botao "Buscar mensagens anteriores").
    socket.ev.on("messaging-history.set", async ({ messages }) => {
        if (!historicoPedido || Date.now() > historicoPedido.ate) return;
        const daConversa = (messages || []).filter((mensagem) => historicoPedido.chats.has(String(mensagem?.key?.remoteJid || "")));
        if (!daConversa.length) return;
        conexao.registrarLog("historico_privado_recebido", { quantidade: daConversa.length });
        for (const mensagem of daConversa.sort((a, b) => timestampNumero(a.messageTimestamp) - timestampNumero(b.messageTimestamp))) {
            await processar(socket, mensagem);
        }
    });
    socket.ev.on("connection.update", ({ connection, lastDisconnect, qr }) => {
        if (qr) {
            conexao.registrarLog("qr_gerado");
            atualizarEstado({ status: "aguardando_qr", qr, qr_gerado_em: new Date().toISOString(), erro: estado.erro && /QR Code novo|renovado/.test(estado.erro) ? estado.erro : null });
            console.log("\nEscaneie o QR Code em WhatsApp > Aparelhos conectados > Conectar aparelho:\n");
            qrcode.generate(qr, { small: true });
        }
        if (connection === "open") {
            registrarAtividade();
            if (!global.__vmacAtividade) global.__vmacAtividade = setInterval(() => { if (estado.status === "conectado") registrarAtividade(); }, 60 * 1000);
            reconectando = false;
            tentativasReconexao = 0;
            qrSeguidos = 0;
            conexao.registrarLog("conectado", { usuario: socket.user?.id ? "ok" : null });
            atualizarEstado({ status: "conectado", qr: null, conectado_desde: new Date().toISOString(), erro: null });
            console.log(`\nCOLETOR ATIVO\nPasta de saida: ${config.pasta_saida}\nAguardando novas fotos...\n`);
            // Ao conectar, tenta reconhecer quem ainda aparece como desconhecido.
            setTimeout(() => identificarRemetentes().catch((erro) => console.error("Central: identificar remetentes:", erro?.message || erro)), 8000);
        }
        // Evento de um socket antigo (ja substituido) nao deve mexer no estado.
        if (connection === "close" && socket !== socketAtual) return;
        if (connection === "close") {
            socketAtual = null;
            const codigo = lastDisconnect?.error?.output?.statusCode || lastDisconnect?.error?.statusCode;
            const diagnostico = conexao.diagnosticarQueda(codigo, {
                saidaPedida: deslogando, registrado: Boolean(state.creds?.registered || state.creds?.me?.id), statusAnterior: estado.status,
            });
            conexao.registrarLog("queda", { codigo: codigo ?? null, motivo: lastDisconnect?.error?.message || null, status_anterior: estado.status, acao: diagnostico.acao });
            if (diagnostico.mensagem) console.log(`WhatsApp: ${diagnostico.mensagem} (codigo ${codigo ?? "?"})`);
            if (diagnostico.limparSessao && fs.existsSync(PASTA_SESSAO)) fs.rmSync(PASTA_SESSAO, { recursive: true, force: true });

            if (diagnostico.acao === "PARAR") {
                atualizarEstado({ status: deslogando ? "desconectado" : codigo === 440 || codigo === 403 ? "erro" : "desconectado",
                    qr: null, conectado_desde: null, erro: diagnostico.mensagem });
                return;
            }
            if (diagnostico.acao === "RECONECTAR_JA" || diagnostico.acao === "NOVO_QR") {
                // Muitos QR seguidos sem leitura: para e espera a pessoa clicar em Conectar
                // (ninguem na frente do computador nao deve gerar QR para sempre).
                if (diagnostico.acao === "NOVO_QR" && ++qrSeguidos > 4) {
                    qrSeguidos = 0;
                    atualizarEstado({ status: "desconectado", qr: null, erro: "Nenhum QR Code foi lido a tempo. Clique em Conectar quando estiver com o celular em mãos." });
                    return;
                }
                atualizarEstado({ status: "conectando", qr: null, erro: diagnostico.mensagem });
                setTimeout(() => iniciar().catch((erro) => {
                    console.error("Reconexao falhou:", erro?.message || erro);
                    atualizarEstado({ status: "erro", erro: erro?.message || String(erro) });
                }), diagnostico.acao === "RECONECTAR_JA" ? 500 : 1500);
                return;
            }
            if (!reconectando) {
                // Se a propria tentativa de reconexao cair, este bloco roda de
                // novo e agenda outra tentativa (antes o status travava em
                // "reconectando" para sempre). Espera cresce ate 60 s.
                reconectando = true;
                tentativasReconexao += 1;
                const espera = Math.min(60, 3 * 2 ** Math.min(tentativasReconexao - 1, 5));
                atualizarEstado({ status: "reconectando", qr: null });
                console.log(`Conexao perdida. Reconectando em ${espera} segundos (tentativa ${tentativasReconexao})...`);
                setTimeout(() => {
                    reconectando = false;
                    iniciar().catch((erro) => {
                        console.error("Reconexao falhou:", erro?.message || erro);
                        atualizarEstado({ status: "erro", erro: erro?.message || String(erro) });
                    });
                }, espera * 1000);
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
    iniciar, desconectar, listarGrupos, salvarGrupos, salvarContatos, buscarHistoricoPrivado, solicitarCodigoPareamento, identificarRemetentes, contaConectada,
    obterEstado: () => ({ ...estado }), eventos,
    obterConfiguracao: () => ({
        grupos_permitidos: [...gruposPermitidos],
        contatos_permitidos: [...contatosPermitidos],
        nomes_dos_grupos: { ...config.nomes_dos_grupos },
        centros_custo_por_grupo: { ...config.centros_custo_por_grupo },
        numero_conta_ai: config.numero_conta_ai || "",
    }),
    encaminharParaContaAI,
};
