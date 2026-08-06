const fs = require("fs");
const path = require("path");
const qrcode = require("qrcode-terminal");
const { Client, LocalAuth } = require("whatsapp-web.js");

/*
|--------------------------------------------------------------------------
| CONFIGURAÇÃO
|--------------------------------------------------------------------------
*/

const PASTA_SAIDA = path.resolve(
    "C:\\Users\\vmac_\\Desktop\\FOTOS OCR PARA TESTAR\\ENTRADA_WHATSAPP"
);

/*
 * Grupo autorizado para o teste.
 */
const GRUPOS_PERMITIDOS = new Set([
    "120363428228243329@g.us",
]);

/*
 * Nome amigável do grupo.
 */
const NOMES_DOS_GRUPOS = {
    "120363428228243329@g.us": "Eu e Eu",
};

const SOMENTE_GRUPOS = true;

/*
 * false permite capturar fotos enviadas por você mesmo.
 */
const IGNORAR_MENSAGENS_PROPRIAS = false;

/*
 * false permite foto sem legenda.
 */
const EXIGIR_LEGENDA = false;

/*
 * false evita salvar figurinhas.
 */
const ACEITAR_WEBP = false;

const EXTENSOES_POR_MIME = {
    "image/jpeg": ".jpeg",
    "image/jpg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
};

/*
 * Impede que a mesma mensagem seja processada simultaneamente
 * pelos eventos message e message_create.
 */
const MENSAGENS_EM_PROCESSAMENTO = new Set();

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
    const data = new Date(timestamp * 1000);

    const ano = data.getFullYear();
    const mes = String(data.getMonth() + 1).padStart(2, "0");
    const dia = String(data.getDate()).padStart(2, "0");
    const hora = String(data.getHours()).padStart(2, "0");
    const minuto = String(data.getMinutes()).padStart(2, "0");
    const segundo = String(data.getSeconds()).padStart(2, "0");

    return `${ano}-${mes}-${dia}_${hora}-${minuto}-${segundo}`;
}

function dataParaTexto(timestamp) {
    return new Date(timestamp * 1000).toLocaleString(
        "pt-BR",
        {
            dateStyle: "short",
            timeStyle: "medium",
        }
    );
}

function obterIdMensagem(mensagem) {
    return (
        mensagem.id?._serialized ||
        mensagem.id?.id ||
        `${mensagem.timestamp || Date.now()}_` +
        `${mensagem.from || ""}_${mensagem.to || ""}`
    );
}

/*
 * Não usa getChat() nem getChatById().
 *
 * Para mensagens recebidas, o ID do grupo costuma estar em from.
 * Para mensagens enviadas por você, costuma estar em to.
 */
function descobrirIdGrupo(mensagem) {
    const origem = String(mensagem.from || "");
    const destino = String(mensagem.to || "");

    if (origem.endsWith("@g.us")) {
        return origem;
    }

    if (destino.endsWith("@g.us")) {
        return destino;
    }

    return "";
}

function grupoPermitido(idGrupo) {
    return (
        GRUPOS_PERMITIDOS.size === 0 ||
        GRUPOS_PERMITIDOS.has(idGrupo)
    );
}

function nomeDoGrupo(idGrupo) {
    return (
        NOMES_DOS_GRUPOS[idGrupo] ||
        idGrupo ||
        "Grupo_nao_identificado"
    );
}

function arquivoJaExiste(nomeBase) {
    return Object.values(EXTENSOES_POR_MIME).some(
        (extensao) =>
            fs.existsSync(
                path.join(
                    PASTA_SAIDA,
                    `${nomeBase}${extensao}`
                )
            )
    );
}

function esperar(milissegundos) {
    return new Promise(
        (resolve) => setTimeout(resolve, milissegundos)
    );
}

/*
 * Tenta baixar a foto até três vezes.
 */
