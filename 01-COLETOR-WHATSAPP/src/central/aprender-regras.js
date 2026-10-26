"use strict";

// =============================================================================
// APRENDER REGRAS DAS OBSERVACOES (botao "Reclassificar com minhas observações")
// =============================================================================
//
// 1. Junta o que ja foi dito: as observacoes das correcoes de centro/cartao
//    ("almir esta nesse projeto de agora em diante"), os comentarios para a IA
//    e as mensagens da gerencia (Vanessa, Murillo) nos grupos.
// 2. O Claude da assinatura (sem API paga, sem reler foto nenhuma) transforma
//    isso em regras por operador: centro e cartao padrao, com data de inicio.
//    Sem o Claude, as correcoes repetidas ja viram proposta sozinhas.
// 3. Cada regra e conferida no cadastro (centro e cartao precisam existir) e so
//    vale depois do Confirmar de uma pessoa.
// 4. Confirmado: as notas EM REVISAO sem correcao humana sao reclassificadas
//    com a leitura ja guardada (nenhuma leitura nova do Azure).
// =============================================================================

const { lerJson } = require("./banco");
const cadastros = require("./cadastros");
const regrasOperador = require("./regras-operador");

const DIAS_FONTES = 45;
const OPERADOR_SQL = "COALESCE(msg.pessoa_id, json_extract(d.campos, '$.remetente.pessoa_id'))";
const SIMULADA_SQL = "COALESCE(msg.remetente_id, '') LIKE 'historico:%'";
const CAMPO_DA_CORRECAO = { centro_custo: "centro", pagamento: "cartao" };

const desdeDias = (dias) => new Date(Date.now() - dias * 86400000).toISOString();
const valorDaCorrecao = (bruto) => { const v = lerJson(bruto, bruto); return typeof v === "string" ? v : v?.cartao || v?.nome || v?.valor || null; };

/** Correcoes de centro/cartao com a observacao do revisor, por operador e data da nota. */
function correcoesDeCentroECartao(db, dias = DIAS_FONTES) {
    return db.prepare(`SELECT c.despesa_id, c.campo, c.valor_novo, c.observacao, c.em, ${OPERADOR_SQL} AS pessoa_id,
            json_extract(d.campos, '$.data_competencia.valor') AS data
        FROM correcoes c JOIN despesas d ON d.id = c.despesa_id LEFT JOIN mensagens msg ON msg.id = d.mensagem_ref
        WHERE c.campo IN ('centro_custo', 'pagamento') AND c.em >= ? AND NOT ${SIMULADA_SQL}
        ORDER BY c.em`).all(desdeDias(dias))
        .map((l) => ({ ...l, campo: CAMPO_DA_CORRECAO[l.campo], valor: valorDaCorrecao(l.valor_novo) }))
        .filter((l) => l.pessoa_id && l.valor);
}

function fontes(db, cad, { dias = DIAS_FONTES } = {}) {
    const papel = new Map((cad.pessoas || []).map((p) => [p.id, p.papel]));
    const gerencia = (cad.pessoas || []).filter((p) => ["ADMINISTRATIVO", "GESTOR"].includes(p.papel) && p.id !== "yan").map((p) => p.id);
    const operadoresDoGrupo = new Map();
    for (const l of db.prepare(`SELECT DISTINCT grupo_id, pessoa_id FROM mensagens WHERE pessoa_id IS NOT NULL AND enviada_em >= ?`).all(desdeDias(90))) {
        if (papel.get(l.pessoa_id) !== "OPERADOR") continue;
        operadoresDoGrupo.set(l.grupo_id, [...(operadoresDoGrupo.get(l.grupo_id) || []), l.pessoa_id]);
    }
    const mensagensGerencia = gerencia.length ? db.prepare(`SELECT enviada_em, pessoa_id, grupo_id, texto FROM mensagens
        WHERE pessoa_id IN (${gerencia.map(() => "?").join(",")}) AND enviada_em >= ? AND length(COALESCE(texto, '')) >= 12
        ORDER BY enviada_em`).all(...gerencia, desdeDias(dias))
        .map((m) => ({ em: m.enviada_em.slice(0, 16), quem: m.pessoa_id, operadores_do_grupo: operadoresDoGrupo.get(m.grupo_id) || [], texto: m.texto.slice(0, 600) })) : [];
    const comentarios = db.prepare(`SELECT d.id, ${OPERADOR_SQL} AS pessoa_id, json_extract(d.campos, '$.data_competencia.valor') AS data, d.comentario_ia AS texto
        FROM despesas d LEFT JOIN mensagens msg ON msg.id = d.mensagem_ref
        WHERE d.comentario_ia IS NOT NULL AND d.comentario_ia_em >= ? AND NOT ${SIMULADA_SQL}`).all(desdeDias(dias))
        .map((c) => ({ ...c, texto: String(c.texto).slice(0, 400) }));
    return { correcoes: correcoesDeCentroECartao(db, dias), mensagens_gerencia: mensagensGerencia, comentarios };
}

/**
 * Sem IA: o mesmo valor corrigido 2+ vezes para o operador, desde a ultima
 * correcao com valor diferente, vira proposta (inicio = nota mais antiga dessa
 * sequencia).
 */
