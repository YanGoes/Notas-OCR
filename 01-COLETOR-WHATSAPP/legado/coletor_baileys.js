const fs = require("fs");
const path = require("path");
const pino = require("pino");
const qrcode = require("qrcode-terminal");

const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    downloadMediaMessage,
} = require("@whiskeysockets/baileys");

/*
|--------------------------------------------------------------------------
| CONFIGURAÇÃO
|--------------------------------------------------------------------------
*/

const PASTA_SAIDA = path.resolve(
    "C:\\Users\\vmac_\\Desktop\\FOTOS OCR PARA TESTAR\\ENTRADA_WHATSAPP"
);

const PASTA_SESSAO = path.resolve(
    ".baileys_sessao"
);

const GRUPOS_PERMITIDOS = new Set([
    "120363428228243329@g.us",
]);

const NOMES_DOS_GRUPOS = {
    "120363428228243329@g.us": "Eu e Eu",
};

const EXIGIR_LEGENDA = false;
const ACEITAR_WEBP = false;

const EXTENSOES_POR_MIME = {
    "image/jpeg": ".jpeg",
    "image/jpg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
};

/*
|--------------------------------------------------------------------------
| FUNÇÕES AUXILIARES
|--------------------------------------------------------------------------
*/

function garantirPasta() {
    fs.mkdirSync(PASTA_SAIDA, {
        recursive: true,
    });
}

