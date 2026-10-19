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
const { TIPOS, descricaoAbastecimento, descricaoRefeicao, refeicaoPeloHorario } = require("./regras-vmac");
const { normalizar } = require("./texto");

// Motivo de cada correcao. NAO_INFORMADO = a informacao nao existia (o
// operador nao disse o cartao, a nota nao tem a placa): nao e erro da IA, e
// sim o que falta pedir. OUTRO exige explicacao escrita.
const TIPOS_ERRO = ["LEITURA", "CLASSIFICACAO", "NAO_INFORMADO", "OUTRO"];
const ROTULOS_ERRO = {
    LEITURA: "Leitura (OCR leu errado)",
    CLASSIFICACAO: "Classificação (entendeu errado)",
    NAO_INFORMADO: "Não informado (faltou a informação)",
    OUTRO: "Outro (explique abaixo)",
};
// Campos que so o operador informa: vazio na previa = provavelmente nao informado.
const INFORMADOS_PELO_OPERADOR = new Set(["pagamento", "centro_custo", "pessoas"]);

/** Motivo sugerido para uma correcao (a pessoa pode trocar). */
function erroSugerido(chave, anterior) {
    if ((anterior === null || anterior === undefined || anterior === "") && INFORMADOS_PELO_OPERADOR.has(chave)) return "NAO_INFORMADO";
    return CAMPOS[chave]?.erro || "CLASSIFICACAO";
}
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
    // Opcional: reembolso, pagamento fora do cartao, recado do operador. Vai para a observacao no Conta Azul.
    observacao: { rotulo: "Observação (reembolso, etc.)", caminho: ["observacao", "valor"], erro: "NAO_INFORMADO", tipo: "texto" },
    // Opcional: "Descrição" do anexo no Conta Azul (ao lado da foto). Ex.: "REEMBOLSO LORRAN".
    anexo_descricao: { rotulo: "Descrição do anexo", caminho: ["anexo", "descricao"], erro: "NAO_INFORMADO", tipo: "texto" },
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
        fornecedores: [...new Set([...(cad.fornecedores?.opcoes || []), ...Object.values(cad.fornecedores?.genericos_por_tipo || {}),
            ...(cad.fornecedores?.recorrentes || []).map((item) => item.nome)])],
        tipos_erro: TIPOS_ERRO.map((codigo) => ({ codigo, rotulo: ROTULOS_ERRO[codigo] })),
        informados_pelo_operador: [...INFORMADOS_PELO_OPERADOR],
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
        let conhecido = valor ? opcoesCentro(cad).find((item) => normalizar(item.nome) === normalizar(valor) || normalizar(item.projeto) === normalizar(valor)) : null;
        // Digitado com um apelido do cadastro ("ADM", "Rota do Pequi"): resolve so se for exato e unico.
        if (valor && !conhecido) {
            const resolucao = cadastros.resolverProjeto(cad, valor);
            if (resolucao.status === "RESOLVIDO") conhecido = opcoesCentro(cad).find((item) => item.projeto === resolucao.projeto.nome_oficial) || null;
        }
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
/**
 * Centro de custo trocado para um ADMINISTRATIVO na revisao: a categoria
 * acompanha (refeicao e mercado -> Lanches e Refeições), salvo se a
 * pessoa ja escolheu a categoria ou se e material de campo.
 */
function ajustarCategoriaAdministrativa(cad, campos, registros) {
    const centroMudou = registros.some((item) => item.chave === "centro_custo");
    const categoriaEscolhida = registros.some((item) => item.chave === "categoria") || campos.categoria?.origem === "correcao_humana";
    if (!centroMudou || categoriaEscolhida || !/despesas\s+administrativas/i.test(String(campos.centro_custo?.nome || ""))) return;
    const tipo = campos.tipo?.valor;
    const material = /materiais de campo/i.test(String(campos.fornecedor?.valor || ""));
    if (material) return;
    const interno = TIPOS[tipo]?.refeicao || tipo === "MERCADO" ? "ALIMENTACAO EM CAMPO" : null;
    if (!interno) return;
    const categoria = cadastros.categoriaPorNome(cad, interno);
    if (categoria) campos.categoria = { nome: categoria.nome, id: categoria.id, origem: "despesa_administrativa" };
}

