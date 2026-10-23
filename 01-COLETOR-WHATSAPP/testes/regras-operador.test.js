"use strict";

// Regras do operador (centro/cartao padrao), placa deduzida pelo km e
// propostas aprendidas das observacoes do revisor.

const test = require("node:test");
const assert = require("node:assert/strict");

const banco = require("../src/central/banco");
const cadastros = require("../src/central/cadastros");
const regrasOp = require("../src/central/regras-operador");
const aprender = require("../src/central/aprender-regras");
const { montarPrevia } = require("../src/central/regras-vmac");

const cad = cadastros.carregar();
const centroAtivo = cadastros.projetosComId(cad).find((p) => p.ativo === true && cadastros.resolverProjeto(cad, p.nome_oficial).status === "RESOLVIDO");
const almir = cad.pessoas.find((p) => p.id === "almir");

test("regra vigente pela data; regra nova encerra a anterior na vespera", () => {
    const db = banco.abrir(":memory:");
    regrasOp.salvar(db, [{ pessoa_id: "almir", campo: "cartao", valor: "C6", desde: "2026-09-01" }], "Yan");
    regrasOp.salvar(db, [{ pessoa_id: "almir", campo: "cartao", valor: "INTER", desde: "2026-10-20" }], "Yan");
    const lista = regrasOp.listar(db, { pessoaId: "almir" });
    assert.equal(regrasOp.regraPara(lista, "cartao", "2026-10-05").valor, "C6");
    assert.equal(regrasOp.regraPara(lista, "cartao", "2026-10-21").valor, "INTER");
    assert.equal(regrasOp.regraPara(lista, "cartao", "2026-08-01"), null);
    assert.equal(lista.find((r) => r.valor === "C6").ate, "2026-10-19");
});

test("placa pelo km: o km so aumenta; escolhe o veiculo logo abaixo", () => {
    const frota = [
        { placa: "OVN1505", leituras: [{ data: "2026-10-17", odometro: 273974 }] },
        { placa: "RBT2E25", leituras: [{ data: "2026-10-17", odometro: 175075 }] },
        { placa: "CQA6B42", leituras: [{ data: "2026-10-17", odometro: 458218 }] },
    ];
    assert.equal(regrasOp.veiculoPeloKm(frota, 274913, "2026-10-19").placa, "OVN1505");
    assert.equal(regrasOp.veiculoPeloKm(frota, 175400, "2026-10-19").placa, "RBT2E25");
    assert.equal(regrasOp.veiculoPeloKm(frota, 100000, "2026-10-19"), null);
    assert.ok(regrasOp.veiculoPeloKm([{ placa: "A", leituras: [{ data: "2026-10-17", odometro: 1000 }] }, { placa: "B", leituras: [{ data: "2026-10-17", odometro: 1100 }] }], 1200, "2026-10-19").ambiguo);
});

const OCR_SEM_PLACA = { data: "2026-10-19", valor: 143.64, litragem: 22.134, odometro: 274913, placa: null,
    itens: [{ descricao: "GASOLINA C COMUM", quantidade: 22.134, unidade: "L", valor_unitario: 6.49, valor_total: 143.64 }], texto_bruto: "GASOLINA 22,134 L x 6,49" };

test("abastecimento sem placa: deduz pela frota recente do operador e usa a regra de centro e cartao", () => {
    const frotaRecente = () => [{ placa: "OVN1505", leituras: [{ data: "2026-10-17", odometro: 273974 }] }, { placa: "CQA6B42", leituras: [{ data: "2026-10-17", odometro: 458218 }] }];
    const regrasOperador = [
        { id: 1, pessoa_id: "almir", campo: "centro", valor: centroAtivo.nome_oficial, desde: "2026-10-01", ate: null, ativa: 1 },
        { id: 2, pessoa_id: "almir", campo: "cartao", valor: "INTER", desde: "2026-10-01", ate: null, ativa: 1 },
    ];
    const previa = montarPrevia({ ocr: OCR_SEM_PLACA, legenda: { tipos: ["ABASTECIMENTO"] }, contexto: {}, identificacao: { pessoa: almir }, cad, frotaRecente, regrasOperador });
    assert.equal(previa.campos.abastecimento.placa.valor, "OVN1505");
    assert.equal(previa.campos.abastecimento.placa.origem, "deduzida_pelo_km");
    assert.match(previa.campos.descricao.valor, /od 274\.913 - OVN1505/);
    assert.equal(previa.campos.centro_custo.origem, "regra_do_operador");
    assert.equal(previa.campos.pagamento.cartao, "INTER");
    assert.equal(previa.campos.pagamento.origem, "regra_do_operador");
    assert.ok(!previa.pendencias.some((p) => /Projeto não informado|Cartão não informado|sem placa/i.test(p)), previa.pendencias.join(" | "));
});

