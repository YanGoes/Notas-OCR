"use strict";

const readline = require("readline/promises");
const { stdin, stdout } = require("process");
const { credenciais, trocarCodigo } = require("../src/conta-azul");

async function iniciar() {
    const { clientId, redirectUri } = credenciais();
    if (!redirectUri) throw new Error("CONTA_AZUL_REDIRECT_URI ausente no .env.");
    const url = new URL("https://auth.contaazul.com/login");
    url.search = new URLSearchParams({
        response_type: "code",
        client_id: clientId,
        redirect_uri: redirectUri,
        state: `coletor-${Date.now()}`,
        scope: "openid profile aws.cognito.signin.user.admin",
    });
    console.log("\n1. Abra esta URL no navegador e autorize a conta:\n");
    console.log(url.toString());
    console.log("\n2. Copie o valor do parametro 'code' da URL de redirecionamento.");
    const terminal = readline.createInterface({ input: stdin, output: stdout });
    const codigo = (await terminal.question("\nCole o codigo aqui: ")).trim();
    terminal.close();
    if (!codigo) throw new Error("Codigo nao informado.");
    await trocarCodigo(codigo);
    console.log("\nConta Azul conectada. Tokens salvos com seguranca em tokens_conta_azul.json.");
}

iniciar().catch((erro) => { console.error("\nFalha:", erro.message); process.exitCode = 1; });
