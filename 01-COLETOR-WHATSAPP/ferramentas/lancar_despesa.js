"use strict";

// Lanca UMA despesa no Conta Azul conectado e confere se ela existe de verdade.
// A API nao expoe DELETE: despesa errada so sai pela interface do ERP. Por isso o --confirmar
// (que so monta e mostra o JSON, sem enviar) e o padrao seguro para a primeira rodada.
//
//   node ferramentas/lancar_despesa.js --descricao "ALMOÇO - 2 PESSOAS" --valor 84,00 \
//        --data 2026-08-07 --categoria <uuid> [--centro-custo <uuid>] [--enviar]

const { montarDespesa, criarDespesa, confirmarComEspera } = require("../src/despesa-conta-azul");

function argumentos(lista) {
    const dados = {};
    for (let i = 0; i < lista.length; i += 1) {
        if (!lista[i].startsWith("--")) continue;
        const chave = lista[i].slice(2);
        const proximo = lista[i + 1];
        if (proximo === undefined || proximo.startsWith("--")) dados[chave] = true;
        else { dados[chave] = proximo; i += 1; }
    }
    return dados;
}

const esperar = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
    const args = argumentos(process.argv.slice(2));
    const dados = {
        descricao: args.descricao,
        valor: String(args.valor || "").replace(/\./g, "").replace(",", "."),
        data: args.data,
        idCategoria: args.categoria,
        idCentroCusto: args["centro-custo"] || null,
    };
    const corpo = montarDespesa(dados);
    console.log("Corpo que sera enviado:\n" + JSON.stringify(corpo, null, 2));

    if (!args.enviar) {
        console.log("\nNada foi enviado. Repita com --enviar para lancar de verdade.");
        return;
    }

    const criado = await criarDespesa(dados);
    console.log(`\nEnviado. protocolo=${criado.protocolo} status=${criado.status}`);
    console.log("Atencao: PENDING nao significa criado. Conferindo na busca...");

    const check = await confirmarComEspera(
        { data: corpo.data_competencia, descricao: corpo.descricao, valor: corpo.valor, protocolo: criado.protocolo },
        { aoTentar: (n, total, r) => { if (!r.confirmado) console.log(`  tentativa ${n}/${total}: ainda nao apareceu (${r.encontrados_no_dia} lancamentos no dia)`); } },
    );
    if (check.confirmado) {
        console.log(`\nCONFIRMADO pelo protocolo na tentativa ${check.tentativas}. A despesa existe no Conta Azul:`);
        console.log(JSON.stringify(check.lancamento, null, 2));
        return;
    }
    console.error("\nNAO CONFIRMADO depois de ~90 s. A requisicao foi aceita mas a despesa nao aparece na busca.");
    console.error("Pode ser id de categoria/centro de custo inexistente (a API descarta em silencio) OU fila ainda mais lenta.");
    console.error(`NAO RELANCE sem conferir a mao: protocolo ${criado.protocolo}. Sem DELETE na API, duplicata nao sai.`);
    process.exitCode = 1;
}

main().catch((erro) => { console.error("Falhou:", erro.message); process.exitCode = 1; });
