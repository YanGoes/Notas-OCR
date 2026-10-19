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

test("depois de confirmar, o assistente escreve a resposta com o resultado (relatorio)", async () => {
    const db = bancoComDespesas();
    const rodar = async ({ texto }) => (/treino|confirmou/.test(texto) && /Resultado/.test(texto)
        ? { tipo: "resposta", texto: "Relatório: maturidade subiu.", sessao: "s2", propostas: [] }
        : { tipo: "resposta", texto: "Preparei.", sessao: "s1", propostas: [{ ferramenta: "preparar_lancamento", parametros: { ids: [10] } }] });
    const r = await servico.enviar(db, { pessoa: "Yan", texto: "lança a 10", rodar });
    const decisao = await servico.decidir(db, r.proposta.id, { pessoa: "Yan", aceito: true, rodar });
    assert.equal(decisao.relatorio, "Relatório: maturidade subiu.");
    const conversa = servico.lerConversa(db, r.conversa_id);
    assert.equal(conversa.mensagens.at(-1).texto, "Relatório: maturidade subiu.");
});

test("relatorio do treino compara antes e depois por campo", () => {
    const { relatorioDoTreino } = require("../src/assistente/ferramentas");
    const antes = { gerado_em: "a", aprovadas: 80, maturidade: { rotulo: "1", notas_inteiras: { certas: 40, de: 80, taxa: 0.5, minimo_garantido: 0.4 } }, por_campo: { valor: { rotulo: "Valor", total: 80, acertos: 76 } } };
    const depois = { gerado_em: "b", aprovadas: 100, maturidade: { rotulo: "1", notas_inteiras: { certas: 60, de: 100, taxa: 0.6, minimo_garantido: 0.5 }, proximo: "x" }, por_campo: { valor: { rotulo: "Valor", total: 100, acertos: 99 } }, diferencas: ["#1 valor"] };
    const r = relatorioDoTreino(antes, depois);
    assert.equal(r.antes.taxa_pct, 50);
    assert.equal(r.depois.taxa_pct, 60);
    assert.deepEqual(r.campos_do_pior_para_o_melhor[0], { campo: "Valor", acerto_pct: 99, de: 100, acerto_na_medicao_anterior_pct: 95 });
});

// --- Veiculos, consulta livre e habilidades criadas pelo usuario --------------

test("veiculos: km rodados, consumo e leitura de hodometro fora da sequencia descartada", () => {
    const v = require("../src/assistente/veiculos");
    const planilha = [
        { data: "2026-09-01", valor: -200, categoria: "HILUX - OVN5J98", descricao: "40,00L od 100.000 - OVN5J98" },
        { data: "2026-09-05", valor: -210, categoria: "HILUX - OVN5J98", descricao: "50,00L od 100.500 - OVN5J98" },
        { data: "2026-09-07", valor: -220, categoria: "Combustivel OVN-5J98", descricao: "50,00L od 61,788 - OVN5J98" },
        { data: "2026-09-10", valor: -230, categoria: "HILUX - OVN5J98", descricao: "50,00L od 101.000 - OVN5J98" },
        { data: "2026-09-10", valor: -99, categoria: "MANUTENÇÃO HILUX OVN5J98", descricao: "PNEU" },
    ];
    const [hilux] = v.resumoPorVeiculo(v.abastecimentos({ planilha }), { placa: "OVN-5J98" });
    assert.equal(hilux.km_rodados, 1000);
    assert.equal(hilux.abastecimentos, 4, "manutencao nao conta");
    assert.equal(hilux.consumo_km_por_litro, 10, "1000 km / 100 L depois do 1o hodometro");
    assert.equal(hilux.sem_hodometro, 1, "'od 61,788' nao e hodometro valido");
});

test("consulta livre so le: recusa alterar e roda SELECT no banco da Central", () => {
    const fs = require("fs"); const os = require("os"); const path = require("path");
    const consultas = require("../src/assistente/consultas");
    assert.throws(() => consultas.validar("DELETE FROM despesas"), /leitura/);
    assert.throws(() => consultas.validar("SELECT 1; DROP TABLE despesas"), /Uma consulta|alterar/);
    const caminho = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cons-")), "c.db");
    const db = banco.abrir(caminho);
    db.prepare("INSERT INTO despesas (estado, campos, pendencias, avisos, criado_em, atualizado_em) VALUES ('APROVADO', '{\"valor\":{\"valor\":50}}', '[]', '[]', 'x', 'x')").run();
    db.close();
    const r = consultas.consultar({ base: "central", sql: "SELECT SUM(json_extract(campos, '$.valor.valor')) AS total FROM despesas" }, { caminhoCentral: caminho });
    assert.equal(r.linhas[0].total, 50);
});

test("criar habilidade: testa, grava e aparece como ferramenta nova (h_nome)", async () => {
    const fs = require("fs"); const os = require("os"); const path = require("path");
    const caminho = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "hab-")), "c.db");
    process.env.CENTRAL_DB = caminho;
    try {
        const db = banco.abrir(caminho);
        const consultas = require("../src/assistente/consultas");
        consultas.criarHabilidade({ db, pessoa: "Yan" }, { nome: "notas_por_estado", descricao: "Quantas notas há em cada estado", base: "central",
            sql: "SELECT estado, COUNT(*) AS n FROM despesas WHERE estado = :estado OR :estado IS NULL GROUP BY estado", parametros: [{ nome: "estado", descricao: "opcional" }] });
        const lista = ferramentas.todas(db).map((f) => f.nome);
        assert.ok(lista.includes("h_notas_por_estado"));
        const resultado = await ferramentas.executar("h_notas_por_estado", {}, { db });
        assert.deepEqual(resultado.linhas, []);
        assert.throws(() => consultas.criarHabilidade({ db, pessoa: "Yan" }, { nome: "x", descricao: "y", sql: "SELECT 1" }), /Nome da habilidade/);
    } finally { delete process.env.CENTRAL_DB; }
});
