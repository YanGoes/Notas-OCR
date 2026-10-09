"use strict";

// =============================================================================
// REVISAO NA CENTRAL — correcao humana, aprovacao e exemplos de treino
// =============================================================================
//
// Regras do dossie aplicadas aqui:
//   - so o que uma PESSOA aprovou vira exemplo de treino (nunca palpite da IA);
//   - cada correcao diz se o erro foi de LEITURA (o OCR leu errado) ou de
//     CLASSIFICACAO (leu certo, interpretou errado);
//   - aprovar NAO lanca nada no Conta Azul nem copia nada para o Drive.
// =============================================================================

const { agora, json, lerJson, transacao } = require("./banco");
const cadastros = require("./cadastros");
const contexto = require("./contexto");
const { lerDespesa, regenerarPrevia, registrarHistorico, ESTADOS_REGERAVEIS } = require("./orquestrador");
const { TIPOS, descricaoAbastecimento, descricaoRefeicao } = require("./regras-vmac");
const { normalizar } = require("./texto");

const TIPOS_ERRO = ["LEITURA", "CLASSIFICACAO"];
const ESTADOS = {
    AGUARDANDO_REVISAO: "AGUARDANDO_REVISAO",
    CLASSIFICADO: "CLASSIFICADO",
    APROVADO: "APROVADO",
    BLOQUEADO_DUPLICADO: "BLOQUEADO_DUPLICADO",
    DESCARTADO: "DESCARTADO",
};
const EDITAVEIS = [ESTADOS.AGUARDANDO_REVISAO, ESTADOS.CLASSIFICADO];

/**
 * Campos que a Central deixa corrigir. `caminho` aponta para o valor dentro de
 * `despesas.campos`; `erro` e o tipo de erro sugerido (a pessoa pode trocar).
 */
const CAMPOS = {
    data_competencia: { rotulo: "Data da compra", caminho: ["data_competencia", "valor"], erro: "LEITURA", tipo: "data" },
    valor: { rotulo: "Valor", caminho: ["valor", "valor"], erro: "LEITURA", tipo: "numero" },
    fornecedor: { rotulo: "Fornecedor", caminho: ["fornecedor", "valor"], erro: "LEITURA", tipo: "texto" },
    litros: { rotulo: "Litros", caminho: ["abastecimento", "litros", "valor"], erro: "LEITURA", tipo: "numero" },
    odometro: { rotulo: "Hodômetro", caminho: ["abastecimento", "odometro", "valor"], erro: "LEITURA", tipo: "inteiro" },
    placa: { rotulo: "Placa", caminho: ["abastecimento", "placa", "valor"], erro: "LEITURA", tipo: "placa" },
    tipo: { rotulo: "Tipo", caminho: ["tipo", "valor"], erro: "CLASSIFICACAO", tipo: "tipo" },
    pessoas: { rotulo: "Pessoas", caminho: ["pessoas", "valor"], erro: "CLASSIFICACAO", tipo: "inteiro" },
    descricao: { rotulo: "Descrição", caminho: ["descricao", "valor"], erro: "CLASSIFICACAO", tipo: "texto" },
    categoria: { rotulo: "Categoria", caminho: ["categoria", "nome"], erro: "CLASSIFICACAO", tipo: "categoria" },
    centro_custo: { rotulo: "Centro de custo", caminho: ["centro_custo", "nome"], erro: "CLASSIFICACAO", tipo: "centro" },
    pagamento: { rotulo: "Pagamento", caminho: ["pagamento", "cartao"], erro: "CLASSIFICACAO", tipo: "pagamento" },
};
const OBRIGATORIOS_PARA_APROVAR = ["data_competencia", "valor", "tipo", "descricao", "categoria", "centro_custo"];

// ---------------------------------------------------------------------------
// Utilitarios de caminho
// ---------------------------------------------------------------------------

function ler(objeto, caminho) {
    return caminho.reduce((atual, chave) => (atual == null ? undefined : atual[chave]), objeto) ?? null;
}

