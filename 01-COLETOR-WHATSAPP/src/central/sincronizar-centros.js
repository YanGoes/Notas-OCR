"use strict";

// =============================================================================
// CENTROS DE CUSTO NOVOS DO CONTA AZUL, UMA VEZ POR DIA
// =============================================================================
//
// Pedido do Yan (13/11/2026): o programa deve ficar sempre em dia com os centros
// de custo criados no Conta Azul. Uma vez por dia le os centros ATIVOS da conta
// OFICIAL (so leitura) e ACRESCENTA em configuracao/centros_custo.json os que
// ainda nao estao la. Dali eles aparecem sozinhos na Central (lista de centros e
// aba "Centros de custo", como "nao confirmado" ate alguem ligar a um projeto).
//
// Nunca apaga nem renomeia um centro existente (projetos.json, apelidos e notas
// dependem dos nomes atuais): centro sumido ou renomeado la so vai para o log.
// Antes de gravar, guarda uma copia .bak. Sem internet ou com a conta oficial
// desconectada: tenta de novo na proxima hora.
// =============================================================================

const fs = require("fs");
const path = require("path");

const RAIZ = path.resolve(__dirname, "..", "..");
const ARQUIVO_CENTROS = path.join(RAIZ, "configuracao", "centros_custo.json");
const ARQUIVO_ESTADO = path.join(RAIZ, "dados", "conta-azul", "centros-sincronizacao.json");
const ARQUIVO_LOG = path.join(RAIZ, "dados", "logs", "centros-conta-azul.log");

const normalizar = (texto) => String(texto || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
const hojeLocal = (data = new Date()) => new Date(data.getTime() - 3 * 3600 * 1000).toISOString().slice(0, 10); // Brasilia (sem horario de verao)

function lerJson(arquivo, padrao) {
    try { return JSON.parse(fs.readFileSync(arquivo, "utf8")); } catch (_) { return padrao; }
}
function gravarJson(arquivo, dados) {
    fs.mkdirSync(path.dirname(arquivo), { recursive: true });
    const temporario = `${arquivo}.tmp`;
    fs.writeFileSync(temporario, `${JSON.stringify(dados, null, 2)}\n`, "utf8");
    fs.renameSync(temporario, arquivo);
}
function registrarLog(texto) {
    try {
        fs.mkdirSync(path.dirname(ARQUIVO_LOG), { recursive: true });
        fs.appendFileSync(ARQUIVO_LOG, `${new Date().toISOString()} ${texto}\n`, "utf8");
    } catch (_) { /* log nunca derruba */ }
}

/**
 * Compara a lista do Conta Azul com a local. Puro (sem arquivo): devolve a
 * lista nova (local + os novos no fim) e o que mudou.
 * @param {Array<{nome:string,id:string,apelidos?:string[]}>} locais
 * @param {Array<{id:string,nome:string}>} remotos — centros ativos no Conta Azul
 */
function compararCentros(locais, remotos, { hoje = hojeLocal() } = {}) {
    const ids = new Set(locais.map((c) => String(c.id || "")).filter(Boolean));
    const nomes = new Set(locais.map((c) => normalizar(c.nome)));
    const novos = [];
    const renomeados = [];
    for (const remoto of remotos || []) {
        const id = String(remoto?.id || "").trim();
        const nome = String(remoto?.nome || "").trim();
        if (!id || !nome) continue;
        if (ids.has(id)) {
            const local = locais.find((c) => String(c.id) === id);
            if (normalizar(local.nome) !== normalizar(nome)) renomeados.push({ id, antes: local.nome, agora: nome });
            continue;
        }
        if (nomes.has(normalizar(nome))) continue; // mesmo nome com outro id: nao duplica
        novos.push({ nome, id, apelidos: [], origem: "sincronizado_conta_azul", incluido_em: hoje });
        ids.add(id);
        nomes.add(normalizar(nome));
    }
    const idsRemotos = new Set((remotos || []).map((r) => String(r?.id || "")));
    const sumidos = locais.filter((c) => c.id && !idsRemotos.has(String(c.id))).map((c) => c.nome);
    return { lista: [...locais, ...novos], novos, renomeados, sumidos };
}

/** Busca no Conta Azul (conta oficial) e acrescenta os centros novos. */
async function sincronizar({ listar = null, arquivo = ARQUIVO_CENTROS, avisar = null } = {}) {
    const buscar = listar || (() => {
        const contaAzul = require("../conta-azul");
        return contaAzul.comPerfil("oficial", () => contaAzul.listarCentrosCusto());
    });
    const remotos = await buscar();
    if (!Array.isArray(remotos) || !remotos.length) throw new Error("O Conta Azul devolveu a lista de centros vazia; nada foi alterado.");
    const locais = lerJson(arquivo, []);
    const r = compararCentros(locais, remotos);
    if (r.novos.length) {
        if (fs.existsSync(arquivo)) fs.copyFileSync(arquivo, `${arquivo}.bak`);
        gravarJson(arquivo, r.lista);
    }
    const resumo = { em: new Date().toISOString(), no_conta_azul: remotos.length, no_programa: r.lista.length,
        novos: r.novos.map((c) => c.nome), renomeados: r.renomeados, sumidos_ou_inativos: r.sumidos.length };
    registrarLog(`ok: ${remotos.length} no Conta Azul, ${r.novos.length} novo(s)${r.novos.length ? `: ${r.novos.map((c) => c.nome).join("; ")}` : ""}`
        + `${r.renomeados.length ? ` | renomeados la (nao mudei aqui): ${r.renomeados.map((x) => `${x.antes} -> ${x.agora}`).join("; ")}` : ""}`);
    if (r.novos.length && avisar) {
        try {
            avisar({ titulo: `${r.novos.length} centro(s) de custo novo(s) do Conta Azul`, nivel: "info",
                texto: `Incluídos no programa: ${r.novos.map((c) => c.nome).join(", ")}. Ligue cada um a um projeto na aba "Centros de custo" da Central, se precisar de apelidos ou cartão.` });
        } catch (_) { /* aviso e opcional */ }
    }
    return resumo;
}

/** Ja rodou com sucesso hoje? */
function rodouHoje(agora = new Date()) {
    return lerJson(ARQUIVO_ESTADO, {})?.dia === hojeLocal(agora);
}

/**
 * Agenda: confere de hora em hora (e 2 min depois de abrir) e roda UMA vez por
 * dia. Falhou (sem internet, conta oficial desconectada)? Tenta na proxima hora.
 */
function agendar({ avisar = null, intervaloMs = 60 * 60 * 1000 } = {}) {
    const rodar = async () => {
        if (rodouHoje()) return;
        try {
            const resumo = await sincronizar({ avisar });
            gravarJson(ARQUIVO_ESTADO, { dia: hojeLocal(), ...resumo });
            if (resumo.novos.length) console.log(`Centros de custo: ${resumo.novos.length} novo(s) do Conta Azul incluído(s): ${resumo.novos.join(", ")}`);
        } catch (erro) {
            registrarLog(`falhou (tenta de novo em 1 h): ${erro?.message || erro}`);
        }
    };
    setTimeout(rodar, 2 * 60 * 1000).unref();
    setInterval(rodar, intervaloMs).unref();
}

module.exports = { sincronizar, compararCentros, agendar, rodouHoje, ARQUIVO_CENTROS };
