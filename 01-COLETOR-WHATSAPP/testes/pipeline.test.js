"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const RAIZ = path.resolve(__dirname, "..");

// Stub do azure-ocr.js: evita chamada real (e o erro "nao configurado" quando
// nao ha credenciais no ambiente de teste). Precisa ser inserido no cache do
// require ANTES do pipeline.js ser carregado, pois ele desestrutura a funcao
// no momento do import.
const azureOcrPath = require.resolve(path.join(RAIZ, "src", "azure-ocr"));
require.cache[azureOcrPath] = {
    id: azureOcrPath,
    filename: azureOcrPath,
    loaded: true,
    exports: {
        analisarDocumento: async () => ({
            fornecedor: "Restaurante Teste Pipeline", cnpj: null, data: "2026-08-10", hora: null,
            valor: 48, valor_origem: "ocr", data_origem: "ocr", confianca: 0.99,
            texto_bruto: "", modelo: "prebuilt-receipt", resposta_bruta: {},
        }),
    },
};

const pipeline = require(path.join(RAIZ, "src", "pipeline"));

const PASTA_ENTRADA = path.join(RAIZ, "dados", "entrada");
const INDICE_PATH = path.join(RAIZ, "dados", "auditoria", "indice-duplicidade.json");

function pngMinusculo() {
    return Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
        "base64"
    );
}

function criarImagem(nomeBase, conteudo) {
    fs.mkdirSync(PASTA_ENTRADA, { recursive: true });
    const imagemPath = path.join(PASTA_ENTRADA, `${nomeBase}.png`);
    fs.writeFileSync(imagemPath, conteudo);
    const meta = {
        id_mensagem: `${nomeBase}-${crypto.randomUUID()}`,
        remetente: "teste-pipeline",
        legenda: "Tipo: Alimentacao\nCentro de custo: Nao Configurado",
        recebido_em_ms: Date.now(),
    };
    fs.writeFileSync(path.join(PASTA_ENTRADA, `${nomeBase}.json`), JSON.stringify(meta, null, 2), "utf8");
    return imagemPath;
}

function limparArtefatos(nomeBase) {
    for (const pasta of ["entrada", "simulacao", "revisao", "bloqueados", "erros", "auditoria", "ocr-bruto"]) {
        const dir = path.join(RAIZ, "dados", pasta);
        if (!fs.existsSync(dir)) continue;
        for (const arquivo of fs.readdirSync(dir)) {
            if (arquivo.startsWith(nomeBase)) fs.rmSync(path.join(dir, arquivo), { force: true });
        }
    }
}

async function comIndiceIsolado(fn) {
    const backup = fs.existsSync(INDICE_PATH) ? fs.readFileSync(INDICE_PATH, "utf8") : null;
    try {
        return await fn();
    } finally {
        if (backup === null) fs.rmSync(INDICE_PATH, { force: true });
        else fs.writeFileSync(INDICE_PATH, backup, "utf8");
    }
}

test("sem callback nenhum, o pipeline nunca dispara acao financeira", async () => {
    // Protecao critica: ferramentas de teste (testar_pipeline.js, reprocessar_ocr_salvo.js)
    // chamam o pipeline SEM callback. Se um dia o pipeline passar a agir sozinho,
    // rodar um teste criaria despesa de verdade no Conta Azul.
    await comIndiceIsolado(async () => {
        const nomeBase = `teste_pipeline_sem_callback_${Date.now()}`;
        const imagem = criarImagem(nomeBase, pngMinusculo());
        try {
            const resultado = await pipeline.processar(imagem, { modo: "simulacao" });
            assert.ok(resultado.validacoes, "processou normalmente");
            assert.equal(resultado.conta_azul.status, "NAO_ENVIADO", "nada foi enviado ao Conta Azul");
        } finally {
            limparArtefatos(nomeBase);
        }
    });
});

test("o callback recebe a auditoria completa para decidir o que fazer", async () => {
    // Quem decide (encaminhar ao Conta AI? lancar direto?) e o despachante em
    // coletor.js, lendo o config. O pipeline apenas avisa que terminou.
    await comIndiceIsolado(async () => {
        const nomeBase = `teste_pipeline_callback_${Date.now()}`;
        const imagem = criarImagem(nomeBase, pngMinusculo());
        try {
            let recebido = null;
            await pipeline.processar(imagem, { modo: "simulacao" }, async (caminho, auditoria) => { recebido = { caminho, auditoria }; });
            assert.ok(recebido, "o callback foi chamado");
            assert.ok(recebido.auditoria.validacoes, "recebeu as validacoes");
            assert.ok(recebido.auditoria.classificacao, "recebeu a classificacao");
            assert.ok(recebido.caminho.endsWith(".png"), "recebeu o caminho da imagem ja movida");
        } finally {
            limparArtefatos(nomeBase);
        }
    });
});

test("callback dispara para documento aprovado", async () => {
    await comIndiceIsolado(async () => {
        const nomeBase = `teste_pipeline_flag_on_${Date.now()}`;
        const imagem = criarImagem(nomeBase, pngMinusculo());
        try {
            let chamado = false;
            let argumentos = null;
            const resultado = await pipeline.processar(
                imagem,
                { modo: "simulacao" },
                async (...args) => { chamado = true; argumentos = args; }
            );
            assert.notEqual(resultado.validacoes.bloqueado, true);
            assert.equal(chamado, true);
            assert.equal(argumentos[1], resultado);
        } finally {
            limparArtefatos(nomeBase);
        }
    });
});

test("callback NUNCA dispara para documento bloqueado por duplicidade", async () => {
    await comIndiceIsolado(async () => {
        const nomeBaseA = `teste_pipeline_dup_a_${Date.now()}`;
        const nomeBaseB = `teste_pipeline_dup_b_${Date.now()}`;
        const conteudo = pngMinusculo();
        try {
            await pipeline.processar(criarImagem(nomeBaseA, conteudo), { modo: "simulacao" }, async () => {});
        } finally {
            limparArtefatos(nomeBaseA);
        }
        try {
            let chamado = false;
            const resultado = await pipeline.processar(
                criarImagem(nomeBaseB, conteudo),
                { modo: "simulacao" },
                async () => { chamado = true; }
            );
            assert.equal(resultado.validacoes.bloqueado, true);
            assert.equal(chamado, false);
        } finally {
            limparArtefatos(nomeBaseB);
        }
    });
});
