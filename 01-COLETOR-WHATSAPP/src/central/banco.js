"use strict";

// =============================================================================
// BANCO DA CENTRAL (SQLite embutido do Node)
// =============================================================================
//
// Guarda o estado critico que antes ficava espalhado em JSONs soltos:
// mensagens, contexto (lotes do dia, projeto, cartao), fotos, comprovantes
// lidos em cada foto, despesas candidatas, correcoes humanas e exemplos
// validados para treino.
//
// Usa `node:sqlite` (Node >= 22.5), sem dependencia nativa para instalar.
// Toda alteracao de estrutura entra como uma nova migracao numerada.
// =============================================================================

const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");

const RAIZ = path.resolve(__dirname, "..", "..");
const CAMINHO_PADRAO = path.join(RAIZ, "dados", "central.db");

const MIGRACOES = [
    `
    CREATE TABLE mensagens (
        id INTEGER PRIMARY KEY,
        grupo_id TEXT NOT NULL,
        mensagem_id TEXT NOT NULL,
        remetente_id TEXT NOT NULL,
        remetente_nome TEXT,
        pessoa_id TEXT,
        enviada_em TEXT NOT NULL,
        texto TEXT,
        citado_id TEXT,
        tem_midia INTEGER NOT NULL DEFAULT 0,
        intencao TEXT,
        interpretacao TEXT,
        registrada_em TEXT NOT NULL,
        UNIQUE (grupo_id, mensagem_id)
    );
    CREATE INDEX idx_mensagens_contexto ON mensagens (grupo_id, remetente_id, enviada_em);

    -- Eventos de contexto sao imutaveis: uma mudanca nova "substitui" a anterior,
    -- mas a anterior continua guardada para auditoria.
    CREATE TABLE eventos_contexto (
        id INTEGER PRIMARY KEY,
        tipo TEXT NOT NULL,
        grupo_id TEXT NOT NULL,
        remetente_id TEXT NOT NULL,
        autor_pessoa_id TEXT,
        projeto_texto TEXT,
        projeto_chave TEXT,
        cartao TEXT,
        valido_desde TEXT NOT NULL,
        mensagem_ref INTEGER REFERENCES mensagens(id),
        status TEXT NOT NULL DEFAULT 'VALIDO',
        dados TEXT,
        criado_em TEXT NOT NULL
    );
    CREATE INDEX idx_eventos_busca ON eventos_contexto (tipo, grupo_id, valido_desde);

    CREATE TABLE lotes (
        id INTEGER PRIMARY KEY,
        grupo_id TEXT NOT NULL,
        remetente_id TEXT NOT NULL,
        data_declarada TEXT,
        projeto_texto TEXT,
        projeto_chave TEXT,
        cartao TEXT,
        quantidades TEXT,
        observacoes TEXT,
        mensagem_ref INTEGER REFERENCES mensagens(id),
        criado_em TEXT NOT NULL
    );
    CREATE INDEX idx_lotes_contexto ON lotes (grupo_id, remetente_id, criado_em);

    CREATE TABLE midias (
        id INTEGER PRIMARY KEY,
        sha256 TEXT NOT NULL,
        arquivo TEXT NOT NULL,
        grupo_id TEXT,
        remetente_id TEXT,
        mensagem_id TEXT,
        recebida_em TEXT NOT NULL,
        legenda TEXT,
        lote_id INTEGER REFERENCES lotes(id),
        repete_midia_id INTEGER REFERENCES midias(id),
        registrada_em TEXT NOT NULL,
        UNIQUE (arquivo)
    );
    CREATE INDEX idx_midias_hash ON midias (sha256);

    -- Um comprovante fisico lido dentro de uma foto. Uma foto pode ter varios.
    CREATE TABLE documentos (
        id INTEGER PRIMARY KEY,
        midia_id INTEGER NOT NULL REFERENCES midias(id),
        indice INTEGER NOT NULL,
        ocr TEXT NOT NULL,
        chave_nfce TEXT,
        impressao_digital TEXT,
        papel TEXT NOT NULL DEFAULT 'PRINCIPAL',
        principal_id INTEGER REFERENCES documentos(id),
        criado_em TEXT NOT NULL,
        UNIQUE (midia_id, indice)
    );
    CREATE INDEX idx_documentos_nfce ON documentos (chave_nfce);
    CREATE INDEX idx_documentos_digital ON documentos (impressao_digital);

    CREATE TABLE despesas (
        id INTEGER PRIMARY KEY,
        documento_id INTEGER REFERENCES documentos(id),
        midia_id INTEGER REFERENCES midias(id),
        mensagem_ref INTEGER REFERENCES mensagens(id),
        lote_id INTEGER REFERENCES lotes(id),
        estado TEXT NOT NULL,
        campos TEXT NOT NULL,
        pendencias TEXT NOT NULL,
        avisos TEXT NOT NULL,
        duplicada_de INTEGER REFERENCES despesas(id),
        criado_em TEXT NOT NULL,
        atualizado_em TEXT NOT NULL,
        UNIQUE (documento_id)
    );
    CREATE INDEX idx_despesas_estado ON despesas (estado);

    CREATE TABLE historico_estados (
        id INTEGER PRIMARY KEY,
        despesa_id INTEGER NOT NULL REFERENCES despesas(id),
        de TEXT,
        para TEXT NOT NULL,
        motivo TEXT,
        em TEXT NOT NULL
    );

    -- Correcao humana feita na Central. tipo_erro separa erro de LEITURA (OCR
    -- leu errado) de erro de CLASSIFICACAO (leu certo, interpretou errado).
    CREATE TABLE correcoes (
        id INTEGER PRIMARY KEY,
        despesa_id INTEGER NOT NULL REFERENCES despesas(id),
        campo TEXT NOT NULL,
        valor_anterior TEXT,
        valor_novo TEXT,
        tipo_erro TEXT NOT NULL,
        autor TEXT NOT NULL,
        em TEXT NOT NULL
    );

    -- Somente o que uma pessoa validou vira exemplo de treino.
    CREATE TABLE exemplos_treino (
        id INTEGER PRIMARY KEY,
        despesa_id INTEGER NOT NULL REFERENCES despesas(id),
        rotulos TEXT NOT NULL,
        entrada TEXT NOT NULL,
        aprovado_por TEXT NOT NULL,
        aprovado_em TEXT NOT NULL,
        UNIQUE (despesa_id)
    );

    -- Vinculo aprendido entre um id do WhatsApp (inclusive @lid) e uma pessoa
    -- do cadastro. So e criado por confirmacao humana ou por telefone exato.
    CREATE TABLE remetentes_vinculados (
        whatsapp_id TEXT PRIMARY KEY,
        pessoa_id TEXT NOT NULL,
        origem TEXT NOT NULL,
        vinculado_em TEXT NOT NULL
    );
    `,
    // 2 — Revisao na Central: a previa como a IA gerou (para medir acerto por
    // campo depois das correcoes) e quem revisou por ultimo.
    `
    ALTER TABLE despesas ADD COLUMN campos_originais TEXT;
    ALTER TABLE despesas ADD COLUMN revisado_por TEXT;
    ALTER TABLE despesas ADD COLUMN revisado_em TEXT;
    UPDATE despesas SET campos_originais = campos WHERE campos_originais IS NULL
        AND id NOT IN (SELECT despesa_id FROM correcoes);
    `,
    // 3 — Auditoria das alteracoes de cadastro feitas pela Central
    // (ex.: projeto/centro de custo criado, ativado ou com apelido novo).
    `
    CREATE TABLE alteracoes_cadastro (
        id INTEGER PRIMARY KEY,
        cadastro TEXT NOT NULL,
        chave TEXT NOT NULL,
        acao TEXT NOT NULL,
        antes TEXT,
        depois TEXT,
        autor TEXT NOT NULL,
        em TEXT NOT NULL
    );
    `,
];

