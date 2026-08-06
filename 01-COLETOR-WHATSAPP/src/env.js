"use strict";

const fs = require("fs");
const path = require("path");

function carregarEnv(raiz) {
    const arquivo = path.join(raiz, ".env");
    const valores = {};
    if (fs.existsSync(arquivo)) {
        for (const linhaBruta of fs.readFileSync(arquivo, "utf8").split(/\r?\n/)) {
            const linha = linhaBruta.trim();
            if (!linha || linha.startsWith("#") || !linha.includes("=")) continue;
            const indice = linha.indexOf("=");
            valores[linha.slice(0, indice).trim()] = linha.slice(indice + 1).trim().replace(/^['"]|['"]$/g, "");
        }
    }
    return { ...valores, ...process.env };
}

module.exports = { carregarEnv };
