"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { arquivar, caminhoDeDestino, pastaDoOperador, dataDeArquivo } = require("../src/arquivo-drive");

// Pastas que existem de verdade no Drive da empresa
const PASTAS = ["Almir", "Cláudio", "Daniel", "Emerson", "Everson", "Hugo",
    "Kelvyn", "Lilian", "Murillo", "Ribeiro", "Rodrigo", "Vitor", "Vitor Ponce"];

function opcoes(raiz) {
    return { habilitado: true, raiz, modelo_pasta_ano: "Despesas de Campo {ano}", usar_data_da_nota: true, operadores: {} };
}

function auditoria({ nome = "Emerson Silva", remetente = "123@lid", data = "2026-04-27", arquivo = "nota.jpg" } = {}) {
    return {
        operador: { remetente, remetente_nome: nome },
        ocr: { data },
        arquivo_imagem: arquivo,
        recebido_em: "2026-08-13T18:00:00.000Z",
    };
}

// ---------------------------------------------------------------------------
// Estrutura de pastas
// ---------------------------------------------------------------------------

test("monta o caminho no padrao da empresa: ano / despesas / operador / mes.ano / dia", () => {
    const r = caminhoDeDestino(auditoria(), opcoes("G:\\Drive"), PASTAS);
    assert.equal(r.destino, path.join("G:\\Drive", "2026", "Despesas de Campo 2026", "Emerson", "04.26", "27"));
    assert.equal(r.mesAno, "04.26");
    assert.equal(r.dia, "27");
});

test("nome composto nao cai na pasta do primeiro nome", () => {
    // Existem "Vitor" e "Vitor Ponce": cada um tem que ir para a sua pasta.
    assert.equal(pastaDoOperador(auditoria({ nome: "Vitor Ponce" }), {}, PASTAS).pasta, "Vitor Ponce");
    assert.equal(pastaDoOperador(auditoria({ nome: "Vitor" }), {}, PASTAS).pasta, "Vitor");
    assert.equal(pastaDoOperador(auditoria({ nome: "Vitor Ponce Ferreira" }), {}, PASTAS).pasta, "Vitor Ponce");
});

test("acento no nome nao impede achar a pasta", () => {
    assert.equal(pastaDoOperador(auditoria({ nome: "Claudio" }), {}, PASTAS).pasta, "Cláudio");
    assert.equal(pastaDoOperador(auditoria({ nome: "Cláudio Souza" }), {}, PASTAS).pasta, "Cláudio");
});

test("mapeamento manual por remetente vence o nome do WhatsApp", () => {
    const r = pastaDoOperador(
        auditoria({ nome: "Ze da Silva", remetente: "999@lid" }),
        { operadores: { "999@lid": "Rodrigo" } },
        PASTAS
    );
    assert.equal(r.pasta, "Rodrigo");
    assert.equal(r.origem, "mapeamento");
});

test("operador desconhecido ganha pasta propria em vez de se perder", () => {
    const r = pastaDoOperador(auditoria({ nome: "Funcionario Novo" }), {}, PASTAS);
    assert.equal(r.pasta, "Funcionario Novo");
    assert.equal(r.origem, "nome_whatsapp_novo");
});

test("sem nenhuma identificacao, vai para a pasta de nao identificados", () => {
    const r = pastaDoOperador({ operador: {} }, { pasta_nao_identificado: "Nao identificado" }, PASTAS);
    assert.equal(r.pasta, "Nao identificado");
});

// ---------------------------------------------------------------------------
// Data que organiza as pastas
// ---------------------------------------------------------------------------

test("usa a data da nota, nao a data em que a foto chegou", () => {
    const r = dataDeArquivo(auditoria({ data: "2025-11-28" }), { usar_data_da_nota: true });
    assert.deepEqual([r.ano, r.mes, r.dia], ["2025", "11", "28"]);
    assert.equal(r.origem, "data_da_nota");
});