function pai(objeto, caminho) {
    let atual = objeto;
    for (const chave of caminho.slice(0, -1)) {
        if (atual[chave] == null || typeof atual[chave] !== "object") atual[chave] = {};
        atual = atual[chave];
    }
    return atual;
}

const iguais = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

// ---------------------------------------------------------------------------
// Opcoes para os campos de escolha
// ---------------------------------------------------------------------------

/** Categorias conhecidas: cadastro interno + categorias por veiculo da frota. */
function opcoesCategoria(cad) {
    const porNome = new Map();
    const incluir = (nome, id, grupo) => {
        if (!nome) return;
        const chave = normalizar(nome);
        const atual = porNome.get(chave);
        if (!atual || (!atual.id && id)) porNome.set(chave, { nome, id: id && !String(id).startsWith("PREENCHER_") ? id : null, grupo });
    };
    for (const categoria of cad.categorias || []) incluir(categoria.nome_conta_azul || categoria.nome, categoria.id, "Despesas");
    for (const veiculo of cad.veiculos || []) {
        if (veiculo.ativo === false) continue;
        incluir(veiculo.categoria_nome_conta_azul, veiculo.categoria_id, "Combustível por veículo");
        incluir(veiculo.manutencao_categoria_nome, veiculo.manutencao_categoria_id, "Manutenção por veículo");
    }
    for (const pessoa of cad.pessoas || []) {
        for (const regra of pessoa.regras_especiais || []) incluir(regra.categoria_nome, regra.categoria_id, "Regras especiais");
    }
    return [...porNome.values()].filter((item) => !String(item.nome).startsWith("PREENCHER_"))
        .sort((a, b) => a.grupo.localeCompare(b.grupo) || a.nome.localeCompare(b.nome));
}

/** Centros de custo: ativos primeiro; inativos aparecem, mas marcados. */
function opcoesCentro(cad) {
    return cadastros.projetosComId(cad)
        .filter((projeto) => projeto.nome_oficial !== "TESTE")
        .map((projeto) => ({
            nome: cadastros.nomeCentro(projeto), projeto: projeto.nome_oficial, id: projeto.id_conta_azul || null,
            ativo: projeto.ativo, id_sistema: projeto.id_sistema_projetos ?? null,
        }))
        .sort((a, b) => Number(b.ativo === true) - Number(a.ativo === true) || a.nome.localeCompare(b.nome));
}

function opcoes(cad) {
    return {
        campos: Object.entries(CAMPOS).map(([chave, campo]) => ({ chave, rotulo: campo.rotulo, erro_sugerido: campo.erro, tipo: campo.tipo })),
        tipos: Object.entries(TIPOS).map(([codigo, tipo]) => ({ codigo, rotulo: tipo.rotulo })),
        categorias: opcoesCategoria(cad),
        centros: opcoesCentro(cad),
        cartoes: (cad.cartoes || []).map((cartao) => ({ codigo: cartao.codigo, rotulo: cartao.rotulo, forma: cartao.forma_pagamento })),
        pessoas: (cad.pessoas || []).map((pessoa) => ({ id: pessoa.id, nome: pessoa.nome })),
        tipos_erro: TIPOS_ERRO,
    };
}

// ---------------------------------------------------------------------------
// Normalizacao do valor digitado
// ---------------------------------------------------------------------------

function numeroBr(valor) {
    if (valor === null || valor === undefined || valor === "") return null;
    if (typeof valor === "number") return Number.isFinite(valor) ? valor : NaN;
    const texto = String(valor).trim().replace(/\s|R\$/gi, "");
    const normal = texto.includes(",") ? texto.replace(/\./g, "").replace(",", ".") : texto;
    return Number(normal);
}

