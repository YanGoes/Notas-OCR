"use strict";

// =============================================================================
// MATURIDADE DA IA — quando da para confiar e lancar sem revisar
// =============================================================================
//
// Entrada: o resultado de ferramentas/medir-contra-aprovadas.js (a versao
// ATUAL da IA reprocessando notas que uma pessoa aprovou).
//
// Para nao se enganar com amostra pequena, cada taxa vem com o "minimo
// garantido": o limite inferior do intervalo de confianca de 95% (Wilson).
// Ex.: 9 acertos em 10 = 90%, mas o minimo garantido e so 60% — pode ter
// sido sorte. Com 900 em 1000, o minimo sobe para 88%.
//
// Estagios (o lancamento autonomo so e LIBERADO pela pessoa; isto so mede):
//   1 APRENDENDO       — revisar todas as notas.
//   2 ASSISTIDO        — notas inteiras certas >= 80% garantido (50+ notas):
//                        revisao rapida; aprovar em lote as sem pendencia.
//   3 AUTONOMO_PARCIAL — >= 95% garantido (150+ notas) e campos criticos
//                        maduros: lancar sozinha SO as notas sem pendencia.
//   4 AUTONOMO         — >= 98% garantido (300+ notas).
// =============================================================================

const Z_95 = 1.96;

/** Limite inferior de Wilson (95%) para `acertos` em `total`. */
function minimoGarantido(acertos, total, z = Z_95) {
    if (!total) return 0;
    const p = acertos / total;
    const z2 = z * z;
    const centro = p + z2 / (2 * total);
    const margem = z * Math.sqrt((p * (1 - p) + z2 / (4 * total)) / total);
    return Math.max(0, (centro - margem) / (1 + z2 / total));
}

// Campos que vao para o Conta Azul e precisam estar maduros para lancar sozinho.
const CAMPOS_CRITICOS = ["data_competencia", "valor", "fornecedor", "tipo", "descricao", "categoria", "centro_custo", "pagamento"];

const ESTAGIOS = [
    { codigo: "APRENDENDO", rotulo: "1 · Aprendendo", explicacao: "Revisar todas as notas antes de lançar.", minimo: 0, notas: 0 },
    { codigo: "ASSISTIDO", rotulo: "2 · Assistido", explicacao: "Revisão rápida: as notas sem pendência podem ser aprovadas em lote.", minimo: 0.80, notas: 50 },
    { codigo: "AUTONOMO_PARCIAL", rotulo: "3 · Autônomo parcial", explicacao: "Pode lançar sozinha as notas sem pendência; o resto continua em revisão.", minimo: 0.95, notas: 150, camposMaduros: true },
    { codigo: "AUTONOMO", rotulo: "4 · Autônomo", explicacao: "Pode lançar sozinha; a revisão vira conferência por amostragem.", minimo: 0.98, notas: 300, camposMaduros: true },
];

function statusDoCampo(total, minimo) {
    if (total < 30) return "POUCOS_DADOS";
    if (minimo >= 0.97) return "MADURO";
    if (minimo >= 0.90) return "QUASE";
    return "APRENDENDO";
}

/** Quantas notas certas seguidas faltariam para o minimo garantido chegar a `alvo` (mantida a taxa atual). */
function notasQueFaltam(acertos, total, alvo, notasMinimas) {
    const taxa = total ? acertos / total : 0;
    if (taxa <= alvo) return null; // na taxa atual nunca chega: precisa melhorar a IA, nao so juntar notas
    for (let extra = 0; extra <= 5000; extra += 5) {
        const n = total + extra;
        if (n >= notasMinimas && minimoGarantido(Math.round(taxa * n), n) >= alvo) return extra;
    }
    return null;
}

/**
 * @param {object} medicao — saida de medir-contra-aprovadas (por_campo, notas_inteiras_certas)
 */
