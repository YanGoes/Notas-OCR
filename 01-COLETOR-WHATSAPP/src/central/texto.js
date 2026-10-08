"use strict";

// Utilidades de texto compartilhadas pelos modulos da Central.

/** Sem acento, minusculo, so letras/numeros separados por um espaco. */
function normalizar(valor) {
    return String(valor ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "")
        .toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/** Procura a expressao como palavra(s) inteira(s), nunca como pedaco de palavra. */
function contemTermo(texto, termo) {
    const alvo = normalizar(termo);
    if (!alvo) return false;
    return ` ${normalizar(texto)} `.includes(` ${alvo} `);
}

function somenteDigitos(valor) {
    return String(valor ?? "").replace(/\D/g, "");
}

/** "30/09/2026", "30-09-26", "2026-09-30" -> "2026-09-30" (ou null se invalida). */
function dataIso(valor) {
    const texto = String(valor ?? "").trim();
    let ano; let mes; let dia;
    let achado = texto.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (achado) [, ano, mes, dia] = achado.map(Number);
    else {
        achado = texto.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})$/);
        if (!achado) return null;
        dia = Number(achado[1]); mes = Number(achado[2]);
        ano = achado[3].length === 2 ? 2000 + Number(achado[3]) : Number(achado[3]);
    }
    const data = new Date(Date.UTC(ano, mes - 1, dia));
    if (data.getUTCFullYear() !== ano || data.getUTCMonth() !== mes - 1 || data.getUTCDate() !== dia) return null;
    return `${ano}-${String(mes).padStart(2, "0")}-${String(dia).padStart(2, "0")}`;
}

/** "R$ 1.234,56" / "37" / "37,5" -> numero; null se nao for valor. */
function numeroMonetario(valor) {
    let texto = String(valor ?? "").replace(/[^\d,.-]/g, "");
    if (!texto) return null;
    if (texto.includes(",")) texto = texto.replace(/\./g, "").replace(",", ".");
    const numero = Number(texto);
    return Number.isFinite(numero) && numero > 0 ? Math.round(numero * 100) / 100 : null;
}

function centavos(valor) {
    const numero = Number(valor);
    return Number.isFinite(numero) ? Math.round(numero * 100) : null;
}

module.exports = { normalizar, contemTermo, somenteDigitos, dataIso, numeroMonetario, centavos };