function normalizarValor(chave, bruto) {
    const campo = CAMPOS[chave];
    if (bruto === null || bruto === undefined || String(bruto).trim() === "") return null;
    switch (campo.tipo) {
        case "data": {
            const texto = String(bruto).trim();
            const br = texto.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
            const iso = br ? `${br[3]}-${br[2]}-${br[1]}` : texto;
            if (!/^\d{4}-\d{2}-\d{2}$/.test(iso) || Number.isNaN(Date.parse(`${iso}T12:00:00Z`))) throw new Error(`${campo.rotulo}: data inválida (${texto}).`);
            return iso;
        }
        case "numero": {
            const numero = numeroBr(bruto);
            if (!Number.isFinite(numero) || numero <= 0) throw new Error(`${campo.rotulo}: número inválido (${bruto}).`);
            return Math.round(numero * 1000) / 1000;
        }
        case "inteiro": {
            const numero = Number(String(bruto).replace(/\D/g, ""));
            if (!Number.isInteger(numero) || numero <= 0) throw new Error(`${campo.rotulo}: número inteiro inválido (${bruto}).`);
            return numero;
        }
        case "placa": {
            const placa = cadastros.placaCanonica(bruto);
            if (!/^[A-Z]{3}[0-9][A-Z0-9][0-9]{2}$/.test(placa)) throw new Error(`Placa inválida (${bruto}).`);
            return placa;
        }
        case "tipo": {
            const codigo = String(bruto).trim().toUpperCase();
            if (!TIPOS[codigo]) throw new Error(`Tipo desconhecido (${bruto}).`);
            return codigo;
        }
        default: {
            const texto = String(bruto).replace(/\s+/g, " ").trim();
            if (texto.length > 200) throw new Error(`${campo.rotulo}: texto longo demais.`);
            return texto;
        }
    }
}

// ---------------------------------------------------------------------------
// Aplicacao das correcoes nos campos da despesa
// ---------------------------------------------------------------------------

const MARCA = { origem: "correcao_humana" };

function aplicar(cad, campos, chave, valor) {
    const campo = CAMPOS[chave];
    if (campo.tipo === "categoria") {
        const conhecida = valor ? opcoesCategoria(cad).find((item) => normalizar(item.nome) === normalizar(valor)) : null;
        campos.categoria = { nome: conhecida?.nome || valor, id: conhecida?.id || null, ...MARCA };
        return;
    }
    if (campo.tipo === "centro") {
        const conhecido = valor ? opcoesCentro(cad).find((item) => normalizar(item.nome) === normalizar(valor) || normalizar(item.projeto) === normalizar(valor)) : null;
        campos.centro_custo = {
            ...(campos.centro_custo || {}), nome: conhecido?.nome || valor, projeto: conhecido?.projeto || null,
            id: conhecido?.id || null, status: conhecido ? "ESCOLHIDO_NA_REVISAO" : "INFORMADO_NA_REVISAO", candidatos: [], ...MARCA,
        };
        return;
    }
    if (campo.tipo === "pagamento") {
        const cartao = valor ? (cad.cartoes || []).find((item) => item.codigo === valor) : null;
        campos.pagamento = cartao
            ? { forma: cartao.forma_pagamento, cartao: cartao.codigo, rotulo: cartao.rotulo, conta_id: cartao.conta_conta_azul_id || null, ...MARCA }
            : { forma: valor || null, cartao: null, rotulo: valor || null, ...MARCA };
        return;
    }
    const destino = pai(campos, campo.caminho);
    destino[campo.caminho.at(-1)] = valor;
    Object.assign(destino, MARCA);
    if (chave === "pessoas") destino.confirmado = true;
}

/** Valor atual de um campo, no formato que a Central compara e grava. */
function valorDe(campos, chave) {
    if (CAMPOS[chave].tipo === "pagamento") return campos?.pagamento?.cartao || campos?.pagamento?.forma || null;
    return ler(campos, CAMPOS[chave].caminho);
}

/**
 * Descricao de template acompanha os campos de que depende, a menos que a
 * pessoa tenha escrito a descricao a mao.
 */
