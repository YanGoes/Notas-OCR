"use strict";

// Cadastro de projetos/centros de custo pela Central (pasta temporaria, banco em memoria).

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const banco = require("../src/central/banco");
const cadastros = require("../src/central/cadastros");
const admin = require("../src/central/projetos-admin");

function ambiente({ projetos = [], centros = [] } = {}) {
    const pasta = fs.mkdtempSync(path.join(os.tmpdir(), "central-projetos-"));
    fs.writeFileSync(path.join(pasta, "projetos.json"), JSON.stringify({ _leia_me: "teste", projetos }, null, 2));
    fs.writeFileSync(path.join(pasta, "centros_custo.json"), JSON.stringify(centros));
    const db = banco.abrir(":memory:");
    return { pasta, db, ler: () => JSON.parse(fs.readFileSync(path.join(pasta, "projetos.json"), "utf8")), fim: () => fs.rmSync(pasta, { recursive: true, force: true }) };
}

test("cadastra projeto novo, grava no arquivo e registra quem fez", () => {
    const amb = ambiente({ centros: [{ nome: "HOUER MT - ROTA DO PEQUI", id: "id-pequi" }] });
    try {
        admin.criar(amb.db, { nome_oficial: " Rota  do Pequi ", busca_centro_conta_azul: "rota do pequi", ativo: true, servico: "iri", apelidos: ["Pequi", "pequi", ""] }, "Yan", { pasta: amb.pasta });
        const [gravado] = amb.ler().projetos;
        assert.equal(gravado.nome_oficial, "Rota do Pequi");
        assert.equal(gravado.servico, "IRI");
        assert.deepEqual(gravado.apelidos, ["Pequi"]);
        assert.equal(amb.ler()._leia_me, "teste", "o restante do arquivo e preservado");
        // Ja vale para a resolucao, sem reiniciar nada.
        const resolvido = cadastros.resolverProjeto(cadastros.carregar(amb.pasta), "Pequi");
        assert.equal(resolvido.projeto.id_conta_azul, "id-pequi");
        const [log] = admin.historico(amb.db);
        assert.equal(log.autor, "Yan");
        assert.equal(log.acao, "CRIADO");
    } finally { amb.fim(); }
});

test("exige autor e nome, e recusa campo desconhecido", () => {
    const amb = ambiente();
    try {
        assert.throws(() => admin.criar(amb.db, { nome_oficial: "X" }, "", { pasta: amb.pasta }), /quem está alterando/);
        assert.throws(() => admin.criar(amb.db, { nome_oficial: "  " }, "Yan", { pasta: amb.pasta }), /nome do projeto/);
        assert.throws(() => admin.criar(amb.db, { nome_oficial: "X", id_conta_azul: "forjado" }, "Yan", { pasta: amb.pasta }), /não editável/);
        assert.throws(() => admin.criar(amb.db, { nome_oficial: "X", id_sistema_projetos: "4a" }, "Yan", { pasta: amb.pasta }), /número/);
        assert.equal(amb.ler().projetos.length, 0);
    } finally { amb.fim(); }
});

test("um nome ou apelido nao pode apontar para dois projetos", () => {
    const amb = ambiente({ projetos: [{ nome_oficial: "DYNA GOINFRA CICLO III - FWD", apelidos: ["GOINFRA FWD"], ativo: false }] });
    try {
        assert.throws(() => admin.criar(amb.db, { nome_oficial: "Outro", apelidos: ["goinfra fwd"] }, "Yan", { pasta: amb.pasta }),
            /já é usado pelo projeto "DYNA GOINFRA CICLO III - FWD"/);
        assert.equal(amb.ler().projetos.length, 1, "nada gravado quando ha conflito");
        assert.equal(admin.historico(amb.db).length, 0);
    } finally { amb.fim(); }
});

test("editar ativa o projeto e renomear guarda o nome antigo como apelido", () => {
    const amb = ambiente({ projetos: [{ nome_oficial: "Projeto Velho", ativo: null, apelidos: [] }] });
    try {
        admin.editar(amb.db, "projeto velho", { nome_oficial: "Projeto Novo", ativo: true }, "Yan", { pasta: amb.pasta });
        const [gravado] = amb.ler().projetos;
        assert.equal(gravado.nome_oficial, "Projeto Novo");
        assert.equal(gravado.ativo, true);
        assert.deepEqual(gravado.apelidos, ["Projeto Velho"]);
        assert.equal(cadastros.resolverProjeto(cadastros.carregar(amb.pasta), "Projeto Velho").status, "RESOLVIDO");
        assert.equal(admin.historico(amb.db)[0].antes.nome_oficial, "Projeto Velho");
    } finally { amb.fim(); }
});

