"use strict";

// Assistente da Central: ferramentas, servidor MCP, conversa e propostas.
// Banco em memoria; o Claude Code e trocado por um motor falso (nada e enviado).

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("events");
const { PassThrough } = require("stream");

const banco = require("../src/central/banco");
const ferramentas = require("../src/assistente/ferramentas");
const mcp = require("../src/assistente/mcp");
const servico = require("../src/assistente/servico");
const assinatura = require("../src/assistente/assinatura");

const CAD = {
    pessoas: [{ id: "lorran", nome: "Lorran", telefone: "5511900000031", papel: "OPERADOR" }],
    projetos: [{ nome_oficial: "IMTRAFF CICLO II MT", ativo: true, cartao: "INTER", apelidos: [] }],
    centros: [], veiculos: [], cartoes: [{ codigo: "INTER", rotulo: "CRÉDITO INTER" }], categorias: [], fornecedores: { opcoes: ["RESTAURANTES"], recorrentes: [] },
};

function bancoComDespesas() {
    const db = banco.abrir(":memory:");
    const agora = "2026-10-14T12:00:00Z";
    const msg = (id, grupo, quem, quando, foto) => db.prepare(`INSERT INTO mensagens (id, grupo_id, mensagem_id, remetente_id, remetente_nome, pessoa_id, enviada_em, texto, tem_midia, intencao, interpretacao, registrada_em)
        VALUES (?, ?, ?, ?, ?, ?, ?, '', ?, 'INFORMACAO_DESPESA', '{}', ?)`).run(id, grupo, `m${id}`, "5511900000031@s.whatsapp.net", quem, "lorran", quando, foto, agora);
    msg(1, "g@g.us", "Lorran", "2026-10-10T20:00:00Z", 1);
    msg(2, "g@g.us", "Lorran", "2026-10-12T12:00:00Z", 1);
    const despesa = (id, estado, data, valor, tipo, ref) => db.prepare(`INSERT INTO despesas (id, mensagem_ref, estado, campos, pendencias, avisos, criado_em, atualizado_em)
        VALUES (?, ?, ?, ?, '[]', '[]', ?, ?)`).run(id, ref, estado, JSON.stringify({
            remetente: { valor: "Lorran" }, data_competencia: { valor: data }, valor: { valor }, tipo: { valor: tipo },
            centro_custo: { nome: "IMTRAFF CICLO II MT" }, fornecedor: { valor: "RESTAURANTES" }, pagamento: { cartao: "INTER" } }), agora, agora);
    despesa(10, "APROVADO", "2026-10-10", 80, "JANTAR", 1);
    despesa(11, "AGUARDANDO_REVISAO", "2026-10-12", 58, "ALMOCO", 2);
    despesa(12, "DESCARTADO", "2026-10-12", 999, "ALMOCO", 2);
    return db;
}

test("relatorio de gastos soma por operador, ignora descartadas e diz a fonte", () => {
    const db = bancoComDespesas();
    const r = ferramentas.FERRAMENTAS.find((f) => f.nome === "relatorio_gastos").executar({ db, cad: CAD }, { de: "2026-10-01", ate: "2026-10-31", agrupar_por: "operador" });
    assert.equal(r.total, 138);
    assert.equal(r.quantidade, 2);
    assert.deepEqual(r.grupos[0], { grupo: "Lorran", quantidade: 2, total: 138, media: 69 });
    assert.match(r.fonte, /Central/);
});

test("ultimo envio por operador e busca de despesas nunca mostram telefone", async () => {
    const db = bancoComDespesas();
    const envio = await ferramentas.executar("ultimo_envio_por_operador", {}, { db, cad: CAD });
    assert.equal(envio[0].operador, "Lorran");
    assert.equal(envio[0].ultimo_envio, "2026-10-12T12:00:00Z");
    const busca = await ferramentas.executar("buscar_despesas", { estado: "revisar" }, { db, cad: CAD });
    assert.equal(busca.encontradas, 1);
    const tudo = JSON.stringify([envio, busca, await ferramentas.executar("cadastros", { tipo: "pessoas" }, { db, cad: CAD })]);
    assert.ok(!/5511900000031/.test(tudo), "telefone nunca sai pelas ferramentas");
});

test("MCP lista ferramentas e transforma o que grava em proposta (nao executa)", async () => {
    const fs = require("fs"); const os = require("os"); const path = require("path");
    const fila = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "mcp-")), "fila.jsonl");
    const db = bancoComDespesas();
    const ctx = { db, cad: CAD, fila, pessoa: "Yan" };
    const lista = await mcp.tratar({ jsonrpc: "2.0", id: 1, method: "tools/list" }, ctx);
    assert.ok(lista.result.tools.some((t) => t.name === "preparar_lancamento"));
    const chamada = await mcp.tratar({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "preparar_lancamento", arguments: { ids: [10] } } }, ctx);
    assert.match(chamada.result.content[0].text, /Confirmar/);
    assert.deepEqual(JSON.parse(fs.readFileSync(fila, "utf8").trim()), { ferramenta: "preparar_lancamento", parametros: { ids: [10] } });
    assert.equal(await mcp.tratar({ jsonrpc: "2.0", method: "notifications/initialized" }, ctx), null);
});

