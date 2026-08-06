"use strict";

const fs = require("fs");
const path = require("path");
const { processarPendentes } = require("../src/pipeline");

const raiz = path.resolve(__dirname, "..");
const config = JSON.parse(fs.readFileSync(path.join(raiz, "config.json"), "utf8"));
const pastaInformada = String(config.pasta_saida || "dados/entrada");
const entrada = path.isAbsolute(pastaInformada) ? pastaInformada : path.join(raiz, pastaInformada);
fs.mkdirSync(entrada, { recursive: true });

console.log(`Testando documentos em: ${entrada}`);
processarPendentes(entrada, { ...(config.pipeline || {}), modo: "simulacao" })
    .then(() => console.log("Teste concluido. Consulte dados/auditoria, dados/simulacao, dados/revisao, dados/bloqueados e dados/erros."))
    .catch((erro) => { console.error("Teste falhou:", erro.message); process.exitCode = 1; });
