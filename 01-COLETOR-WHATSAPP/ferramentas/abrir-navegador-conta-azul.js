"use strict";

// Abre a janela do ROBO DE TELA do Conta Azul para a pessoa fazer o login.
//   node ferramentas/abrir-navegador-conta-azul.js            (conta de teste)
//   node ferramentas/abrir-navegador-conta-azul.js oficial    (conta oficial)
// Cada conta tem a sua janela e o seu perfil (dados/navegador-conta-azul e
// dados/navegador-conta-azul-oficial). O login (e-mail, senha, codigo) e
// digitado pela pessoa nessa janela e fica guardado no perfil. O programa nunca
// ve a senha.

const navegador = require("../src/central/navegador-conta-azul");
const { perfilDaConta, SITE } = require("../src/central/anexo-conta-azul");

(async () => {
    const conta = process.argv[2] === "oficial" ? "oficial" : "teste";
    const { porta, reaproveitado } = await navegador.abrir({ perfil: perfilDaConta(conta), url: SITE });
    if (reaproveitado) await navegador.novaAba(porta, SITE);
    console.log(reaproveitado ? `A janela do robô (conta ${conta}) já estava aberta: abri uma aba nova no Conta Azul.` : `Janela do robô (conta ${conta}) aberta no Conta Azul.`);
    console.log(`Entre nessa janela com o login do Conta Azul da conta ${conta.toUpperCase()}. Pode deixá-la aberta ou minimizada.`);
})().catch((erro) => { console.error(`Erro: ${erro.message}`); process.exitCode = 1; });