function propostasDasCorrecoes(correcoes) {
    const porChave = new Map();
    for (const c of correcoes) {
        const chave = `${c.pessoa_id}|${c.campo}`;
        porChave.set(chave, [...(porChave.get(chave) || []), c]);
    }
    const propostas = [];
    for (const lista of porChave.values()) {
        const ultima = lista[lista.length - 1];
        const sequencia = [];
        for (let i = lista.length - 1; i >= 0 && lista[i].valor === ultima.valor; i -= 1) sequencia.push(lista[i]);
        if (sequencia.length < 2) continue;
        const datas = sequencia.map((c) => c.data).filter(Boolean).sort();
        propostas.push({
            pessoa_id: ultima.pessoa_id, campo: ultima.campo, valor: ultima.valor, desde: datas[0] || ultima.em.slice(0, 10),
            motivo: `${sequencia.length} correções suas iguais`, fonte: sequencia.map((c) => c.observacao).filter(Boolean)[0] || "",
            correcoes: sequencia.length,
        });
    }
    return propostas;
}

const SISTEMA = `Você organiza regras de lançamento de despesas de campo da VMac.
Recebe, em JSON: correções que o revisor fez (com a observação dele), comentários dele para a IA e mensagens da gerência (Vanessa, Murillo) nos grupos dos operadores.
Extraia SÓ regras do tipo "centro de custo padrão" e "cartão padrão" de cada operador, com a data a partir da qual valem.
- Use apenas pessoa_id, centros e cartões que existem nas listas recebidas (copie o texto exato do centro e o código do cartão).
- "desde": a data (AAAA-MM-DD) em que a regra passa a valer. "a partir de hoje"/"de agora em diante" = data da nota ou da mensagem em que foi dito. Se a gerência deu um período, use "ate" também.
- Uma mudança mais recente substitui a anterior: devolva só a regra vigente de cada operador e campo, a menos que haja períodos diferentes explícitos.
- Não invente: se não está claro, não crie a regra.
Responda SOMENTE com JSON, sem texto em volta: {"regras":[{"pessoa_id":"","campo":"centro|cartao","valor":"","desde":"AAAA-MM-DD","ate":null,"motivo":"frase curta","fonte":"trecho que justifica"}]}`;

/** Confere cada proposta no cadastro e devolve o valor canonico. */
function validar(cad, proposta) {
    const pessoa = (cad.pessoas || []).find((p) => p.id === proposta.pessoa_id);
    if (!pessoa) return { ...proposta, erro: `operador "${proposta.pessoa_id}" não existe no cadastro` };
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(proposta.desde || ""))) return { ...proposta, erro: "sem data de início" };
    if (proposta.campo === "centro") {
        const r = cadastros.resolverProjeto(cad, proposta.valor, pessoa);
        if (r.status !== "RESOLVIDO") return { ...proposta, erro: `centro "${proposta.valor}" não está cadastrado` };
        return { ...proposta, valor: r.projeto.nome_oficial, nome: cadastros.nomeCentro(r.projeto), operador: pessoa.nome };
    }
    if (proposta.campo === "cartao") {
        const alvo = String(proposta.valor || "").toUpperCase();
        const cartao = (cad.cartoes || []).find((c) => c.codigo === alvo || String(c.rotulo).toUpperCase() === alvo || String(c.rotulo).toUpperCase().includes(alvo));
        if (!cartao) return { ...proposta, erro: `cartão "${proposta.valor}" não está cadastrado` };
        return { ...proposta, valor: cartao.codigo, nome: cartao.rotulo, operador: pessoa.nome };
    }
    if (proposta.campo === "categoria_material") {
        const categoria = cadastros.categoriaPorNome(cad, proposta.valor);
        if (!categoria) return { ...proposta, erro: `categoria "${proposta.valor}" não está cadastrada` };
        return { ...proposta, valor: categoria.nome_interno, nome: categoria.nome, operador: pessoa.nome };
    }
    return { ...proposta, erro: `campo "${proposta.campo}" não suportado` };
}

function extrairJson(texto) {
    const inicio = texto.indexOf("{");
    const fim = texto.lastIndexOf("}");
    if (inicio < 0 || fim < inicio) throw new Error("A IA não devolveu as regras no formato esperado.");
    return JSON.parse(texto.slice(inicio, fim + 1));
}

/**
 * Propostas para o revisor confirmar. `perguntar` e o Claude da assinatura
 * (trocavel nos testes); se falhar, ficam so as propostas das correcoes.
 */
