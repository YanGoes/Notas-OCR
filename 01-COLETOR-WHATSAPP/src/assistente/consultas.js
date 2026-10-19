"use strict";

// =============================================================================
// CONSULTA LIVRE (SO LEITURA) E HABILIDADES CRIADAS PELO USUARIO
// =============================================================================
//
// Para perguntas que nenhuma ferramenta pronta responde, o assistente escreve
// uma consulta SQL de LEITURA:
//   - base "central": o banco da Central, aberto SOMENTE LEITURA (nao grava);
//   - base "planilha": os lancamentos da planilha do Conta Azul numa tabela
//     temporaria em memoria.
// So SELECT/WITH, uma consulta por vez, no maximo 500 linhas.
//
// Habilidade = consulta salva com nome e descricao. Criar uma passa pelo
// Confirmar; depois ela aparece como ferramenta nova em toda conversa.
// =============================================================================

const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");
const { CAMINHO_PADRAO, agora } = require("../central/banco");

const RAIZ = path.resolve(__dirname, "..", "..");
const LIMITE = 500;

const ESQUEMA = {
    central: `Banco da Central (SQLite). Tabelas principais:
- despesas(id, estado [AGUARDANDO_REVISAO|CLASSIFICADO|APROVADO|DESCARTADO|BLOQUEADO_DUPLICADO], campos JSON, pendencias JSON, avisos JSON, mensagem_ref, midia_id, criado_em, atualizado_em, revisado_por, comentario_ia)
  campos JSON: $.data_competencia.valor, $.valor.valor, $.tipo.valor, $.fornecedor.valor, $.fornecedor.nome_lido, $.categoria.nome, $.centro_custo.nome,
  $.pagamento.cartao, $.pagamento.forma, $.descricao.valor, $.pessoas.valor, $.remetente.valor (operador), $.abastecimento.litros.valor,
  $.abastecimento.odometro.valor, $.abastecimento.placa.valor, $.observacao.valor
- mensagens(id, grupo_id, remetente_nome, pessoa_id, enviada_em, texto, tem_midia, intencao)
- correcoes(despesa_id, campo, valor_anterior, valor_novo, tipo_erro, observacao, autor, em)
- exemplos_treino(despesa_id, rotulos JSON, aprovado_por, aprovado_em)
Use json_extract(campos, '$.valor.valor') etc. Notas simuladas do treino tem mensagens.remetente_id LIKE 'historico:%'.`,
    planilha: `Tabela lancamentos (planilha "Contas a pagar" do Conta Azul, desde 01/2025):
lancamentos(data TEXT 'AAAA-MM-DD', valor REAL (negativo = despesa; use ABS), fornecedor, categoria, centro, descricao, referencia, situacao, forma, conta)
Abastecimento: descricao no padrao '63,57L od 310.748 - OVN5J98'; categoria do veiculo (ex.: 'HILUX - OVN5J98').`,
};

function validar(sql) {
    const texto = String(sql || "").trim().replace(/;\s*$/, "");
    if (!/^(select|with)\b/i.test(texto)) throw new Error("Só consultas de leitura (SELECT ou WITH).");
    if (texto.includes(";")) throw new Error("Uma consulta por vez (sem ';').");
    if (/\b(insert|update|delete|drop|alter|create|attach|detach|pragma|vacuum|replace|reindex)\b/i.test(texto)) throw new Error("A consulta não pode alterar nada.");
    return texto;
}

function abrirPlanilha() {
    const arquivo = path.join(RAIZ, "dados", "aprendizado", "lancamentos-conta-azul.json");
    if (!fs.existsSync(arquivo)) throw new Error("Planilha do Conta Azul ainda não importada (atalho 14).");
    const { lancamentos = [] } = JSON.parse(fs.readFileSync(arquivo, "utf8"));
    const db = new DatabaseSync(":memory:");
    db.exec("CREATE TABLE lancamentos (data TEXT, valor REAL, fornecedor TEXT, categoria TEXT, centro TEXT, descricao TEXT, referencia TEXT, situacao TEXT, forma TEXT, conta TEXT)");
    const inserir = db.prepare("INSERT INTO lancamentos VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
    db.exec("BEGIN");
    for (const l of lancamentos) inserir.run(l.data, l.valor, l.fornecedor, l.categoria, l.centro, l.descricao, l.referencia, l.situacao, l.forma, l.conta || null);
    db.exec("COMMIT");
    return db;
}

/** Roda uma consulta de leitura. `parametros`: valores nomeados (:nome) da habilidade. */
function consultar({ base = "central", sql, parametros = {} } = {}, { caminhoCentral = process.env.CENTRAL_DB || CAMINHO_PADRAO } = {}) {
    const texto = validar(sql);
    const db = base === "planilha" ? abrirPlanilha() : new DatabaseSync(caminhoCentral, { readOnly: true });
    try {
        const linhas = db.prepare(`SELECT * FROM (${texto}) LIMIT ${LIMITE + 1}`).all(parametros || {});
        return { base, linhas: linhas.slice(0, LIMITE), cortado: linhas.length > LIMITE };
    } finally {
        db.close();
    }
}

// ---------------------------------------------------------------------------
// Habilidades (consultas salvas)
// ---------------------------------------------------------------------------

const nomeValido = (nome) => /^[a-z][a-z0-9_]{2,40}$/.test(String(nome || ""));

function listarHabilidades(db) {
    return db.prepare("SELECT * FROM assistente_habilidades WHERE ativa = 1 ORDER BY nome").all().map((h) => ({ ...h, parametros: JSON.parse(h.parametros || "[]") }));
}

/** Testa a consulta e grava a habilidade (chamado so depois do Confirmar). */
function criarHabilidade(ctx, { nome, descricao, base = "central", sql, parametros = [] } = {}) {
    if (!nomeValido(nome)) throw new Error("Nome da habilidade: minúsculas, números e _ (ex.: km_por_veiculo).");
    if (!String(descricao || "").trim()) throw new Error("Descreva o que a habilidade responde.");
    const exemplo = Object.fromEntries((parametros || []).map((p) => [p.nome, p.exemplo ?? null]));
    consultar({ base, sql, parametros: exemplo });
    ctx.db.prepare(`INSERT INTO assistente_habilidades (nome, descricao, base, sql, parametros, criada_por, em, ativa) VALUES (?, ?, ?, ?, ?, ?, ?, 1)
        ON CONFLICT(nome) DO UPDATE SET descricao = excluded.descricao, base = excluded.base, sql = excluded.sql, parametros = excluded.parametros,
            criada_por = excluded.criada_por, em = excluded.em, ativa = 1`)
        .run(nome, String(descricao).trim(), base, validar(sql), JSON.stringify(parametros || []), ctx.pessoa || "?", agora());
    return { criada: true, nome: `h_${nome}`, mensagem: "Habilidade criada: já vale nas próximas perguntas (e em todas as conversas)." };
}

function ferramentaDaHabilidade(h) {
    return {
        nome: `h_${h.nome}`, grava: false,
        descricao: `[Habilidade criada por ${h.criada_por}] ${h.descricao}`,
        esquema: { type: "object", properties: Object.fromEntries((h.parametros || []).map((p) => [p.nome, { type: p.tipo || "string", description: p.descricao || "" }])) },
        executar: (_ctx, parametros) => consultar({ base: h.base, sql: h.sql, parametros: Object.fromEntries((h.parametros || []).map((p) => [p.nome, parametros?.[p.nome] ?? null])) }),
    };
}

module.exports = { consultar, validar, ESQUEMA, listarHabilidades, criarHabilidade, ferramentaDaHabilidade };
