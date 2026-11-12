"use strict";

// Botoes de envio da Central: controle de quem envia, de um envio por vez e do
// andamento. O envio em si e falso: nada fala com o Conta Azul nem abre navegador.

const test = require("node:test");
const assert = require("node:assert/strict");

const banco = require("../src/central/banco");
const envioReal = require("../src/central/envio");
const { criarEnvioCentral } = require("../src/central/envio-central");

const CONFIG = { central: { lancamento_habilitado: true, envio_conta_azul: { habilitado: true, somente_empresa_id: "999", oficial: { habilitado: false, empresa_id: "" } } } };

function criarDespesa(db, estado = "APROVADO") {
    const t = new Date().toISOString();
    const midia = db.prepare("INSERT INTO midias (sha256, arquivo, recebida_em, registrada_em) VALUES ('x', ?, ?, ?)").run(`f${Math.random()}.jpg`, t, t);
    return Number(db.prepare(`INSERT INTO despesas (midia_id, estado, campos, pendencias, avisos, criado_em, atualizado_em)
        VALUES (?, ?, '{}', '[]', '[]', ?, ?)`).run(midia.lastInsertRowid, estado, t, t).lastInsertRowid);
}

/** Envio falso: registra como o de verdade (para "pendentes" e "envios" funcionarem) e deixa segurar o lote. */
function cenario({ config = CONFIG, falhar = null } = {}) {
    const db = banco.abrir(":memory:");
    const chamadas = [];
    let liberar = null;
    const segurar = () => new Promise((resolve) => { liberar = resolve; });
    const envio = {
        empresaDaConta: envioReal.empresaDaConta, pendentesDeEnvio: envioReal.pendentesDeEnvio,
        enviarLote: async (banco_, ids, opcoes) => {
            chamadas.push({ ids, conta: opcoes.conta, autor: opcoes.autor, perfil: contaAzul.perfilAtual });
            if (falhar) throw new Error(falhar);
            const resultados = [];
            for (const id of ids) {
                if (opcoes.sinal?.parar) return { parado: true, empresa: { id: "999" }, resumo: {}, resultados };
                if (cenarioAtual.pausar) await segurar();
                banco_.prepare("INSERT INTO envios_conta_azul (despesa_id, empresa_id, status, evento_id, autor, criado_em, atualizado_em, relatorio) VALUES (?, '999', 'ENVIADO', 'ev', ?, 'x', 'x', ?)")
                    .run(id, opcoes.autor, JSON.stringify({ anexo: { ok: true, tipo: "arquivo", nome: "foto.jpg" }, faltou: [] }));
                const r = { despesa_id: id, status: "ENVIADO", faltou: [], erro: null };
                resultados.push(r);
                opcoes.aoAvancar(r);
            }
            return { parado: false, empresa: { id: "999", nome: "Teste" }, resumo: { completas: resultados.length, incompletas: 0, incertas: 0, nao_enviadas: 0 }, resultados };
        },
    };
    const contaAzul = {
        perfilAtual: null,
        statusPerfis: () => ({ teste: { conectada: true }, oficial: { conectada: false } }),
        comPerfil: (perfil, fn) => { contaAzul.perfilAtual = perfil; return fn(); },
    };
    const cenarioAtual = { db, chamadas, pausar: false, soltar: () => liberar && liberar() };
    cenarioAtual.central = criarEnvioCentral({ lerConfig: () => config, contaAzul, envio, podemEnviar: ["Yan", "Jhonathan", "Vanessa"] });
    return cenarioAtual;
}

test("situacao: cada conta diz se esta liberada, conectada e quantas aprovadas faltam", () => {
    const c = cenario();
    criarDespesa(c.db); criarDespesa(c.db); criarDespesa(c.db, "AGUARDANDO_REVISAO");
    const s = c.central.situacao(c.db);
    assert.equal(s.lancamento_habilitado, true);
    assert.deepEqual(s.contas, [
        { conta: "teste", empresa_id: "999", liberada: true, conectada: true, pendentes: 2 },
        { conta: "oficial", empresa_id: null, liberada: false, conectada: false, pendentes: null },
    ]);
    assert.equal(s.tarefa, null);
});

