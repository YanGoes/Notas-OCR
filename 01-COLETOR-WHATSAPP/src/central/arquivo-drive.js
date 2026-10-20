"use strict";

// =============================================================================
// ARQUIVO DAS FOTOS NO GOOGLE DRIVE (notas aprovadas na Central)
// =============================================================================
//
// Copia a foto de cada nota aprovada para a pasta do operador, no mes e no dia
// da nota. O desenho das pastas vem do config (central.arquivo_drive.modelo):
//
//   pasta de teste:  "{operador}/{mm}-{aa}/{dd}"                        -> Almir\01-26\05
//   pasta oficial:   "{ano}/Despesas de Campo {ano}/{operador}/{mm}.{aa}/{dd}"
//
// O Drive para computador sincroniza a pasta sozinho: aqui e so copia de
// arquivo. O original nunca sai do programa. Cada foto copiada fica anotada em
// arquivos_drive; se a nota for corrigida depois (outra data, outro operador),
// a copia e movida para a pasta nova na proxima rodada.
// =============================================================================

const fs = require("fs");
const path = require("path");

const RAIZ = path.resolve(__dirname, "..", "..");
const PASTAS_IMAGEM = ["entrada", "simulacao", "revisao", "bloqueados", "erros", "enviados", "importados"];
const MODELO_PADRAO = "{ano}/Despesas de Campo {ano}/{operador}/{mm}.{aa}/{dd}";

