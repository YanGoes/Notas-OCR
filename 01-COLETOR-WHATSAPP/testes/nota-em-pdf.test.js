"use strict";

// Nota que chega em PDF (18/11/2026): o WhatsApp entrega como documento, a
// Central mostra e le igual a foto, e o envio anexa o PDF no mesmo lugar.

const test = require("node:test");
const assert = require("node:assert/strict");

const { midiaDaNota } = require("../src/whatsapp-midia");
const drive = require("../src/central/arquivo-drive");
const anexo = require("../src/central/anexo-conta-azul");

test("PDF mandado como documento no WhatsApp e nota (com a legenda); planilha nao e", () => {
    const pdf = midiaDaNota({ documentWithCaptionMessage: { message: { documentMessage: { mimetype: "application/pdf", caption: "Almoço 2 pessoas", fileName: "nfce.pdf" } } } });
    assert.deepEqual(pdf, { caption: "Almoço 2 pessoas", fileName: "nfce.pdf", mimetype: "application/pdf" });
    assert.equal(midiaDaNota({ documentMessage: { mimetype: "application/pdf; charset=binary" } }).mimetype, "application/pdf");
    assert.equal(midiaDaNota({ ephemeralMessage: { message: { documentMessage: { mimetype: "image/JPEG" } } } }).mimetype, "image/jpeg", "foto enviada como arquivo tambem vale");
    assert.equal(midiaDaNota({ documentMessage: { mimetype: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" } }), null);
    assert.equal(midiaDaNota({ conversation: "oi" }), null);
    // Foto comum continua igual.
    const foto = { mimetype: "image/jpeg", caption: "x" };
    assert.equal(midiaDaNota({ imageMessage: foto }), foto);
});

test("no Drive e no anexo do Conta Azul o PDF continua PDF", async () => {
    assert.equal(drive.nomeDoArquivo([{ id: 601, tipo: "ALMOCO", valor: 134 }], "2026-11-18_x.pdf"), "#601 ALMOCO R$ 134,00.pdf");
    // O robo aceita .pdf (a recusa e so por arquivo inexistente, nao pelo formato).
    const robo = anexo.criarRobo({ perfil: "Z:\nao-existe" });
    const r = await robo.anexarArquivo("487e13c6-639e-4870-86f4-ee40784905df", { arquivo: "Z:\nao-existe\nota.pdf", nome: "#601 ALMOCO R$ 134,00.pdf" });
    assert.equal(r.erro, "foto não encontrada no programa");
});
