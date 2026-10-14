"use strict";

// =============================================================================
// BACKUP AUTOMATICO DA CENTRAL
// =============================================================================
//
// Uma copia por dia do banco da Central (revisoes, correcoes, treino) e dos
// cadastros locais. Fica em dados/backups/<data>/ — dentro deste computador,
// porque os cadastros tem telefones. Guarda os ultimos 14 dias.
//
// O banco e copiado pela API de backup do SQLite: a copia sai consistente
// mesmo com o programa gravando ao mesmo tempo (copiar o arquivo nao e seguro).
// =============================================================================

const fs = require("fs");
const path = require("path");
const sqlite = require("node:sqlite");

const RAIZ = path.resolve(__dirname, "..");
const PASTA_BACKUPS = path.join(RAIZ, "dados", "backups");
const DIAS_GUARDADOS = 14;
const ARQUIVOS_DE_CADASTRO = [
    path.join(RAIZ, "configuracao", "pessoas.json"),
    path.join(RAIZ, "configuracao", "projetos.json"),
    path.join(RAIZ, "configuracao", "veiculos.json"),
    path.join(RAIZ, "configuracao", "cartoes.json"),
    path.join(RAIZ, "configuracao", "categorias.json"),
    path.join(RAIZ, "config.json"),
];

const dataLocal = (quando = new Date()) => {
    const d = new Date(quando.getTime() - quando.getTimezoneOffset() * 60000);
    return d.toISOString().slice(0, 10);
};

/** Faz o backup de hoje (se ainda nao existir) e apaga os mais antigos que 14 dias. */
async function fazerBackup(db, { pasta = PASTA_BACKUPS, hoje = new Date(), cadastros = ARQUIVOS_DE_CADASTRO, dias = DIAS_GUARDADOS } = {}) {
    const destino = path.join(pasta, dataLocal(hoje));
    const arquivoBanco = path.join(destino, "central.db");
    if (fs.existsSync(arquivoBanco)) return { feito: false, destino };
    fs.mkdirSync(destino, { recursive: true });
    const temporario = `${arquivoBanco}.parcial`;
    await sqlite.backup(db, temporario);
    fs.renameSync(temporario, arquivoBanco);
    for (const arquivo of cadastros) if (fs.existsSync(arquivo)) fs.copyFileSync(arquivo, path.join(destino, path.basename(arquivo)));
    const removidos = limparAntigos(pasta, hoje, dias);
    return { feito: true, destino, removidos };
}

function limparAntigos(pasta, hoje, dias) {
    const limite = dataLocal(new Date(hoje.getTime() - dias * 86400000));
    const removidos = [];
    for (const nome of fs.existsSync(pasta) ? fs.readdirSync(pasta) : []) {
        if (/^\d{4}-\d{2}-\d{2}$/.test(nome) && nome < limite) {
            fs.rmSync(path.join(pasta, nome), { recursive: true, force: true });
            removidos.push(nome);
        }
    }
    return removidos;
}

/** Backup ao abrir o programa e depois a cada 6 horas (so grava uma vez por dia). */
function agendarBackups(obterBanco, { intervaloMs = 6 * 3600 * 1000 } = {}) {
    const rodar = () => fazerBackup(obterBanco())
        .then((resultado) => { if (resultado.feito) console.log(`Backup da Central salvo em ${resultado.destino}`); })
        .catch((erro) => console.error("Backup da Central falhou:", erro?.message || erro));
    setTimeout(rodar, 30 * 1000).unref();
    setInterval(rodar, intervaloMs).unref();
}

module.exports = { fazerBackup, agendarBackups, PASTA_BACKUPS };
