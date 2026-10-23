"use strict";

// Modo completo do assistente: ferramentas liberadas so para quem pode confirmar,
// segredos bloqueados.

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");

const assinatura = require("../src/assistente/assinatura");
const banco = require("../src/central/banco");
const servico = require("../src/assistente/servico");

test("modo completo libera arquivos, comandos e web e bloqueia os segredos", () => {
    const args = assinatura.comando({ configMcp: "mcp.json", completo: true });
    assert.equal(args[args.indexOf("--tools") + 1], "Bash,Read,Write,Edit,Glob,Grep,WebSearch,WebFetch");
    assert.equal(args[args.indexOf("--permission-mode") + 1], "acceptEdits");
    const regras = JSON.parse(args[args.indexOf("--settings") + 1]);
    for (const segredo of ["Read(**/.env)", "Read(**/tokens_conta_azul*.json)", "Read(**/configuracao/pessoas.json)", "Bash(taskkill:*)"]) assert.ok(regras.permissions.deny.includes(segredo), segredo);
    assert.ok(args.includes("--add-dir"));
    const consulta = assinatura.comando({ configMcp: "mcp.json" });
    assert.equal(consulta[consulta.indexOf("--tools") + 1], "");
});

test("arquivos: libera dentro das pastas do programa e nunca segredos", () => {
    const raiz = path.resolve(__dirname, "..");
    assert.ok(assinatura.arquivoLiberado(path.join(raiz, "package.json")));
    assert.equal(assinatura.arquivoLiberado(path.join(raiz, ".env")), null);
    assert.equal(assinatura.arquivoLiberado(path.join(raiz, "configuracao", "pessoas.json")), null);
    assert.equal(assinatura.arquivoLiberado("C:\Windows\win.ini"), null);
});

test("so quem pode confirmar recebe o modo completo", async () => {
    const db = banco.abrir(":memory:");
    const vistos = [];
    const rodar = async (o) => { vistos.push(o.completo); return { tipo: "resposta", texto: "ok", sessao: null, propostas: [] }; };
    await servico.enviar(db, { pessoa: "Yan", texto: "oi", rodar });
    await servico.enviar(db, { pessoa: "Cauã", texto: "oi", rodar });
    assert.deepEqual(vistos, [true, false]);
});