test("nota sem data legivel cai na data de recebimento", () => {
    const r = dataDeArquivo(auditoria({ data: null }), { usar_data_da_nota: true });
    assert.equal(r.origem, "data_de_recebimento");
    assert.equal(r.ano, "2026");
});

// ---------------------------------------------------------------------------
// Copia de verdade
// ---------------------------------------------------------------------------

function prepararDrive(raiz, ano = "2026") {
    // Cria as pastas dos operadores como existem no Drive real
    for (const nome of PASTAS) {
        fs.mkdirSync(path.join(raiz, ano, `Despesas de Campo ${ano}`, nome), { recursive: true });
    }
}

test("copia a foto para a pasta certa sem mexer no original", () => {
    const raiz = fs.mkdtempSync(path.join(os.tmpdir(), "drive-teste-"));
    prepararDrive(raiz);
    const origem = path.join(raiz, "origem.jpg");
    fs.writeFileSync(origem, "conteudo-da-foto");
    try {
        const r = arquivar(origem, auditoria(), opcoes(raiz));
        assert.equal(r.arquivado, true);
        assert.ok(fs.existsSync(r.destino), "arquivo chegou ao destino");
        assert.ok(fs.existsSync(origem), "o original continua onde estava");
        assert.deepEqual(r.destino.split(path.sep).slice(-6), ["2026", "Despesas de Campo 2026", "Emerson", "04.26", "27", "nota.jpg"]);
    } finally { fs.rmSync(raiz, { recursive: true, force: true }); }
});

test("arquivar duas vezes a mesma foto nao duplica", () => {
    const raiz = fs.mkdtempSync(path.join(os.tmpdir(), "drive-teste-"));
    prepararDrive(raiz);
    const origem = path.join(raiz, "origem.jpg");
    fs.writeFileSync(origem, "conteudo-da-foto");
    try {
        const primeira = arquivar(origem, auditoria(), opcoes(raiz));
        const segunda = arquivar(origem, auditoria(), opcoes(raiz));
        assert.equal(segunda.jaExistia, true);
        assert.equal(fs.readdirSync(path.dirname(primeira.destino)).length, 1);
    } finally { fs.rmSync(raiz, { recursive: true, force: true }); }
});

test("Drive fora do ar nao derruba o fluxo, so avisa", () => {
    const raiz = path.join(os.tmpdir(), "drive-que-nao-existe-" + Date.now());
    const origem = path.join(os.tmpdir(), `foto-${Date.now()}.jpg`);
    fs.writeFileSync(origem, "x");
    try {
        const r = arquivar(origem, auditoria(), opcoes(raiz));
        assert.equal(r.arquivado, false);
        assert.match(r.erro, /Drive/i);
    } finally { fs.rmSync(origem, { force: true }); }
});

test("desligado no config nao copia nada", () => {
    const r = arquivar("qualquer.jpg", auditoria(), { habilitado: false });
    assert.equal(r.arquivado, false);
    assert.equal(r.motivo, "desligado");
});

test("na virada de ano, mantem a convencao de nomes do ano anterior", () => {
    const raiz = fs.mkdtempSync(path.join(os.tmpdir(), "drive-teste-"));
    // So 2026 existe; a nota e de 2027, cuja pasta ainda nao foi criada.
    for (const nome of PASTAS) {
        fs.mkdirSync(path.join(raiz, "2026", "Despesas de Campo 2026", nome), { recursive: true });
    }
    const origem = path.join(raiz, "origem.jpg");
    fs.writeFileSync(origem, "x");
    try {
        const r = arquivar(origem, auditoria({ nome: "Emerson Silva", data: "2027-01-08" }), opcoes(raiz));
        assert.equal(r.arquivado, true);
        assert.equal(r.operador, "Emerson", "usou a convencao do ano anterior, nao criou 'Emerson Silva'");
        // Compara por partes do caminho, para nao depender do separador do sistema
        assert.deepEqual(r.destino.split(path.sep).slice(-6), ["2027", "Despesas de Campo 2027", "Emerson", "01.27", "08", "nota.jpg"]);
    } finally { fs.rmSync(raiz, { recursive: true, force: true }); }
});
