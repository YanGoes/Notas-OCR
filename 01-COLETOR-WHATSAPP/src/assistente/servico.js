"use strict";

// Conversas do assistente: guarda no banco, roda um turno por vez e trata as
// propostas (lancar, treinar) que so executam com o Confirmar de quem pode.

const { agora, json, lerJson, transacao } = require("../central/banco");
const ferramentas = require("./ferramentas");
const assinatura = require("./assinatura");
const anexos = require("./anexos");

// Quem conversa e quem manda (decisao do Yan em 14/10/2026; Rodrigo incluido em
// 18/11/2026). Quem manda: o que pede o assistente faz na hora, sem Confirmar.
const USUARIOS = ["Yan", "Rodrigo", "Vanessa", "Jhonathan", "Cauã"];
const PODEM_CONFIRMAR = ["Yan", "Rodrigo", "Vanessa", "Jhonathan"];

let emAndamento = null;

function conferirPessoa(pessoa) {
    const nome = USUARIOS.find((usuario) => usuario.toLowerCase() === String(pessoa || "").trim().toLowerCase());
    if (!nome) throw new Error(`Escolha quem está conversando: ${USUARIOS.join(", ")}.`);
    return nome;
}

function listarConversas(db, { pessoa } = {}) {
    return db.prepare(`SELECT c.id, c.pessoa, c.titulo, c.atualizada_em,
            (SELECT COUNT(*) FROM assistente_mensagens m WHERE m.conversa_id = c.id) AS mensagens
        FROM assistente_conversas c ${pessoa ? "WHERE c.pessoa = ?" : ""} ORDER BY c.atualizada_em DESC LIMIT 30`).all(...(pessoa ? [pessoa] : []));
}

function lerConversa(db, id) {
    const conversa = db.prepare("SELECT * FROM assistente_conversas WHERE id = ?").get(Number(id));
    if (!conversa) throw new Error("Conversa não encontrada.");
    const mensagens = db.prepare("SELECT id, papel, texto, dados, em FROM assistente_mensagens WHERE conversa_id = ? ORDER BY id").all(conversa.id)
        .map((m) => ({ ...m, dados: lerJson(m.dados, null) }));
    const propostas = db.prepare("SELECT * FROM assistente_propostas WHERE conversa_id = ? ORDER BY id").all(conversa.id)
        .map((p) => ({ ...p, parametros: lerJson(p.parametros, {}), resultado: lerJson(p.resultado, null) }));
    return { ...conversa, mensagens, propostas };
}

function registrarMensagem(db, conversaId, papel, texto, dados = null) {
    db.prepare("INSERT INTO assistente_mensagens (conversa_id, papel, texto, dados, em) VALUES (?, ?, ?, ?, ?)").run(conversaId, papel, texto, dados ? json(dados) : null, agora());
    db.prepare("UPDATE assistente_conversas SET atualizada_em = ? WHERE id = ?").run(agora(), conversaId);
}

/**
 * Envia uma mensagem e espera a resposta. `emitir` recebe os eventos ao vivo.
 * @param {object} opcoes.rodar — troca o motor (testes)
 */
