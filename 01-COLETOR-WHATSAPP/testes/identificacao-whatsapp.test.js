"use strict";

// Remetente do grupo (codigo interno @lid) reconhecido pelo telefone.
// Telefones ficticios.

const test = require("node:test");
const assert = require("node:assert/strict");

const banco = require("../src/central/banco");
const orquestrador = require("../src/central/orquestrador");
const revisao = require("../src/central/revisao");
const { jidTelefone, vincularPorTelefone, identificarDesconhecidos } = require("../src/central/identificacao-whatsapp");

const LID_LILIAN = "11112222333344@lid";
const LID_ESTRANHO = "99998888777766@lid";

function cenario() {
    const db = banco.abrir(":memory:");
    const cad = {
        pessoas: [
            { id: "lilian", nome: "Lilian", telefone: "5561900000005", papel: "OPERADOR", pasta_drive: "Lilian" },
            { id: "almir", nome: "Almir", telefone: "5511900000001", papel: "OPERADOR", pasta_drive: "Almir" },
        ],
        projetos: [], centros: [], veiculos: [], cartoes: [], categorias: [], fornecedores: { recorrentes: [] },
    };
    const foto = (remetente) => orquestrador.processarFoto(db, cad, {
        arquivo: `f-${Math.random()}.jpg`, sha256: `h-${Math.random()}`, hoje: new Date("2026-10-02T12:00:00Z"),
        brutoAzure: { analyzeResult: { content: "PADARIA\nTOTAL 20,00", documents: [{ fields: { Total: { type: "currency", valueCurrency: { amount: 20 } } } }] } },
        meta: { id_mensagem: `m-${Math.random()}`, id_grupo: "g@g.us", remetente, legenda: "Lanche", recebido_em_ms: Date.parse("2026-10-01T08:00:00Z") },
    }).despesas[0];
    return { db, cad, notaLilian: foto(LID_LILIAN), notaEstranho: foto(LID_ESTRANHO) };
}

test("telefone do WhatsApp sem o numero do aparelho", () => {
    assert.equal(jidTelefone("5561900000005:12@s.whatsapp.net"), "5561900000005@s.whatsapp.net");
    assert.equal(jidTelefone("11112222333344@lid"), null);
    assert.equal(jidTelefone(null), null);
});

test("remetente @lid com telefone do cadastro passa a ser a pessoa, e as previas sao refeitas", () => {
    const { db, cad, notaLilian } = cenario();
    assert.equal(revisao.listar(db, { aba: "revisar", cad, operador: "lilian" }).itens.length, 0);
    const vinculo = vincularPorTelefone(db, cad, LID_LILIAN, "5561900000005:3@s.whatsapp.net");
    assert.equal(vinculo.pessoa, "Lilian");
    assert.equal(vinculo.regeradas, 1);
    assert.deepEqual(revisao.listar(db, { aba: "revisar", cad, operador: "lilian" }).itens.map((i) => i.id), [notaLilian]);
    assert.equal(db.prepare("SELECT origem FROM remetentes_vinculados WHERE whatsapp_id = ?").get(LID_LILIAN).origem, "telefone_do_whatsapp");
    // Ja vinculado: nao refaz nada.
    assert.equal(vincularPorTelefone(db, cad, LID_LILIAN, "5561900000005@s.whatsapp.net"), null);
});

test("busca nos contatos: vincula quem tem telefone no cadastro e conta o resto", async () => {
    const { db, cad } = cenario();
    const telefones = { [LID_LILIAN]: "5561900000005@s.whatsapp.net", [LID_ESTRANHO]: "5599900000099@s.whatsapp.net" };
    const r = await identificarDesconhecidos(db, cad, async (lid) => telefones[lid] || null);
    assert.equal(r.verificados, 2);
    assert.deepEqual(r.vinculados.map((item) => item.pessoa), ["Lilian"]);
    assert.equal(r.fora_do_cadastro, 1, "telefone que nao e de ninguem do cadastro nao vira vinculo");
    assert.equal(revisao.remetentesNaoVinculados(db).length, 1);
});

test("sem telefone disponivel no WhatsApp nada e inventado", async () => {
    const { db, cad } = cenario();
    const r = await identificarDesconhecidos(db, cad, async () => null);
    assert.equal(r.sem_telefone, 2);
    assert.equal(r.vinculados.length, 0);
});
