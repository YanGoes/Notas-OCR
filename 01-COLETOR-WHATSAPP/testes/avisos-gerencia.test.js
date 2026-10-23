"use strict";

// Mensagens da gerencia lidas pela IA (falsa): mudanca vira aviso; confirmar grava a regra.

const test = require("node:test");
const assert = require("node:assert/strict");

const banco = require("../src/central/banco");
const cadastros = require("../src/central/cadastros");
const avisos = require("../src/central/avisos-gerencia");
const regrasOp = require("../src/central/regras-operador");

const cad = cadastros.carregar();

function mensagem(db, { pessoa = "vanessa", texto, grupo = "g1", tempo = new Date().toISOString(), id = Math.random() }) {
    return Number(db.prepare(`INSERT INTO mensagens (grupo_id, mensagem_id, remetente_id, pessoa_id, enviada_em, texto, tem_midia, registrada_em)
        VALUES (?, ?, 'r', ?, ?, ?, 0, ?)`).run(grupo, String(id), pessoa, tempo, texto, tempo).lastInsertRowid);
}

test("mensagem que muda projeto vira aviso; as outras nao; nao pergunta duas vezes", async () => {
    const db = banco.abrir(":memory:");
    mensagem(db, { texto: "A partir de amanhã o Almir vai pra Dutra Rio SP" });
    mensagem(db, { texto: "Boa tarde, favor mandar o km no comprovante" });
    mensagem(db, { pessoa: "almir", texto: "Despesas 19/10/2026 centro Dutra" });
    let perguntas = 0;
    const perguntar = async ({ texto }) => {
        perguntas += 1;
        const { mensagem: m } = JSON.parse(texto);
        if (/Dutra/.test(m.texto)) return JSON.stringify({ muda: true, regras: [{ pessoa_id: "almir", campo: "centro", valor: "Dutra Rio SP", desde: "2026-10-24", trecho: "o Almir vai pra Dutra" }] });
        return JSON.stringify({ muda: false, regras: [] });
    };
    const r = await avisos.analisarNovas(db, cad, { perguntar });
    assert.deepEqual(r, { analisadas: 2, avisos: 1, adiadas: 0 });
    assert.equal(perguntas, 2);
    await avisos.analisarNovas(db, cad, { perguntar });
    assert.equal(perguntas, 2);
    const [aviso] = avisos.pendentes(db, cad);
    assert.equal(aviso.regras[0].valor, "IMTRAFF - MOTIVA RIO/SP (FWD/ADE)");
    let regeradas = 0;
    const d = avisos.decidir(db, cad, aviso.id, { aceito: true, autor: "Yan", regenerar: () => { regeradas += 1; } });
    assert.equal(d.status, "CONFIRMADO");
    assert.equal(regrasOp.regraPara(regrasOp.listar(db, { pessoaId: "almir" }), "centro", "2026-10-25").valor, "IMTRAFF - MOTIVA RIO/SP (FWD/ADE)");
    assert.equal(avisos.pendentes(db, cad).length, 0);
    assert.throws(() => avisos.decidir(db, cad, aviso.id, { aceito: false, autor: "Yan", regenerar: () => {} }), /já foi confirmado/);
});

test("assinatura fora do ar: adia sem marcar a mensagem como lida", async () => {
    const db = banco.abrir(":memory:");
    mensagem(db, { texto: "Almir agora usa o cartão C6" });
    const r = await avisos.analisarNovas(db, cad, { perguntar: async () => { throw new Error("limite"); } });
    assert.equal(r.adiadas, 1);
    assert.equal(avisos.naoAnalisadas(db, cad).length, 1);
});

test("ignorar nao grava regra", async () => {
    const db = banco.abrir(":memory:");
    mensagem(db, { texto: "Almir agora usa o cartão C6" });
    await avisos.analisarNovas(db, cad, { perguntar: async () => JSON.stringify({ muda: true, regras: [{ pessoa_id: "almir", campo: "cartao", valor: "C6", desde: "2026-10-24" }] }) });
    const [aviso] = avisos.pendentes(db, cad);
    avisos.decidir(db, cad, aviso.id, { aceito: false, autor: "Yan", regenerar: () => {} });
    assert.equal(regrasOp.listar(db).length, 0);
});