/** Fornecedor generico -> tipo de despesa (o revisor escolheu o fornecedor; o tipo acompanha). */
function tipoDoFornecedor(fornecedor, campos) {
    const nome = normalizar(fornecedor || "");
    const tipoAtual = campos.tipo?.valor;
    if (/^(restaurantes?|padaria|lanchonete)$/.test(nome)) {
        return TIPOS[tipoAtual]?.refeicao ? tipoAtual : refeicaoPeloHorario(campos.hora_da_nota?.valor) || "ALMOCO";
    }
    if (/^(hoteis|hotel|pousada)$/.test(nome)) return "HOSPEDAGEM";
    if (/^postos? de combustive(l|is)$/.test(nome)) return "ABASTECIMENTO";
    if (/^materiais de campo$/.test(nome)) return "OUTROS";
    if (/^manutencao veiculos$/.test(nome)) return "MANUTENCAO";
    return null;
}

/**
 * A nota acompanha a mudanca feita na revisao: fornecedor escolhido muda o tipo;
 * tipo novo traz a categoria e o fornecedor do tipo (quando a pessoa nao os
 * escolheu). O ajuste automatico do tipo fica registrado como correcao, para
 * a IA aprender que errou o tipo.
 */
function acompanharTipo(cad, campos, registros) {
    const mudou = (chave) => registros.some((item) => item.chave === chave);
    if (mudou("fornecedor") && !mudou("tipo")) {
        const novo = tipoDoFornecedor(campos.fornecedor?.valor, campos);
        const anterior = campos.tipo?.valor;
        if (novo && novo !== anterior) {
            campos.tipo = { valor: novo, origem: "correcao_humana", via: "fornecedor" };
            registros.push({ chave: "tipo", anterior, novo, tipoErro: "CLASSIFICACAO", observacao: `ajustado pelo fornecedor escolhido (${campos.fornecedor.valor})` });
        }
    }
    if (!mudou("tipo")) return;
    const tipo = campos.tipo?.valor;
    if (!mudou("categoria") && campos.categoria?.origem !== "correcao_humana" && tipo !== "ABASTECIMENTO") {
        const doTipo = TIPOS[tipo]?.categoria ? cadastros.categoriaPorNome(cad, TIPOS[tipo].categoria) : null;
        campos.categoria = doTipo ? { nome: doTipo.nome, id: doTipo.id, origem: "regra_do_tipo" } : { nome: null, id: null, origem: null };
    }
    const generico = cad.fornecedores?.genericos_por_tipo?.[tipo];
    if (!mudou("fornecedor") && campos.fornecedor?.origem !== "correcao_humana" && generico) {
        campos.fornecedor = { ...(campos.fornecedor || {}), valor: generico, origem: "fornecedor_generico_do_tipo" };
    }
    if (tipo !== "ABASTECIMENTO") delete campos.placa_veiculo;
}

function atualizarDescricao(campos) {
    if (campos.descricao?.origem === "correcao_humana") return;
    const tipo = campos.tipo?.valor;
    if (tipo === "ABASTECIMENTO") {
        const ab = campos.abastecimento || {};
        campos.descricao = { valor: descricaoAbastecimento({ litros: ab.litros?.valor, odometro: ab.odometro?.valor, placa: ab.placa?.valor }), origem: "template_abastecimento" };
    } else if (TIPOS[tipo]?.refeicao || tipo === "HOSPEDAGEM") {
        campos.descricao = { valor: descricaoRefeicao(tipo, campos.pessoas?.valor), origem: "template_refeicao", estimada: !campos.pessoas?.confirmado };
    }
}