test("uma nota: so pessoa autorizada envia; vai na conta pedida, com o nome de quem enviou", async () => {
    const c = cenario();
    const id = criarDespesa(c.db);
    assert.throws(() => c.central.iniciar(c.db, { conta: "teste", ids: [id], autor: "Cauã" }), /Só Yan, Jhonathan, Vanessa podem enviar/);
    assert.throws(() => c.central.iniciar(c.db, { conta: "teste", ids: [], autor: "Yan" }), /Nenhuma despesa informada/);
    assert.throws(() => c.central.iniciar(c.db, { conta: "banco", ids: [id], autor: "Yan" }), /Conta inválida/);
    const { fim } = c.central.iniciar(c.db, { conta: "teste", ids: [id, id], autor: "yan" });
    const tarefa = await fim;
    assert.equal(tarefa.status, "CONCLUIDO");
    assert.equal(tarefa.feitos, 1);
    assert.deepEqual(c.chamadas, [{ ids: [id], conta: "teste", autor: "Yan", perfil: "teste" }]);
    // A nota passa a mostrar para onde foi enviada, na tela da nota e na lista.
    const [envio] = c.central.enviosDaDespesa(c.db, id);
    assert.equal(envio.conta, "teste");
    assert.equal(envio.status, "ENVIADO");
    assert.deepEqual(envio.anexo, { ok: true, tipo: "arquivo", nome: "foto.jpg" });
    assert.deepEqual(c.central.enviadasDaLista(c.db, [id]).get(id), [{ conta: "teste", status: "ENVIADO" }]);
    assert.equal(c.central.situacao(c.db).contas[0].pendentes, 0);
});

test("todas: envia so as aprovadas que faltam, uma tarefa por vez, com andamento e Parar", async () => {
    const c = cenario();
    const ids = [criarDespesa(c.db), criarDespesa(c.db), criarDespesa(c.db)];
    criarDespesa(c.db, "AGUARDANDO_REVISAO");
    c.pausar = true;
    const { tarefa, fim } = c.central.iniciar(c.db, { conta: "teste", todas: true, autor: "Vanessa" });
    assert.equal(tarefa.status, "RODANDO");
    assert.equal(tarefa.total, 3);
    assert.deepEqual(c.chamadas[0].ids, ids);
    assert.throws(() => c.central.iniciar(c.db, { conta: "teste", ids: [ids[0]], autor: "Yan" }), /Já existe um envio em andamento .* iniciado por Vanessa/);
    c.soltar();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(c.central.andamento().feitos, 1);
    assert.deepEqual(c.central.parar(), { parando: true });
    assert.equal(c.central.andamento().parando, true);
    c.soltar();
    const final = await fim;
    assert.equal(final.status, "PARADO");
    assert.equal(final.feitos, 2, "a nota que estava em andamento termina; a seguinte nem começa");
    assert.deepEqual(c.central.parar(), { parando: false });
    // Segunda rodada: so sobra a que nao foi.
    c.pausar = false;
    const segunda = await c.central.iniciar(c.db, { conta: "teste", todas: true, autor: "Yan" }).fim;
    assert.deepEqual(c.chamadas.at(-1).ids, [ids[2]]);
    assert.equal(segunda.status, "CONCLUIDO");
    assert.throws(() => c.central.iniciar(c.db, { conta: "teste", todas: true, autor: "Yan" }), /Não há nota aprovada esperando envio para a conta de teste/);
});

test("travas viram mensagem, nao envio: conta oficial nao liberada, lancamento desligado, robo sem login", async () => {
    const c = cenario();
    const id = criarDespesa(c.db);
    assert.throws(() => c.central.iniciar(c.db, { conta: "oficial", todas: true, autor: "Yan" }), /conta OFICIAL ainda não foi liberada/);
    const desligado = cenario({ config: { central: { lancamento_habilitado: false, envio_conta_azul: CONFIG.central.envio_conta_azul } } });
    assert.throws(() => desligado.central.iniciar(desligado.db, { conta: "teste", ids: [criarDespesa(desligado.db)], autor: "Yan" }), /lançamento está desligado/);
    assert.equal(desligado.chamadas.length, 0);
    const semRobo = cenario({ falhar: "Robô sem login no Conta Azul (conta teste)" });
    const tarefa = await semRobo.central.iniciar(semRobo.db, { conta: "teste", ids: [criarDespesa(semRobo.db)], autor: "Yan" }).fim;
    assert.equal(tarefa.status, "ERRO");
    assert.match(tarefa.erro, /Robô sem login/);
    assert.equal(tarefa.feitos, 0);
    assert.equal(c.central.enviosDaDespesa(c.db, id).length, 0);
});
