"use strict";

// Passo 1 do fluxo manual: conecta no WhatsApp, mostra os grupos numerados,
// voce escolhe um e a escolha ja fica gravada no config.json.

const fs = require("fs");
const path = require("path");
const readline = require("readline/promises");
const { stdin, stdout } = require("process");
const pino = require("pino");
const qrcode = require("qrcode-terminal");
const { default: makeWASocket, useMultiFileAuthState } = require("@whiskeysockets/baileys");

const RAIZ = path.resolve(__dirname, "..");
const PASTA_SESSAO = path.join(RAIZ, ".baileys_sessao");
const ARQUIVO_CONFIG = path.join(RAIZ, "config.json");

async function escolher(grupos) {
    console.log("\n=====================================");
    console.log("  GRUPOS DISPONIVEIS");
    console.log("=====================================\n");

    grupos.forEach((grupo, indice) => {
        const participantes = grupo.participants?.length ?? "?";
        console.log(`  [${String(indice + 1).padStart(2)}]  ${grupo.subject}`);
        console.log(`        ${participantes} participantes`);
    });

    const terminal = readline.createInterface({ input: stdin, output: stdout });
    const resposta = (await terminal.question("\nDigite o numero do grupo que quer monitorar: ")).trim();
    terminal.close();

    const escolhido = grupos[Number(resposta) - 1];
    if (!escolhido) throw new Error(`'${resposta}' nao corresponde a nenhum grupo da lista.`);
    return escolhido;
}

function salvar(grupo) {
    const config = JSON.parse(fs.readFileSync(ARQUIVO_CONFIG, "utf8"));
    config.grupos_permitidos = [grupo.id];
    config.nomes_dos_grupos = { [grupo.id]: grupo.subject };
    fs.writeFileSync(ARQUIVO_CONFIG, JSON.stringify(config, null, 2) + "\n", "utf8");
}

async function iniciar() {
    const { state, saveCreds } = await useMultiFileAuthState(PASTA_SESSAO);
    const socket = makeWASocket({
        auth: state,
        logger: pino({ level: "silent" }),
        browser: ["Coletor de Fotos", "Chrome", "1.0.0"],
        markOnlineOnConnect: false,
        syncFullHistory: false,
    });
    socket.ev.on("creds.update", saveCreds);

    let jaRodou = false;
    socket.ev.on("connection.update", async ({ connection, qr, lastDisconnect }) => {
        if (qr) {
            console.log("\nEscaneie o QR Code em WhatsApp > Aparelhos conectados > Conectar aparelho:\n");
            qrcode.generate(qr, { small: true });
        }

        if (connection === "close") {
            const codigo = lastDisconnect?.error?.output?.statusCode;
            console.error(`\nConexao encerrada (codigo ${codigo ?? "desconhecido"}).`);
            if (!jaRodou) console.error("Se a sessao expirou, apague a pasta .baileys_sessao e rode de novo para ler um novo QR Code.");
            process.exit(jaRodou ? 0 : 1);
        }

        if (connection !== "open" || jaRodou) return;
        jaRodou = true;

        console.log("Conectado. Buscando seus grupos...");
        const encontrados = await socket.groupFetchAllParticipating();
        const grupos = Object.values(encontrados)
            .sort((a, b) => a.subject.localeCompare(b.subject, "pt-BR"));

        if (grupos.length === 0) {
            console.error("Nenhum grupo encontrado nesta conta.");
            process.exit(1);
        }

        try {
            const grupo = await escolher(grupos);
            salvar(grupo);
            console.log(`\nGrupo escolhido: ${grupo.subject}`);
            console.log(`ID: ${grupo.id}`);
            console.log(`\nGravado em config.json.`);
            console.log(`\nProximo passo: rode  npm start  e mande as fotos no grupo.`);
        } catch (erro) {
            console.error(`\n${erro.message}`);
            process.exitCode = 1;
        }
        process.exit(process.exitCode || 0);
    });
}

iniciar().catch((erro) => {
    console.error("Falha:", erro?.message || erro);
    process.exitCode = 1;
});
