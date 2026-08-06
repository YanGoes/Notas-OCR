"use strict";

// Processa as fotos de UM dia: le a legenda, manda o cupom para a Azure,
// classifica e mostra o que deu certo e o que nao deu, com o motivo.
// Nao lanca nada no Conta Azul: e a etapa de conferencia.
//
// Uso:  npm run processar-dia            (pergunta o dia)
//       npm run processar-dia -- 06/08/2026

const fs = require("fs");
const path = require("path");
const readline = require("readline/promises");
const { stdin, stdout } = require("process");
const { interpretar, interpretarCabecalho, dataISO } = require("../src/legenda");
const classificador = require("../src/classificador");
const { lerCupom } = require("../src/azure-ocr");

const RAIZ = path.resolve(__dirname, "..");
const CONFIG = JSON.parse(fs.readFileSync(path.join(RAIZ, "config.json"), "utf8"));
const PASTA = path.isAbsolute(CONFIG.pasta_saida)
    ? CONFIG.pasta_saida : path.join(RAIZ, CONFIG.pasta_saida);
const PASTA_RELATORIOS = path.join(RAIZ, "relatorios");

const IMAGENS = /\.(jpe?g|png|bmp)$/i;

function lerMetadados() {
    if (!fs.existsSync(PASTA)) return [];
    return fs.readdirSync(PASTA)
        .filter((nome) => IMAGENS.test(nome))
        .map((nome) => {
            const imagem = path.join(PASTA, nome);
            const jsonPath = imagem.replace(/\.[^.]+$/, ".json");
            if (!fs.existsSync(jsonPath)) return { imagem, nome, erro: "sem arquivo .json de metadados" };
            try {
                const meta = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
                return { imagem, nome, meta, dia: (meta.data || "").slice(0, 10) };
            } catch (erro) {
                return { imagem, nome, erro: `metadados ilegiveis: ${erro.message}` };
            }
        });
}

// A data no .json vem como "30/07/2026, 19:48:27".
function diaDoRegistro(registro) {
    return dataISO(registro.meta?.data) || null;
}

async function perguntarDia(disponiveis) {
    console.log("\nDias com fotos baixadas:");
    for (const [dia, quantidade] of disponiveis) {
        const [a, m, d] = dia.split("-");
        console.log(`   ${d}/${m}/${a}   ${quantidade} foto(s)`);
    }
    const terminal = readline.createInterface({ input: stdin, output: stdout });
    const resposta = (await terminal.question("\nQual dia quer processar? (DD/MM/AAAA)  ")).trim();
    terminal.close();
    return dataISO(resposta);
}

async function processar(registro, contexto) {
    const nome = registro.nome;
    const legenda = String(registro.meta?.legenda || "");

    const despesa = interpretar(legenda, contexto);
    if (!despesa.ok) return { nome, ok: false, etapa: "legenda", motivo: despesa.motivo, legenda };

    let cupom = null;
    try {
        cupom = await lerCupom(registro.imagem);
    } catch (erro) {
        return { nome, ok: false, etapa: "azure", motivo: erro.message, despesa };
    }

    const classificacao = classificador.classificar(despesa);
    if (!classificacao.ok) {
        return { nome, ok: false, etapa: "classificacao", motivo: classificacao.motivo, despesa, cupom };
    }

    // O valor digitado pelo operador e o valor lido no cupom precisam bater.
    const divergencia = (cupom.valor != null && Math.abs(cupom.valor - despesa.valor) > 0.005)
        ? { legenda: despesa.valor, cupom: cupom.valor }
        : null;

    return { nome, ok: true, despesa, cupom, classificacao, divergencia };
}

function imprimirResultado(r) {
    if (!r.ok) {
        console.log(`\n  [FALHOU] ${r.nome}`);
        console.log(`     etapa: ${r.etapa}`);
        console.log(`     motivo: ${r.motivo}`);
        if (r.legenda) console.log(`     legenda recebida: ${JSON.stringify(r.legenda.split("\n")[0] || "(vazia)")}`);
        return;
    }
    console.log(`\n  [OK] ${r.nome}`);
    console.log(`     ${r.classificacao.categoria.nome}  //  ${r.classificacao.centro_de_custo.nome}`);
    console.log(`     legenda: R$ ${r.despesa.valor.toFixed(2)}  em ${r.despesa.data}`);
    console.log(`     cupom:   R$ ${r.cupom.valor != null ? r.cupom.valor.toFixed(2) : "?"}  ${r.cupom.fornecedor || "(fornecedor nao lido)"}${r.cupom.cnpj ? `  CNPJ ${r.cupom.cnpj}` : ""}`);
    if (r.divergencia) {
        console.log(`     >>> DIVERGENCIA: legenda diz R$ ${r.divergencia.legenda.toFixed(2)}, cupom diz R$ ${r.divergencia.cupom.toFixed(2)}`);
    }
}