async function propor(db, cad, { perguntar = null, modelo = "" } = {}) {
    const dados = fontes(db, cad);
    // Notas de teste do escritorio (Yan, no "Eu e Eu") nao viram regra: so quem manda nota de campo.
    const deCampo = new Set((cad.pessoas || []).filter((p) => ["OPERADOR", "GESTOR"].includes(p.papel)).map((p) => p.id));
    const doHistorico = propostasDasCorrecoes(dados.correcoes.filter((c) => deCampo.has(c.pessoa_id)));
    let daIa = [];
    let avisoIa = null;
    if (perguntar && (dados.correcoes.length || dados.mensagens_gerencia.length || dados.comentarios.length)) {
        const listas = {
            hoje: new Date().toISOString().slice(0, 10),
            operadores: (cad.pessoas || []).filter((p) => p.papel === "OPERADOR" || p.papel === "GESTOR").map((p) => ({ pessoa_id: p.id, nome: p.nome })),
            centros: cadastros.projetosComId(cad).filter((p) => p.ativo !== false).map((p) => p.nome_oficial),
            cartoes: (cad.cartoes || []).map((c) => ({ codigo: c.codigo, rotulo: c.rotulo })),
            regras_vigentes: regrasOperador.listar(db).map((r) => ({ pessoa_id: r.pessoa_id, campo: r.campo, valor: r.valor, desde: r.desde, ate: r.ate })),
            ...dados,
        };
        try {
            daIa = (extrairJson(await perguntar({ sistema: SISTEMA, texto: JSON.stringify(listas), modelo })).regras || [])
                .map((r) => ({ ...r, motivo: r.motivo || "lido pela IA" }));
        } catch (erro) { avisoIa = erro.message; }
    }
    // Junta: a IA manda no texto/datas; a contagem de correcoes iguais reforca.
    const chave = (r) => `${r.pessoa_id}|${r.campo}|${String(r.valor).toUpperCase()}`;
    const juntas = new Map();
    for (const r of [...daIa, ...doHistorico]) {
        const anterior = juntas.get(chave(r));
        juntas.set(chave(r), anterior ? { ...anterior, correcoes: anterior.correcoes || r.correcoes, fonte: anterior.fonte || r.fonte } : r);
    }
    const vigentes = regrasOperador.listar(db);
    const propostas = [...juntas.values()].map((r) => validar(cad, r))
        .map((r) => ({ ...r, ja_existe: !r.erro && vigentes.some((v) => v.pessoa_id === r.pessoa_id && v.campo === r.campo && v.valor === r.valor && v.desde <= r.desde) }));
    return {
        propostas: propostas.filter((r) => !r.erro && !r.ja_existe),
        descartadas: propostas.filter((r) => r.erro).map((r) => ({ pessoa_id: r.pessoa_id, campo: r.campo, valor: r.valor, erro: r.erro })),
        ja_vigentes: propostas.filter((r) => r.ja_existe).length,
        fontes: { correcoes: dados.correcoes.length, mensagens_gerencia: dados.mensagens_gerencia.length, comentarios: dados.comentarios.length },
        aviso_ia: avisoIa,
    };
}

/**
 * Grava as regras confirmadas e reclassifica as notas em revisao sem correcao
 * humana (nao mexe nas aprovadas nem nas simuladas). Devolve o que mudou.
 */
function confirmarEReclassificar(db, cad, regras, autor, { regenerar, opcoes = {} }) {
    const validas = (regras || []).map((r) => validar(cad, r));
    const invalida = validas.find((r) => r.erro);
    if (invalida) throw new Error(`Regra recusada: ${invalida.erro}.`);
    regrasOperador.salvar(db, validas, autor);
    return reclassificar(db, cad, { regenerar, opcoes });
}

function reclassificar(db, cad, { regenerar, opcoes = {} }) {
    const ids = db.prepare(`SELECT d.id FROM despesas d LEFT JOIN mensagens msg ON msg.id = d.mensagem_ref
        WHERE d.estado IN ('AGUARDANDO_REVISAO', 'CLASSIFICADO') AND d.mensagem_ref IS NOT NULL AND NOT ${SIMULADA_SQL}
          AND NOT EXISTS (SELECT 1 FROM correcoes c WHERE c.despesa_id = d.id)`).all().map((l) => l.id);
    const resumo = { reclassificadas: 0, centros_preenchidos: 0, cartoes_preenchidos: 0, placas_deduzidas: 0, sem_pendencia: 0, falhas: [] };
    const ler = (id) => db.prepare("SELECT campos, pendencias FROM despesas WHERE id = ?").get(id);
    for (const id of ids) {
        const antes = ler(id);
        try { regenerar(db, cad, id, opcoes); } catch (erro) { resumo.falhas.push({ id, erro: erro.message }); continue; }
        const depois = ler(id);
        const [a, b] = [lerJson(antes.campos, {}), lerJson(depois.campos, {})];
        resumo.reclassificadas += 1;
        if (!a.centro_custo?.nome && b.centro_custo?.nome) resumo.centros_preenchidos += 1;
        if (!a.pagamento?.cartao && b.pagamento?.cartao) resumo.cartoes_preenchidos += 1;
        if (!a.abastecimento?.placa?.valor && b.abastecimento?.placa?.origem === "deduzida_pelo_km") resumo.placas_deduzidas += 1;
        if (lerJson(antes.pendencias, []).length && !lerJson(depois.pendencias, []).length) resumo.sem_pendencia += 1;
    }
    return resumo;
}

module.exports = { fontes, propostasDasCorrecoes, validar, propor, confirmarEReclassificar, reclassificar, SISTEMA };
