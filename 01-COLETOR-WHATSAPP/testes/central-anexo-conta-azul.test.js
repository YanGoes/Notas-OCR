"use strict";

// Robo de tela do anexo: so a logica local (nada abre navegador nem fala com o site).

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");

const anexo = require("../src/central/anexo-conta-azul");

const LINK = "https://drive.google.com/file/d/1Is6u32kmlssT9FdgsiPLhnsMpy9UsKFp/view";
const EVENTO = "487e13c6-639e-4870-86f4-ee40784905df";

test("anexo no formato que o site grava: por link e por arquivo (Tipo: Outros)", () => {
    assert.deepEqual(anexo.anexoPorLink(LINK, "REEMBOLSO ALMIR"),
        { name: null, reference: null, url: LINK, description: "REEMBOLSO ALMIR", type: "OTHERS", contentType: "URL" });
    assert.equal(anexo.anexoPorLink(LINK).description, "Foto da nota");
    assert.deepEqual(anexo.anexoPorArquivo("#448 ALMOCO R$ 134,00.jpg", "0d487ad6-1781-4c91-b863-cf84b9e48ee8"),
        { name: "#448 ALMOCO R$ 134,00.jpg", reference: "0d487ad6-1781-4c91-b863-cf84b9e48ee8", url: null, description: null, type: "OTHERS", contentType: "FILE" });
});

test("a lista enviada mantem os anexos vivos (o site substitui a lista inteira) e nao repete o mesmo anexo", () => {
    const vivo = { id: "a1", name: null, reference: null, url: "https://exemplo.test/boleto.pdf", description: "Boleto", type: "BANK_SLIP", contentType: "URL", deletedAt: null, createdBy: 1 };
    const apagado = { id: "a0", url: LINK, contentType: "URL", deletedAt: "2026-11-11T18:06:04-03:00" };
    const novoLink = anexo.anexoPorLink(LINK);
    // Do anexo que ja existe vao so os campos que o site reenvia (sem createdBy, deletedAt…).
    assert.deepEqual(anexo.listaComNovo([apagado, vivo], novoLink),
        [{ name: null, id: "a1", reference: null, url: "https://exemplo.test/boleto.pdf", description: "Boleto", type: "BANK_SLIP", contentType: "URL" }, novoLink]);
    assert.deepEqual(anexo.listaComNovo([], novoLink), [novoLink]);
    assert.equal(anexo.listaComNovo([vivo, { id: "a2", url: LINK, contentType: "URL", deletedAt: null }], novoLink), null);
    // Arquivo: o mesmo nome ja anexado nao sobe de novo; um link com o mesmo texto nao conta.
    const novoArquivo = anexo.anexoPorArquivo("#448 ALMOCO R$ 134,00.jpg", "ref-1");
    assert.equal(anexo.listaComNovo([{ id: "a3", name: "#448 ALMOCO R$ 134,00.jpg", contentType: "FILE", deletedAt: null }], novoArquivo), null);
    assert.equal(anexo.listaComNovo([vivo], novoArquivo).length, 2);
});

test("recusa lancamento, link ou foto invalidos sem abrir o navegador", async () => {
    const robo = anexo.criarRobo({ perfil: "Z:\\nao-existe" });
    assert.equal((await robo.anexarLink("nao-e-uuid", { url: LINK })).erro, "id do lançamento inválido");
    assert.equal((await robo.anexarLink(EVENTO, { url: "javascript:alert(1)" })).erro, "link da foto inválido");
    assert.deepEqual(await robo.anexarArquivo(EVENTO, { arquivo: "Z:\\nao-existe\\foto.jpg" }), { tipo: "arquivo", ok: false, erro: "foto não encontrada no programa" });
    assert.equal((await robo.anexarArquivo(EVENTO, { arquivo: __filename })).erro, "formato de foto não aceito");
});

test("cada conta tem a sua pasta de navegador", () => {
    assert.notEqual(anexo.perfilDaConta("teste"), anexo.perfilDaConta("oficial"));
    assert.equal(path.basename(anexo.perfilDaConta("oficial")), "navegador-conta-azul-oficial");
    assert.equal(anexo.criarRobo({ conta: "oficial", perfil: "Z:\\x" }).conta, "oficial");
});

test("o script da pagina e JavaScript valido e leva evento, valor, anexo e arquivo", () => {
    const comoFuncao = (script) => new Function(`return ${script.replace(/\(\)$/, "")}`);
    const link = anexo.scriptDeAnexar(EVENTO, anexo.anexoPorLink(LINK, "nota do \"Zé\" `x` ${y}"), { valor: 29.19 });
    assert.ok(link.includes(`finance-pro/v1/financial-events/${EVENTO}`));
    assert.ok(link.includes("const valor = 2919;"));
    assert.ok(anexo.scriptDeAnexar(EVENTO, anexo.anexoPorLink(LINK)).includes("const valor = null;"));
    assert.doesNotThrow(() => comoFuncao(link));
    const novo = { ...anexo.anexoPorArquivo("foto.jpg", "x"), reference: null };
    const arquivo = anexo.scriptDeAnexar(EVENTO, novo, { valor: 29.19, arquivo: { base64: "AAAA", tipo: "image/jpeg" } });
    assert.ok(arquivo.includes("attachment-service/v1/files"));
    assert.ok(arquivo.includes('"base64":"AAAA"'));
    assert.doesNotThrow(() => comoFuncao(arquivo));
});
