"use strict";

// =============================================================================
// AVISOS DA GERENCIA (Vanessa, Murillo): mudanca de projeto/cartao na hora
// =============================================================================
//
// A cada 2 minutos, as mensagens novas da gerencia nos grupos monitorados vao
// para o Claude da assinatura com uma pergunta so: "essa mensagem muda o
// projeto ou o cartao de algum operador? A partir de quando?".
//   - Nao muda: anotada como SEM_MUDANCA (nao pergunta de novo).
//   - Muda: vira aviso PENDENTE no topo da Central com Confirmar/Ignorar.
// Confirmar grava a regra do operador e reclassifica as notas em revisao.
// Nenhuma foto e lida (nada de Azure).
// =============================================================================

const { agora, lerJson } = require("./banco");
const cadastros = require("./cadastros");
const regrasOperador = require("./regras-operador");
const aprender = require("./aprender-regras");

const HORAS_INICIAIS = 72;

const SISTEMA = `Você lê UMA mensagem da gerência da VMac (Vanessa ou Murillo) enviada num grupo de WhatsApp de despesas de campo.
Pergunta única: essa mensagem muda o centro de custo (projeto) ou o cartão de algum operador? A partir de quando?
- "a partir de amanhã", "de hoje em diante", "semana que vem" são relativos à data/hora da mensagem.
- Se a mensagem fala "você"/"vocês" sem nome, vale para os operadores do grupo (lista operadores_do_grupo).
- Use só pessoa_id, centros e cartões das listas recebidas; um nome parecido de centro (apelido) pode ser copiado como está.
- Cobrança de comprovante, agradecimento, acerto de Pix, pedido de km etc. NÃO mudam nada.
- Na dúvida, não invente: muda=false.
Responda SOMENTE JSON: {"muda":true|false,"regras":[{"pessoa_id":"","campo":"centro|cartao","valor":"","desde":"AAAA-MM-DD","ate":null,"trecho":"parte da mensagem"}]}`;

function pessoasDaGerencia(cad) {
    return (cad.pessoas || []).filter((p) => ["ADMINISTRATIVO", "GESTOR"].includes(p.papel) && p.id !== "yan").map((p) => p.id);
}

/** Mensagens da gerencia ainda nao analisadas (so as recentes). */
function naoAnalisadas(db, cad, { horas = HORAS_INICIAIS } = {}) {
    const gerencia = pessoasDaGerencia(cad);
    if (!gerencia.length) return [];
    return db.prepare(`SELECT m.* FROM mensagens m
        WHERE m.pessoa_id IN (${gerencia.map(() => "?").join(",")}) AND m.tem_midia = 0 AND length(COALESCE(m.texto, '')) >= 12
          AND m.enviada_em >= ? AND NOT EXISTS (SELECT 1 FROM avisos_gerencia a WHERE a.mensagem_ref = m.id)
        ORDER BY m.enviada_em`).all(...gerencia, new Date(Date.now() - horas * 3600000).toISOString());
}

function operadoresDoGrupo(db, cad, grupoId) {
    const operadores = new Set((cad.pessoas || []).filter((p) => p.papel === "OPERADOR" || p.papel === "GESTOR").map((p) => p.id));
    return db.prepare("SELECT DISTINCT pessoa_id FROM mensagens WHERE grupo_id = ? AND pessoa_id IS NOT NULL").all(grupoId)
        .map((l) => l.pessoa_id).filter((id) => operadores.has(id));
}

function extrairJson(texto) {
    const inicio = texto.indexOf("{");
    const fim = texto.lastIndexOf("}");
    if (inicio < 0 || fim < inicio) throw new Error("resposta fora do formato");
    return JSON.parse(texto.slice(inicio, fim + 1));
}

