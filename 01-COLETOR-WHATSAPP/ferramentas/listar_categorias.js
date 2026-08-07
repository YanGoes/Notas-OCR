"use strict";

// Lista categorias e centros de custo do Conta Azul conectado e aponta quais nomes de
// configuracao/categorias.json ja existem la. Serve para preencher os ids sem chutar.

const fs = require("fs");
const path = require("path");
const { requisicao } = require("../src/conta-azul");

const RAIZ = path.resolve(__dirname, "..");
const normalizar = (texto) => String(texto || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();

function lista(resposta) {
    for (const chave of ["itens", "content", "dados", "data", "results"]) {
        if (Array.isArray(resposta?.[chave])) return resposta[chave];
    }
    return Array.isArray(resposta) ? resposta : [];
}

async function main() {
    const categorias = lista(await requisicao("/v1/categorias?tamanho_pagina=200"));
    const despesas = categorias.filter((c) => !c.tipo || String(c.tipo).toUpperCase() === "DESPESA");
    console.log(`Categorias no Conta Azul: ${categorias.length} (${despesas.length} de DESPESA)\n`);

    const locais = JSON.parse(fs.readFileSync(path.join(RAIZ, "configuracao", "categorias.json"), "utf8"));
    console.log("Confronto com configuracao/categorias.json:");
    for (const local of locais) {
        const achado = despesas.find((c) => normalizar(c.nome) === normalizar(local.nome));
        const situacao = achado ? `id ${achado.id}` : "NAO EXISTE no Conta Azul (categoria so se cria pelo ERP)";
        console.log(`  ${local.nome.padEnd(24)} ${situacao}`);
    }

    console.log("\nCategorias de despesa com 'refei', 'cafe', 'lanche' ou 'aliment' no nome:");
    for (const c of despesas.filter((x) => /refei|cafe|lanche|aliment|almoc|jantar/.test(normalizar(x.nome)))) {
        console.log(`  ${String(c.id).padEnd(38)} ${c.nome}`);
    }

    const centros = lista(await requisicao("/v1/centro-de-custo"));
    console.log(`\nCentros de custo: ${centros.length}`);
    for (const c of centros.slice(0, 40)) console.log(`  ${String(c.id).padEnd(38)} ${c.nome}`);
    if (!centros.length) console.log("  (vazio — criar com POST /v1/centro-de-custo {\"nome\": \"...\"})");
}

main().catch((erro) => { console.error("Falhou:", erro.message); process.exitCode = 1; });
