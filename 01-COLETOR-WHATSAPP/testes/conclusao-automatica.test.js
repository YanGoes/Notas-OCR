"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const RAIZ = path.resolve(__dirname, "..");
const enriquecedor = require("../src/enriquecedor-conta-azul");
const notificacoes = require("../src/notificacoes");
const { concluirDocumento, pendenciasLocais, montarNotificacao } = require("../src/conclusao-automatica");

const PASTA_AUDITORIA = path.join(RAIZ, "dados", "auditoria");

// concluirDocumento() grava avisos de verdade; o teste nao pode sujar o
// historico real do operador. Guarda o arquivo antes e restaura no fim.
let backupNotificacoes = null;
test.before(() => {
    backupNotificacoes = fs.existsSync(notificacoes.ARQUIVO) ? fs.readFileSync(notificacoes.ARQUIVO, "utf8") : null;
});
test.after(() => {
    if (backupNotificacoes === null) fs.rmSync(notificacoes.ARQUIVO, { force: true });
    else fs.writeFileSync(notificacoes.ARQUIVO, backupNotificacoes, "utf8");
});

function auditoriaBase(extra = {}) {
    return {
        arquivo_imagem: "nota.jpg",
        ocr: { fornecedor: "PANIFICADORA TESTE", valor: 48, data: "2026-08-10", cnpj: "12345678000199" },
        classificacao: {
            tipo: "alimentacao",
            categoria_nome: "ALIMENTACAO EM CAMPO", categoria_id: "cat-uuid",
            centro_custo_nome: "PROJETO EXEMPLO", centro_custo_id: "centro-uuid",
        },
        forma_pagamento: { codigo: "PIX", origem: "comprovante_campo_fiscal", candidatos: ["PIX"] },
        validacoes: { bloqueado: false, revisao_necessaria: false, motivos: [] },
        ...extra,
    };
}

function escreverAuditoria(base, auditoria) {
    fs.mkdirSync(PASTA_AUDITORIA, { recursive: true });
    fs.writeFileSync(path.join(PASTA_AUDITORIA, `${base}.json`), JSON.stringify(auditoria, null, 2), "utf8");
}

function limpar(base) {
    fs.rmSync(path.join(PASTA_AUDITORIA, `${base}.json`), { force: true });
}

async function comEnriquecedorFalso(implementacao, fn) {
    const original = enriquecedor.enriquecer;
    enriquecedor.enriquecer = implementacao;
    try { return await fn(); } finally { enriquecedor.enriquecer = original; }
}

const semLog = () => {};

test("documento bloqueado nunca e concluido automaticamente", async () => {
    const base = `teste_conclusao_bloqueado_${Date.now()}`;
    escreverAuditoria(base, auditoriaBase({
        validacoes: { bloqueado: true, revisao_necessaria: false, motivos: ["Possivel documento duplicado."] },
    }));
    try {
        let chamou = false;
        await comEnriquecedorFalso(async () => { chamou = true; return { sucesso: true, etapas: {}, pendencias: [] }; }, async () => {
            const resultado = await concluirDocumento(base, { log: semLog });
            assert.equal(resultado.executado, false);
            assert.equal(resultado.motivo, "documento_bloqueado");
        });
        assert.equal(chamou, false, "o enriquecedor nao pode ser chamado para documento bloqueado");
    } finally { limpar(base); }
});

test("documento ja concluido nao e processado de novo", async () => {
    const base = `teste_conclusao_repetido_${Date.now()}`;
    escreverAuditoria(base, auditoriaBase({
        conclusao_automatica: { status: "CONCLUIDO", em: new Date().toISOString() },
    }));
    try {
        let chamou = false;
        await comEnriquecedorFalso(async () => { chamou = true; return { sucesso: true, etapas: {}, pendencias: [] }; }, async () => {
            const resultado = await concluirDocumento(base, { log: semLog });
            assert.equal(resultado.executado, false);
            assert.equal(resultado.motivo, "ja_concluido");
        });
        assert.equal(chamou, false);
    } finally { limpar(base); }
});

