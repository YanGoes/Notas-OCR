"use strict";

const readline = require("readline/promises");
const { stdin, stdout } = require("process");
const { credenciais, trocarCodigo, requisicao, caminhoTokens } = require("../src/conta-azul");
const { usuarioDoToken, explicarErro } = require("../src/conta-azul-diagnostico");

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
    console.log("\n1. Abra esta URL numa JANELA ANONIMA do navegador e entre com o usuario do Conta Azul da EMPRESA");
    console.log("   (nao com a conta de teste do Portal do Desenvolvedor):\n");
    console.log(url.toString());
    console.log("\n2. Copie o valor do parametro 'code' da URL de redirecionamento.");
    const terminal = readline.createInterface({ input: stdin, output: stdout });
    const codigo = (await terminal.question("\nCole o codigo aqui: ")).trim();
    terminal.close();
    if (!codigo) throw new Error("Codigo nao informado.");
    await trocarCodigo(codigo);
    // A autorizacao pode dar certo e a API recusar a conta (ex.: teste vencido): testa ja.
    console.log("\nAutorizacao recebida. Testando o acesso a API...");
    try {
        const empresa = await requisicao("/v1/pessoas/conta-conectada");
        console.log(`\nConta Azul conectada e funcionando: ${empresa?.nome || empresa?.razao_social || "empresa conectada"}.`);
    } catch (erro) {
        console.error("\nA API recusou o acesso:\n");
        console.error(explicarErro(erro, usuarioDoToken(caminhoTokens())));
        process.exitCode = 1;
    }
}

iniciar().catch((erro) => { console.error("\nFalha:", erro.message); process.exitCode = 1; });
