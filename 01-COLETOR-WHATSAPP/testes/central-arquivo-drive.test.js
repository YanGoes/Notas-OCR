"use strict";

// Arquivo das fotos aprovadas no Drive: pasta temporaria, nada toca o Drive real.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const banco = require("../src/central/banco");
const drive = require("../src/central/arquivo-drive");

const MODELO_TESTE = "{operador}/{mm}-{aa}/{dd}";

function cenario(operadores = ["Almir", "Jonathan", "Vitor Ponce"]) {
    const raiz = fs.mkdtempSync(path.join(os.tmpdir(), "drive-"));
    for (const o of operadores) fs.mkdirSync(path.join(raiz, o, "01-26", "05"), { recursive: true });
    const fotos = fs.mkdtempSync(path.join(os.tmpdir(), "fotos-"));
    const db = banco.abrir(":memory:");
    const config = { central: { arquivo_drive: { habilitado: true, raiz, modelo: MODELO_TESTE } } };
    const localizar = (arquivo) => path.join(fotos, arquivo);
    let n = 0;
    const despesa = ({ operador = null, pessoa = null, data = "2026-01-05", tipo = "ALMOCO", valor = 50, estado = "APROVADO", midia = null }) => {
        n += 1;
        let midiaId = midia;
        if (!midiaId) {
            const arquivo = `foto${n}.jpeg`;
            fs.writeFileSync(path.join(fotos, arquivo), Buffer.alloc(100 + n));
            midiaId = Number(db.prepare("INSERT INTO midias (sha256, arquivo, recebida_em, registrada_em) VALUES ('x', ?, '2026-10-01', '2026-10-01')").run(arquivo).lastInsertRowid);
        }
        const campos = { data_competencia: { valor: data }, tipo: { valor: tipo }, valor: { valor }, remetente: { valor: operador, pessoa_id: pessoa } };
        const id = Number(db.prepare(`INSERT INTO despesas (midia_id, estado, campos, pendencias, avisos, criado_em, atualizado_em)
            VALUES (?, ?, ?, '[]', '[]', 'x', 'x')`).run(midiaId, estado, JSON.stringify(campos)).lastInsertRowid);
        return { id, midiaId };
    };
    return { raiz, db, config, localizar, despesa };
}

test("acha a pasta do operador por nome, nome composto, primeiro nome e grafia parecida", () => {
    const pastas = ["Almir", "Jonathan", "Vitor Ponce", "Everson"];
    assert.equal(drive.pastaDoOperador("almir", pastas).pasta, "Almir");
    assert.equal(drive.pastaDoOperador("Vitor Ponce Ferreira", pastas).pasta, "Vitor Ponce");
    assert.equal(drive.pastaDoOperador("Jhonathan", pastas).pasta, "Jonathan");
    assert.equal(drive.pastaDoOperador("Éverson", pastas).pasta, "Everson");
    assert.deepEqual(drive.pastaDoOperador("Daniel", pastas), { pasta: "Daniel", como: "pasta nova", nova: true });
});

test("monta o caminho do modelo de teste e do oficial", () => {
    const raiz = fs.mkdtempSync(path.join(os.tmpdir(), "drive-"));
    assert.equal(drive.destinoDe({ raiz, modelo: MODELO_TESTE, data: "2026-01-05", operador: "Almir" }).pasta, path.join(raiz, "Almir", "01-26", "05"));
    assert.equal(drive.destinoDe({ raiz, modelo: drive.MODELO_PADRAO, data: "2025-11-30", operador: "Almir" }).pasta,
        path.join(raiz, "2025", "Despesas de Campo 2025", "Almir", "11.25", "30"));
});

test("copia cada foto aprovada para operador/mes/dia, uma vez por foto, e nao repete", () => {
    const c = cenario();
    const a = c.despesa({ operador: "Almir", data: "2026-01-05", valor: 30 });
    c.despesa({ operador: "Almir", data: "2026-01-05", tipo: "JANTAR", valor: 20, midia: a.midiaId });
    c.despesa({ operador: "Jhonathan", data: "2026-03-12", tipo: "ABASTECIMENTO", valor: 200 });
    c.despesa({ operador: "Almir", estado: "AGUARDANDO_REVISAO" });
    const r = drive.arquivarPendentes(c.db, { pessoas: [] }, { config: c.config, localizar: c.localizar });
    assert.equal(r.erros.length, 0, JSON.stringify(r.erros));
    assert.equal(r.copiadas.length, 2);
    assert.ok(fs.existsSync(path.join(c.raiz, "Almir", "01-26", "05", "#1-2 ALMOCO R$ 50,00.jpeg")));
    assert.ok(fs.existsSync(path.join(c.raiz, "Jonathan", "03-26", "12", "#3 ABASTECIMENTO R$ 200,00.jpeg")));
    const de_novo = drive.arquivarPendentes(c.db, { pessoas: [] }, { config: c.config, localizar: c.localizar });
    assert.equal(de_novo.copiadas.length, 0);
    assert.equal(de_novo.ja_estavam, 2);
});

test("nota corrigida depois: a foto e movida para a pasta nova", () => {
    const c = cenario();
    const { id } = c.despesa({ operador: "Almir", data: "2026-01-05" });
    drive.arquivarPendentes(c.db, { pessoas: [] }, { config: c.config, localizar: c.localizar });
    c.db.prepare("UPDATE despesas SET campos = json_set(campos, '$.data_competencia.valor', '2026-01-07') WHERE id = ?").run(id);
    const r = drive.arquivarPendentes(c.db, { pessoas: [] }, { config: c.config, localizar: c.localizar });
    assert.equal(r.movidas.length, 1);
    assert.ok(fs.existsSync(path.join(c.raiz, "Almir", "01-26", "07", `#${id} ALMOCO R$ 50,00.jpeg`)));
    assert.equal(fs.readdirSync(path.join(c.raiz, "Almir", "01-26", "05")).length, 0);
});

test("operador do cadastro vence; sem operador vai para Nao identificado; simular nao grava", () => {
    const c = cenario();
    c.despesa({ operador: "Fulano WhatsApp", pessoa: "almir" });
    c.despesa({});
    const sim = drive.arquivarPendentes(c.db, { pessoas: [{ id: "almir", nome: "Almir" }] }, { config: c.config, localizar: c.localizar, simular: true });
    assert.deepEqual(sim.copiadas.map((l) => l.operador), ["Almir", "Nao identificado"]);
    assert.equal(fs.readdirSync(path.join(c.raiz, "Almir", "01-26", "05")).length, 0);
});

test("Drive fechado ou desligado nao derruba nada", () => {
    const c = cenario();
    c.despesa({ operador: "Almir" });
    assert.match(drive.arquivarPendentes(c.db, {}, { config: { central: { arquivo_drive: { habilitado: true, raiz: "Z:\\nao-existe" } } } }).erro, /indisponível/);
    assert.equal(drive.arquivarPendentes(c.db, {}, { config: {} }).desligado, true);
});
