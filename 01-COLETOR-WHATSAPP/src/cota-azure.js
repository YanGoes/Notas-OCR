"use strict";

// =============================================================================
// COTA MENSAL DO AZURE (plano gratuito F0: 500 paginas por mes)
// =============================================================================
//
// Conta as paginas lidas no mes. Ao chegar no limite configurado, o pipeline
// PARA de mandar fotos ao Azure: elas ficam esperando em dados/entrada e sao
// lidas quando o mes virar (ou quando o limite for aumentado). Melhor esperar
// do que ter a leitura recusada e a foto indo parar em "erros".
//
// O limite padrao (450) deixa folga para leituras feitas fora deste programa
// com a mesma chave (ex.: o programa original, testes manuais).
// =============================================================================

const fs = require("fs");
const path = require("path");

const ARQUIVO = path.resolve(__dirname, "..", "dados", "azure-uso.json");
const LIMITE_PADRAO = 450;

const mesAtual = (agora = new Date()) => agora.toISOString().slice(0, 7);

function ler(arquivo = ARQUIVO, agora = new Date()) {
    try {
        const dados = JSON.parse(fs.readFileSync(arquivo, "utf8"));
        if (dados.mes === mesAtual(agora)) return dados;
    } catch (_) { /* sem arquivo ainda */ }
    return { mes: mesAtual(agora), paginas: 0, leituras: 0, limite_atingido_em: null };
}

function gravar(dados, arquivo = ARQUIVO) {
    fs.mkdirSync(path.dirname(arquivo), { recursive: true });
    const temporario = `${arquivo}.${process.pid}.tmp`;
    fs.writeFileSync(temporario, JSON.stringify(dados, null, 2), "utf8");
    fs.renameSync(temporario, arquivo);
}

/** Situacao da cota no mes. `limite` 0 ou negativo = sem limite (plano pago). */
function situacao({ limite = LIMITE_PADRAO, arquivo = ARQUIVO, agora = new Date() } = {}) {
    const dados = ler(arquivo, agora);
    const semLimite = !(Number(limite) > 0);
    return { ...dados, limite: semLimite ? null : Number(limite), restantes: semLimite ? null : Math.max(0, Number(limite) - dados.paginas),
        disponivel: semLimite || dados.paginas < Number(limite) };
}

/** Registra uma leitura feita (paginas = paginas do documento lido). */
function registrar(paginas = 1, { arquivo = ARQUIVO, agora = new Date(), limite = LIMITE_PADRAO } = {}) {
    const dados = ler(arquivo, agora);
    dados.paginas += Math.max(1, Number(paginas) || 1);
    dados.leituras += 1;
    if (Number(limite) > 0 && dados.paginas >= Number(limite) && !dados.limite_atingido_em) dados.limite_atingido_em = agora.toISOString();
    gravar(dados, arquivo);
    return dados;
}

module.exports = { situacao, registrar, LIMITE_PADRAO, ARQUIVO };
