"use strict";

const { requisicao, caminhoTokens } = require("../src/conta-azul");
const { usuarioDoToken, explicarErro } = require("../src/conta-azul-diagnostico");

requisicao("/v1/pessoas/conta-conectada")
    .then((empresa) => console.log("Conexao funcionando:\n", JSON.stringify(empresa, null, 2)))
    .catch((erro) => {
        console.error("Teste falhou.\n");
        console.error(explicarErro(erro, usuarioDoToken(caminhoTokens())));
        process.exitCode = 1;
    });
