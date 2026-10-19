"use strict";

// Envia UMA despesa aprovada da Central para o Conta Azul de TESTE.
//   node ferramentas/enviar-teste-conta-azul.js --despesa 182            (so mostra o plano)
//   node ferramentas/enviar-teste-conta-azul.js --despesa 182 --executar (envia e confere)
// So funciona se a empresa conectada for config.central.envio_conta_azul.somente_empresa_id.

const banco = require("../src/central/banco");
const envio = require("../src/central/envio");
const api = require("../src/conta-azul");

function argumentos() {
    const opcoes = {};
    const lista = process.argv.slice(2);
    for (let i = 0; i < lista.length; i += 1) {
        const chave = lista[i].replace(/^--/, "");
        if (chave === "executar") opcoes.executar = true;
        else opcoes[chave] = lista[i + 1], i += 1;
    }
    return opcoes;
}

(async () => {
    const opcoes = argumentos();
    const id = Number(opcoes.despesa);
    if (!Number.isInteger(id) || id <= 0) throw new Error("Use --despesa <id>.");
    const db = banco.abrir();
    if (!opcoes.executar) {
        const plano = await envio.planejar(db, id, { api });
        console.log(`Empresa conectada: ${plano.empresa.id} (${plano.empresa.nome})`);
        console.log(`Foto: ${plano.foto || "não encontrada"} (não vai para o Conta Azul: a API não aceita anexo)`);
        console.log(`Fornecedor no Conta Azul: ${plano.fornecedor.nome} (achado pelo ${plano.fornecedor.por})`);
        console.log(`Conta financeira: ${plano.conta.nome}`);
        console.log("Dados aprovados:", JSON.stringify(plano.dados, null, 2));
        console.log(`Categoria no Conta Azul: ${plano.mapa.categoria?.nome?.trim() || "NÃO ENCONTRADA"}`);
        console.log(`Centro no Conta Azul: ${plano.mapa.centro?.nome || "NÃO ENCONTRADO"}`);
        for (const s of plano.mapa.substituicoes) console.log(`⚠ ${s}`);
        console.log("Será enviado:", JSON.stringify(envio.corpoDoLancamento(plano), null, 2));
        console.log("\nNada foi enviado. Repita com --executar para enviar.");
        return;
    }
    const relatorio = await envio.enviar(db, id, { api, autor: opcoes.autor || "terminal" });
    console.log(envio.relatorioEmTexto(relatorio));
})().catch((erro) => { console.error(`Erro: ${erro.message}`); process.exitCode = 1; });