function limparNome(texto) {
    return String(texto || "")
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/[<>:"/\\|?*\x00-\x1F]/g, "_")
        .replace(/\s+/g, "_")
        .replace(/_+/g, "_")
        .replace(/^_+|_+$/g, "")
        .slice(0, 100);
}

function dataParaNome(timestamp) {
    const data = new Date(Number(timestamp) * 1000);

    const ano = data.getFullYear();
    const mes = String(data.getMonth() + 1).padStart(2, "0");
    const dia = String(data.getDate()).padStart(2, "0");
    const hora = String(data.getHours()).padStart(2, "0");
    const minuto = String(data.getMinutes()).padStart(2, "0");
    const segundo = String(data.getSeconds()).padStart(2, "0");

    return `${ano}-${mes}-${dia}_${hora}-${minuto}-${segundo}`;
}

function dataParaTexto(timestamp) {
    return new Date(
        Number(timestamp) * 1000
    ).toLocaleString("pt-BR");
}

function nomeDoGrupo(idGrupo) {
    return (
        NOMES_DOS_GRUPOS[idGrupo] ||
        idGrupo ||
        "Grupo_nao_identificado"
    );
}

function grupoPermitido(idGrupo) {
    return (
        GRUPOS_PERMITIDOS.size === 0 ||
        GRUPOS_PERMITIDOS.has(idGrupo)
    );
}

function obterImagemDaMensagem(message) {
    if (message?.imageMessage) {
        return message.imageMessage;
    }

    if (
        message?.ephemeralMessage
        ?.message
        ?.imageMessage
    ) {
        return (
            message.ephemeralMessage
                .message
                .imageMessage
        );
    }

    if (
        message?.viewOnceMessage
        ?.message
        ?.imageMessage
    ) {
        return (
            message.viewOnceMessage
                .message
                .imageMessage
        );
    }

    if (
        message?.viewOnceMessageV2
        ?.message
        ?.imageMessage
    ) {
        return (
            message.viewOnceMessageV2
                .message
                .imageMessage
        );
    }

    return null;
}

/*
|--------------------------------------------------------------------------
| PROCESSAMENTO
|--------------------------------------------------------------------------
*/

async function processarMensagem(
    socket,
    mensagemCompleta
) {
    try {
        const chave = mensagemCompleta.key;
        const mensagem = mensagemCompleta.message;

        if (!mensagem || !chave) {
            return;
        }

        const idGrupo = String(
            chave.remoteJid || ""
        );

        if (!idGrupo.endsWith("@g.us")) {
            return;
        }

        if (!grupoPermitido(idGrupo)) {
            console.log(
                `Grupo não autorizado: ${idGrupo}`
            );
            return;
        }

        const imagem = obterImagemDaMensagem(
            mensagem
        );

        if (!imagem) {
            return;
        }

        const legenda = String(
            imagem.caption || ""
        ).trim();

        if (
            EXIGIR_LEGENDA &&
            !legenda
        ) {
            console.log(
                "Imagem ignorada porque está sem legenda."
            );
            return;
        }

        const mimetype =
            imagem.mimetype ||
            "image/jpeg";

        const extensao =
            EXTENSOES_POR_MIME[mimetype];

        if (!extensao) {
            console.log(
                `Tipo ignorado: ${mimetype}`
            );
            return;
        }

        if (
            mimetype === "image/webp" &&
            !ACEITAR_WEBP
        ) {
            console.log(
                "WEBP ou figurinha ignorada."
            );
            return;
        }

        console.log("");
        console.log("Imagem detectada.");
        console.log(
            `Grupo: ${nomeDoGrupo(idGrupo)}`
        );
        console.log(
            `Grupo ID: ${idGrupo}`
        );
        console.log(
            `Legenda: ${legenda || "Sem legenda"}`
        );
        console.log("Baixando mídia...");

        const buffer = await downloadMediaMessage(
            mensagemCompleta,
            "buffer",
            {},
            {
                logger: pino({
                    level: "silent",
                }),
                reuploadRequest:
                    socket.updateMediaMessage,
            }
        );

        if (!buffer) {
            console.log(
                "Não foi possível baixar a imagem."
            );
            return;
        }

        const timestamp =
            Number(
                mensagemCompleta
                    .messageTimestamp
            ) ||
            Math.floor(Date.now() / 1000);

        const remetente =
            chave.participant ||
            chave.remoteJid ||
            "nao_identificado";

        const idMensagem =
            chave.id ||
            String(Date.now());

        const nomeBase = [
            dataParaNome(timestamp),
            limparNome(
                nomeDoGrupo(idGrupo)
            ),
            limparNome(
                remetente
                    .replace("@s.whatsapp.net", "")
                    .replace("@lid", "")
            ),
            limparNome(idMensagem).slice(-24),
        ].join("_");

        const caminhoImagem = path.join(
            PASTA_SAIDA,
            `${nomeBase}${extensao}`
        );

        const caminhoTxt = path.join(
            PASTA_SAIDA,
            `${nomeBase}.txt`
        );

        const caminhoJson = path.join(
            PASTA_SAIDA,
            `${nomeBase}.json`
        );

        fs.writeFileSync(
            caminhoImagem,
            buffer
        );

        const conteudoTxt = [
            "=== DADOS DO WHATSAPP ===",
            "",
            `Data: ${dataParaTexto(timestamp)}`,
            `Grupo: ${nomeDoGrupo(idGrupo)}`,
            `ID do grupo: ${idGrupo}`,
            `Remetente: ${remetente}`,
            `Mensagem enviada por mim: ${
                chave.fromMe ? "Sim" : "Não"
            }`,
            `ID da mensagem: ${idMensagem}`,
            "",
            "=== LEGENDA / COMENTÁRIO ===",
            "",
            legenda || "Sem legenda informada.",
            "",
        ].join("\n");

        fs.writeFileSync(
            caminhoTxt,
            conteudoTxt,
            "utf8"
        );

        const metadados = {
            data: dataParaTexto(timestamp),
            timestamp,
            grupo: nomeDoGrupo(idGrupo),
            id_grupo: idGrupo,
            remetente,
            enviada_por_mim:
                Boolean(chave.fromMe),
            id_mensagem: idMensagem,
            legenda: legenda || null,
            arquivo_imagem:
                path.basename(caminhoImagem),
            arquivo_txt:
                path.basename(caminhoTxt),
            mimetype,
        };

        fs.writeFileSync(
            caminhoJson,
            JSON.stringify(
                metadados,
                null,
                2
            ),
            "utf8"
        );

        console.log("");
        console.log(
            "========================================"
        );
        console.log("NOTA RECEBIDA E SALVA");
        console.log(
            "========================================"
        );
        console.log(
            `Imagem: ${caminhoImagem}`
        );
        console.log(
            `TXT: ${caminhoTxt}`
        );
        console.log(
            `JSON: ${caminhoJson}`
        );
        console.log("");

    } catch (erro) {
        console.error("");
        console.error(
            "Erro ao processar mensagem:"
        );
        console.error(
            erro?.stack || erro
        );
    }
}

/*
|--------------------------------------------------------------------------
| CONEXÃO
|--------------------------------------------------------------------------
*/

async function iniciar() {
    garantirPasta();

    console.log("Iniciando o coletor Baileys...");

    garantirPasta();

    const {
        state,
        saveCreds,
    } = await useMultiFileAuthState(
        PASTA_SESSAO
    );

    console.log("Criando conexão com o WhatsApp...");

const socket = makeWASocket({
    auth: state,

    logger: pino({
        level: "silent",
    }),

    browser: [
        "Coletor de Notas",
        "Chrome",
        "1.0.0",
    ],

    markOnlineOnConnect: false,
    syncFullHistory: false,
});

    socket.ev.on(
        "creds.update",
        saveCreds
    );

    socket.ev.on(
    "connection.update",
    async (atualizacao) => {
        const {
            connection,
            lastDisconnect,
            qr,
            isNewLogin,
        } = atualizacao;

        /*
         * Nas versões atuais, o QR chega por este evento.
         */
        if (qr) {
            console.log("");
            console.log("========================================");
            console.log("ESCANEIE O QR CODE");
            console.log("========================================");
            console.log(
                "No celular: WhatsApp > Aparelhos conectados " +
                "> Conectar aparelho"
            );
            console.log("");

            qrcode.generate(qr, {
                small: true,
            });
        }

        if (connection === "connecting") {
            console.log(
                "Conectando aos servidores do WhatsApp..."
            );
        }

        if (isNewLogin) {
            console.log(
                "Novo aparelho vinculado. Finalizando a conexão..."
            );
        }

        if (connection === "open") {
            console.log("");
            console.log(
                "========================================"
            );
            console.log(
                "COLETOR DE NOTAS ATIVO"
            );
            console.log(
                "========================================"
            );
            console.log(
                `Pasta de saída: ${PASTA_SAIDA}`
            );
            console.log(
                `Grupos permitidos: ${
                    GRUPOS_PERMITIDOS.size
                }`
            );
            console.log(
                "Aguardando novas imagens..."
            );
        }

        if (connection === "close") {
            const erroDesconexao =
                lastDisconnect?.error;

            const codigo =
                erroDesconexao?.output?.statusCode ||
                erroDesconexao?.statusCode;

            const foiDeslogado =
                codigo === DisconnectReason.loggedOut;

            console.log("");
            console.log(
                `Conexão encerrada. Código: ${
                    codigo || "desconhecido"
                }`
            );

            if (!foiDeslogado) {
                console.log(
                    "Tentando reconectar em 3 segundos..."
                );

                setTimeout(() => {
                    iniciar().catch((erro) => {
                        console.error(
                            "Falha ao reconectar:",
                            erro?.stack || erro
                        );
                    });
                }, 3000);
            } else {
                console.log(
                    "O WhatsApp desconectou esta sessão."
                );
                console.log(
                    "Apague a pasta .baileys_sessao e execute novamente."
                );
            }
        }
    }
);

    socket.ev.on(
        "messages.upsert",
        async ({ messages }) => {
            for (
                const mensagem of messages
            ) {
                await processarMensagem(
                    socket,
                    mensagem
                );
            }
        }
    );
}

iniciar().catch((erro) => {
    console.error(
        "Erro ao iniciar o coletor:"
    );
    console.error(
        erro?.stack || erro
    );
});