function atualizarDescricao(campos) {
    if (campos.descricao?.origem === "correcao_humana") return;
    const tipo = campos.tipo?.valor;
    if (tipo === "ABASTECIMENTO") {
        const ab = campos.abastecimento || {};
        campos.descricao = { valor: descricaoAbastecimento({ litros: ab.litros?.valor, odometro: ab.odometro?.valor, placa: ab.placa?.valor }), origem: "template_abastecimento" };
    } else if (TIPOS[tipo]?.refeicao) {
        campos.descricao = { valor: descricaoRefeicao(tipo, campos.pessoas?.valor), origem: "template_refeicao", estimada: !campos.pessoas?.confirmado };
    }
}

/**
 * Corrige um ou mais campos de uma despesa em revisao.
 *
 * @param {Array<{campo:string, valor:any, tipo_erro?:string}>} alteracoes
 * @param {string} autor — quem corrigiu (obrigatorio)
 */
function corrigir(db, cad, despesaId, alteracoes, autor) {
    const quem = String(autor || "").trim();
    if (!quem) throw new Error("Informe quem está revisando.");
    if (!Array.isArray(alteracoes) || !alteracoes.length) throw new Error("Nenhuma correção enviada.");
    const despesa = lerDespesa(db, despesaId);
    if (!despesa) throw new Error(`Despesa #${despesaId} não encontrada.`);
    if (!EDITAVEIS.includes(despesa.estado)) throw new Error(`Despesa #${despesaId} está ${despesa.estado}; reabra antes de corrigir.`);

    const campos = structuredClone(despesa.campos);
    const registros = [];
    for (const alteracao of alteracoes) {
        const chave = String(alteracao?.campo || "");
        if (!CAMPOS[chave]) throw new Error(`Campo não editável: ${chave}.`);
        const tipoErro = alteracao.tipo_erro || CAMPOS[chave].erro;
        if (!TIPOS_ERRO.includes(tipoErro)) throw new Error(`Tipo de erro inválido: ${tipoErro}.`);
        const novo = normalizarValor(chave, alteracao.valor);
        const anterior = valorDe(campos, chave);
        if (iguais(anterior, novo)) continue;
        aplicar(cad, campos, chave, novo);
        registros.push({ chave, anterior, novo, tipoErro });
    }
    if (!registros.length) return { despesa, alteradas: 0 };
    atualizarDescricao(campos);

    transacao(db, () => {
        const inserir = db.prepare(`INSERT INTO correcoes (despesa_id, campo, valor_anterior, valor_novo, tipo_erro, autor, em)
            VALUES (?, ?, ?, ?, ?, ?, ?)`);
        for (const item of registros) inserir.run(despesaId, item.chave, json(item.anterior), json(item.novo), item.tipoErro, quem, agora());
        // Despesa antiga (antes da migracao 2) sem a previa original: guarda a de agora como base.
        db.prepare(`UPDATE despesas SET campos = ?, campos_originais = COALESCE(campos_originais, ?), revisado_por = ?, revisado_em = ?,
            atualizado_em = ? WHERE id = ?`).run(json(campos), json(despesa.campos), quem, agora(), agora(), despesaId);
    });
    return { despesa: lerDespesa(db, despesaId), alteradas: registros.length };
}

// ---------------------------------------------------------------------------
// Aprovar / descartar / reabrir
// ---------------------------------------------------------------------------

function faltandoParaAprovar(campos) {
    return OBRIGATORIOS_PARA_APROVAR.filter((chave) => {
        const valor = valorDe(campos, chave);
        return valor === null || valor === undefined || valor === "";
    }).map((chave) => CAMPOS[chave].rotulo);
}