async function enviar(db, { pessoa, texto, anexos: arquivos = [], conversaId = null, emitir = () => {}, rodar = assinatura.rodarTurno, modelo = "", esforco = "", sinal = null, pastaAnexos = undefined, ctx = {} }) {
    const quem = conferirPessoa(pessoa);
    const temAnexo = Array.isArray(arquivos) && arquivos.length > 0;
    const pergunta = String(texto || "").trim() || (temAnexo ? "Veja o(s) anexo(s)." : "");
    if (!pergunta) throw new Error("Escreva a mensagem.");
    if (emAndamento) throw new Error("O assistente está respondendo outra pergunta. Espere um pouco.");
    let id = conversaId ? Number(conversaId) : null;
    if (id) {
        const conversa = db.prepare("SELECT * FROM assistente_conversas WHERE id = ?").get(id);
        if (!conversa) throw new Error("Conversa não encontrada.");
        if (PODEM_CONFIRMAR.includes(quem)) {
            db.prepare("UPDATE assistente_propostas SET status = 'CANCELADA', decidida_por = ?, decidida_em = ? WHERE conversa_id = ? AND status = 'PENDENTE'")
                .run(`${quem} (substituída por pedido novo)`, agora(), id);
        } else {
            const pendente = db.prepare("SELECT id FROM assistente_propostas WHERE conversa_id = ? AND status = 'PENDENTE'").get(id);
            if (pendente) throw new Error("Há uma proposta esperando Confirmar ou Cancelar nesta conversa.");
        }
    } else {
        id = Number(db.prepare("INSERT INTO assistente_conversas (pessoa, titulo, criada_em, atualizada_em) VALUES (?, ?, ?, ?)")
            .run(quem, pergunta.slice(0, 80), agora(), agora()).lastInsertRowid);
    }
    const conversa = db.prepare("SELECT * FROM assistente_conversas WHERE id = ?").get(id);
    emAndamento = { conversaId: id, sinal };
    try {
        if (temAnexo) emitir({ tipo: "anexos", texto: "Lendo os anexos…" });
        let preparados = { blocos: [], resumo: [] };
        try {
            if (temAnexo) preparados = await anexos.preparar(arquivos, { conversaId: id, pasta: pastaAnexos });
        } catch (erro) {
            // Conversa nova que nem chegou a ter mensagem: nao deixa uma vazia na lista.
            if (!conversaId) db.prepare("DELETE FROM assistente_conversas WHERE id = ? AND NOT EXISTS (SELECT 1 FROM assistente_mensagens WHERE conversa_id = ?)").run(id, id);
            throw erro;
        }
        const { blocos, resumo } = preparados;
        registrarMensagem(db, id, "pessoa", pergunta, { pessoa: quem, ...(resumo.length ? { anexos: resumo } : {}) });
        const manda = PODEM_CONFIRMAR.includes(quem)
            ? `\n[PERMISSÃO TOTAL: ${quem} manda no programa. O que ${quem} pede, você FAZ agora, nesta resposta, chamando as ferramentas — sem botão Confirmar, sem pedir confirmação, sem perguntar "quer que eu…?". As ferramentas que gravam são executadas pelo programa assim que você termina. Esqueça qualquer coisa dita antes nesta conversa sobre "botões Confirmar" ou "não consigo confirmar": isso mudou. Se o pedido se refere a algo combinado antes nesta conversa (ex.: "faz o que eu pedi"), refaça as chamadas agora.]`
            : "";
        const prompt = `[${quem} está falando · ${new Date().toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" })}]${manda}\n\n${pergunta}`;
        // Modo completo (arquivos, comandos, Drive, web) so para quem pode confirmar acoes.
        const resultado = await rodar({ texto: prompt, blocos, sessao: conversa.sessao, pessoa: quem, conversaId: id, emitir, modelo, esforco, sinal, completo: PODEM_CONFIRMAR.includes(quem) });
        if (resultado.sessao) db.prepare("UPDATE assistente_conversas SET sessao = ? WHERE id = ?").run(resultado.sessao, id);
        registrarMensagem(db, id, "assistente", resultado.texto || "(sem resposta)", { tipo: resultado.tipo });
        // Quem manda (Yan, Rodrigo, Vanessa, Jhonathan): o pedido ja e a decisao. Todas as
        // acoes da resposta rodam agora, na ordem, e o assistente relata o resultado uma vez.
        if (PODEM_CONFIRMAR.includes(quem) && resultado.propostas?.length) {
            const feitas = await executarDireto(db, id, quem, resultado.propostas.slice(0, MAX_ACOES_DIRETAS), { ctx, emitir });
            const sobra = resultado.propostas.length - feitas.length;
            const relatorio = await relatar(db, { conversa_id: id }, quem,
                `[Programa] As ações que você registrou foram executadas agora, a pedido de ${quem}${sobra > 0 ? ` (só as ${feitas.length} primeiras; ${sobra} ficaram de fora pelo limite por resposta — diga isso)` : ""}. Resultado de cada uma (dados do programa):\n${JSON.stringify(feitas).slice(0, 20000)}\n\nConte à pessoa, curto, o que foi feito e o que não deu certo (com o motivo). Se teve lançamento no Conta Azul, diga nota a nota o que subiu e o que não subiu. Não diga que algo espera Confirmar.`,
                rodar, emitir);
            return { conversa_id: id, tipo: resultado.tipo, texto: relatorio || resultado.texto, proposta: null, executadas: feitas.length };
        }
        // Os demais: so a primeira proposta da resposta vale (vira botao Confirmar).
        let proposta = null;
        const [primeira] = resultado.propostas || [];
        if (primeira) {
            const ferramenta = ferramentas.obter(primeira.ferramenta, db);
            const resumo = ferramenta.resumir ? ferramenta.resumir(primeira.parametros || {}) : primeira.ferramenta;
            const propostaId = Number(db.prepare(`INSERT INTO assistente_propostas (conversa_id, ferramenta, parametros, resumo, pedida_por, em) VALUES (?, ?, ?, ?, ?, ?)`)
                .run(id, primeira.ferramenta, json(primeira.parametros || {}), resumo, quem, agora()).lastInsertRowid);
            proposta = { id: propostaId, ferramenta: primeira.ferramenta, resumo, parametros: primeira.parametros || {} };
        }
        return { conversa_id: id, tipo: resultado.tipo, texto: resultado.texto, proposta };
    } finally {
        emAndamento = null;
    }
}