test("sem placa e sem km: so sugere os veiculos do operador; o que a mensagem diz vence a regra", () => {
    const frotaRecente = () => [{ placa: "OVN1505", leituras: [] }];
    const regrasOperador = [{ id: 2, pessoa_id: "almir", campo: "cartao", valor: "INTER", desde: "2026-10-01", ate: null, ativa: 1 }];
    const previa = montarPrevia({ ocr: { ...OCR_SEM_PLACA, odometro: null }, legenda: { tipos: ["ABASTECIMENTO"], pagamento: { forma: "CARTAO_CREDITO", cartao: "C6", rotulo: "CRÉDITO C6" } },
        contexto: {}, identificacao: { pessoa: almir }, cad, frotaRecente, regrasOperador });
    assert.equal(previa.campos.abastecimento.placa.valor, null);
    assert.equal(previa.campos.abastecimento.placa.sugestao.valor, "OVN1505");
    assert.ok(previa.pendencias.some((p) => /Veículos de Almir nos últimos dias: OVN1505/.test(p)));
    assert.equal(previa.campos.pagamento.cartao, "C6");
    assert.ok(!previa.pendencias.some((p) => /diverge/.test(p)));
});

test("correcoes iguais repetidas viram proposta; regra invalida e recusada", () => {
    const correcoes = [
        { pessoa_id: "almir", campo: "cartao", valor: "C6", data: "2026-10-01", em: "2026-10-02T00:00", observacao: "c6" },
        { pessoa_id: "almir", campo: "cartao", valor: "INTER", data: "2026-10-19", em: "2026-10-20T00:00", observacao: "almir usa o inter" },
        { pessoa_id: "almir", campo: "cartao", valor: "INTER", data: "2026-10-18", em: "2026-10-21T00:00", observacao: "sempre inter" },
        { pessoa_id: "lorran", campo: "centro", valor: "X", data: "2026-10-18", em: "2026-10-21T00:00", observacao: "uma so" },
    ];
    const p = aprender.propostasDasCorrecoes(correcoes);
    assert.deepEqual(p.map((r) => [r.pessoa_id, r.campo, r.valor, r.desde, r.correcoes]), [["almir", "cartao", "INTER", "2026-10-18", 2]]);
    assert.match(aprender.validar(cad, { pessoa_id: "almir", campo: "centro", valor: "PROJETO QUE NAO EXISTE", desde: "2026-10-01" }).erro, /não está cadastrado/);
    assert.equal(aprender.validar(cad, { pessoa_id: "almir", campo: "cartao", valor: "inter", desde: "2026-10-01" }).valor, "INTER");
});

test("propor: junta IA e correcoes; IA fora do ar nao impede as propostas", async () => {
    const db = banco.abrir(":memory:");
    const t = "2026-10-21T10:00:00Z";
    const msg = Number(db.prepare("INSERT INTO mensagens (mensagem_id, grupo_id, remetente_id, pessoa_id, texto, tem_midia, enviada_em, registrada_em) VALUES ('m', 'g', 'r', 'almir', '', 1, ?, ?)").run(t, t).lastInsertRowid);
    for (const dia of ["2026-10-19", "2026-10-20"]) {
        const id = Number(db.prepare(`INSERT INTO despesas (mensagem_ref, estado, campos, pendencias, avisos, criado_em, atualizado_em)
            VALUES (?, 'AGUARDANDO_REVISAO', ?, '[]', '[]', ?, ?)`).run(msg, JSON.stringify({ data_competencia: { valor: dia } }), t, t).lastInsertRowid);
        db.prepare("INSERT INTO correcoes (despesa_id, campo, valor_anterior, valor_novo, tipo_erro, autor, em, observacao) VALUES (?, 'pagamento', 'null', '\"INTER\"', 'X', 'Yan', ?, 'almir usa o inter')")
            .run(id, new Date().toISOString());
    }
    const semIa = await aprender.propor(db, cad, { perguntar: async () => { throw new Error("limite"); } });
    assert.equal(semIa.aviso_ia, "limite");
    assert.deepEqual(semIa.propostas.map((r) => [r.pessoa_id, r.campo, r.valor, r.desde]), [["almir", "cartao", "INTER", "2026-10-19"]]);
    const comIa = await aprender.propor(db, cad, { perguntar: async () => JSON.stringify({ regras: [
        { pessoa_id: "almir", campo: "centro", valor: centroAtivo.nome_oficial, desde: "2026-10-20", motivo: "de agora em diante" },
        { pessoa_id: "fulano", campo: "cartao", valor: "INTER", desde: "2026-10-20" }] }) });
    assert.equal(comIa.propostas.length, 2);
    assert.equal(comIa.descartadas[0].pessoa_id, "fulano");
});