test("centro novo vindo da sincronizacao e confirmado e passa a fazer parte do cadastro", () => {
    const amb = ambiente({ centros: [{ nome: "IMTRAFF NOVO - GO", id: "id-novo" }] });
    try {
        const antes = admin.listar({ pasta: amb.pasta }).projetos;
        assert.equal(antes[0].no_cadastro, false);
        assert.equal(antes[0].ativo, null);
        admin.editar(amb.db, "IMTRAFF NOVO - GO", { ativo: true, apelidos: ["Imtraff GO"] }, "Yan", { pasta: amb.pasta });
        const depois = admin.listar({ pasta: amb.pasta }).projetos;
        assert.equal(depois.length, 1, "nao fica duplicado");
        assert.equal(depois[0].no_cadastro, true);
        assert.equal(depois[0].id_conta_azul, "id-novo");
        assert.equal(admin.historico(amb.db)[0].acao, "CONFIRMADO_DA_SINCRONIZACAO");
        assert.throws(() => admin.editar(amb.db, "Inexistente", { ativo: true }, "Yan", { pasta: amb.pasta }), /não encontrado/);
    } finally { amb.fim(); }
});

test("o projetos.json real passa na validacao de conflitos", () => {
    const amb = ambiente({ projetos: cadastros.carregar().projetos });
    try {
        // Uma edicao neutra roda a verificacao sobre o cadastro inteiro.
        const primeiro = cadastros.carregar().projetos[0];
        admin.editar(amb.db, primeiro.nome_oficial, { ativo: primeiro.ativo ?? null }, "Teste", { pasta: amb.pasta });
    } finally { amb.fim(); }
});

test("centro de custo guarda o cartao usado e recusa cartao fora do cadastro", () => {
    const amb = ambiente();
    try {
        fs.writeFileSync(path.join(amb.pasta, "cartoes.json"), JSON.stringify([{ codigo: "INTER", rotulo: "CRÉDITO INTER", forma_pagamento: "CARTAO_CREDITO" }]));
        admin.criar(amb.db, { nome_oficial: "IMTRAFF CICLO II MT", ativo: true, cartao: "inter" }, "Yan", { pasta: amb.pasta });
        assert.equal(amb.ler().projetos[0].cartao, "INTER");
        assert.equal(admin.listar({ pasta: amb.pasta }).projetos[0].cartao, "INTER");
        assert.throws(() => admin.editar(amb.db, "IMTRAFF CICLO II MT", { cartao: "NUBANK" }, "Yan", { pasta: amb.pasta }), /não está no cadastro de cartões/);
        admin.editar(amb.db, "IMTRAFF CICLO II MT", { cartao: "" }, "Yan", { pasta: amb.pasta });
        assert.equal(amb.ler().projetos[0].cartao, null);
    } finally { amb.fim(); }
});

test("catalogo do Conta Azul entra nos cadastros sem sobrescrever o que ja existe", () => {
    const amb = ambiente({ projetos: [{ nome_oficial: "Rota do Pequi", centro_conta_azul: "HOUER / YVY - ROTA DO PEQUI", ativo: true, apelidos: [] }] });
    try {
        fs.writeFileSync(path.join(amb.pasta, "categorias.json"), JSON.stringify([{ nome: "JANTAR", nome_conta_azul: "Refeição - Jantar", id: "id-jantar" }]));
        fs.writeFileSync(path.join(amb.pasta, "catalogo_conta_azul.json"), JSON.stringify({
            centros: [{ nome: "HOUER / YVY - ROTA DO PEQUI", usos: 51 }, { nome: "ETEL FWD/VIGA - GO", usos: 224, ultimo_uso: "2026-09-16" }],
            categorias: [{ nome: "Refeição - Jantar", usos: 9 }, { nome: "GERADOR", usos: 105 }],
            fornecedores: [{ nome: "SUPERBOM SUPERMERCADO", usos: 22 }],
        }));
        const cad = cadastros.carregar(amb.pasta);
        const nomes = cadastros.projetosComId(cad).map((p) => p.nome_oficial);
        assert.deepEqual(nomes.filter((n) => /ROTA DO PEQUI/i.test(n)), ["Rota do Pequi"], "centro ja ligado a um projeto nao duplica");
        assert.ok(nomes.includes("ETEL FWD/VIGA - GO"));
        assert.equal(cad.categorias.filter((c) => c.nome_conta_azul === "Refeição - Jantar").length, 1);
        assert.equal(cad.categorias.find((c) => c.nome === "GERADOR").id, null, "sem ID ate a sincronizacao");
        assert.ok(cad.fornecedores.opcoes.includes("SUPERBOM SUPERMERCADO"));
    } finally { amb.fim(); }
});