function avaliar(medicao) {
    const inteiras = medicao?.notas_inteiras_certas || { atual: 0, de: 0 };
    const campos = Object.entries(medicao?.por_campo || {}).map(([chave, item]) => {
        const minimo = minimoGarantido(item.acertos, item.total);
        return { chave, rotulo: item.rotulo, total: item.total, acertos: item.acertos, taxa: item.total ? item.acertos / item.total : null,
            minimo_garantido: minimo, status: statusDoCampo(item.total, minimo), critico: CAMPOS_CRITICOS.includes(chave) };
    }).sort((a, b) => (a.minimo_garantido ?? 0) - (b.minimo_garantido ?? 0));
    const minimoInteiras = minimoGarantido(inteiras.atual, inteiras.de);
    const criticosMaduros = CAMPOS_CRITICOS.every((chave) => campos.find((c) => c.chave === chave)?.status === "MADURO");

    let atual = ESTAGIOS[0];
    for (const estagio of ESTAGIOS.slice(1)) {
        const passa = inteiras.de >= estagio.notas && minimoInteiras >= estagio.minimo && (!estagio.camposMaduros || criticosMaduros);
        if (passa) atual = estagio; else break;
    }
    const proximo = ESTAGIOS[ESTAGIOS.indexOf(atual) + 1] || null;
    return {
        estagio: atual.codigo, rotulo: atual.rotulo, explicacao: atual.explicacao,
        notas_inteiras: { certas: inteiras.atual, de: inteiras.de, taxa: inteiras.de ? inteiras.atual / inteiras.de : null, minimo_garantido: minimoInteiras },
        campos,
        campos_que_seguram: campos.filter((c) => c.critico && c.status !== "MADURO").map((c) => c.rotulo),
        proximo: proximo ? {
            rotulo: proximo.rotulo, precisa: `notas inteiras certas com mínimo garantido ≥ ${Math.round(proximo.minimo * 100)}% em ${proximo.notas}+ notas${proximo.camposMaduros ? " e campos críticos maduros" : ""}`,
            notas_aprovadas_que_faltam: notasQueFaltam(inteiras.atual, inteiras.de, proximo.minimo, proximo.notas),
        } : null,
    };
}

const pct = (v) => (v == null ? "—" : `${Math.round(v * 100)}%`);

/** Resumo em texto (log do treino e terminal). */
function texto(m) {
    const linhas = [
        `MATURIDADE DA IA: ${m.rotulo} — ${m.explicacao}`,
        `Notas inteiras certas: ${m.notas_inteiras.certas} de ${m.notas_inteiras.de} (${pct(m.notas_inteiras.taxa)}; mínimo garantido ${pct(m.notas_inteiras.minimo_garantido)}).`,
    ];
    const criticos = m.campos.filter((c) => c.critico && c.status !== "MADURO");
    const errando = criticos.filter((c) => c.status !== "POUCOS_DADOS");
    const poucos = criticos.filter((c) => c.status === "POUCOS_DADOS");
    if (errando.length) linhas.push(`Campos críticos que ainda erram: ${errando.map((c) => `${c.rotulo} (${pct(c.taxa)})`).join(", ")}.`);
    if (poucos.length) linhas.push(`Campos críticos com poucos dados (menos de 30 notas): ${poucos.map((c) => `${c.rotulo} ${c.acertos}/${c.total}`).join(", ")}.`);
    if (m.proximo) {
        const falta = m.proximo.notas_aprovadas_que_faltam;
        linhas.push(`Próximo estágio (${m.proximo.rotulo}): ${m.proximo.precisa}. `
            + (falta == null ? "Na taxa atual não chega lá só juntando notas: precisa melhorar a IA nos erros que restam." : `Faltam cerca de ${falta} notas aprovadas mantendo a taxa atual.`));
    }
    return linhas.join("\n");
}

module.exports = { avaliar, texto, minimoGarantido, ESTAGIOS, CAMPOS_CRITICOS };