/** Entrada do exemplo: so o que a IA tinha no momento (leitura + mensagem), nunca a resposta. */
function entradaDoExemplo(db, despesa) {
    const documento = despesa.documento_id ? db.prepare("SELECT ocr, papel FROM documentos WHERE id = ?").get(despesa.documento_id) : null;
    const mensagem = despesa.mensagem_ref ? db.prepare("SELECT texto, pessoa_id, grupo_id, enviada_em FROM mensagens WHERE id = ?").get(despesa.mensagem_ref) : null;
    const lote = despesa.lote_id ? db.prepare("SELECT data_declarada, projeto_texto, cartao, quantidades, observacoes FROM lotes WHERE id = ?").get(despesa.lote_id) : null;
    return {
        ocr: documento ? lerJson(documento.ocr, null) : null,
        mensagem: mensagem ? { texto: mensagem.texto, pessoa_id: mensagem.pessoa_id, enviada_em: mensagem.enviada_em } : null,
        lote: lote ? { ...lote, quantidades: lerJson(lote.quantidades, null), observacoes: lerJson(lote.observacoes, null) } : null,
        previa_da_ia: despesa.campos_originais || null,
    };
}

function rotulosDoExemplo(campos) {
    const rotulos = {};
    for (const chave of Object.keys(CAMPOS)) rotulos[chave] = valorDe(campos, chave);
    rotulos.categoria_id = campos.categoria?.id || null;
    rotulos.centro_custo_id = campos.centro_custo?.id || null;
    rotulos.sem_comprovante = Boolean(campos.sem_comprovante?.valor);
    return rotulos;
}

function mudarEstado(db, despesa, para, motivo, autor) {
    db.prepare("UPDATE despesas SET estado = ?, revisado_por = ?, revisado_em = ?, atualizado_em = ? WHERE id = ?")
        .run(para, autor, agora(), agora(), despesa.id);
    registrarHistorico(db, despesa.id, despesa.estado, para, motivo);
}

/**
 * Aprovacao humana. A despesa vira exemplo de treino validado.
 * NAO lanca no Conta Azul: o lancamento real e outra etapa, ainda desligada.
 */
function aprovar(db, despesaId, autor) {
    const quem = String(autor || "").trim();
    if (!quem) throw new Error("Informe quem está aprovando.");
    const despesa = lerDespesa(db, despesaId);
    if (!despesa) throw new Error(`Despesa #${despesaId} não encontrada.`);
    if (!EDITAVEIS.includes(despesa.estado)) throw new Error(`Despesa #${despesaId} está ${despesa.estado}; não pode ser aprovada.`);
    const faltando = faltandoParaAprovar(despesa.campos);
    if (faltando.length) throw new Error(`Preencha antes de aprovar: ${faltando.join(", ")}.`);
    transacao(db, () => {
        mudarEstado(db, despesa, ESTADOS.APROVADO, "aprovada_na_central", quem);
        db.prepare(`INSERT INTO exemplos_treino (despesa_id, rotulos, entrada, aprovado_por, aprovado_em) VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(despesa_id) DO UPDATE SET rotulos = excluded.rotulos, entrada = excluded.entrada,
                aprovado_por = excluded.aprovado_por, aprovado_em = excluded.aprovado_em`)
            .run(despesaId, json(rotulosDoExemplo(despesa.campos)), json(entradaDoExemplo(db, despesa)), quem, agora());
    });
    return lerDespesa(db, despesaId);
}

/** Descarta (nao e despesa, foto ilegivel, duplicata confirmada...). Sai do treino. */
function descartar(db, despesaId, motivo, autor) {
    const quem = String(autor || "").trim();
    const porque = String(motivo || "").trim();
    if (!quem) throw new Error("Informe quem está revisando.");
    if (!porque) throw new Error("Informe o motivo do descarte.");
    const despesa = lerDespesa(db, despesaId);
    if (!despesa) throw new Error(`Despesa #${despesaId} não encontrada.`);
    if (despesa.estado === ESTADOS.DESCARTADO) return despesa;
    transacao(db, () => {
        mudarEstado(db, despesa, ESTADOS.DESCARTADO, `descartada: ${porque}`.slice(0, 300), quem);
        db.prepare("DELETE FROM exemplos_treino WHERE despesa_id = ?").run(despesaId);
    });
    return lerDespesa(db, despesaId);
}

/**
 * Volta para revisao: aprovada (o exemplo sai do treino ate nova aprovacao),
 * descartada, ou duplicata que a pessoa confirmou ser outra compra.
 */