/**
 * Corrige um ou mais campos de uma despesa em revisao.
 *
 * @param {Array<{campo:string, valor:any, tipo_erro?:string, observacao?:string}>} alteracoes
 *   `observacao`: explicacao livre do erro (obrigatoria quando tipo_erro = OUTRO)
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
        const novo = normalizarValor(chave, alteracao.valor);
        const anterior = valorDe(campos, chave);
        const tipoErro = alteracao.tipo_erro || erroSugerido(chave, anterior);
        if (!TIPOS_ERRO.includes(tipoErro)) throw new Error(`Tipo de erro inválido: ${tipoErro}.`);
        const observacao = String(alteracao.observacao || "").replace(/\s+/g, " ").trim();
        if (observacao.length > 300) throw new Error(`${CAMPOS[chave].rotulo}: explicação longa demais (máximo 300 caracteres).`);
        if (tipoErro === "OUTRO" && !observacao) throw new Error(`${CAMPOS[chave].rotulo}: escreva qual foi o erro (motivo "Outro").`);
        if (iguais(anterior, novo)) continue;
        aplicar(cad, campos, chave, novo);
        registros.push({ chave, anterior, novo, tipoErro, observacao: observacao || null });
    }
    if (!registros.length) return { despesa, alteradas: 0 };
    acompanharTipo(cad, campos, registros);
    atualizarDescricao(campos);
    ajustarCategoriaAdministrativa(cad, campos, registros);

    transacao(db, () => {
        const inserir = db.prepare(`INSERT INTO correcoes (despesa_id, campo, valor_anterior, valor_novo, tipo_erro, observacao, autor, em)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
        for (const item of registros) inserir.run(despesaId, item.chave, json(item.anterior), json(item.novo), item.tipoErro, item.observacao, quem, agora());
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
    });
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
        // O que a pessoa corrigiu, com o motivo e a explicacao: diz a IA o que
        // ela errou (e o que simplesmente nao foi informado).
        // Comentario livre do revisor: explica o caso (ex.: duas notas na mesma foto).
        comentario_da_revisao: despesa.comentario_ia || null,
        correcoes_da_revisao: db.prepare("SELECT campo, tipo_erro, observacao FROM correcoes WHERE despesa_id = ? ORDER BY id").all(despesa.id)
            .map((linha) => ({ campo: linha.campo, motivo: linha.tipo_erro, explicacao: linha.observacao || null })),
    };
}

// Campos que a pessoa pode marcar como "nao vale para treino" ao aprovar (ex.:
// nota antiga lancada sem saber o centro de custo e o cartao reais).
const CAMPOS_EXCLUIVEIS_DO_TREINO = ["centro_custo", "pagamento"];

function rotulosDoExemplo(campos, naoUsar = []) {
    const rotulos = {};
    for (const chave of Object.keys(CAMPOS)) rotulos[chave] = valorDe(campos, chave);
    rotulos.categoria_id = campos.categoria?.id || null;
    rotulos.centro_custo_id = campos.centro_custo?.id || null;
    rotulos.sem_comprovante = Boolean(campos.sem_comprovante?.valor);
    const ignorados = [...new Set(naoUsar)].filter((chave) => CAMPOS_EXCLUIVEIS_DO_TREINO.includes(chave));
    if (ignorados.length) rotulos._nao_usar_no_treino = ignorados;
    return rotulos;
}

/** Campos que faltaram na aprovacao: fora do treino e da medicao (vazio nao e resposta certa). */
function rotulosComFaltantes(rotulos, faltando) {
    if (!faltando.length) return rotulos;
    return { ...rotulos, _faltou_na_aprovacao: faltando, _nao_usar_no_treino: [...new Set([...(rotulos._nao_usar_no_treino || []), ...faltando])] };
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
function aprovar(db, despesaId, autor, { naoUsarNoTreino = [] } = {}) {
    const quem = String(autor || "").trim();
    if (!quem) throw new Error("Informe quem está aprovando.");
    const despesa = lerDespesa(db, despesaId);
    if (!despesa) throw new Error(`Despesa #${despesaId} não encontrada.`);
    if (!EDITAVEIS.includes(despesa.estado)) throw new Error(`Despesa #${despesaId} está ${despesa.estado}; não pode ser aprovada.`);
    const faltando = faltandoParaAprovar(despesa.campos);
    // Faltou informacao (operador nao mandou): aprova so com o porque escrito no
    // comentario para a IA; os campos faltantes ficam fora do treino.
    if (faltando.length && !String(despesa.comentario_ia || "").trim()) {
        const nomes = faltando.map((chave) => CAMPOS[chave]?.rotulo || chave);
        throw new Error(`Preencha antes de aprovar: ${nomes.join(", ")}. Ou escreva no "Comentário para a IA" por que está aprovando assim.`);
    }
    transacao(db, () => {
        mudarEstado(db, despesa, ESTADOS.APROVADO, "aprovada_na_central", quem);
        db.prepare(`INSERT INTO exemplos_treino (despesa_id, rotulos, entrada, aprovado_por, aprovado_em) VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(despesa_id) DO UPDATE SET rotulos = excluded.rotulos, entrada = excluded.entrada,
                aprovado_por = excluded.aprovado_por, aprovado_em = excluded.aprovado_em`)
            .run(despesaId, json(rotulosComFaltantes(rotulosDoExemplo(despesa.campos, naoUsarNoTreino), faltando)), json(entradaDoExemplo(db, despesa)), quem, agora());
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
 * Marca campos de exemplos JA aprovados como "nao valem para treino" (ex.:
 * centro de custo e pagamento inventados em notas antigas).
 */
function marcarNaoUsarNoTreino(db, despesaIds, campos, autor) {
    const quem = String(autor || "").trim();
    if (!quem) throw new Error("Informe quem está alterando.");
    const validos = campos.filter((chave) => CAMPOS_EXCLUIVEIS_DO_TREINO.includes(chave));
    let alterados = 0;
    transacao(db, () => {
        for (const id of despesaIds) {
            const exemplo = db.prepare("SELECT rotulos FROM exemplos_treino WHERE despesa_id = ?").get(id);
            if (!exemplo) continue;
            const rotulos = lerJson(exemplo.rotulos, {});
            rotulos._nao_usar_no_treino = [...new Set([...(rotulos._nao_usar_no_treino || []), ...validos])];
            db.prepare("UPDATE exemplos_treino SET rotulos = ? WHERE despesa_id = ?").run(json(rotulos), id);
            registrarHistorico(db, id, "APROVADO", "APROVADO", `treino: nao usar ${validos.join(", ")} (${quem})`);
            alterados += 1;
        }
    });
    return { alterados };
}

/**
 * Confirma de quem e um id do WhatsApp e regera as previas ainda sem correcao
 * desse remetente (o remetente passa a ser reconhecido daqui em diante).
 */
function vincularRemetente(db, cad, whatsappId, pessoaId, { regras = {}, hoje = new Date(), origem = "confirmacao_central" } = {}) {
    if (!cad.pessoas.some((pessoa) => pessoa.id === pessoaId)) throw new Error("Pessoa não cadastrada.");
    contexto.vincularRemetente(db, whatsappId, pessoaId, origem);
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
    // Notas do treino com o historico (ferramentas/treino-historico.js) ainda
    // sem decisao: ficam aqui, fora de "Para revisar" e "Classificadas".
    simuladas: [ESTADOS.AGUARDANDO_REVISAO, ESTADOS.CLASSIFICADO],
};
const SIMULADA_SQL = "COALESCE(msg.remetente_id, '') LIKE 'historico:%'";
/** Filtro de origem por aba: simuladas so na aba delas; nas abas de revisao, so as reais. */
const filtroOrigem = (aba) => (aba === "simuladas" ? `AND ${SIMULADA_SQL}` : ["revisar", "classificadas"].includes(aba) ? `AND NOT ${SIMULADA_SQL}` : "");

// Operador = a PESSOA que mandou a nota (nao o grupo: um grupo pode ter
// varios operadores). Sem vinculo, cai em "nao identificado".
const SEM_OPERADOR = "nao_identificado";
const OPERADOR_SQL = `COALESCE(msg.pessoa_id, json_extract(d.campos, '$.remetente.pessoa_id'), '${SEM_OPERADOR}')`;

function nomeDoOperador(id, nomes, nomeNoWhatsApp = null) {
    if (id === SEM_OPERADOR) return "Não identificado";
    return nomes.get(id) || nomeNoWhatsApp || id;
}

/** id -> nome das pessoas do cadastro (para os rotulos). */
function nomesDasPessoas(cad) {
    return new Map((cad?.pessoas || []).map((pessoa) => [pessoa.id, pessoa.nome]));
}

function resumo(linha) {
    const campos = lerJson(linha.campos, {});
    return {
        id: linha.id, estado: linha.estado, midia_id: linha.midia_id, operador: linha.operador || null,
        data: campos.data_competencia?.valor || null, valor: campos.valor?.valor ?? null,
        fornecedor: campos.fornecedor?.valor || null, tipo: campos.tipo?.valor || null,
        descricao: campos.descricao?.valor || null, centro_custo: campos.centro_custo?.nome || null,
        remetente: campos.remetente?.valor || linha.remetente_nome || null,
        pendencias: lerJson(linha.pendencias, []).length, recebida_em: linha.recebida_em || linha.criado_em,
        sem_comprovante: Boolean(campos.sem_comprovante?.valor), corrigida: Boolean(linha.correcoes),
    };
}

const DATA_DA_NOTA_SQL = "json_extract(d.campos, '$.data_competencia.valor')";
const DATA_RECEBIDA_SQL = "substr(COALESCE(m.recebida_em, d.criado_em), 1, 10)";
const DATA_ISO = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Filtro de periodo (datas AAAA-MM-DD, inclusivas). Pela data da nota
 * (competencia) ou pela data em que a foto chegou. Devolve SQL + parametros.
 */
function filtroPeriodo({ de = null, ate = null, pela = "nota" } = {}) {
    const coluna = pela === "recebida" ? DATA_RECEBIDA_SQL : DATA_DA_NOTA_SQL;
    const partes = [];
    const parametros = [];
    if (DATA_ISO.test(String(de || ""))) { partes.push(`${coluna} >= ?`); parametros.push(String(de)); }
    if (DATA_ISO.test(String(ate || ""))) { partes.push(`${coluna} <= ?`); parametros.push(String(ate)); }
    return { sql: partes.map((p) => `AND ${p}`).join(" "), parametros, ativo: partes.length > 0 };
}

/**
 * Lista de uma aba, opcionalmente so de um operador e de um periodo.
 * `operadores` traz, para a aba atual, quantas notas cada operador tem
 * (operadores do cadastro aparecem mesmo com zero).
 */
function listar(db, { aba = "revisar", limite = 300, operador = null, cad = null, de = null, ate = null, pela = "nota" } = {}) {
    if (!ABAS[aba]) aba = "revisar";
    const estados = ABAS[aba];
    const origem = filtroOrigem(aba);
    const marcadores = estados.map(() => "?").join(",");
    const filtrarOperador = operador && operador !== "todos";
    const periodo = filtroPeriodo({ de, ate, pela });
    // Com periodo escolhido a pessoa quer ver tudo daquele intervalo.
    const teto = periodo.ativo ? 2000 : 1000;
    const linhas = db.prepare(`
        SELECT d.*, m.recebida_em, msg.remetente_nome, ${OPERADOR_SQL} AS operador,
            (SELECT COUNT(*) FROM correcoes c WHERE c.despesa_id = d.id) AS correcoes
        FROM despesas d LEFT JOIN midias m ON m.id = d.midia_id LEFT JOIN mensagens msg ON msg.id = d.mensagem_ref
        WHERE d.estado IN (${marcadores}) ${origem} ${periodo.sql} ${filtrarOperador ? `AND ${OPERADOR_SQL} = ?` : ""}
        ORDER BY ${periodo.ativo && pela !== "recebida" ? `${DATA_DA_NOTA_SQL} DESC,` : ""} COALESCE(m.recebida_em, d.criado_em) DESC, d.id DESC LIMIT ?`)
        .all(...estados, ...periodo.parametros, ...(filtrarOperador ? [String(operador)] : []), periodo.ativo ? teto : Math.min(Number(limite) || 300, teto));
    const contagem = Object.fromEntries(Object.keys(ABAS).map((nome) => [nome, 0]));
    for (const { estado, simulada, total } of db.prepare(`SELECT d.estado, (${SIMULADA_SQL}) AS simulada, COUNT(*) AS total
        FROM despesas d LEFT JOIN mensagens msg ON msg.id = d.mensagem_ref GROUP BY 1, 2`).all()) {
        const nome = simulada && ABAS.simuladas.includes(estado) ? "simuladas" : Object.keys(ABAS).find((chave) => chave !== "simuladas" && ABAS[chave].includes(estado));
        if (nome) contagem[nome] += total;
    }

    const nomes = nomesDasPessoas(cad);
    const porOperador = new Map();
    for (const pessoa of cad?.pessoas || []) {
        if (pessoa.papel === "OPERADOR") porOperador.set(pessoa.id, { id: pessoa.id, nome: pessoa.nome, total: 0 });
    }
    for (const linha of db.prepare(`
        SELECT ${OPERADOR_SQL} AS operador, MAX(msg.remetente_nome) AS remetente_nome, COUNT(*) AS total
        FROM despesas d LEFT JOIN midias m ON m.id = d.midia_id LEFT JOIN mensagens msg ON msg.id = d.mensagem_ref
        WHERE d.estado IN (${marcadores}) ${origem} ${periodo.sql} GROUP BY operador`).all(...estados, ...periodo.parametros)) {
        porOperador.set(linha.operador, { id: linha.operador, nome: nomeDoOperador(linha.operador, nomes, linha.remetente_nome), total: linha.total });
    }
    const operadores = [...porOperador.values()]
        .sort((a, b) => (a.id === SEM_OPERADOR) - (b.id === SEM_OPERADOR) || b.total - a.total || a.nome.localeCompare(b.nome));
    const itens = linhas.map(resumo);
    const soma = itens.reduce((total, item) => total + (Number(item.valor) || 0), 0);
    return {
        itens, contagem, operadores, total_da_aba: operadores.reduce((total, item) => total + item.total, 0),
        periodo: periodo.ativo ? { de: de || null, ate: ate || null, pela: pela === "recebida" ? "recebida" : "nota", notas: itens.length, valor: Math.round(soma * 100) / 100 } : null,
    };
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
        correcoes: db.prepare("SELECT campo, valor_anterior, valor_novo, tipo_erro, observacao, autor, em FROM correcoes WHERE despesa_id = ? ORDER BY id").all(despesaId)
            .map((linha) => ({ ...linha, valor_anterior: lerJson(linha.valor_anterior), valor_novo: lerJson(linha.valor_novo) })),
        editavel: EDITAVEIS.includes(despesa.estado),
        valores: Object.fromEntries(Object.keys(CAMPOS).map((chave) => [chave, valorDe(despesa.campos, chave)])),
    };
}

/**
 * Avalia campo a campo uma despesa APROVADA: a previa da IA bateu com o que a
 * pessoa aprovou? Se nao, qual foi o motivo da correcao.
 * @returns {Array<{chave:string, resultado:'ACERTO'|'LEITURA'|'CLASSIFICACAO'|'NAO_INFORMADO'|'OUTRO', iaVazia:boolean}>}
 */
function avaliarCampos(despesa, corrigidos) {
    const final = lerJson(despesa.campos, {});
    const original = lerJson(despesa.campos_originais, null) || final;
    const ignorados = new Set(lerJson(despesa.rotulos, {})?._nao_usar_no_treino || []);
    const resultado = [];
    for (const chave of Object.keys(CAMPOS)) {
        if (ignorados.has(chave)) continue;
        const valorFinal = valorDe(final, chave);
        const valorIa = valorDe(original, chave);
        if (valorFinal == null && valorIa == null) continue;
        // Descricao de template refeita so porque outro campo foi corrigido
        // e consequencia daquele erro, nao um erro proprio da descricao.
        if (chave === "descricao" && !corrigidos.has("descricao") && !iguais(valorIa, valorFinal)) continue;
        const motivo = iguais(valorIa, valorFinal) ? "ACERTO" : (corrigidos.get(chave) || CAMPOS[chave].erro);
        resultado.push({ chave, resultado: TIPOS_ERRO.includes(motivo) || motivo === "ACERTO" ? motivo : "CLASSIFICACAO", iaVazia: valorIa == null });
    }
    return resultado;
}

/** Correcoes (ultimo motivo por campo) das despesas aprovadas. */
function correcoesDasAprovadas(db) {
    const mapa = new Map();
    for (const linha of db.prepare(`SELECT c.despesa_id, c.campo, c.tipo_erro FROM correcoes c
        JOIN despesas d ON d.id = c.despesa_id WHERE d.estado = 'APROVADO' ORDER BY c.id`).all()) {
        if (!mapa.has(linha.despesa_id)) mapa.set(linha.despesa_id, new Map());
        mapa.get(linha.despesa_id).set(linha.campo, linha.tipo_erro);
    }
    return mapa;
}

// "Nao informado" nao e erro da IA (a informacao nao existia): fica fora da conta do acerto.
const acuraciaDe = (acertos, avaliados, naoInformado) => (avaliados - naoInformado > 0 ? acertos / (avaliados - naoInformado) : null);

/**
 * Metricas por campo sobre o que foi APROVADO: quanto da previa da IA a pessoa
 * aceitou sem mexer, separando os motivos das correcoes.
 */
function metricas(db, { nomes = new Map() } = {}) {
    const aprovadas = db.prepare(`SELECT d.id, d.campos, d.campos_originais, e.rotulos FROM despesas d
        LEFT JOIN exemplos_treino e ON e.despesa_id = d.id WHERE d.estado = 'APROVADO'`).all();
    const correcoes = correcoesDasAprovadas(db);
    const porCampo = {};
    let semCorrecao = 0;
    for (const despesa of aprovadas) {
        const corrigidos = correcoes.get(despesa.id) || new Map();
        if (!corrigidos.size) semCorrecao += 1;
        for (const { chave, resultado, iaVazia } of avaliarCampos(despesa, corrigidos)) {
            const item = porCampo[chave] ||= { rotulo: CAMPOS[chave].rotulo, avaliados: 0, acertos: 0, ia_vazia: 0,
                erros_leitura: 0, erros_classificacao: 0, nao_informado: 0, outros: 0 };
            item.avaliados += 1;
            if (iaVazia) item.ia_vazia += 1;
            if (resultado === "ACERTO") item.acertos += 1;
            else if (resultado === "LEITURA") item.erros_leitura += 1;
            else if (resultado === "NAO_INFORMADO") item.nao_informado += 1;
            else if (resultado === "OUTRO") item.outros += 1;
            else item.erros_classificacao += 1;
        }
    }
    for (const item of Object.values(porCampo)) item.acuracia = acuraciaDe(item.acertos, item.avaliados, item.nao_informado);
    const estados = Object.fromEntries(db.prepare("SELECT estado, COUNT(*) AS total FROM despesas GROUP BY estado").all().map((linha) => [linha.estado, linha.total]));
    const tiposErro = Object.fromEntries(db.prepare("SELECT tipo_erro, COUNT(*) AS total FROM correcoes GROUP BY tipo_erro").all().map((linha) => [linha.tipo_erro, linha.total]));
    return {
        aprovadas: aprovadas.length,
        aprovadas_sem_correcao: semCorrecao,
        exemplos_treino: db.prepare("SELECT COUNT(*) AS total FROM exemplos_treino").get().total,
        estados, correcoes_por_tipo: tiposErro, por_campo: porCampo,
        por_operador: metricasPorOperador(db, nomes, correcoes),
    };
}

/**
 * Por operador: quantas notas mandou, em que pe estao, o acerto da IA nas
 * aprovadas e o que mais FALTOU informar (cartao, projeto, pessoas) — mostra
 * quem precisa ser orientado sobre a mensagem padrao.
 */
function metricasPorOperador(db, nomes, correcoes) {
    const linhas = db.prepare(`
        SELECT d.id, d.estado, d.campos, d.campos_originais, e.rotulos, ${OPERADOR_SQL} AS operador, msg.remetente_nome
        FROM despesas d LEFT JOIN mensagens msg ON msg.id = d.mensagem_ref LEFT JOIN exemplos_treino e ON e.despesa_id = d.id`).all();
    const porOperador = new Map();
    for (const linha of linhas) {
        const item = porOperador.get(linha.operador) || {
            operador: linha.operador, nome: nomeDoOperador(linha.operador, nomes, linha.remetente_nome),
            notas: 0, para_revisar: 0, aprovadas: 0, descartadas: 0, avaliados: 0, acertos: 0, nao_informado: 0,
            faltou: { pagamento: 0, centro_custo: 0, pessoas: 0 },
        };
        porOperador.set(linha.operador, item);
        if (linha.estado === ESTADOS.DESCARTADO) { item.descartadas += 1; continue; }
        item.notas += 1;
        if (EDITAVEIS.includes(linha.estado)) item.para_revisar += 1;
        if (linha.estado !== ESTADOS.APROVADO) continue;
        item.aprovadas += 1;
        for (const { chave, resultado } of avaliarCampos(linha, correcoes.get(linha.id) || new Map())) {
            item.avaliados += 1;
            if (resultado === "ACERTO") item.acertos += 1;
            if (resultado === "NAO_INFORMADO") {
                item.nao_informado += 1;
                if (chave in item.faltou) item.faltou[chave] += 1;
            }
        }
    }
    return [...porOperador.values()].map(({ avaliados, acertos, nao_informado: naoInformado, ...item }) => ({
        ...item, nao_informado: naoInformado, acuracia: acuraciaDe(acertos, avaliados, naoInformado),
    })).sort((a, b) => (a.operador === SEM_OPERADOR) - (b.operador === SEM_OPERADOR) || b.notas - a.notas || a.nome.localeCompare(b.nome));
}

/** Pessoas ainda nao reconhecidas que mandaram despesas (para vincular na Central). */
function remetentesNaoVinculados(db) {
    return db.prepare(`
        SELECT m.remetente_id, MAX(m.remetente_nome) AS nome, COUNT(DISTINCT d.id) AS despesas
        FROM mensagens m JOIN despesas d ON d.mensagem_ref = m.id
        WHERE m.pessoa_id IS NULL AND m.remetente_id NOT IN (SELECT whatsapp_id FROM remetentes_vinculados)
          AND d.estado <> 'DESCARTADO'
        GROUP BY m.remetente_id ORDER BY despesas DESC`).all();
}

/**
 * Comentario do revisor para a IA aprender. Vale em qualquer estado (inclusive
 * aprovada); se a nota ja e exemplo de treino, o exemplo e atualizado.
 */
function comentarParaIa(db, despesaId, texto, autor) {
    const quem = String(autor || "").trim();
    if (!quem) throw new Error("Informe quem está comentando.");
    const comentario = String(texto || "").replace(/\s+\n/g, "\n").trim().slice(0, 2000) || null;
    const despesa = lerDespesa(db, despesaId);
    if (!despesa) throw new Error(`Despesa #${despesaId} não encontrada.`);
    transacao(db, () => {
        db.prepare("UPDATE despesas SET comentario_ia = ?, comentario_ia_por = ?, comentario_ia_em = ?, atualizado_em = ? WHERE id = ?")
            .run(comentario, comentario ? quem : null, comentario ? agora() : null, agora(), despesaId);
        registrarHistorico(db, despesaId, despesa.estado, despesa.estado, comentario ? `comentário para a IA (${quem})` : `comentário para a IA removido (${quem})`);
        const exemplo = db.prepare("SELECT entrada FROM exemplos_treino WHERE despesa_id = ?").get(despesaId);
        if (exemplo) {
            const entrada = lerJson(exemplo.entrada, {});
            entrada.comentario_da_revisao = comentario;
            db.prepare("UPDATE exemplos_treino SET entrada = ? WHERE despesa_id = ?").run(json(entrada), despesaId);
        }
    });
    return lerDespesa(db, despesaId);
}

/** Comentarios para a IA mais recentes (aba Treino e assistente). */
function comentariosParaIa(db, limite = 50) {
    return db.prepare(`SELECT id, estado, comentario_ia AS comentario, comentario_ia_por AS por, comentario_ia_em AS em,
            json_extract(campos, '$.tipo.valor') AS tipo, json_extract(campos, '$.valor.valor') AS valor
        FROM despesas WHERE comentario_ia IS NOT NULL ORDER BY comentario_ia_em DESC LIMIT ?`).all(Math.min(Number(limite) || 50, 200));
}

module.exports = {
    comentarParaIa, comentariosParaIa,
    CAMPOS, ESTADOS, ABAS, TIPOS_ERRO, SEM_OPERADOR, erroSugerido, nomesDasPessoas,
    opcoes, listar, detalhar, corrigir, aprovar, descartar, reabrir, vincularRemetente, metricas, remetentesNaoVinculados,
    regenerar: regenerarPrevia, regenerarPendentes, marcarNaoUsarNoTreino, CAMPOS_EXCLUIVEIS_DO_TREINO,
    valorDoCampo: valorDe,
};
