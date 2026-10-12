"use strict";

// =============================================================================
// QUEM MANDOU: codigo interno do WhatsApp (LID) -> telefone -> pessoa
// =============================================================================
//
// Nos grupos, o WhatsApp identifica cada pessoa por um codigo interno
// ("1234...@lid") que esconde o telefone. O cadastro de pessoas e por
// telefone, entao sem traducao ninguem e reconhecido sozinho.
//
// O WhatsApp entrega o telefone de duas formas:
//   - junto da mensagem nova (key.participantAlt), quando pode;
//   - pela tabela LID -> telefone da propria sessao, que cresce quando o
//     contato e salvo no celular ou conversa com a conta.
// Com o telefone, a pessoa e achada no cadastro e o vinculo fica gravado:
// as notas daquele codigo passam para a pessoa certa (e as previas sem
// correcao sao refeitas). Nada aqui grava ou mostra telefone em log.
// =============================================================================

const cadastros = require("./cadastros");
const revisao = require("./revisao");

/** "5561999990000:12@s.whatsapp.net" -> "5561999990000@s.whatsapp.net" (sem o numero do aparelho). */
function jidTelefone(jid) {
    const texto = String(jid || "");
    if (!texto.endsWith("@s.whatsapp.net")) return null;
    const numero = texto.split("@")[0].split(":")[0].replace(/\D/g, "");
    return numero.length >= 10 ? `${numero}@s.whatsapp.net` : null;
}

function jaVinculado(db, whatsappId) {
    return Boolean(db.prepare("SELECT 1 FROM remetentes_vinculados WHERE whatsapp_id = ?").get(String(whatsappId)));
}

/**
 * Vincula um remetente (LID) a uma pessoa do cadastro pelo telefone.
 * @returns {{pessoa: string, regeradas: number} | null} null quando o telefone nao e de ninguem do cadastro
 */
function vincularPorTelefone(db, cad, whatsappId, telefoneJid, { origem = "telefone_do_whatsapp", regras = {} } = {}) {
    const telefone = jidTelefone(telefoneJid);
    if (!telefone || !whatsappId || String(whatsappId) === telefone || jaVinculado(db, whatsappId)) return null;
    const achada = cadastros.identificarPessoa(cad, telefone);
    if (achada.status !== "IDENTIFICADA") return null;
    const { regeradas } = revisao.vincularRemetente(db, cad, String(whatsappId), achada.pessoa.id, { origem, regras });
    return { pessoa: achada.pessoa.nome, regeradas };
}

/**
 * Passa por todos os remetentes ainda desconhecidos e pergunta ao WhatsApp o
 * telefone de cada um. `telefoneDoLid(lid)` vem da sessao conectada.
 */
async function identificarDesconhecidos(db, cad, telefoneDoLid, { regras = {} } = {}) {
    // `nao_reconhecidos` mostra so os 4 ultimos digitos do telefone: o bastante
    // para a pessoa conferir no celular, sem expor o numero.
    const resultado = { verificados: 0, vinculados: [], sem_telefone: 0, fora_do_cadastro: 0, nao_reconhecidos: [] };
    for (const remetente of revisao.remetentesNaoVinculados(db)) {
        const id = String(remetente.remetente_id || "");
        if (!id.endsWith("@lid")) continue;
        resultado.verificados += 1;
        let telefone = null;
        try { telefone = await telefoneDoLid(id); } catch (_) { telefone = null; }
        if (!jidTelefone(telefone)) { resultado.sem_telefone += 1; continue; }
        const vinculo = vincularPorTelefone(db, cad, id, telefone, { origem: "contatos_do_whatsapp", regras });
        if (vinculo) resultado.vinculados.push({ pessoa: vinculo.pessoa, notas: remetente.despesas, previas_refeitas: vinculo.regeradas });
        else {
            resultado.fora_do_cadastro += 1;
            resultado.nao_reconhecidos.push({ remetente_id: id, nome_no_whatsapp: remetente.nome || null, notas: remetente.despesas,
                telefone_final: `…${jidTelefone(telefone).split("@")[0].slice(-4)}` });
        }
    }
    return resultado;
}

module.exports = { jidTelefone, vincularPorTelefone, identificarDesconhecidos };