function reabrir(db, despesaId, motivo, autor) {
    const quem = String(autor || "").trim();
    if (!quem) throw new Error("Informe quem está revisando.");
    const despesa = lerDespesa(db, despesaId);
    if (!despesa) throw new Error(`Despesa #${despesaId} não encontrada.`);
    if (EDITAVEIS.includes(despesa.estado)) return despesa;
    transacao(db, () => {
        mudarEstado(db, despesa, ESTADOS.AGUARDANDO_REVISAO, `reaberta: ${String(motivo || "sem motivo").trim()}`.slice(0, 300), quem);
        db.prepare("DELETE FROM exemplos_treino WHERE despesa_id = ?").run(despesaId);
    });
    return lerDespesa(db, despesaId);
}

/**
 * Confirma de quem e um id do WhatsApp e regera as previas ainda sem correcao
 * desse remetente (o remetente passa a ser reconhecido daqui em diante).
 */
function vincularRemetente(db, cad, whatsappId, pessoaId, { regras = {}, hoje = new Date() } = {}) {
    if (!cad.pessoas.some((pessoa) => pessoa.id === pessoaId)) throw new Error("Pessoa não cadastrada.");
    contexto.vincularRemetente(db, whatsappId, pessoaId, "confirmacao_central");
    const pendentes = db.prepare(`
        SELECT d.id FROM despesas d JOIN mensagens m ON m.id = d.mensagem_ref
        WHERE m.remetente_id = ? AND d.estado IN (${ESTADOS_REGERAVEIS.map(() => "?").join(",")})
          AND NOT EXISTS (SELECT 1 FROM correcoes c WHERE c.despesa_id = d.id)`).all(String(whatsappId), ...ESTADOS_REGERAVEIS);
    for (const linha of pendentes) regenerarPrevia(db, cad, linha.id, { regras, hoje });
    return { regeradas: pendentes.length };
}

/**
 * Refaz, com os cadastros atuais, todas as previas em revisao que ninguem
 * corrigiu ainda (ex.: depois de cadastrar um projeto ou um apelido novo).
 */
function regenerarPendentes(db, cad, { regras = {}, hoje = new Date() } = {}) {
    const linhas = db.prepare(`
        SELECT d.id FROM despesas d
        WHERE d.estado IN (${ESTADOS_REGERAVEIS.map(() => "?").join(",")}) AND d.mensagem_ref IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM correcoes c WHERE c.despesa_id = d.id)`).all(...ESTADOS_REGERAVEIS);
    const falhas = [];
    for (const { id } of linhas) {
        try { regenerarPrevia(db, cad, id, { regras, hoje }); } catch (erro) { falhas.push({ id, erro: erro.message }); }
    }
    return { regeradas: linhas.length - falhas.length, falhas };
}

// ---------------------------------------------------------------------------
// Consultas para o painel
// ---------------------------------------------------------------------------

const ABAS = {
    revisar: [ESTADOS.AGUARDANDO_REVISAO],
    classificadas: [ESTADOS.CLASSIFICADO],
    aprovadas: [ESTADOS.APROVADO],
    fora: [ESTADOS.BLOQUEADO_DUPLICADO, ESTADOS.DESCARTADO],
};

function resumo(linha) {
    const campos = lerJson(linha.campos, {});
    return {
        id: linha.id, estado: linha.estado, midia_id: linha.midia_id,
        data: campos.data_competencia?.valor || null, valor: campos.valor?.valor ?? null,
        fornecedor: campos.fornecedor?.valor || null, tipo: campos.tipo?.valor || null,
        descricao: campos.descricao?.valor || null, centro_custo: campos.centro_custo?.nome || null,
        remetente: campos.remetente?.valor || linha.remetente_nome || null,
        pendencias: lerJson(linha.pendencias, []).length, recebida_em: linha.recebida_em || linha.criado_em,
        sem_comprovante: Boolean(campos.sem_comprovante?.valor), corrigida: Boolean(linha.correcoes),
    };
}