test("sem valor ou data lidos com seguranca, avisa e nao chama a API", async () => {
    const base = `teste_conclusao_sem_valor_${Date.now()}`;
    escreverAuditoria(base, auditoriaBase({ ocr: { fornecedor: "X", valor: null, data: null } }));
    try {
        let chamou = false;
        let notificacao = null;
        await comEnriquecedorFalso(async () => { chamou = true; return { sucesso: true, etapas: {}, pendencias: [] }; }, async () => {
            const resultado = await concluirDocumento(base, { log: semLog, notificar: async (texto) => { notificacao = texto; } });
            assert.equal(resultado.executado, false);
            assert.equal(resultado.motivo, "sem_valor_ou_data");
        });
        assert.equal(chamou, false);
        assert.match(notificacao, /Valor ou data nao foram lidos/i);
    } finally { limpar(base); }
});

test("conclui, grava o resultado na auditoria e notifica o operador", async () => {
    const base = `teste_conclusao_ok_${Date.now()}`;
    escreverAuditoria(base, auditoriaBase());
    try {
        let contextoRecebido = null;
        let notificacao = null;
        await comEnriquecedorFalso(async (valor, data, contexto) => {
            contextoRecebido = { valor, data, contexto };
            return {
                sucesso: true,
                etapas: { lancamento: { id: "evento-1" }, parcela: { id: "parcela-1" }, campos_mantidos: { categoria: true, centro_custo: false, metodo_pagamento: false } },
                pendencias: [],
            };
        }, async () => {
            const resultado = await concluirDocumento(base, { simular: false, log: semLog, notificar: async (t) => { notificacao = t; } });
            assert.equal(resultado.executado, true);
        });

        // reaproveita os UUIDs ja resolvidos pelo pipeline
        assert.equal(contextoRecebido.contexto.categoriaId, "cat-uuid");
        assert.equal(contextoRecebido.contexto.centroCustoId, "centro-uuid");
        assert.equal(contextoRecebido.contexto.metodoPagamento, "PIX");
        assert.equal(contextoRecebido.valor, 48);

        const gravado = JSON.parse(fs.readFileSync(path.join(PASTA_AUDITORIA, `${base}.json`), "utf8"));
        assert.equal(gravado.conclusao_automatica.status, "CONCLUIDO");
        assert.equal(gravado.conclusao_automatica.lancamento_id, "evento-1");
        assert.match(notificacao, /Despesa completa no Conta Azul/i);
        assert.match(notificacao, /PANIFICADORA TESTE/);
    } finally { limpar(base); }
});

test("modo simulacao deixa claro que nada foi alterado", async () => {
    const base = `teste_conclusao_simulado_${Date.now()}`;
    escreverAuditoria(base, auditoriaBase());
    try {
        let notificacao = null;
        await comEnriquecedorFalso(async () => ({ sucesso: true, etapas: {}, pendencias: [] }), async () => {
            await concluirDocumento(base, { simular: true, log: semLog, notificar: async (t) => { notificacao = t; } });
        });
        assert.match(notificacao, /simulacao/i);
        assert.match(notificacao, /nada foi alterado/i);
    } finally { limpar(base); }
});

test("lista pendencias acionaveis quando falta centro de custo e forma de pagamento", () => {
    const pendencias = pendenciasLocais(auditoriaBase({
        classificacao: { tipo: "alimentacao", categoria_id: "cat-uuid", categoria_nome: "X" },
        forma_pagamento: { codigo: null, candidatos: ["DINHEIRO", "CARTAO_CREDITO"] },
    }));
    assert.equal(pendencias.length, 2);
    assert.match(pendencias[0], /#centro NOME DO PROJETO/);
    assert.match(pendencias[1], /dinheiro ou cartao de credito/i);
});

test("avisa quando o centro de custo nao pode ser aplicado pela API", () => {
    const texto = montarNotificacao({
        auditoria: auditoriaBase(),
        resultado: { sucesso: true, etapas: {}, pendencias: ["centro_de_custo_nao_aplicado_via_api"] },
        pendencias: [],
        simulado: false,
    });
    assert.match(texto, /centro de custo precisa ser ajustado na tela do Conta Azul/i);
});