const normalizar = (texto) => String(texto || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
const nomeSeguro = (texto) => String(texto || "").replace(/[<>:"/\\|?*\x00-\x1F]/g, "_").replace(/\s+/g, " ").trim().replace(/[. ]+$/, "");

function lerConfig() {
    try { return JSON.parse(fs.readFileSync(path.join(RAIZ, "config.json"), "utf8")); } catch (_) { return {}; }
}

function localizarFoto(arquivo) {
    if (!arquivo || path.basename(arquivo) !== arquivo) return null;
    for (const pasta of PASTAS_IMAGEM) {
        const caminho = path.join(RAIZ, "dados", pasta, arquivo);
        if (fs.existsSync(caminho)) return caminho;
    }
    return null;
}

function listarPastas(caminho) {
    try { return fs.readdirSync(caminho, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch (_) { return []; }
}

/** Distancia de edicao (para "Jhonathan" achar a pasta "Jonathan"). */
function distancia(a, b) {
    const linha = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i += 1) {
        let anterior = linha[0];
        linha[0] = i;
        for (let j = 1; j <= b.length; j += 1) {
            const guardado = linha[j];
            linha[j] = Math.min(linha[j] + 1, linha[j - 1] + 1, anterior + (a[i - 1] === b[j - 1] ? 0 : 1));
            anterior = guardado;
        }
    }
    return linha[b.length];
}

/**
 * Pasta existente do operador: nome igual > pasta contida no nome ("Vitor
 * Ponce Ferreira" -> "Vitor Ponce") > mesmo primeiro nome (so se for unico) >
 * grafia parecida (1 letra de diferenca, so se for unica). Senao, pasta nova
 * com o nome do cadastro.
 */
function pastaDoOperador(nome, existentes) {
    const alvo = normalizar(nome);
    if (!alvo) return null;
    const partes = alvo.split(" ");
    const exata = existentes.find((p) => normalizar(p) === alvo);
    if (exata) return { pasta: exata, como: "nome igual" };
    const contida = existentes.filter((p) => normalizar(p).split(" ").every((x) => partes.includes(x)))
        .sort((a, b) => normalizar(b).length - normalizar(a).length)[0];
    if (contida) return { pasta: contida, como: "nome contido" };
    const mesmoPrimeiro = existentes.filter((p) => normalizar(p).split(" ")[0] === partes[0]);
    if (mesmoPrimeiro.length === 1) return { pasta: mesmoPrimeiro[0], como: "primeiro nome" };
    if (partes[0].length >= 5) {
        const parecidas = existentes.filter((p) => distancia(normalizar(p).split(" ")[0], partes[0]) <= 1);
        if (parecidas.length === 1) return { pasta: parecidas[0], como: `grafia parecida (${nome})` };
    }
    return { pasta: nomeSeguro(nome), como: "pasta nova", nova: true };
}

/** Separa o modelo nas partes antes do operador, o operador e as depois. */
function partesDoModelo(modelo) {
    const partes = String(modelo || MODELO_PADRAO).split(/[\\/]+/).filter(Boolean);
    const indice = partes.findIndex((p) => p.includes("{operador}"));
    if (indice < 0) throw new Error("O modelo de pastas precisa ter {operador}.");
    return { antes: partes.slice(0, indice), depois: partes.slice(indice + 1) };
}

function preencher(parte, data) {
    const [ano, mm, dd] = data.split("-");
    return nomeSeguro(parte.replace(/\{ano\}/g, ano).replace(/\{aa\}/g, ano.slice(-2)).replace(/\{mm\}/g, mm).replace(/\{dd\}/g, dd));
}

/** Caminho de destino (sem criar nada). */
function destinoDe({ raiz, modelo, data, operador }) {
    const { antes, depois } = partesDoModelo(modelo);
    const base = path.join(raiz, ...antes.map((p) => preencher(p, data)));
    const resolvido = pastaDoOperador(operador, listarPastas(base));
    return { pasta: path.join(base, resolvido.pasta, ...depois.map((p) => preencher(p, data))), operador: resolvido };
}

/** Nome do arquivo no Drive: numero(s) da nota, tipo e valor, para achar facil. */
function nomeDoArquivo(despesas, arquivoOriginal) {
    const ext = path.extname(arquivoOriginal || "").toLowerCase() || ".jpg";
    const ids = despesas.map((d) => d.id).join("-");
    const tipo = String(despesas[0].tipo || "NOTA").replaceAll("_", " ");
    const total = despesas.reduce((soma, d) => soma + (Number(d.valor) || 0), 0);
    const valor = total ? ` R$ ${total.toFixed(2).replace(".", ",")}` : "";
    return nomeSeguro(`#${ids} ${tipo}${valor}`) + ext;
}

/**
 * Fotos das notas aprovadas, uma entrada por foto (uma foto pode ter 2 notas),
 * com o operador (cadastro > nome no WhatsApp) e a data da nota.
 */
function fotosParaArquivar(db, cad) {
    const nomes = new Map((cad?.pessoas || []).map((p) => [p.id, p.nome]));
    const linhas = db.prepare(`SELECT d.id, d.midia_id, d.campos, m.arquivo, m.recebida_em, msg.pessoa_id, msg.remetente_nome
        FROM despesas d JOIN midias m ON m.id = d.midia_id LEFT JOIN mensagens msg ON msg.id = d.mensagem_ref
        WHERE d.estado = 'APROVADO' ORDER BY d.midia_id, d.id`).all();
    const porMidia = new Map();
    for (const l of linhas) {
        const c = JSON.parse(l.campos);
        if (c.sem_comprovante?.valor) continue;
        const pessoaId = l.pessoa_id || c.remetente?.pessoa_id || null;
        const operador = nomes.get(pessoaId) || c.remetente?.valor || l.remetente_nome || null;
        const data = /^\d{4}-\d{2}-\d{2}$/.test(c.data_competencia?.valor || "") ? c.data_competencia.valor : String(l.recebida_em || "").slice(0, 10);
        const item = porMidia.get(l.midia_id) || { midia_id: l.midia_id, arquivo: l.arquivo, operador, data, despesas: [] };
        item.despesas.push({ id: l.id, tipo: c.tipo?.valor || null, valor: c.valor?.valor ?? null });
        porMidia.set(l.midia_id, item);
    }
    return [...porMidia.values()];
}

/**
 * Copia (ou move, se a nota mudou) as fotos que faltam. Nunca derruba nada:
 * erro de uma foto vira linha no relatorio e a proxima rodada tenta de novo.
 */
function arquivarPendentes(db, cad, { config = lerConfig(), simular = false, localizar = localizarFoto } = {}) {
    const opcoes = config.central?.arquivo_drive || {};
    const relatorio = { copiadas: [], movidas: [], ja_estavam: 0, erros: [], pastas_novas: [], operadores: {} };
    if (!opcoes.habilitado) return { ...relatorio, desligado: true };
    const raiz = String(opcoes.raiz || "");
    if (!raiz || !fs.existsSync(raiz)) return { ...relatorio, erro: `Pasta do Drive indisponível: ${raiz || "(não configurada)"}. Verifique se o Google Drive está aberto.` };
    const pastaSemOperador = opcoes.pasta_nao_identificado || "Nao identificado";
    const registro = db.prepare("SELECT * FROM arquivos_drive WHERE midia_id = ? AND raiz = ?");
    for (const foto of fotosParaArquivar(db, cad)) {
        try {
            const origem = localizar(foto.arquivo);
            if (!origem) throw new Error(`foto não encontrada (${foto.arquivo})`);
            if (!/^\d{4}-\d{2}-\d{2}$/.test(foto.data)) throw new Error("nota sem data");
            const destino = destinoDe({ raiz, modelo: opcoes.modelo, data: foto.data, operador: foto.operador || pastaSemOperador });
            const caminho = path.join(destino.pasta, nomeDoArquivo(foto.despesas, foto.arquivo));
            const anterior = registro.get(foto.midia_id, raiz);
            if (anterior && anterior.caminho === caminho && fs.existsSync(caminho)) { relatorio.ja_estavam += 1; continue; }
            const linha = { despesas: foto.despesas.map((d) => d.id), operador: destino.operador.pasta, como: destino.operador.como, data: foto.data, caminho: path.relative(raiz, caminho) };
            if (destino.operador.nova && !relatorio.pastas_novas.includes(destino.operador.pasta)) relatorio.pastas_novas.push(destino.operador.pasta);
            relatorio.operadores[destino.operador.pasta] = (relatorio.operadores[destino.operador.pasta] || 0) + 1;
            if (simular) { relatorio.copiadas.push(linha); continue; }
            fs.mkdirSync(destino.pasta, { recursive: true });
            const moveu = anterior && anterior.caminho !== caminho && fs.existsSync(anterior.caminho);
            if (moveu) fs.renameSync(anterior.caminho, caminho);
            else fs.copyFileSync(origem, caminho);
            if (fs.statSync(caminho).size !== fs.statSync(origem).size) throw new Error("a cópia no Drive ficou com tamanho diferente do original");
            db.prepare(`INSERT INTO arquivos_drive (midia_id, raiz, caminho, despesas, em) VALUES (?, ?, ?, ?, ?)
                ON CONFLICT (midia_id, raiz) DO UPDATE SET caminho = excluded.caminho, despesas = excluded.despesas, em = excluded.em`)
                .run(foto.midia_id, raiz, caminho, JSON.stringify(linha.despesas), new Date().toISOString());
            (moveu ? relatorio.movidas : relatorio.copiadas).push(linha);
        } catch (erro) {
            relatorio.erros.push({ despesas: foto.despesas.map((d) => d.id), erro: erro.message });
        }
    }
    return relatorio;
}

/** Roda sozinho de tempos em tempos (Drive fechado: tenta de novo depois). */
function agendar(obterBanco, obterCadastros, { intervaloMs = 10 * 60 * 1000 } = {}) {
    const rodar = () => {
        try {
            const r = arquivarPendentes(obterBanco(), obterCadastros());
            if (r.desligado) return;
            if (r.erro) console.error(`Arquivo no Drive: ${r.erro}`);
            else if (r.copiadas.length || r.movidas.length || r.erros.length) {
                console.log(`Arquivo no Drive: ${r.copiadas.length} copiada(s), ${r.movidas.length} movida(s), ${r.erros.length} erro(s).`);
            }
        } catch (erro) { console.error("Arquivo no Drive falhou:", erro?.message || erro); }
    };
    setTimeout(rodar, 60 * 1000).unref();
    setInterval(rodar, intervaloMs).unref();
}

module.exports = { arquivarPendentes, fotosParaArquivar, destinoDe, pastaDoOperador, nomeDoArquivo, partesDoModelo, agendar, MODELO_PADRAO };