test("conversa guarda mensagens, sessao e proposta; so Yan/Jhonathan/Vanessa confirmam", async () => {
    const db = bancoComDespesas();
    const rodar = async ({ texto, emitir }) => {
        assert.match(texto, /Cauã está falando/);
        emitir({ tipo: "texto_parcial", texto: "Preparei" });
        return { tipo: "resposta", texto: "Preparei o lançamento da #10.", sessao: "sessao-1", propostas: [{ ferramenta: "preparar_lancamento", parametros: { ids: [10] } }] };
    };
    const eventos = [];
    const resposta = await servico.enviar(db, { pessoa: "cauã", texto: "lança a 10", emitir: (e) => eventos.push(e), rodar });
    assert.equal(resposta.proposta.resumo, "Lançar no Conta Azul 1 despesa(s) aprovada(s): #10");
    assert.equal(eventos[0].texto, "Preparei");
    assert.equal(db.prepare("SELECT sessao FROM assistente_conversas WHERE id = ?").get(resposta.conversa_id).sessao, "sessao-1");
    await assert.rejects(() => servico.enviar(db, { pessoa: "Yan", texto: "e agora?", conversaId: resposta.conversa_id, rodar }), /esperando Confirmar/);
    await assert.rejects(() => servico.decidir(db, resposta.proposta.id, { pessoa: "Cauã", aceito: true }), /Só Yan, Jhonathan, Vanessa/);
    const decisao = await servico.decidir(db, resposta.proposta.id, { pessoa: "Vanessa", aceito: true });
    assert.equal(decisao.status, "EXECUTADA");
    assert.equal(decisao.resultado.enviado, false, "lancamento desligado na fase de testes: nada enviado");
    await assert.rejects(() => servico.decidir(db, resposta.proposta.id, { pessoa: "Yan", aceito: true }), /já foi decidida/);
});

test("lancamento recusa despesa que nao foi aprovada", async () => {
    const db = bancoComDespesas();
    await assert.rejects(() => ferramentas.executar("preparar_lancamento", { ids: [11] }, { db, cad: CAD }), /Só despesas aprovadas/);
});

test("motor da assinatura: comando sem ferramentas embutidas e eventos do stream-json", async () => {
    const args = assinatura.comando({ configMcp: "mcp.json", sessao: "abc" });
    assert.deepEqual(args.slice(args.indexOf("--tools"), args.indexOf("--tools") + 2), ["--tools", ""]);
    assert.ok(args.includes("--strict-mcp-config") && args.includes("--resume"));
    // Processo falso que imita o claude -p.
    const iniciar = (_exe, _args, opcoes) => {
        assert.ok(!("ANTHROPIC_API_KEY" in opcoes.env), "nunca usa a API paga");
        const proc = new EventEmitter();
        proc.stdout = new PassThrough(); proc.stderr = new PassThrough(); proc.stdin = new PassThrough(); proc.kill = () => {};
        setImmediate(() => {
            proc.stdout.write(`${JSON.stringify({ type: "system", subtype: "init", session_id: "s1", model: "claude" })}\n`);
            proc.stdout.write(`${JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "Olá" } } })}\n`);
            proc.stdout.write(`${JSON.stringify({ type: "result", is_error: false, result: "Olá, Yan.", session_id: "s1" })}\n`);
            proc.stdout.end();
            proc.emit("close", 0);
        });
        return proc;
    };
    process.env.ANTHROPIC_API_KEY = "nao-usar";
    const eventos = [];
    const r = await assinatura.rodarTurno({ texto: "oi", executavel: "claude.exe", iniciar, emitir: (e) => eventos.push(e), pasta: require("os").tmpdir() });
    delete process.env.ANTHROPIC_API_KEY;
    assert.equal(r.tipo, "resposta");
    assert.equal(r.texto, "Olá, Yan.");
    assert.equal(r.sessao, "s1");
    assert.ok(eventos.some((e) => e.tipo === "texto_parcial" && e.texto === "Olá"));
});

test("limite do plano vira 'indisponivel' com aviso claro", async () => {
    const iniciar = () => {
        const proc = new EventEmitter();
        proc.stdout = new PassThrough(); proc.stderr = new PassThrough(); proc.stdin = new PassThrough(); proc.kill = () => {};
        setImmediate(() => { proc.stdout.end(`${JSON.stringify({ type: "result", is_error: true, result: "Claude AI usage limit reached" })}\n`); proc.emit("close", 1); });
        return proc;
    };
    const r = await assinatura.rodarTurno({ texto: "oi", executavel: "claude.exe", iniciar, pasta: require("os").tmpdir() });
    assert.equal(r.tipo, "indisponivel");
    assert.match(r.texto, /limite/);
});
