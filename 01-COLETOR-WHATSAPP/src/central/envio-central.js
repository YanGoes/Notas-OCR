"use strict";

// =============================================================================
// ENVIO AO CONTA AZUL PELOS BOTOES DA CENTRAL
// =============================================================================
//
// "Enviar ao Conta Azul" (uma nota) e "Enviar todas" (todas as aprovadas que
// ainda nao subiram para a conta escolhida). O envio em si e o mesmo do
// assistente (envio.enviarLote): API cria o lancamento, robo de tela anexa a
// imagem. Aqui fica so o controle:
//   - quem pode enviar (os mesmos que confirmam no assistente);
//   - um envio por vez, rodando em segundo plano, com andamento e botao Parar;
//   - a situacao de cada conta (liberada, conectada, quantas notas faltam).
// =============================================================================

const fs = require("fs");
const path = require("path");

const RAIZ = path.resolve(__dirname, "..", "..");
const CONTAS = ["teste", "oficial"];

function lerConfigPadrao() {
    try { return JSON.parse(fs.readFileSync(path.join(RAIZ, "config.json"), "utf8")); } catch (_) { return {}; }
}

function criarEnvioCentral({ lerConfig = lerConfigPadrao, contaAzul = null, envio = null, podemEnviar = null } = {}) {
    const ca = () => contaAzul || require("../conta-azul");
    const env = () => envio || require("./envio");
    const podem = () => podemEnviar || require("../assistente/servico").PODEM_CONFIRMAR;
    let tarefa = null;
    let proximaTarefa = 1;

    const resumoDaTarefa = (t) => (t ? {
        id: t.id, conta: t.conta, todas: t.todas, total: t.total, feitos: t.resultados.length, status: t.status, erro: t.erro,
        por: t.por, iniciada_em: t.iniciada_em, concluida_em: t.concluida_em, parando: Boolean(t.sinal.parar && t.status === "RODANDO"),
        empresa: t.empresa, resumo: t.resumo, resultados: t.resultados,
    } : null);

    function quemEnvia(autor) {
        const nome = podem().find((p) => p.toLowerCase() === String(autor || "").trim().toLowerCase());
        if (!nome) throw new Error(`Só ${podem().join(", ")} podem enviar ao Conta Azul. Escreva o seu nome no campo Revisor.`);
        return nome;
    }

    /** Situacao de cada conta, sem falar com o Conta Azul nem abrir a janela do robo. */
    function situacao(db) {
        const config = lerConfig();
        const regra = config.central?.envio_conta_azul || {};
        let perfis = {};
        try { perfis = ca().statusPerfis(); } catch (_) { /* sem .env: aparece como nao conectada */ }
        const contas = CONTAS.map((conta) => {
            const empresaId = env().empresaDaConta(config, conta);
            const liberada = Boolean(regra.habilitado && empresaId && (conta === "teste" || regra.oficial?.habilitado));
            return {
                conta, empresa_id: empresaId || null, liberada, conectada: Boolean(perfis[conta]?.conectada),
                pendentes: empresaId ? env().pendentesDeEnvio(db, empresaId).length : null,
            };
        });
        return { lancamento_habilitado: Boolean(config.central?.lancamento_habilitado), podem_enviar: podem(), contas, tarefa: resumoDaTarefa(tarefa) };
    }

    /** Envios ja feitos de uma despesa (para a tela dizer "enviada para a conta X"). */
    function enviosDaDespesa(db, despesaId) {
        const config = lerConfig();
        const contaDe = (empresaId) => CONTAS.find((conta) => env().empresaDaConta(config, conta) === String(empresaId)) || null;
        return db.prepare("SELECT id, empresa_id, status, evento_id, autor, criado_em, relatorio FROM envios_conta_azul WHERE despesa_id = ? ORDER BY id DESC").all(despesaId)
            .map((l) => {
                let relatorio = {};
                try { relatorio = JSON.parse(l.relatorio || "{}"); } catch (_) { /* relatorio antigo */ }
                return { id: l.id, conta: contaDe(l.empresa_id), empresa_id: l.empresa_id, status: l.status, evento_id: l.evento_id, por: l.autor, em: l.criado_em,
                    faltou: relatorio.faltou || [], anexo: relatorio.anexo ? { ok: Boolean(relatorio.anexo.ok), tipo: relatorio.anexo.tipo || null, nome: relatorio.anexo.nome || null } : null,
                    erro: relatorio.erro || null };
            });
    }

    /** Ultimo envio que criou lancamento, por despesa (para a etiqueta da lista). */
    function enviadasDaLista(db, ids) {
        if (!ids.length) return new Map();
        const config = lerConfig();
        const contaDe = (empresaId) => CONTAS.find((conta) => env().empresaDaConta(config, conta) === String(empresaId)) || null;
        const mapa = new Map();
        const linhas = db.prepare(`SELECT despesa_id, empresa_id, status FROM envios_conta_azul
            WHERE status IN ('ENVIADO', 'ENVIADO_INCOMPLETO') AND despesa_id IN (${ids.map(() => "?").join(",")}) ORDER BY id`).all(...ids);
        for (const l of linhas) {
            const atual = mapa.get(l.despesa_id) || [];
            const conta = contaDe(l.empresa_id) || "outra";
            mapa.set(l.despesa_id, [...atual.filter((e) => e.conta !== conta), { conta, status: l.status }]);
        }
        return mapa;
    }

    /**
     * Comeca um envio. `ids` = notas escolhidas; `todas` = todas as aprovadas
     * que ainda nao subiram para a conta. Devolve a tarefa (que roda em segundo
     * plano) e, em `fim`, a promessa do resultado.
     */
    function iniciar(db, { conta = "teste", ids = null, todas = false, autor } = {}) {
        const por = quemEnvia(autor);
        if (!CONTAS.includes(conta)) throw new Error("Conta inválida: use teste ou oficial.");
        const config = lerConfig();
        if (!config.central?.lancamento_habilitado) throw new Error("O lançamento está desligado (config.json → central.lancamento_habilitado). Nada foi enviado.");
        if (tarefa?.status === "RODANDO") throw new Error(`Já existe um envio em andamento (${tarefa.resultados.length} de ${tarefa.total}), iniciado por ${tarefa.por}. Espere terminar ou clique em Parar.`);
        let lista;
        if (todas) {
            const empresaId = env().empresaDaConta(config, conta);
            if (!empresaId) throw new Error(conta === "oficial" ? "A conta OFICIAL ainda não foi liberada (config.json → central.envio_conta_azul.oficial)." : "Falta a empresa de teste no config.");
            lista = env().pendentesDeEnvio(db, empresaId);
            if (!lista.length) throw new Error(`Não há nota aprovada esperando envio para a conta ${conta === "oficial" ? "oficial" : "de teste"}.`);
        } else {
            lista = [...new Set((Array.isArray(ids) ? ids : []).map(Number).filter((n) => Number.isInteger(n) && n > 0))];
            if (!lista.length) throw new Error("Nenhuma despesa informada.");
        }
        const nova = {
            id: proximaTarefa, conta, todas: Boolean(todas), total: lista.length, resultados: [], status: "RODANDO", erro: null, por,
            iniciada_em: new Date().toISOString(), concluida_em: null, sinal: { parar: false }, empresa: null, resumo: null,
        };
        proximaTarefa += 1;
        tarefa = nova;
        const fim = ca().comPerfil(conta, () => env().enviarLote(db, lista, {
            api: ca(), config, conta, autor: por, sinal: nova.sinal,
            aoAvancar: (resultado) => { nova.resultados.push(resultado); },
        })).then((r) => {
            nova.status = r.parado ? "PARADO" : "CONCLUIDO";
            nova.empresa = r.empresa;
            nova.resumo = r.resumo;
            nova.resultados = r.resultados;
        }).catch((erro) => {
            // Travas (empresa errada, conta nao liberada, robo sem login): nada foi enviado alem do que ja esta em resultados.
            nova.status = "ERRO";
            nova.erro = erro.message;
        }).then(() => { nova.concluida_em = new Date().toISOString(); return resumoDaTarefa(nova); });
        return { tarefa: resumoDaTarefa(nova), fim };
    }

    function parar() {
        if (tarefa?.status !== "RODANDO") return { parando: false };
        tarefa.sinal.parar = true;
        return { parando: true };
    }

    return { situacao, enviosDaDespesa, enviadasDaLista, iniciar, parar, andamento: () => resumoDaTarefa(tarefa) };
}

module.exports = { criarEnvioCentral, CONTAS };
