"use strict";

// =============================================================================
// HABITOS DO OPERADOR — aprendidos das notas dele ja APROVADAS
// =============================================================================
//
// Ex.: o Lorran viaja sozinho (refeicoes de 1 pessoa) e paga com o Inter.
// Quando a mensagem nao informa, o habito vira ESTIMATIVA (pessoas) ou
// SUGESTAO (cartao) — sempre para confirmar, nunca decisao final.
//
// So conta habito firme: 5+ notas aprovadas e 80%+ iguais. Campos marcados
// "nao usar no treino" ficam de fora.
// =============================================================================

const { lerJson } = require("./banco");

const MINIMO_AMOSTRAS = 5;
const MINIMO_PARTICIPACAO = 0.8;
const REFEICOES = new Set(["CAFE_DA_MANHA", "ALMOCO", "JANTAR", "LANCHE"]);

function maisFrequente(valores) {
    if (valores.length < MINIMO_AMOSTRAS) return null;
    const contagem = new Map();
    for (const valor of valores) contagem.set(valor, (contagem.get(valor) || 0) + 1);
    const [valor, vezes] = [...contagem.entries()].sort((a, b) => b[1] - a[1])[0];
    const participacao = vezes / valores.length;
    return participacao >= MINIMO_PARTICIPACAO ? { valor, amostras: valores.length, participacao } : null;
}

/** @returns {{pessoas:{refeicao:object|null, hospedagem:object|null}, cartao:object|null, centro:object|null}|null} */
function habitosDoOperador(db, pessoaId, { excluirDespesas = [] } = {}) {
    if (!pessoaId) return null;
    const excluir = new Set(excluirDespesas.map(Number));
    const linhas = db.prepare(`
        SELECT d.id, d.campos, e.rotulos FROM despesas d
        JOIN mensagens m ON m.id = d.mensagem_ref LEFT JOIN exemplos_treino e ON e.despesa_id = d.id
        WHERE d.estado = 'APROVADO' AND m.pessoa_id = ?`).all(String(pessoaId));
    const refeicao = []; const hospedagem = []; const cartoes = []; const centros = [];
    for (const linha of linhas) {
        if (excluir.has(Number(linha.id))) continue;
        const campos = lerJson(linha.campos, {});
        const ignorados = new Set(lerJson(linha.rotulos, {})?._nao_usar_no_treino || []);
        const tipo = campos.tipo?.valor;
        const pessoas = Number(campos.pessoas?.valor);
        if (Number.isInteger(pessoas) && pessoas > 0) {
            if (REFEICOES.has(tipo)) refeicao.push(pessoas);
            if (tipo === "HOSPEDAGEM") hospedagem.push(pessoas);
        }
        if (!ignorados.has("pagamento") && campos.pagamento?.cartao) cartoes.push(campos.pagamento.cartao);
        // Centro de teste ("TESTE CC") nao e costume de ninguem.
        const centro = campos.centro_custo?.nome;
        if (!ignorados.has("centro_custo") && centro && !/^teste\b/i.test(centro)) centros.push(centro);
    }
    const cartao = maisFrequente(cartoes);
    const centro = maisFrequente(centros);
    return {
        centro: centro ? { valor: centro.valor, amostras: centro.amostras, participacao: centro.participacao } : null,
        pessoas: { refeicao: maisFrequente(refeicao), hospedagem: maisFrequente(hospedagem) },
        cartao: cartao ? { codigo: cartao.valor, amostras: cartao.amostras, participacao: cartao.participacao } : null,
    };
}

module.exports = { habitosDoOperador, MINIMO_AMOSTRAS, MINIMO_PARTICIPACAO };
