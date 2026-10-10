"use strict";

// Conexao com o WhatsApp: versao apresentada ao celular e reacao a cada queda.

const test = require("node:test");
const assert = require("node:assert/strict");
const { versaoWhatsAppWeb, diagnosticarQueda } = require("../src/whatsapp-conexao");

test("usa a versao do site do WhatsApp Web, nao a lista defasada da biblioteca", async () => {
    const baileys = {
        fetchLatestWaWebVersion: async () => ({ version: [2, 3000, 1049967817] }),
        fetchLatestBaileysVersion: async () => ({ version: [2, 3000, 1043857760] }),
    };
    const { versao, origem } = await versaoWhatsAppWeb(baileys);
    assert.deepEqual(versao, [2, 3000, 1049967817]);
    assert.equal(origem, "whatsapp_web");
});

test("sem acesso ao site, cai para a ultima versao boa ou a lista da biblioteca; nunca trava", async () => {
    const semSite = {
        fetchLatestWaWebVersion: async () => { throw new Error("offline"); },
        fetchLatestBaileysVersion: async () => ({ version: [2, 3000, 1] }),
    };
    const r1 = await versaoWhatsAppWeb(semSite);
    assert.ok(["ultima_que_funcionou", "lista_do_baileys"].includes(r1.origem));
    const nada = { fetchLatestWaWebVersion: () => new Promise(() => {}), fetchLatestBaileysVersion: () => new Promise(() => {}) };
    const inicio = Date.now();
    const r2 = await versaoWhatsAppWeb(nada, { tempoLimiteMs: 50 });
    assert.ok(Date.now() - inicio < 2000, "fonte pendurada nao trava a conexao");
    assert.ok(r2.origem);
});

test("cada motivo de queda vira a acao certa", () => {
    // Logo depois de ler o QR o WhatsApp pede reinicio: reconecta na hora.
    assert.equal(diagnosticarQueda(515, { registrado: true }).acao, "RECONECTAR_JA");
    // Vinculo recusado antes de registrar: QR novo e sessao limpa, com explicacao.
    const recusado = diagnosticarQueda(401, { registrado: false });
    assert.equal(recusado.acao, "NOVO_QR");
    assert.equal(recusado.limparSessao, true);
    assert.match(recusado.mensagem, /4 aparelhos/);
    // Aparelho removido pelo celular depois de conectado: para e pede Conectar.
    assert.equal(diagnosticarQueda(401, { registrado: true }).acao, "PARAR");
    // QR expirou sem leitura: QR novo, sem espera.
    assert.equal(diagnosticarQueda(408, { registrado: false, statusAnterior: "aguardando_qr" }).acao, "NOVO_QR");
    // Outra copia com a mesma sessao: para (nao fica brigando pela conexao).
    assert.equal(diagnosticarQueda(440, { registrado: true }).acao, "PARAR");
    // Sessao corrompida: descarta e gera QR novo.
    assert.deepEqual([diagnosticarQueda(500).acao, diagnosticarQueda(500).limparSessao], ["NOVO_QR", true]);
    // Saida pedida pela pessoa: para e limpa, sem mensagem de erro.
    assert.deepEqual(diagnosticarQueda(401, { saidaPedida: true }), { acao: "PARAR", limparSessao: true, mensagem: null });
    // Queda de rede comum: reconecta com espera crescente.
    assert.equal(diagnosticarQueda(428, { registrado: true }).acao, "RECONECTAR_COM_ESPERA");
});