function listar(db, { aba = "revisar", limite = 300 } = {}) {
    const estados = ABAS[aba] || ABAS.revisar;
    const linhas = db.prepare(`
        SELECT d.*, m.recebida_em, msg.remetente_nome,
            (SELECT COUNT(*) FROM correcoes c WHERE c.despesa_id = d.id) AS correcoes
        FROM despesas d LEFT JOIN midias m ON m.id = d.midia_id LEFT JOIN mensagens msg ON msg.id = d.mensagem_ref
        WHERE d.estado IN (${estados.map(() => "?").join(",")})
        ORDER BY COALESCE(m.recebida_em, d.criado_em) DESC, d.id DESC LIMIT ?`).all(...estados, Math.min(Number(limite) || 300, 1000));
    const contagem = Object.fromEntries(Object.keys(ABAS).map((nome) => [nome, 0]));
    for (const { estado, total } of db.prepare("SELECT estado, COUNT(*) AS total FROM despesas GROUP BY estado").all()) {
        const nome = Object.keys(ABAS).find((chave) => ABAS[chave].includes(estado));
        if (nome) contagem[nome] += total;
    }
    return { itens: linhas.map(resumo), contagem };
}

function detalhar(db, despesaId) {
    const despesa = lerDespesa(db, despesaId);
    if (!despesa) return null;
    const midia = despesa.midia_id ? db.prepare("SELECT id, arquivo, recebida_em, legenda, grupo_id, remetente_id FROM midias WHERE id = ?").get(despesa.midia_id) : null;
    const mensagem = despesa.mensagem_ref ? db.prepare("SELECT texto, remetente_id, remetente_nome, pessoa_id, enviada_em FROM mensagens WHERE id = ?").get(despesa.mensagem_ref) : null;
    const documento = despesa.documento_id ? db.prepare("SELECT indice, papel, ocr FROM documentos WHERE id = ?").get(despesa.documento_id) : null;
    const ocr = documento ? lerJson(documento.ocr, {}) : null;
    const irmas = despesa.midia_id ? db.prepare("SELECT id, estado FROM despesas WHERE midia_id = ? AND id <> ?").all(despesa.midia_id, despesaId) : [];
    const lote = despesa.lote_id ? db.prepare("SELECT data_declarada, projeto_texto, cartao, quantidades, observacoes, criado_em FROM lotes WHERE id = ?").get(despesa.lote_id) : null;
    return {
        ...despesa,
        midia,
        mensagem: mensagem ? { ...mensagem, vinculada: Boolean(mensagem.pessoa_id) } : null,
        documento: documento ? {
            indice: documento.indice, papel: documento.papel,
            leitura: { fornecedor: ocr.fornecedor, cnpj: ocr.cnpj, data: ocr.data, hora: ocr.hora, valor: ocr.valor, confianca: ocr.confianca,
                placa: ocr.placa, litragem: ocr.litragem, odometro: ocr.odometro, forma_pagamento: ocr.forma_pagamento, produto_principal: ocr.produto_principal },
            texto: String(ocr.texto_bruto || "").slice(0, 6000),
        } : null,
        lote: lote ? { ...lote, quantidades: lerJson(lote.quantidades, null), observacoes: lerJson(lote.observacoes, null) } : null,
        outras_da_mesma_foto: irmas,
        historico: db.prepare("SELECT de, para, motivo, em FROM historico_estados WHERE despesa_id = ? ORDER BY id").all(despesaId),
        correcoes: db.prepare("SELECT campo, valor_anterior, valor_novo, tipo_erro, autor, em FROM correcoes WHERE despesa_id = ? ORDER BY id").all(despesaId)
            .map((linha) => ({ ...linha, valor_anterior: lerJson(linha.valor_anterior), valor_novo: lerJson(linha.valor_novo) })),
        editavel: EDITAVEIS.includes(despesa.estado),
        valores: Object.fromEntries(Object.keys(CAMPOS).map((chave) => [chave, valorDe(despesa.campos, chave)])),
    };
}