async function baixarMidiaComTentativas(
    mensagem,
    tentativas = 3
) {
    let ultimoErro = null;

    for (
        let tentativa = 1;
        tentativa <= tentativas;
        tentativa += 1
    ) {
        try {
            const midia = await mensagem.downloadMedia();

            if (midia?.data) {
                return midia;
            }
        } catch (erro) {
            ultimoErro = erro;
        }

        if (tentativa < tentativas) {
            const esperaSegundos = tentativa * 2;

            console.log(
                `Nova tentativa de download em ` +
                `${esperaSegundos}s...`
            );

            await esperar(esperaSegundos * 1000);
        }
    }

    if (ultimoErro) {
        throw ultimoErro;
    }

    return null;
}

/*
|--------------------------------------------------------------------------
| PROCESSAMENTO DA MENSAGEM
|--------------------------------------------------------------------------
*/

async function processarMensagem(mensagem, evento) {
    const idMensagemCompleto = obterIdMensagem(mensagem);

    if (
        MENSAGENS_EM_PROCESSAMENTO.has(
            idMensagemCompleto
        )
    ) {
        return;
    }

    MENSAGENS_EM_PROCESSAMENTO.add(
        idMensagemCompleto
    );

    try {
        if (!mensagem.hasMedia) {
            return;
        }

        if (
            IGNORAR_MENSAGENS_PROPRIAS &&
            mensagem.fromMe
        ) {
            return;
        }

        const idGrupo = descobrirIdGrupo(mensagem);

        if (SOMENTE_GRUPOS && !idGrupo) {
            console.log(
                "Imagem ignorada: não pertence a um grupo."
            );
            return;
        }

        if (
            idGrupo &&
            !grupoPermitido(idGrupo)
        ) {
            console.log("");
            console.log(
                "Imagem recebida em grupo não autorizado."
            );
            console.log(
                `ID detectado: ${idGrupo}`
            );
            return;
        }

        const legenda = String(
            mensagem.body || ""
        ).trim();

        if (
            EXIGIR_LEGENDA &&
            !legenda
        ) {
            console.log(
                "Imagem ignorada porque não possui legenda."
            );
            return;
        }

        console.log("");
        console.log("Imagem detectada.");
        console.log(`Evento: ${evento}`);
        console.log(
            `Grupo: ${nomeDoGrupo(idGrupo)}`
        );
        console.log(
            `Grupo ID: ${idGrupo || "não identificado"}`
        );
        console.log(
            `Enviada por mim: ${
                mensagem.fromMe ? "Sim" : "Não"
            }`
        );
        console.log(
            `Legenda: ${legenda || "Sem legenda"}`
        );
        console.log("Baixando mídia...");

        const midia = await baixarMidiaComTentativas(
            mensagem
        );

        if (!midia?.data) {
            console.log(
                "Não foi possível baixar a imagem."
            );
            return;
        }

        const extensao =
            EXTENSOES_POR_MIME[midia.mimetype];

        if (!extensao) {
            console.log(
                `Tipo de mídia ignorado: ${
                    midia.mimetype || "desconhecido"
                }`
            );
            return;
        }

        if (
            midia.mimetype === "image/webp" &&
            !ACEITAR_WEBP
        ) {
            console.log(
                "Imagem WEBP ou figurinha ignorada."
            );
            return;
        }

        /*
         * Não usa getContact().
         *
         * Em grupos, author normalmente contém o remetente.
         * Para mensagens próprias, pode ficar vazio.
         */
        const remetenteId = String(
            mensagem.author ||
            (
                mensagem.fromMe
                    ? "proprio_numero"
                    : mensagem.from
            ) ||
            "nao_identificado"
        );

        const nomeGrupo = nomeDoGrupo(idGrupo);
        const dataNome = dataParaNome(
            mensagem.timestamp
        );

        const idCurto = limparNome(
            idMensagemCompleto
        ).slice(-24);

        const remetenteLimpo = limparNome(
            remetenteId
                .replace("@c.us", "")
                .replace("@lid", "")
        ) || "remetente";

        const nomeBase = [
            dataNome,
            limparNome(nomeGrupo),
            remetenteLimpo,
            idCurto,
        ].join("_");

        if (arquivoJaExiste(nomeBase)) {
            console.log(
                `Mensagem já salva: ${nomeBase}`
            );
            return;
        }

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
            Buffer.from(
                midia.data,
                "base64"
            )
        );

        const conteudoTxt = [
            "=== DADOS DO WHATSAPP ===",
            "",
            `Data: ${dataParaTexto(
                mensagem.timestamp
            )}`,
            `Grupo: ${nomeGrupo}`,
            `ID do grupo: ${
                idGrupo || "Não identificado"
            }`,
            `Remetente: ${remetenteId}`,
            `Mensagem enviada por mim: ${
                mensagem.fromMe ? "Sim" : "Não"
            }`,
            `ID da mensagem: ${idMensagemCompleto}`,
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
            data: dataParaTexto(
                mensagem.timestamp
            ),
            timestamp: mensagem.timestamp,
            grupo: nomeGrupo,
            id_grupo: idGrupo || null,
            remetente: remetenteId,
            enviada_por_mim: Boolean(
                mensagem.fromMe
            ),
            evento,
            id_mensagem: idMensagemCompleto,
            legenda: legenda || null,
            arquivo_imagem:
                path.basename(caminhoImagem),
            arquivo_txt:
                path.basename(caminhoTxt),
            mimetype: midia.mimetype,
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
        console.log(`Grupo: ${nomeGrupo}`);
        console.log(
            `ID: ${idGrupo || "não identificado"}`
        );
        console.log(
            `Legenda: ${legenda || "Sem legenda"}`
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
    } finally {
        /*
         * Mantém o ID protegido por um minuto para evitar
         * processamento duplicado.
         */
        setTimeout(() => {
            MENSAGENS_EM_PROCESSAMENTO.delete(
                idMensagemCompleto
            );
        }, 60000);
    }
}

/*
|--------------------------------------------------------------------------
| CLIENTE DO WHATSAPP
|--------------------------------------------------------------------------
*/

garantirPasta();

const cliente = new Client({
    authStrategy: new LocalAuth({
        clientId: "coletor-notas",
        dataPath: path.resolve(
            ".whatsapp_sessao"
        ),
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
    console.log("");
    console.log("Escaneie o QR Code:");
    console.log(
        "WhatsApp > Aparelhos conectados " +
        "> Conectar aparelho"
    );
    console.log("");

    qrcode.generate(
        qr,
        {
            small: true,
        }
    );
});

cliente.on("authenticated", () => {
    console.log(
        "WhatsApp autenticado."
    );
});

cliente.on("ready", () => {
    console.log("");
    console.log(
        "========================================"
    );
    console.log("COLETOR DE NOTAS ATIVO");
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
        `Captura mensagens próprias: ${
            IGNORAR_MENSAGENS_PROPRIAS
                ? "Não"
                : "Sim"
        }`
    );
    console.log(
        "Aguardando novas imagens..."
    );
});

/*
 * Recebe fotos enviadas por outras pessoas.
 */
cliente.on(
    "message",
    async (mensagem) => {
        if (mensagem.fromMe) {
            return;
        }

        await processarMensagem(
            mensagem,
            "message"
        );
    }
);

/*
 * Recebe fotos enviadas pelo próprio número conectado.
 */
cliente.on(
    "message_create",
    async (mensagem) => {
        if (!mensagem.fromMe) {
            return;
        }

        await processarMensagem(
            mensagem,
            "message_create"
        );
    }
);

cliente.on(
    "auth_failure",
    (mensagem) => {
        console.error(
            "Falha na autenticação:",
            mensagem
        );
    }
);

cliente.on(
    "disconnected",
    (motivo) => {
        console.error(
            "WhatsApp desconectado:",
            motivo
        );
    }
);

/*
 * Encerra corretamente ao pressionar Ctrl + C.
 */
process.on(
    "SIGINT",
    async () => {
        console.log(
            "\nEncerrando o coletor..."
        );

        try {
            await cliente.destroy();
        } catch (_) {
            // Ignora falhas durante o encerramento.
        }

        process.exit(0);
    }
);

cliente.initialize();