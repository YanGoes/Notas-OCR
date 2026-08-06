"use strict";

const { requisicao } = require("../src/conta-azul");

requisicao("/v1/pessoas/conta-conectada")
    .then((empresa) => console.log("Conexao funcionando:\n", JSON.stringify(empresa, null, 2)))
    .catch((erro) => { console.error("Teste falhou:", erro.message); process.exitCode = 1; });
