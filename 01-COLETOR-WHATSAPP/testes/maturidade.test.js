"use strict";

// Maturidade da IA: minimo garantido (Wilson 95%) e estagios.

const test = require("node:test");
const assert = require("node:assert/strict");
const { avaliar, minimoGarantido } = require("../src/central/maturidade");

const perto = (a, b, tol = 0.01) => Math.abs(a - b) <= tol;

test("minimo garantido: amostra pequena nao engana", () => {
    assert.ok(perto(minimoGarantido(9, 10), 0.596), "9 de 10 garante so ~60%");
    assert.ok(perto(minimoGarantido(900, 1000), 0.880), "900 de 1000 garante ~88%");
    assert.ok(minimoGarantido(18, 18) < 0.85, "18 de 18 ainda nao garante 85%");
    assert.equal(minimoGarantido(0, 0), 0);
});

function medicao({ inteiras, de, campos = {} }) {
    const porCampo = {};
    for (const chave of ["data_competencia", "valor", "fornecedor", "tipo", "descricao", "categoria", "centro_custo", "pagamento"]) {
        porCampo[chave] = { rotulo: chave, total: de, acertos: campos[chave] ?? de };
    }
    return { notas_inteiras_certas: { atual: inteiras, de }, por_campo: porCampo };
}

test("poucas notas: aprendendo, mesmo acertando tudo", () => {
    const m = avaliar(medicao({ inteiras: 18, de: 18 }));
    assert.equal(m.estagio, "APRENDENDO");
    assert.ok(m.campos.every((c) => c.status === "POUCOS_DADOS"));
    assert.ok(m.proximo.notas_aprovadas_que_faltam > 0);
});

test("estagios sobem com volume e acerto garantido", () => {
    assert.equal(avaliar(medicao({ inteiras: 58, de: 60 })).estagio, "ASSISTIDO");
    assert.equal(avaliar(medicao({ inteiras: 198, de: 200 })).estagio, "AUTONOMO_PARCIAL");
    assert.equal(avaliar(medicao({ inteiras: 399, de: 400 })).estagio, "AUTONOMO");
});

test("autonomo exige os campos criticos maduros, nao so a media", () => {
    const m = avaliar(medicao({ inteiras: 198, de: 200, campos: { pagamento: 170 } }));
    assert.equal(m.estagio, "ASSISTIDO");
    assert.ok(m.campos_que_seguram.includes("pagamento"));
});

test("taxa abaixo do alvo: juntar notas nao basta, precisa melhorar a IA", () => {
    const m = avaliar(medicao({ inteiras: 30, de: 50 }));
    assert.equal(m.estagio, "APRENDENDO");
    assert.equal(m.proximo.notas_aprovadas_que_faltam, null);
});
