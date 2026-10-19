"use strict";

// Filtro de periodo da lista de notas (dia / mes / ano / intervalo).

const test = require("node:test");
const assert = require("node:assert/strict");

const banco = require("../src/central/banco");
const revisao = require("../src/central/revisao");

function criar(db, data, recebida, valor) {
    const midia = db.prepare("INSERT INTO midias (sha256, arquivo, recebida_em, registrada_em) VALUES ('x', ?, ?, ?)")
        .run(`f${Math.random()}.jpg`, recebida, recebida);
    const campos = { data_competencia: { valor: data }, valor: { valor } };
    return Number(db.prepare(`INSERT INTO despesas (midia_id, estado, campos, pendencias, avisos, criado_em, atualizado_em)
        VALUES (?, 'APROVADO', ?, '[]', '[]', ?, ?)`).run(midia.lastInsertRowid, JSON.stringify(campos), recebida, recebida).lastInsertRowid);
}

test("filtra pela data da nota, por dia, mes e ano, e soma o valor", () => {
    const db = banco.abrir(":memory:");
    const a = criar(db, "2026-01-11", "2026-01-12T10:00:00Z", 10);
    const b = criar(db, "2026-01-31", "2026-02-02T10:00:00Z", 20.5);
    const c = criar(db, "2025-12-31", "2026-01-01T10:00:00Z", 5);
    const ids = (filtro) => revisao.listar(db, { aba: "aprovadas", ...filtro }).itens.map((i) => i.id).sort();
    assert.deepEqual(ids({ de: "2026-01-11", ate: "2026-01-11" }), [a]);
    assert.deepEqual(ids({ de: "2026-01-01", ate: "2026-01-31" }), [a, b]);
    assert.deepEqual(ids({ de: "2025-01-01", ate: "2025-12-31" }), [c]);
    assert.deepEqual(ids({}), [a, b, c]);
    const r = revisao.listar(db, { aba: "aprovadas", de: "2026-01-01", ate: "2026-01-31" });
    assert.deepEqual({ notas: r.periodo.notas, valor: r.periodo.valor }, { notas: 2, valor: 30.5 });
    assert.equal(revisao.listar(db, { aba: "aprovadas" }).periodo, null);
});

test("filtra pela data em que a foto chegou e ignora datas invalidas", () => {
    const db = banco.abrir(":memory:");
    const a = criar(db, "2026-01-31", "2026-02-02T10:00:00Z", 1);
    criar(db, "2026-02-02", "2026-03-01T10:00:00Z", 1);
    const r = revisao.listar(db, { aba: "aprovadas", de: "2026-02-01", ate: "2026-02-28", pela: "recebida" });
    assert.deepEqual(r.itens.map((i) => i.id), [a]);
    assert.equal(revisao.listar(db, { aba: "aprovadas", de: "2026-02' OR 1=1 --" }).itens.length, 2);
});