/** Analisa uma mensagem e grava o resultado (SEM_MUDANCA, PENDENTE ou ERRO). */
async function analisar(db, cad, mensagem, { perguntar }) {
    const entrada = {
        mensagem: { de: mensagem.pessoa_id, em: mensagem.enviada_em, texto: String(mensagem.texto).slice(0, 1500) },
        hoje: new Date().toISOString().slice(0, 10),
        operadores_do_grupo: operadoresDoGrupo(db, cad, mensagem.grupo_id),
        operadores: (cad.pessoas || []).filter((p) => p.papel === "OPERADOR" || p.papel === "GESTOR").map((p) => ({ pessoa_id: p.id, nome: p.nome })),
        centros: cadastros.projetosComId(cad).filter((p) => p.ativo !== false).map((p) => ({ nome: p.nome_oficial, apelidos: p.apelidos || [] })),
        cartoes: (cad.cartoes || []).map((c) => ({ codigo: c.codigo, rotulo: c.rotulo })),
        regras_vigentes: regrasOperador.listar(db).map((r) => ({ pessoa_id: r.pessoa_id, campo: r.campo, valor: r.valor, desde: r.desde })),
    };
    let status = "SEM_MUDANCA";
    let regras = [];
    let erro = null;
    try {
        const resposta = extrairJson(await perguntar({ sistema: SISTEMA, texto: JSON.stringify(entrada) }));
        if (resposta.muda && Array.isArray(resposta.regras) && resposta.regras.length) {
            regras = resposta.regras.map((r) => ({ ...aprender.validar(cad, r), trecho: r.trecho || null }));
            status = "PENDENTE";
        }
    } catch (falha) {
        // Limite da assinatura ou fora do ar: tenta de novo na proxima rodada.
        return { status: "ADIADA", erro: falha.message };
    }
    db.prepare("INSERT INTO avisos_gerencia (mensagem_ref, status, regras, erro, em) VALUES (?, ?, ?, ?, ?)")
        .run(mensagem.id, status, JSON.stringify(regras), erro, agora());
    return { status, regras };
}

async function analisarNovas(db, cad, { perguntar, limite = 10 } = {}) {
    const resultado = { analisadas: 0, avisos: 0, adiadas: 0 };
    for (const mensagem of naoAnalisadas(db, cad).slice(0, limite)) {
        const r = await analisar(db, cad, mensagem, { perguntar });
        if (r.status === "ADIADA") { resultado.adiadas += 1; break; }
        resultado.analisadas += 1;
        if (r.status === "PENDENTE") resultado.avisos += 1;
    }
    return resultado;
}

/** Avisos pendentes para o topo da Central, com o texto e o grupo da mensagem. */
function pendentes(db, cad) {
    const nomes = new Map((cad.pessoas || []).map((p) => [p.id, p.nome]));
    return db.prepare(`SELECT a.id, a.regras, a.em, m.texto, m.enviada_em, m.pessoa_id, m.grupo_id FROM avisos_gerencia a
        JOIN mensagens m ON m.id = a.mensagem_ref WHERE a.status = 'PENDENTE' ORDER BY m.enviada_em`).all()
        .map((l) => ({
            id: l.id, quem: nomes.get(l.pessoa_id) || l.pessoa_id, em: l.enviada_em, texto: String(l.texto || "").slice(0, 400),
            operadores_do_grupo: operadoresDoGrupo(db, cad, l.grupo_id).map((id) => nomes.get(id) || id),
            regras: lerJson(l.regras, []),
        }));
}

