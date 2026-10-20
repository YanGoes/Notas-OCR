"use strict";

// Anexos do assistente: cada formato vira o bloco certo para o Claude.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const anexos = require("../src/assistente/anexos");
const assinatura = require("../src/assistente/assinatura");
const banco = require("../src/central/banco");
const servico = require("../src/assistente/servico");

const pasta = () => fs.mkdtempSync(path.join(os.tmpdir(), "anexos-teste-"));
const b64 = (texto) => Buffer.from(texto).toString("base64");
// PNG 1x1 valido.
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

test("classifica pelos nomes e tipos", () => {
    assert.equal(anexos.classificar("a.JPG"), "imagem");
    assert.equal(anexos.classificar("x", "image/png"), "imagem");
    assert.equal(anexos.classificar("nota.pdf"), "pdf");
    assert.equal(anexos.classificar("v.mp4"), "video");
    assert.equal(anexos.classificar("p.xlsx"), "planilha");
    assert.equal(anexos.classificar("d.docx"), "word");
    assert.equal(anexos.classificar("dados.csv"), "texto");
    assert.equal(anexos.classificar("prog.exe"), null);
});

test("imagem, PDF e texto viram blocos e ficam guardados para o historico", async () => {
    const dir = pasta();
    const { blocos, resumo } = await anexos.preparar([
        { nome: "foto.png", tipo: "image/png", dados: `data:image/png;base64,${PNG}` },
        { nome: "nota.pdf", tipo: "application/pdf", dados: b64("%PDF-1.4 teste") },
        { nome: "dados.csv", tipo: "text/csv", dados: b64("a;b\n1;2") },
    ], { conversaId: 7, pasta: dir });
    assert.equal(blocos.find((b) => b.type === "image").source.media_type, "image/png");
    assert.equal(blocos.find((b) => b.type === "document").source.media_type, "application/pdf");
    assert.ok(blocos.some((b) => b.type === "text" && b.text.includes("a;b\n1;2")));
    assert.deepEqual(resumo.map((r) => r.classe), ["imagem", "pdf", "texto"]);
    assert.ok(anexos.caminhoDoAnexo("7", resumo[0].arquivo, dir));
    assert.equal(anexos.caminhoDoAnexo("7", "../../config.json", dir), null);
});

test("recusa formato desconhecido e arquivo vazio", async () => {
    await assert.rejects(anexos.preparar([{ nome: "x.exe", dados: b64("MZ") }], { conversaId: 1, pasta: pasta() }), /não suportado/);
    await assert.rejects(anexos.preparar([{ nome: "x.txt", dados: "" }], { conversaId: 1, pasta: pasta() }), /vazio/);
});

test("planilha .xlsx vira texto por aba", async () => {
    const ExcelJS = require("exceljs");
    const livro = new ExcelJS.Workbook();
    livro.addWorksheet("Gastos").addRows([["Data", "Valor"], ["01/10", 45.5]]);
    const buffer = await livro.xlsx.writeBuffer();
    const { blocos } = await anexos.preparar([{ nome: "g.xlsx", dados: Buffer.from(buffer).toString("base64") }], { conversaId: 2, pasta: pasta() });
    assert.match(blocos[0].text, /Aba "Gastos"[\s\S]*Data;Valor[\s\S]*01\/10;45.5/);
});

test("video vira quadros (quando o ffmpeg existe)", { skip: !anexos.localizarFfmpeg() && "sem ffmpeg" }, async () => {
    const dir = pasta();
    const video = path.join(dir, "v.mp4");
    execFileSync(anexos.localizarFfmpeg(), ["-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc=duration=4:size=160x120:rate=10", "-pix_fmt", "yuv420p", video], { windowsHide: true });
    const { blocos } = await anexos.preparar([{ nome: "v.mp4", tipo: "video/mp4", dados: fs.readFileSync(video).toString("base64") }], { conversaId: 3, pasta: dir });
    assert.match(blocos[0].text, /vídeo v\.mp4, 4 s/);
    assert.equal(blocos.filter((b) => b.type === "image").length, 2);
});

test("com anexos o turno vai como stream-json com os blocos", async () => {
    let args = null;
    let entrada = "";
    const { EventEmitter } = require("events");
    const iniciar = (_exe, a) => {
        args = a;
        const p = new EventEmitter();
        p.stdout = new EventEmitter(); p.stderr = new EventEmitter();
        p.kill = () => {};
        p.stdin = { end: (texto) => {
            entrada = texto;
            setImmediate(() => { p.stdout.emit("data", `${JSON.stringify({ type: "result", result: "ok", session_id: "s1" })}\n`); p.emit("close", 0); });
        } };
        return p;
    };
    const r = await assinatura.rodarTurno({ texto: "veja", blocos: [{ type: "image", source: { type: "base64", media_type: "image/png", data: PNG } }],
        executavel: "claude", iniciar, pasta: pasta() });
    assert.equal(r.texto, "ok");
    assert.ok(args.includes("--input-format"));
    const mensagem = JSON.parse(entrada);
    assert.equal(mensagem.message.content[0].text, "veja");
    assert.equal(mensagem.message.content[1].type, "image");
});

test("servico guarda os anexos na mensagem e aceita mensagem so com anexo", async () => {
    const db = banco.abrir(":memory:");
    let recebido = null;
    const rodar = async (opcoes) => { recebido = opcoes; return { tipo: "resposta", texto: "vi", sessao: "s", propostas: [] }; };
    const r = await servico.enviar(db, { pessoa: "Yan", texto: "", anexos: [{ nome: "f.png", tipo: "image/png", dados: PNG }], rodar, pastaAnexos: pasta() });
    assert.equal(recebido.blocos.some((b) => b.type === "image"), true);
    const conversa = servico.lerConversa(db, r.conversa_id);
    assert.equal(conversa.mensagens[0].dados.anexos[0].nome, "f.png");
    await assert.rejects(servico.enviar(db, { pessoa: "Yan", texto: "", anexos: [{ nome: "x.exe", dados: b64("MZ") }], rodar, pastaAnexos: pasta() }), /não suportado/);
    assert.equal(servico.listarConversas(db, {}).length, 1);
});