const MAX_ACOES_DIRETAS = 40;

/** Grava cada acao como proposta ja decidida por `quem` e executa, uma a uma, na ordem. */
async function executarDireto(db, conversaId, quem, lista, { ctx = {}, emitir = () => {} } = {}) {
    const feitas = [];
    for (const [i, item] of lista.entries()) {
        let resumo = item.ferramenta;
        let ferramenta = null;
        try { ferramenta = ferramentas.obter(item.ferramenta, db); resumo = ferramenta.resumir ? ferramenta.resumir(item.parametros || {}) : item.ferramenta; } catch (_) { /* nome invalido: falha abaixo */ }
        const propostaId = Number(db.prepare(`INSERT INTO assistente_propostas (conversa_id, ferramenta, parametros, resumo, status, pedida_por, decidida_por, em, decidida_em)
            VALUES (?, ?, ?, ?, 'EXECUTANDO', ?, ?, ?, ?)`).run(conversaId, item.ferramenta, json(item.parametros || {}), resumo, quem, quem, agora(), agora()).lastInsertRowid);
        try { emitir({ tipo: "acao", texto: `Fazendo ${i + 1} de ${lista.length}: ${resumo}` }); } catch (_) { /* tela fechada */ }
        try {
            if (!ferramenta) throw new Error(`Ferramenta "${item.ferramenta}" não existe.`);
            const saida = await ferramentas.executar(item.ferramenta, item.parametros || {}, { ...ctx, db, pessoa: quem, conversaId });
            db.prepare("UPDATE assistente_propostas SET status = 'EXECUTADA', resultado = ? WHERE id = ?").run(json(saida), propostaId);
            registrarMensagem(db, conversaId, "sistema", `Feito (pedido de ${quem}): ${resumo}.`, { resultado: saida });
            feitas.push({ acao: resumo, ok: true, resultado: saida });
        } catch (erro) {
            db.prepare("UPDATE assistente_propostas SET status = 'FALHOU', resultado = ? WHERE id = ?").run(json({ erro: erro.message }), propostaId);
            registrarMensagem(db, conversaId, "sistema", `Não deu certo: ${resumo}. ${erro.message}`);
            feitas.push({ acao: resumo, ok: false, erro: erro.message });
        }
    }
    return feitas;
}

function parar() {
    if (!emAndamento?.sinal?.parar) return false;
    emAndamento.sinal.parado = true;
    emAndamento.sinal.parar();
    return true;
}

/** Confirmar ou cancelar uma proposta (das pessoas sem permissao total). So quem manda confirma. */
/**
 * Depois de executar (ou falhar), o assistente le o resultado e escreve a
 * resposta na conversa (ex.: relatorio do treino: antes x depois, o que
 * melhorou, onde ainda erra). `rodar` = motor do assistente (ausente nos testes).
 */
async function relatar(db, proposta, quem, texto, rodar, emitir) {
    if (typeof rodar !== "function") return null;
    const conversa = db.prepare("SELECT * FROM assistente_conversas WHERE id = ?").get(proposta.conversa_id);
    emAndamento = { conversaId: conversa.id, sinal: {} };
    try {
        const resultado = await rodar({ texto, sessao: conversa.sessao, pessoa: quem, conversaId: conversa.id, emitir: emitir || (() => {}) });
        if (resultado.sessao) db.prepare("UPDATE assistente_conversas SET sessao = ? WHERE id = ?").run(resultado.sessao, conversa.id);
        registrarMensagem(db, conversa.id, "assistente", resultado.texto || "(sem resposta)", { tipo: resultado.tipo });
        return resultado.texto;
    } catch (_) {
        return null;
    } finally {
        emAndamento = null;
    }
}

