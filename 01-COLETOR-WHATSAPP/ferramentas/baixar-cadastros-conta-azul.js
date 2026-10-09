"use strict";

// Baixa do Conta Azul (SOMENTE LEITURA) as listas que os cadastros da Central
// usam: categorias de despesa, centros de custo e contas financeiras.
// Grava em dados/conta-azul/ (fora do Git). Nao cria nem altera nada la.
//
// Uso: node ferramentas/baixar-cadastros-conta-azul.js

const fs = require("fs");
const path = require("path");
const contaAzul = require("../src/conta-azul");

const DESTINO = path.resolve(__dirname, "..", "dados", "conta-azul");

function gravar(nome, dados) {
    fs.mkdirSync(DESTINO, { recursive: true });
    fs.writeFileSync(path.join(DESTINO, nome), `${JSON.stringify(dados, null, 2)}\n`, "utf8");
}

async function executar() {
    const empresa = await contaAzul.empresaConectada();
    const [categorias, centros, contas] = await Promise.all([
        contaAzul.listarCategoriasDespesa(), contaAzul.listarCentrosCusto(), contaAzul.listarContasFinanceiras(),
    ]);
    const baixadoEm = new Date().toISOString();
    gravar("categorias-despesa.json", categorias);
    gravar("centros-custo-ativos.json", centros);
    gravar("contas-financeiras.json", contas);
    gravar("ultimo-download.json", { baixado_em: baixadoEm, empresa: empresa?.nome || empresa?.razao_social || null,
        categorias: categorias.length, centros: centros.length, contas: contas.length });
    console.log(JSON.stringify({ empresa: empresa?.nome || empresa?.razao_social || null, categorias: categorias.length, centros: centros.length, contas: contas.length }, null, 2));
}

executar().catch((erro) => { console.error(`Falha: ${erro.message}`); process.exit(1); });
