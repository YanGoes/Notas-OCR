"use strict";

// Ferramenta experimental para montar ou criar UMA despesa diretamente.
// Sem --enviar, apenas mostra o corpo. Mesmo com envio, a API publica nao
// vincula fornecedor, CNPJ, imagem, conta financeira ou baixa.
//
// node ferramentas/lancar_despesa.js --descricao "ALMOCO - 2 PESSOAS" \
//   --valor 84,00 --data 2026-08-07 --categoria <uuid> --centro-custo <uuid> \
//   --empresa <id-confirmado> [--enviar --confirmacao LANCAR_SEM_FORNECEDOR_E_ANEXO]

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

async function main() {
    const args = argumentos(process.argv.slice(2));
    const dados = {
        descricao: args.descricao,
        valor: args.valor,
        data: args.data,
        idCategoria: args.categoria,
        idCentroCusto: args["centro-custo"] || null,
    };
    const corpo = montarDespesa(dados);
    console.log("Corpo que seria enviado:\n" + JSON.stringify(corpo, null, 2));
    console.log("\nLIMITACAO: fornecedor, CNPJ, imagem, conta financeira e baixa nao sao vinculados por este POST.");

    if (!args.enviar) {
        console.log("\nNada foi enviado. O modo seguro padrao e apenas simulacao.");
        return;
    }
    if (!args.empresa) throw new Error("Informe --empresa com o ID confirmado no painel.");
    if (String(args.confirmacao || "").toUpperCase() !== "LANCAR_SEM_FORNECEDOR_E_ANEXO") {
        throw new Error("Confirme conscientemente com --confirmacao LANCAR_SEM_FORNECEDOR_E_ANEXO.");
    }

    const criado = await criarDespesa(dados, { empresaEsperadaId: args.empresa });
    if (!criado.protocolo) {
        throw new Error("O Conta Azul nao devolveu protocolo. Nao relance: confira o ERP para evitar duplicidade.");
    }
    console.log(`\nEnviado. protocolo=${criado.protocolo} status=${criado.status}`);
    console.log("PENDING nao significa criado. Conferindo valor, data, categoria e centro...");

    const check = await confirmarComEspera({
        data: corpo.data_competencia,
        descricao: corpo.descricao,
        valor: corpo.valor,
        protocolo: criado.protocolo,
        idCategoria: dados.idCategoria,
        idCentroCusto: dados.idCentroCusto,
    }, {
        aoTentar: (n, total, resultado) => {
            if (!resultado.confirmado) {
                console.log(`  tentativa ${n}/${total}: ainda nao confirmado (${resultado.encontrados_no_dia} no dia)`);
            }
        },
    });

    if (check.confirmado) {
        console.log(`\nCONFIRMADO na tentativa ${check.tentativas}.`);
        console.log(JSON.stringify(check.lancamento, null, 2));
        return;
    }
    console.error("\nCRIACAO INCERTA. Nao execute novamente.");
    console.error(`Procure manualmente pelo protocolo ${criado.protocolo} antes de qualquer nova acao.`);
    process.exitCode = 1;
}

main().catch((erro) => { console.error("Falhou:", erro.message); process.exitCode = 1; });