/** Confirmar (grava as regras validas e reclassifica) ou Ignorar. */
function decidir(db, cad, avisoId, { aceito, autor, regenerar, opcoes = {} }) {
    const aviso = db.prepare("SELECT * FROM avisos_gerencia WHERE id = ?").get(Number(avisoId));
    if (!aviso) throw new Error("Aviso não encontrado.");
    if (aviso.status !== "PENDENTE") throw new Error(`Este aviso já foi ${aviso.status.toLowerCase()}.`);
    if (!String(autor || "").trim()) throw new Error("Informe seu nome no campo Revisor (topo da página).");
    let resumo = null;
    if (aceito) {
        const validas = lerJson(aviso.regras, []).filter((r) => !r.erro)
            .map((r) => ({ ...r, fonte: `Mensagem da gerência: ${r.trecho || ""}`.slice(0, 500) }));
        if (!validas.length) throw new Error("Nenhuma regra válida neste aviso (centro ou cartão fora do cadastro). Use Ignorar e ajuste o cadastro.");
        resumo = aprender.confirmarEReclassificar(db, cad, validas, autor, { regenerar, opcoes });
    }
    db.prepare("UPDATE avisos_gerencia SET status = ?, decidido_por = ?, decidido_em = ? WHERE id = ?")
        .run(aceito ? "CONFIRMADO" : "IGNORADO", String(autor), agora(), aviso.id);
    return { status: aceito ? "CONFIRMADO" : "IGNORADO", resumo };
}

// ---------------------------------------------------------------------------
// Uma vez por dia (fim da tarde, 18:30 por padrao) para poupar a assinatura;
// o botao da Central e o assistente leem na hora quando alguem pedir.
// ---------------------------------------------------------------------------
const fs = require("fs");
const path = require("path");
const ARQUIVO_ULTIMA = path.join(__dirname, "..", "..", "dados", "avisos-gerencia.json");
const HORARIO_PADRAO = "18:30";

function hojeEmBrasilia(agoraData = new Date()) {
    const local = new Date(agoraData.getTime() - 3 * 3600000);
    return { dia: local.toISOString().slice(0, 10), minutos: local.getUTCHours() * 60 + local.getUTCMinutes() };
}

function ultimaLeitura() {
    try { return JSON.parse(fs.readFileSync(ARQUIVO_ULTIMA, "utf8")); } catch (_) { return {}; }
}

let lendo = null;
/** Le agora (botao, assistente ou horario do dia). Duas chamadas juntas esperam a mesma leitura. */
function lerAgora(db, cad, { perguntar, origem = "botao" } = {}) {
    if (!lendo) {
        lendo = analisarNovas(db, cad, { perguntar, limite: 50 })
            .then((r) => {
                const agora = new Date().toISOString();
                const anterior = ultimaLeitura();
                const registro = { ...anterior, em: agora, origem, ...r, ...(origem === "horario" ? { horario_em: agora } : {}) };
                try { fs.writeFileSync(ARQUIVO_ULTIMA, JSON.stringify(registro, null, 2)); } catch (_) { /* sem disco */ }
                return { ...r, pendentes: pendentes(db, cad).length };
            })
            .finally(() => { lendo = null; });
    }
    return lendo;
}

/** Confere a cada minuto: passou do horario e ainda nao leu hoje -> le. */
function agendar(obterBanco, obterCadastros, { perguntar, horario = HORARIO_PADRAO } = {}) {
    const [hh, mm] = String(horario).split(":").map(Number);
    const alvo = hh * 60 + (mm || 0);
    const conferir = async () => {
        const { dia, minutos } = hojeEmBrasilia();
        if (minutos < alvo || String(ultimaLeitura().horario_em || "").slice(0, 10) === dia) return;
        try {
            const r = await lerAgora(obterBanco(), obterCadastros(), { perguntar, origem: "horario" });
            console.log(`Gerência (${horario}): ${r.analisadas} mensagem(ns) lida(s), ${r.avisos} aviso(s) novo(s).`);
        } catch (erro) { console.error("Leitura das mensagens da gerência falhou:", erro?.message || erro); }
    };
    setTimeout(conferir, 60 * 1000).unref();
    setInterval(conferir, 60 * 1000).unref();
}

module.exports = { naoAnalisadas, analisar, analisarNovas, pendentes, decidir, agendar, lerAgora, ultimaLeitura, hojeEmBrasilia, SISTEMA };