function agora() { return new Date().toISOString(); }

function migrar(db) {
    db.exec("CREATE TABLE IF NOT EXISTS schema_versao (versao INTEGER NOT NULL)");
    const linha = db.prepare("SELECT versao FROM schema_versao").get();
    let versao = linha ? linha.versao : 0;
    if (!linha) db.prepare("INSERT INTO schema_versao (versao) VALUES (0)").run();
    for (; versao < MIGRACOES.length; versao += 1) {
        transacao(db, () => {
            db.exec(MIGRACOES[versao]);
            db.prepare("UPDATE schema_versao SET versao = ?").run(versao + 1);
        });
    }
}

function transacao(db, fn) {
    db.exec("BEGIN IMMEDIATE");
    try {
        const resultado = fn();
        db.exec("COMMIT");
        return resultado;
    } catch (erro) {
        db.exec("ROLLBACK");
        throw erro;
    }
}

/**
 * Abre (e migra) o banco. Use ":memory:" nos testes para nunca tocar nos dados reais.
 */
function abrir(caminho = CAMINHO_PADRAO) {
    if (caminho !== ":memory:") fs.mkdirSync(path.dirname(caminho), { recursive: true });
    const db = new DatabaseSync(caminho);
    db.exec("PRAGMA foreign_keys = ON");
    if (caminho !== ":memory:") db.exec("PRAGMA journal_mode = WAL");
    migrar(db);
    return db;
}

let compartilhado = null;
/** Conexao unica do processo principal (coletor + painel). */
function banco() {
    if (!compartilhado) compartilhado = abrir(process.env.CENTRAL_DB || CAMINHO_PADRAO);
    return compartilhado;
}

const json = (valor) => JSON.stringify(valor ?? null);
const lerJson = (texto, padrao = null) => {
    if (texto == null) return padrao;
    try { return JSON.parse(texto); } catch (_) { return padrao; }
};

module.exports = { abrir, banco, transacao, agora, json, lerJson, CAMINHO_PADRAO, MIGRACOES };
