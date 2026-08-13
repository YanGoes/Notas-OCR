"use strict";

// =============================================================================
// ARQUIVAMENTO NO GOOGLE DRIVE
// =============================================================================
//
// Copia a foto do comprovante para a estrutura de pastas do Drive da empresa:
//
//   <raiz>/<ANO>/Despesas de Campo <ANO>/<Operador>/<MM.AA>/<DD>/<arquivo>
//
// Exemplo:
//   G:\Meu Drive\...\Controle Financeiro - VMac\2026\Despesas de Campo 2026\
//       Emerson\04.26\27\WhatsApp Image 2026-04-27 at 09.32.56.jpg
//
// O Drive para computador sincroniza a pasta sozinho — aqui e so copia de
// arquivo, sem API do Google e sem credencial nova.
//
// Nunca move o original: a foto continua na auditoria local. Se a pasta do
// Drive estiver indisponivel (Drive fechado, sem rede), registra o erro e
// segue — arquivamento nao pode derrubar o lancamento da despesa.
// =============================================================================

const fs = require("fs");
const path = require("path");

/** Remove acentos e caixa, para comparar nomes de pasta com o nome do WhatsApp. */
function normalizar(texto) {
    return String(texto || "")
        .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
        .toLowerCase().trim();
}

/** Tira caracteres que o Windows nao aceita em nome de arquivo/pasta. */
function nomeSeguro(texto) {
    return String(texto || "").replace(/[<>:"/\\|?*\x00-\x1F]/g, "_").replace(/\s+/g, " ").trim();
}

/**
 * Descobre a pasta do operador.
 *
 * Ordem: mapeamento explicito por remetente > nome do WhatsApp que bate com
 * uma pasta existente > pasta de nao identificados (nada se perde).
 */
function pastaDoOperador(auditoria = {}, opcoes = {}, pastasExistentes = []) {
    const remetente = String(auditoria.operador?.remetente || "");
    const mapeados = opcoes.operadores || {};

    if (remetente && mapeados[remetente]) return { pasta: nomeSeguro(mapeados[remetente]), origem: "mapeamento" };

    const nomeWhats = String(auditoria.operador?.remetente_nome || "").trim();
    if (nomeWhats) {
        if (mapeados[nomeWhats]) return { pasta: nomeSeguro(mapeados[nomeWhats]), origem: "mapeamento" };
        const alvo = normalizar(nomeWhats);
        const partesAlvo = alvo.split(/\s+/).filter(Boolean);

        // A correspondencia mais especifica vence. Existindo as pastas "Vitor" e
        // "Vitor Ponce", o nome "Vitor Ponce" precisa cair na dele, nao na do
        // Vitor — por isso o nome completo e testado antes do primeiro nome.
        const exata = pastasExistentes.find((p) => normalizar(p) === alvo);
        if (exata) return { pasta: exata, origem: "nome_whatsapp" };

        // Pasta com nome composto contida no nome do WhatsApp ("Vitor Ponce
        // Ferreira" -> pasta "Vitor Ponce"), da mais longa para a mais curta.
        const contida = pastasExistentes
            .filter((p) => normalizar(p).split(/\s+/).every((parte) => partesAlvo.includes(parte)))
            .sort((a, b) => normalizar(b).length - normalizar(a).length)[0];
        if (contida) return { pasta: contida, origem: "nome_whatsapp" };

        // So entao aceita casar pelo primeiro nome, e apenas se houver um unico
        // candidato — dois "Vitor" diferentes nao podem ser adivinhados.
        const porPrimeiroNome = pastasExistentes.filter((p) => normalizar(p).split(/\s+/)[0] === partesAlvo[0]);
        if (porPrimeiroNome.length === 1) return { pasta: porPrimeiroNome[0], origem: "nome_whatsapp" };
        return { pasta: nomeSeguro(nomeWhats), origem: "nome_whatsapp_novo" };
    }

    return { pasta: nomeSeguro(opcoes.pasta_nao_identificado || "Nao identificado"), origem: "nao_identificado" };
}

/** Data que organiza as pastas: a da nota (competencia) ou a de recebimento. */
function dataDeArquivo(auditoria = {}, opcoes = {}) {
    const daNota = String(auditoria.ocr?.data || "");
    if (opcoes.usar_data_da_nota !== false && /^\d{4}-\d{2}-\d{2}$/.test(daNota)) {
        const [ano, mes, dia] = daNota.split("-");
        return { ano, mes, dia, origem: "data_da_nota" };
    }
    const recebido = auditoria.recebido_em ? new Date(auditoria.recebido_em) : new Date();
    const p = (n) => String(n).padStart(2, "0");
    return {
        ano: String(recebido.getFullYear()),
        mes: p(recebido.getMonth() + 1),
        dia: p(recebido.getDate()),
        origem: "data_de_recebimento",
    };
}

function listarPastas(caminho) {
    try {
        return fs.readdirSync(caminho, { withFileTypes: true })
            .filter((item) => item.isDirectory())
            .map((item) => item.name);
    } catch (_) { return []; }
}

/**
 * Monta o caminho completo de destino, sem criar nada. Exposto para teste.
 */
function caminhoDeDestino(auditoria, opcoes = {}, pastasExistentes = []) {
    const raiz = String(opcoes.raiz || "");
    if (!raiz) throw new Error("Caminho raiz do Drive nao configurado (arquivo_drive.raiz).");

    const { ano, mes, dia, origem: origemData } = dataDeArquivo(auditoria, opcoes);
    const { pasta: operador, origem: origemOperador } = pastaDoOperador(auditoria, opcoes, pastasExistentes);
    const mesAno = `${mes}.${ano.slice(-2)}`;

    const pastaAno = String(opcoes.modelo_pasta_ano || "Despesas de Campo {ano}").replace("{ano}", ano);
    const destino = path.join(raiz, ano, pastaAno, operador, mesAno, dia);
    return { destino, operador, origemOperador, origemData, ano, mesAno, dia };
}

/**
 * Copia o comprovante para o Drive.
 *
 * @param {string} caminhoImagem — foto ja processada (na pasta local)
 * @param {object} auditoria
 * @param {object} opcoes — bloco `arquivo_drive` do config.json
 * @returns {{arquivado:boolean, destino?:string, erro?:string}}
 */
function arquivar(caminhoImagem, auditoria, opcoes = {}) {
    if (!opcoes.habilitado) return { arquivado: false, motivo: "desligado" };
    if (!fs.existsSync(caminhoImagem)) return { arquivado: false, erro: "Imagem nao encontrada para arquivar." };

    try {
        const raiz = String(opcoes.raiz || "");
        if (!fs.existsSync(raiz)) {
            return { arquivado: false, erro: `Pasta do Drive indisponivel: ${raiz}. Verifique se o Google Drive esta aberto.` };
        }

        const { ano } = caminhoDeDestino(auditoria, opcoes, []);
        const nomeDaPastaAno = (a) => String(opcoes.modelo_pasta_ano || "Despesas de Campo {ano}").replace("{ano}", a);

        // Lista as pastas de operadores que ja existem, para casar o nome certo.
        // Na virada de ano a pasta nova esta vazia: nesse caso olha o ano
        // anterior, para manter a mesma convencao de nomes ("Emerson", nao
        // "Emerson Silva").
        let existentes = listarPastas(path.join(raiz, ano, nomeDaPastaAno(ano)));
        if (!existentes.length) {
            const anoAnterior = String(Number(ano) - 1);
            existentes = listarPastas(path.join(raiz, anoAnterior, nomeDaPastaAno(anoAnterior)));
        }
        const resolvido = caminhoDeDestino(auditoria, opcoes, existentes);

        fs.mkdirSync(resolvido.destino, { recursive: true });

        const nomeArquivo = nomeSeguro(auditoria.arquivo_imagem || path.basename(caminhoImagem));
        let destinoFinal = path.join(resolvido.destino, nomeArquivo);

        // Mesmo nome ja arquivado: se for o mesmo arquivo, nao duplica.
        if (fs.existsSync(destinoFinal)) {
            const igual = fs.statSync(destinoFinal).size === fs.statSync(caminhoImagem).size;
            if (igual) return { arquivado: true, destino: destinoFinal, jaExistia: true, operador: resolvido.operador };
            const ext = path.extname(nomeArquivo);
            destinoFinal = path.join(resolvido.destino, `${path.basename(nomeArquivo, ext)}_${Date.now()}${ext}`);
        }

        fs.copyFileSync(caminhoImagem, destinoFinal);
        return {
            arquivado: true,
            destino: destinoFinal,
            operador: resolvido.operador,
            origem_operador: resolvido.origemOperador,
            origem_data: resolvido.origemData,
            pasta_relativa: path.join(resolvido.operador, resolvido.mesAno, resolvido.dia),
        };
    } catch (erro) {
        return { arquivado: false, erro: erro.message };
    }
}

module.exports = { arquivar, caminhoDeDestino, pastaDoOperador, dataDeArquivo, nomeSeguro, normalizar };
