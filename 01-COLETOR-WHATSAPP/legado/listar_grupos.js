const path = require("path");
const qrcode = require("qrcode-terminal");
const { Client, LocalAuth } = require("whatsapp-web.js");

const cliente = new Client({
    authStrategy: new LocalAuth({
        clientId: "coletor-notas",
        dataPath: path.resolve(".whatsapp_sessao"),
    }),

    puppeteer: {
        headless: false,
        args: [
            "--no-sandbox",
            "--disable-setuid-sandbox",
        ],
    },
});

cliente.on("qr", (qr) => {
    console.log("\nEscaneie o QR Code:\n");
    qrcode.generate(qr, { small: true });
});

cliente.on("authenticated", () => {
    console.log("WhatsApp autenticado.");
});

cliente.on("ready", () => {
    console.log("\n========================================");
    console.log("IDENTIFICADOR ATIVO");
    console.log("========================================");
    console.log("Envie uma mensagem no grupo Eu e Eu.");
    console.log("Aguardando mensagens...\n");
});

function mostrarMensagem(mensagem, evento) {
    try {
        const origem = String(mensagem.from || "");
        const destino = String(mensagem.to || "");

        /*
         * Para mensagens recebidas, o grupo costuma estar em from.
         * Para mensagens enviadas por você, costuma estar em to.
         */
        const idGrupo = origem.endsWith("@g.us")
            ? origem
            : destino.endsWith("@g.us")
                ? destino
                : null;

        console.log("\nMENSAGEM DETECTADA");
        console.log(`Evento: ${evento}`);
        console.log(`Enviada por mim: ${mensagem.fromMe}`);
        console.log(`From: ${origem}`);
        console.log(`To: ${destino}`);
        console.log(`Texto: ${mensagem.body || "(sem texto)"}`);

        if (idGrupo) {
            console.log("");
            console.log("GRUPO IDENTIFICADO");
            console.log(`ID: ${idGrupo}`);
        } else {
            console.log("Esta mensagem não foi identificada como grupo.");
        }

        console.log("----------------------------------------");

    } catch (erro) {
        console.error("Erro:", erro);
    }
}

cliente.on("message", (mensagem) => {
    mostrarMensagem(mensagem, "message");
});

cliente.on("message_create", (mensagem) => {
    mostrarMensagem(mensagem, "message_create");
});

cliente.on("message_ciphertext", (mensagem) => {
    console.log("Mensagem criptografada detectada.");
});

cliente.on("auth_failure", (erro) => {
    console.error("Falha de autenticação:", erro);
});

cliente.on("disconnected", (motivo) => {
    console.error("Desconectado:", motivo);
});

cliente.initialize();