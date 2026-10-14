"use strict";

// Explica em portugues por que a conexao com o Conta Azul nao funciona.
// O caso mais comum: a autorizacao foi feita com a conta de TESTE do Portal do
// Desenvolvedor (usuario "...@devportal.com"), cujo periodo gratis acabou
// (403 END_TRIAL). A autorizacao "funciona", mas a API recusa tudo depois.

const fs = require("fs");

/** Usuario que autorizou (lido do token, sem expor o token). */
function usuarioDoToken(caminhoTokens) {
    try {
        const tokens = JSON.parse(fs.readFileSync(caminhoTokens, "utf8"));
        const carga = JSON.parse(Buffer.from(String(tokens.access_token || "").split(".")[1] || "", "base64url").toString("utf8"));
        return carga.username || null;
    } catch (_) { return null; }
}

/** "abc123@devportal.com" -> "abc…@devportal.com" (nao mostra o usuario inteiro). */
const mascarar = (usuario) => String(usuario || "").replace(/^(.{3}).*(@.*)$/, "$1…$2");

function explicarErro(erro, usuario = null) {
    const texto = String(erro?.message || erro || "");
    const contaDeTeste = /@devportal\.com$/i.test(String(usuario || ""));
    if (/END_TRIAL|n[aã]o est[aá] eleg[ií]vel/i.test(texto)) {
        return [
            "A autorizacao funcionou, mas a CONTA usada no login nao pode usar a API: o periodo de teste dela acabou (END_TRIAL).",
            contaDeTeste
                ? `O login foi feito com a conta de TESTE do Portal do Desenvolvedor (${mascarar(usuario)}).`
                : usuario ? `Usuario que autorizou: ${mascarar(usuario)}.` : "",
            "Para resolver sem pagar nada a mais: rode o atalho 04 de novo e, na tela de login do Conta Azul,",
            "entre com o usuario da EMPRESA (o mesmo do Conta Azul do dia a dia, com o plano em dia).",
            "Use uma janela anonima do navegador para nao entrar sozinho na conta de teste.",
        ].filter(Boolean).join("\n");
    }
    if (/401|invalid_grant|refresh/i.test(texto)) return "A autorizacao expirou ou foi revogada. Rode o atalho 04 de novo.";
    if (/ENOTFOUND|ECONNRESET|ETIMEDOUT|fetch failed/i.test(texto)) return "Sem acesso a internet ou o Conta Azul nao respondeu. Tente de novo em alguns minutos.";
    return `Erro do Conta Azul: ${texto}`;
}

module.exports = { usuarioDoToken, explicarErro, mascarar };