/**
 * Metricas por campo sobre o que foi APROVADO: quanto da previa da IA a pessoa
 * aceitou sem mexer, separando erro de leitura de erro de classificacao.
 */
function metricas(db) {
    const aprovadas = db.prepare("SELECT id, campos, campos_originais FROM despesas WHERE estado = 'APROVADO'").all();
    const correcoesPorDespesa = new Map();
    for (const linha of db.prepare(`SELECT c.despesa_id, c.campo, c.tipo_erro FROM correcoes c
        JOIN despesas d ON d.id = c.despesa_id WHERE d.estado = 'APROVADO'`).all()) {
        if (!correcoesPorDespesa.has(linha.despesa_id)) correcoesPorDespesa.set(linha.despesa_id, new Map());
        correcoesPorDespesa.get(linha.despesa_id).set(linha.campo, linha.tipo_erro);
    }
    const porCampo = {};
    let semCorrecao = 0;
    for (const despesa of aprovadas) {
        const final = lerJson(despesa.campos, {});
        const original = lerJson(despesa.campos_originais, null) || final;
        const corrigidos = correcoesPorDespesa.get(despesa.id) || new Map();
        if (!corrigidos.size) semCorrecao += 1;
        for (const chave of Object.keys(CAMPOS)) {
            const valorFinal = valorDe(final, chave);
            const valorIa = valorDe(original, chave);
            if (valorFinal == null && valorIa == null) continue;
            // Descricao de template refeita so porque outro campo foi corrigido
            // e consequencia daquele erro, nao um erro proprio da descricao.
            if (chave === "descricao" && !corrigidos.has("descricao") && !iguais(valorIa, valorFinal)) continue;
            const item = porCampo[chave] ||= { rotulo: CAMPOS[chave].rotulo, avaliados: 0, acertos: 0, ia_vazia: 0, erros_leitura: 0, erros_classificacao: 0 };
            item.avaliados += 1;
            if (valorIa == null) item.ia_vazia += 1;
            if (iguais(valorIa, valorFinal)) item.acertos += 1;
            else if ((corrigidos.get(chave) || CAMPOS[chave].erro) === "LEITURA") item.erros_leitura += 1;
            else item.erros_classificacao += 1;
        }
    }
    for (const item of Object.values(porCampo)) item.acuracia = item.avaliados ? item.acertos / item.avaliados : null;
    const estados = Object.fromEntries(db.prepare("SELECT estado, COUNT(*) AS total FROM despesas GROUP BY estado").all().map((linha) => [linha.estado, linha.total]));
    const tiposErro = Object.fromEntries(db.prepare("SELECT tipo_erro, COUNT(*) AS total FROM correcoes GROUP BY tipo_erro").all().map((linha) => [linha.tipo_erro, linha.total]));
    return {
        aprovadas: aprovadas.length,
        aprovadas_sem_correcao: semCorrecao,
        exemplos_treino: db.prepare("SELECT COUNT(*) AS total FROM exemplos_treino").get().total,
        estados, correcoes_por_tipo: tiposErro, por_campo: porCampo,
    };
}

/** Pessoas ainda nao reconhecidas que mandaram despesas (para vincular na Central). */
function remetentesNaoVinculados(db) {
    return db.prepare(`
        SELECT m.remetente_id, MAX(m.remetente_nome) AS nome, COUNT(DISTINCT d.id) AS despesas
        FROM mensagens m JOIN despesas d ON d.mensagem_ref = m.id
        WHERE m.pessoa_id IS NULL AND m.remetente_id NOT IN (SELECT whatsapp_id FROM remetentes_vinculados)
        GROUP BY m.remetente_id ORDER BY despesas DESC`).all();
}

module.exports = {
    CAMPOS, ESTADOS, ABAS, TIPOS_ERRO,
    opcoes, listar, detalhar, corrigir, aprovar, descartar, reabrir, vincularRemetente, metricas, remetentesNaoVinculados,
    regenerar: regenerarPrevia, regenerarPendentes,
};