async function principal() {
    const registros = lerMetadados();
    if (registros.length === 0) {
        console.log(`\nNenhuma foto em ${PASTA}.`);
        console.log("Ligue o coletor (npm start) e mande as fotos no grupo.");
        return;
    }

    const porDia = new Map();
    for (const r of registros) {
        const dia = diaDoRegistro(r);
        if (!dia) continue;
        porDia.set(dia, (porDia.get(dia) || 0) + 1);
    }
    const disponiveis = [...porDia.entries()].sort();

    const argumento = process.argv[2];
    const dia = argumento ? dataISO(argumento) : await perguntarDia(disponiveis);
    if (!dia) { console.error("Data invalida. Use DD/MM/AAAA."); process.exitCode = 1; return; }

    const doDia = registros.filter((r) => diaDoRegistro(r) === dia);
    if (doDia.length === 0) {
        console.log(`\nNenhuma foto em ${dia}. Dias disponiveis: ${disponiveis.map(([d]) => d).join(", ") || "(nenhum)"}`);
        return;
    }

    console.log(`\n==============================================`);
    console.log(`  PROCESSANDO ${dia} — ${doDia.length} foto(s)`);
    console.log(`==============================================`);

    await classificador.carregarIndices();

    // O cabecalho do dia, se veio como legenda de alguma foto, vale para as demais.
    let contexto = {};
    for (const r of doDia) {
        const cab = interpretarCabecalho(r.meta?.legenda || "");
        if (cab) {
            contexto = { data: cab.data, centro_de_custo: cab.centro_de_custo, cartao: cab.cartao };
            console.log(`\nCabecalho do dia encontrado: centro de custo "${cab.centro_de_custo}", cartao "${cab.cartao}".`);
        }
    }
    if (!contexto.centro_de_custo) {
        console.log(`\nAviso: nenhum cabecalho "DESPESAS DO DIA" encontrado. Sem centro de custo, as despesas serao recusadas.`);
    }

    const resultados = [];
    for (const registro of doDia) {
        if (registro.erro) {
            const r = { nome: registro.nome, ok: false, etapa: "arquivo", motivo: registro.erro };
            resultados.push(r); imprimirResultado(r); continue;
        }
        const r = await processar(registro, contexto);
        resultados.push(r);
        imprimirResultado(r);
    }

    const ok = resultados.filter((r) => r.ok);
    const falhas = resultados.filter((r) => !r.ok);
    const divergentes = ok.filter((r) => r.divergencia);

    console.log(`\n==============================================`);
    console.log(`  RESUMO DE ${dia}`);
    console.log(`==============================================`);
    console.log(`  prontas para lancar: ${ok.length - divergentes.length}`);
    console.log(`  com divergencia de valor: ${divergentes.length}`);
    console.log(`  falharam: ${falhas.length}`);
    if (falhas.length) {
        console.log(`\n  O que nao deu para processar:`);
        for (const f of falhas) console.log(`    - ${f.nome}\n        ${f.motivo}`);
    }

    fs.mkdirSync(PASTA_RELATORIOS, { recursive: true });
    const destino = path.join(PASTA_RELATORIOS, `${dia}.json`);
    fs.writeFileSync(destino, JSON.stringify({
        dia,
        gerado_em: new Date().toISOString(),
        contexto,
        total: resultados.length,
        prontas: ok.length - divergentes.length,
        divergentes: divergentes.length,
        falhas: falhas.length,
        resultados: resultados.map((r) => ({ ...r, cupom: r.cupom ? { ...r.cupom, texto_bruto: undefined } : undefined })),
    }, null, 2), "utf8");
    console.log(`\n  Relatorio salvo em: ${destino}`);
}

principal().catch((erro) => {
    console.error("\nFalha:", erro?.message || erro);
    process.exitCode = 1;
});
