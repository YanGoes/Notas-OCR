"use strict";

const path = require("path");
const pino = require("pino");
const qrcode = require("qrcode-terminal");
const { default: makeWASocket, useMultiFileAuthState } = require("@whiskeysockets/baileys");

const pastaSessao = path.resolve(__dirname, "..", ".baileys_sessao");

async function iniciar() {
    const { state, saveCreds } = await useMultiFileAuthState(pastaSessao);
    const socket = makeWASocket({
        auth: state,
        logger: pino({ level: "silent" }),
        browser: ["Listador de Grupos", "Chrome", "1.0.0"],
        markOnlineOnConnect: false,
    });
    socket.ev.on("creds.update", saveCreds);
    socket.ev.on("connection.update", async ({ connection, qr }) => {
        if (qr) {
            console.log("Escaneie o QR Code:");
            qrcode.generate(qr, { small: true });
        }
        if (connection === "open") {
            const grupos = await socket.groupFetchAllParticipating();
            console.log("\nGRUPOS ENCONTRADOS\n");
            Object.values(grupos)
                .sort((a, b) => a.subject.localeCompare(b.subject, "pt-BR"))
                .forEach((grupo) => console.log(`${grupo.subject}\n  ${grupo.id}\n`));
            console.log("Copie os IDs desejados para config.json. Pressione Ctrl+C para sair.");
        }
    });
}

iniciar().catch((erro) => {
    console.error("Erro ao listar grupos:", erro?.stack || erro);
    process.exitCode = 1;
});
