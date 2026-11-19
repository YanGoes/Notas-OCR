"use strict";

// =============================================================================
// QUAL MENSAGEM DO WHATSAPP E UMA NOTA
// =============================================================================
//
// Foto (imageMessage) ou nota mandada como DOCUMENTO (documentMessage): PDF ou
// imagem enviada "como arquivo". Outros documentos (planilha, Word...) nao sao
// nota. Desembrulha mensagem temporaria, visualizacao unica e documento com
// legenda. Devolve o objeto da midia (com caption e mimetype) ou null.
// =============================================================================

const TIPOS_DE_DOCUMENTO = /^(application\/pdf|image\/(jpe?g|png|webp))$/;

function mimetypeLimpo(valor) {
    return String(valor || "").split(";")[0].trim().toLowerCase();
}

function midiaDaNota(message) {
    let atual = message;
    for (let i = 0; i < 5 && atual; i += 1) {
        if (atual.imageMessage) return atual.imageMessage;
        const documento = atual.documentMessage;
        if (documento && TIPOS_DE_DOCUMENTO.test(mimetypeLimpo(documento.mimetype))) {
            return { caption: documento.caption, fileName: documento.fileName, mimetype: mimetypeLimpo(documento.mimetype) };
        }
        const envelope = atual.ephemeralMessage || atual.viewOnceMessage || atual.viewOnceMessageV2 || atual.documentWithCaptionMessage;
        atual = envelope?.message;
    }
    return null;
}

module.exports = { midiaDaNota };