const PEDIDO_DE_RELATORIO = {
    treinar_ia: "Escreva para a pessoa um RELATÓRIO do treino, curto e claro, em português: (1) maturidade antes → depois (estágio, notas inteiras certas, mínimo garantido); (2) tabela dos campos com acerto agora e na medição anterior, destacando o que melhorou e o que piorou; (3) os 3 problemas que mais seguram a IA, com exemplos dos erros que restam; (4) o que fazer agora (ex.: revisar tal tipo de nota) e quanto falta para o próximo estágio. Não invente números: use só o resultado acima.",
    preparar_lancamento: "Explique em 2 ou 3 linhas o que aconteceu com o lançamento (enviado ou não, e por quê).",
};

async function decidir(db, propostaId, { pessoa, aceito, ctx = {}, rodar = null, emitir = null }) {
    const quem = conferirPessoa(pessoa);
    const proposta = db.prepare("SELECT * FROM assistente_propostas WHERE id = ?").get(Number(propostaId));
    if (!proposta) throw new Error("Proposta não encontrada.");
    if (proposta.status !== "PENDENTE") throw new Error("Essa proposta já foi decidida.");
    if (aceito && !PODEM_CONFIRMAR.includes(quem)) throw new Error(`Só ${PODEM_CONFIRMAR.join(", ")} podem confirmar.`);
    if (!aceito) {
        db.prepare("UPDATE assistente_propostas SET status = 'CANCELADA', decidida_por = ?, decidida_em = ? WHERE id = ?").run(quem, agora(), proposta.id);
        registrarMensagem(db, proposta.conversa_id, "sistema", `${quem} cancelou: ${proposta.resumo}. Nada foi feito.`);
        return { status: "CANCELADA" };
    }
    db.prepare("UPDATE assistente_propostas SET status = 'EXECUTANDO', decidida_por = ?, decidida_em = ? WHERE id = ?").run(quem, agora(), proposta.id);
    try {
        const resultado = await ferramentas.executar(proposta.ferramenta, lerJson(proposta.parametros, {}), { ...ctx, db, pessoa: quem, conversaId: proposta.conversa_id });
        transacao(db, () => {
            db.prepare("UPDATE assistente_propostas SET status = 'EXECUTADA', resultado = ? WHERE id = ?").run(json(resultado), proposta.id);
            registrarMensagem(db, proposta.conversa_id, "sistema", `${quem} confirmou: ${proposta.resumo}.`, { resultado });
        });
        const pedido = PEDIDO_DE_RELATORIO[proposta.ferramenta] || "Explique em poucas linhas o resultado.";
        const relatorio = await relatar(db, proposta, quem,
            `[Programa] ${quem} confirmou "${proposta.resumo}" e a ação terminou. Resultado (dados do programa):\n${JSON.stringify(resultado).slice(0, 15000)}\n\n${pedido}`, rodar, emitir);
        return { status: "EXECUTADA", resultado, relatorio };
    } catch (erro) {
        db.prepare("UPDATE assistente_propostas SET status = 'FALHOU', resultado = ? WHERE id = ?").run(json({ erro: erro.message }), proposta.id);
        registrarMensagem(db, proposta.conversa_id, "sistema", `Falhou: ${proposta.resumo}. ${erro.message}`);
        return { status: "FALHOU", erro: erro.message };
    }
}

function estado() {
    const executavel = assinatura.localizarClaude();
    return { disponivel: Boolean(executavel), mensagem: executavel ? "Pela assinatura Claude da empresa (Claude Code deste PC), sem custo de API." : assinatura.MSG_SEM_CLI,
        usuarios: USUARIOS, podem_confirmar: PODEM_CONFIRMAR, ocupado: Boolean(emAndamento) };
}

function sugestoes(db) {
    return db.prepare("SELECT * FROM assistente_sugestoes ORDER BY id DESC LIMIT 100").all();
}

function mudarSugestao(db, id, status) {
    if (!["NOVA", "FEITA", "DESCARTADA"].includes(status)) throw new Error("Situação inválida.");
    db.prepare("UPDATE assistente_sugestoes SET status = ? WHERE id = ?").run(status, Number(id));
    return { ok: true };
}

module.exports = { enviar, parar, decidir, estado, listarConversas, lerConversa, sugestoes, mudarSugestao, USUARIOS, PODEM_CONFIRMAR };
