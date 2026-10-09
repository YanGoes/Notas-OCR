"use strict";

// Central de revisao: escolhe uma despesa, confere com a foto, corrige e aprova.
// Toda correcao vai com o tipo de erro (LEITURA x CLASSIFICACAO) para o treino.

const $ = (seletor) => document.querySelector(seletor);
const estado = { aba: "revisar", selecionada: null, opcoes: null, detalhe: null, giro: 0 };

const NOMES_ESTADO = {
    AGUARDANDO_REVISAO: ["Para revisar", "pend"], CLASSIFICADO: ["Classificada", "okk"], APROVADO: ["Aprovada", "okk"],
    BLOQUEADO_DUPLICADO: ["Duplicada", "mau"], DESCARTADO: ["Descartada", "mau"],
};
const ORIGENS = {
    nota: "lido na nota", mensagem_do_operador: "digitado pelo operador", mensagem_da_foto: "legenda da foto",
    cabecalho_do_lote: "cabeçalho do dia", mensagem_anterior_do_operador: "projeto informado antes", orientacao_da_gerencia: "orientação da gerência",
    placa_da_frota: "categoria da frota", regra_do_tipo: "regra do tipo", regra_especial: "regra especial", correcao_humana: "corrigido por pessoa",
    template_abastecimento: "modelo de abastecimento", template_refeicao: "modelo de refeição", template_simples: "modelo", nome_lido_na_nota: "lido na nota",
    fornecedor_recorrente: "fornecedor recorrente", mercado_nao_recorrente: "mercado genérico", mensagem: "mensagem",
    legenda_da_foto: "legenda da foto", lote_do_dia: "mensagem do dia", estabelecimento_da_nota: "tipo de estabelecimento na nota",
    itens_da_nota: "itens da nota", horario_da_nota_pista: "pelo horário da nota (só pista)", horario_da_nota_confirmado_pelo_lote: "horário confirmado pela mensagem do dia",
    quantidade_do_lote_semantica_indeterminada: "\"Qtd\" da mensagem do dia (não confirmado)", texto: "mensagem", regra_especial_sem_categoria: "regra especial (sem categoria)",
};
const nomeOrigem = (codigo) => ORIGENS[codigo] || String(codigo).replaceAll("_", " ");
const PAGAMENTOS_EXTRA = [["PIX", "PIX"], ["DINHEIRO", "Dinheiro"], ["CARTAO_DEBITO", "Cartão de débito"]];

// ---------------------------------------------------------------------------
// Utilitarios
// ---------------------------------------------------------------------------

function el(tag, atributos = {}, ...filhos) {
    const no = document.createElement(tag);
    for (const [chave, valor] of Object.entries(atributos)) {
        if (valor === null || valor === undefined || valor === false) continue;
        if (chave === "class") no.className = valor;
        else if (chave.startsWith("on")) no.addEventListener(chave.slice(2), valor);
        else if (chave === "dataset") Object.assign(no.dataset, valor);
        else no.setAttribute(chave, valor === true ? "" : valor);
    }
    for (const filho of filhos.flat()) if (filho !== null && filho !== undefined && filho !== false) no.append(filho instanceof Node ? filho : String(filho));
    return no;
}

const moeda = (valor) => (valor == null ? "—" : Number(valor).toLocaleString("pt-BR", { style: "currency", currency: "BRL" }));
const dataBr = (iso) => (iso && /^\d{4}-\d{2}-\d{2}/.test(iso) ? iso.slice(0, 10).split("-").reverse().join("/") : "—");
const dataHora = (iso) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? "" : d.toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" }); };
const numeroBr = (valor) => (valor == null || valor === "" ? "" : String(valor).replace(".", ","));

async function api(caminho, corpo) {
    const resposta = await fetch(`/api/central${caminho}`, corpo === undefined ? {} : {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(corpo),
    });
    const dados = await resposta.json().catch(() => ({}));
    if (!resposta.ok) throw new Error(dados.erro || `Erro ${resposta.status}`);
    return dados;
}

let avisoTimer = null;
function avisar(texto, tipo = "erro") {
    const caixa = $("#aviso");
    caixa.textContent = texto;
    caixa.className = `aviso ${tipo === "ok" ? "ok-msg" : ""}`;
    clearTimeout(avisoTimer);
    avisoTimer = setTimeout(() => caixa.classList.add("oculto"), tipo === "ok" ? 3500 : 9000);
}

function revisor() {
    const campo = $("#revisor");
    const nome = campo.value.trim();
    campo.classList.toggle("faltando", !nome);
    if (!nome) { campo.focus(); throw new Error("Informe seu nome no campo Revisor (topo da página)."); }
    try { localStorage.setItem("vmac-revisor", nome); } catch (_) { /* sem armazenamento */ }
    return nome;
}

async function executar(acao, mensagemOk) {
    try {
        await acao();
        if (mensagemOk) avisar(mensagemOk, "ok");
    } catch (erro) { avisar(erro.message); }
}

// ---------------------------------------------------------------------------
// Lista
// ---------------------------------------------------------------------------

async function carregarLista() {
    const { itens, contagem } = await api(`/despesas?aba=${encodeURIComponent(estado.aba)}`);
    mostrarContagem(contagem);
    const lista = $("#lista");
    lista.replaceChildren();
    if (!itens.length) {
        lista.append(el("div", { class: "vazio" }, "Nada nesta aba."));
        if (!itens.some((item) => item.id === estado.selecionada)) mostrarVazio();
        return;
    }
    for (const item of itens) {
        const rotulo = item.tipo ? item.tipo.replaceAll("_", " ") : "SEM TIPO";
        lista.append(el("button", {
            class: "item", type: "button", "aria-current": item.id === estado.selecionada ? "true" : "false",
            onclick: () => selecionar(item.id),
        },
        el("span", { class: "topo" }, el("span", {}, `#${item.id} · ${rotulo}`), el("span", {}, moeda(item.valor))),
        el("span", { class: "sub" }, `${dataBr(item.data)} · ${item.fornecedor || "fornecedor não lido"}`),
        el("span", { class: "sub" }, `${item.remetente || "remetente não vinculado"} · ${item.centro_custo || "sem centro"}`),
        el("span", {},
            item.pendencias ? el("span", { class: "etiqueta pend" }, `${item.pendencias} pendência(s)`) : el("span", { class: "etiqueta okk" }, "sem pendências"),
            item.corrigida ? " " : null, item.corrigida ? el("span", { class: "etiqueta" }, "corrigida") : null,
            item.sem_comprovante ? " " : null, item.sem_comprovante ? el("span", { class: "etiqueta mau" }, "sem comprovante") : null)));
    }
    if (estado.selecionada == null || !itens.some((item) => item.id === estado.selecionada)) await selecionar(itens[0].id);
}

function mostrarVazio() {
    estado.selecionada = null;
    $("#detalhe").replaceChildren(el("div", { class: "vazio" }, "Escolha uma despesa na lista."));
}

async function selecionar(id) {
    estado.selecionada = id;
    estado.giro = 0;
    for (const botao of document.querySelectorAll(".item")) botao.setAttribute("aria-current", botao.textContent.startsWith(`#${id} `) ? "true" : "false");
    try {
        estado.detalhe = await api(`/despesas/${id}`);
        desenharDetalhe();
    } catch (erro) { avisar(erro.message); }
}

// ---------------------------------------------------------------------------
// Detalhe
// ---------------------------------------------------------------------------

function origemDe(campos, chave) {
    const mapa = {
        data_competencia: campos.data_competencia, valor: campos.valor, fornecedor: campos.fornecedor, litros: campos.abastecimento?.litros,
        odometro: campos.abastecimento?.odometro, placa: campos.abastecimento?.placa, tipo: campos.tipo, pessoas: campos.pessoas,
        descricao: campos.descricao, categoria: campos.categoria, centro_custo: campos.centro_custo, pagamento: campos.pagamento,
    };
    return mapa[chave]?.origem || null;
}

function controle(campo, valor, desabilitado) {
    const opcoes = estado.opcoes;
    const comum = { name: campo.chave, disabled: desabilitado };
    switch (campo.tipo) {
        case "data": return el("input", { ...comum, type: "date", value: valor || "" });
        case "numero": return el("input", { ...comum, inputmode: "decimal", value: numeroBr(valor) });
        case "inteiro": return el("input", { ...comum, inputmode: "numeric", value: valor ?? "" });
        case "tipo": return el("select", comum, el("option", { value: "" }, "—"),
            opcoes.tipos.map((tipo) => el("option", { value: tipo.codigo, selected: tipo.codigo === valor }, tipo.rotulo)));
        case "categoria": return el("input", { ...comum, list: "listaCategorias", value: valor || "", placeholder: "Escolha ou digite a categoria" });
        case "centro": {
            const ativos = opcoes.centros.filter((centro) => centro.ativo === true);
            const outros = opcoes.centros.filter((centro) => centro.ativo !== true);
            const conhecido = opcoes.centros.some((centro) => centro.nome === valor);
            const rotulo = (centro) => `${centro.nome}${centro.ativo === false ? " (inativo)" : centro.ativo == null ? " (não confirmado)" : ""}${centro.id ? "" : " · sem ID"}`;
            return el("select", comum, el("option", { value: "" }, "—"),
                valor && !conhecido ? el("option", { value: valor, selected: true }, `${valor} (fora do cadastro)`) : null,
                el("optgroup", { label: "Projetos ativos" }, ativos.map((centro) => el("option", { value: centro.nome, selected: centro.nome === valor }, rotulo(centro)))),
                el("optgroup", { label: "Inativos / não confirmados" }, outros.map((centro) => el("option", { value: centro.nome, selected: centro.nome === valor }, rotulo(centro)))));
        }
        case "pagamento": return el("select", comum, el("option", { value: "" }, "—"),
            opcoes.cartoes.map((cartao) => el("option", { value: cartao.codigo, selected: cartao.codigo === valor }, cartao.rotulo)),
            PAGAMENTOS_EXTRA.map(([codigo, rotulo]) => el("option", { value: codigo, selected: codigo === valor }, rotulo)));
        default: return el("input", { ...comum, value: valor ?? "" });
    }
}

const CAMPOS_ABASTECIMENTO = ["litros", "odometro", "placa"];

function linhaCampo(campo, detalhe) {
    const tipoAtual = detalhe.valores.tipo;
    if (CAMPOS_ABASTECIMENTO.includes(campo.chave) && tipoAtual !== "ABASTECIMENTO" && detalhe.valores[campo.chave] == null) return null;
    if (campo.chave === "pessoas" && !["ALMOCO", "JANTAR", "CAFE_DA_MANHA", "LANCHE"].includes(tipoAtual) && detalhe.valores.pessoas == null) return null;
    const valor = detalhe.valores[campo.chave];
    const origem = origemDe(detalhe.campos, campo.chave);
    const entrada = controle(campo, valor, !detalhe.editavel);
    const linha = el("div", { class: "campo", dataset: { chave: campo.chave, inicial: valorDoControle(entrada, campo) } },
        el("label", { for: `c-${campo.chave}` }, campo.rotulo),
        el("div", { class: "entrada" }, entrada,
            el("span", { class: `origem ${origem === "correcao_humana" ? "humana" : ""}` }, origem ? nomeOrigem(origem) : "sem valor"),
            el("div", { class: "tipo-erro" }, "Erro de:",
                ["LEITURA", "CLASSIFICACAO"].map((tipo) => el("label", {},
                    el("input", { type: "radio", name: `erro-${campo.chave}`, value: tipo, checked: tipo === campo.erro_sugerido }),
                    tipo === "LEITURA" ? "leitura (OCR leu errado)" : "classificação (interpretou errado)")))));
    entrada.id = `c-${campo.chave}`;
    entrada.addEventListener("input", () => linha.classList.toggle("mudou", valorDoControle(entrada, campo) !== linha.dataset.inicial));
    entrada.addEventListener("change", () => linha.classList.toggle("mudou", valorDoControle(entrada, campo) !== linha.dataset.inicial));
    return linha;
}

function valorDoControle(entrada) { return String(entrada.value ?? "").trim(); }

function blocoLista(titulo, itens, classe) {
    if (!itens?.length) return null;
    return el("div", { class: "bloco" }, el("h3", {}, titulo), el("ul", { class: `lista-pend ${classe}` }, itens.map((texto) => el("li", {}, texto))));
}

function blocoFoto(detalhe) {
    if (!detalhe.imagem_url) {
        return el("div", { class: "foto" }, el("div", { class: "vazio" }, detalhe.midia ? "Imagem não encontrada nas pastas de dados." : "Despesa sem foto (informada só por mensagem)."));
    }
    const img = el("img", { src: detalhe.imagem_url, alt: `Comprovante da despesa #${detalhe.id}` });
    const caixa = el("div", { class: "foto" });
    const girar = () => { estado.giro = (estado.giro + 90) % 360; img.style.transform = `rotate(${estado.giro}deg)`; };
    img.addEventListener("click", () => caixa.classList.toggle("zoom"));
    caixa.append(el("div", { class: "foto-acoes" },
        el("button", { type: "button", class: "secondary", onclick: () => caixa.classList.toggle("zoom") }, "Zoom"),
        el("button", { type: "button", class: "secondary", onclick: girar }, "Girar"),
        el("a", { class: "voltar", href: detalhe.imagem_url, target: "_blank", rel: "noreferrer" }, "Abrir")), img);
    return caixa;
}

function blocoLeitura(detalhe) {
    if (!detalhe.documento) return null;
    const leitura = detalhe.documento.leitura;
    const linhas = [["Fornecedor", leitura.fornecedor], ["CNPJ", leitura.cnpj], ["Data", dataBr(leitura.data)], ["Hora", leitura.hora],
        ["Valor", leitura.valor != null ? moeda(leitura.valor) : null], ["Confiança", leitura.confianca != null ? `${Math.round(leitura.confianca * 100)}%` : null],
        ["Placa", leitura.placa], ["Litros", leitura.litragem], ["Hodômetro", leitura.odometro], ["Pagamento no cupom", leitura.forma_pagamento], ["Produto", leitura.produto_principal]]
        .filter(([, valor]) => valor !== null && valor !== undefined && valor !== "" && valor !== "—");
    return el("div", { class: "bloco" },
        el("h3", {}, `O que o OCR leu${detalhe.documento.indice ? ` (comprovante ${detalhe.documento.indice + 1} da foto)` : ""}`),
        el("table", { class: "tabela-leitura" }, el("tbody", {}, linhas.map(([rotulo, valor]) => el("tr", {}, el("td", {}, rotulo), el("td", {}, String(valor)))))),
        detalhe.documento.texto ? el("details", { class: "leitura" }, el("summary", {}, "Texto completo lido"), el("pre", {}, detalhe.documento.texto)) : null);
}

function blocoMensagem(detalhe) {
    const msg = detalhe.mensagem;
    const partes = [];
    if (msg?.texto) partes.push(el("div", { class: "mensagem" }, msg.texto));
    if (detalhe.lote) {
        const lote = detalhe.lote;
        const resumo = [lote.data_declarada && `data ${dataBr(lote.data_declarada)}`, lote.projeto_texto && `projeto "${lote.projeto_texto}"`, lote.cartao && `cartão ${lote.cartao}`].filter(Boolean).join(" · ");
        if (resumo) partes.push(el("p", { class: "origem" }, `Cabeçalho do dia: ${resumo}`));
    }
    return el("div", { class: "bloco" }, el("h3", {}, `Mensagem${msg?.remetente_nome ? ` de ${msg.remetente_nome}` : ""}${msg?.enviada_em ? ` · ${dataHora(msg.enviada_em)}` : ""}`),
        partes.length ? partes : el("p", { class: "origem" }, "Sem legenda."));
}

function desenharDetalhe() {
    const detalhe = estado.detalhe;
    const [nomeEstado, classeEstado] = NOMES_ESTADO[detalhe.estado] || [detalhe.estado, ""];
    const campos = el("div", { class: "campos" }, estado.opcoes.campos.map((campo) => linhaCampo(campo, detalhe)));
    const acoes = el("div", { class: "acoes" });
    if (detalhe.editavel) {
        acoes.append(
            el("button", { type: "button", class: "secondary", onclick: () => executar(() => salvar(campos), "Correções salvas.") }, "Salvar correções"),
            el("button", { type: "button", class: "primary", onclick: () => executar(() => aprovar(campos), "Aprovada. Virou exemplo de treino.") }, "Salvar e aprovar"),
            detalhe.correcoes.length ? null : el("button", { type: "button", class: "ghost", title: "Gera a prévia de novo com os cadastros atuais (sem chamar o OCR)", onclick: () => executar(regenerar, "Prévia gerada de novo.") }, "Regerar prévia"));
    } else {
        acoes.append(el("button", { type: "button", class: "secondary", onclick: () => executar(reabrir, "Reaberta para revisão.") },
            detalhe.estado === "BLOQUEADO_DUPLICADO" ? "Não é duplicata: revisar" : "Reabrir"));
    }
    if (detalhe.estado !== "DESCARTADO") {
        const motivo = el("input", { placeholder: "Motivo do descarte (ex.: não é despesa)", maxlength: 200 });
        acoes.append(el("div", { class: "descarte" }, motivo,
            el("button", { type: "button", class: "danger ghost", onclick: () => executar(() => descartar(motivo.value), "Descartada.") }, "Descartar")));
    }

    const historico = el("details", { class: "leitura" }, el("summary", {}, `Histórico (${detalhe.historico.length}) e correções (${detalhe.correcoes.length})`),
        el("ul", { class: "historico" },
            detalhe.historico.map((h) => el("li", {}, `${dataHora(h.em)} · ${h.de || "—"} → ${h.para}${h.motivo ? ` (${h.motivo})` : ""}`)),
            detalhe.correcoes.map((c) => el("li", {}, `${dataHora(c.em)} · ${c.autor} corrigiu ${c.campo}: ${JSON.stringify(c.valor_anterior)} → ${JSON.stringify(c.valor_novo)} [${c.tipo_erro}]`))));

    const irmas = detalhe.outras_da_mesma_foto.length
        ? el("p", { class: "origem" }, "Outros comprovantes nesta mesma foto: ", detalhe.outras_da_mesma_foto.map((d) => el("a", { href: "#", onclick: (e) => { e.preventDefault(); selecionar(d.id); } }, `#${d.id} `)))
        : null;
    const duplicada = detalhe.duplicada_de ? el("p", { class: "origem" }, "Parecida com ", el("a", { href: "#", onclick: (e) => { e.preventDefault(); selecionar(detalhe.duplicada_de); } }, `#${detalhe.duplicada_de}`)) : null;

    $("#detalhe").replaceChildren(
        el("div", { class: "detalhe-topo" },
            el("h2", {}, `Despesa #${detalhe.id}`),
            el("span", { class: `etiqueta ${classeEstado}` }, nomeEstado)),
        el("div", { class: "corpo" },
            blocoFoto(detalhe),
            el("div", {},
                blocoLista("Pendências", detalhe.pendencias, "pend"),
                blocoLista("Avisos", detalhe.avisos, "avi"),
                irmas, duplicada,
                el("div", { class: "bloco" }, el("h3", {}, "Prévia"), campos),
                acoes,
                blocoMensagem(detalhe),
                blocoLeitura(detalhe),
                historico)));
}

// ---------------------------------------------------------------------------
// Acoes
// ---------------------------------------------------------------------------

function alteracoesDe(campos) {
    return [...campos.querySelectorAll(".campo.mudou")].map((linha) => ({
        campo: linha.dataset.chave,
        valor: linha.querySelector("input:not([type=radio]), select").value,
        tipo_erro: linha.querySelector(".tipo-erro input:checked")?.value,
    }));
}

async function salvar(campos) {
    const alteracoes = alteracoesDe(campos);
    if (!alteracoes.length) throw new Error("Nenhum campo foi alterado.");
    await api(`/despesas/${estado.selecionada}/corrigir`, { alteracoes, autor: revisor() });
    await recarregar();
}

async function aprovar(campos) {
    const autor = revisor();
    const alteracoes = alteracoesDe(campos);
    if (alteracoes.length) await api(`/despesas/${estado.selecionada}/corrigir`, { alteracoes, autor });
    await api(`/despesas/${estado.selecionada}/aprovar`, { autor });
    estado.selecionada = null;
    await recarregar();
}

async function descartar(motivo) {
    await api(`/despesas/${estado.selecionada}/descartar`, { motivo, autor: revisor() });
    estado.selecionada = null;
    await recarregar();
}

async function reabrir() {
    await api(`/despesas/${estado.selecionada}/reabrir`, { motivo: estado.detalhe.estado === "BLOQUEADO_DUPLICADO" ? "não é duplicata" : "reaberta na Central", autor: revisor() });
    await recarregar();
}

async function regenerar() {
    await api(`/despesas/${estado.selecionada}/regenerar`, {});
    await recarregar();
}

async function recarregar() {
    await carregarRemetentes();
    await carregarLista();
    if (estado.selecionada != null) await selecionar(estado.selecionada);
}

// ---------------------------------------------------------------------------
// Remetentes nao vinculados
// ---------------------------------------------------------------------------

async function carregarRemetentes() {
    const caixa = $("#remetentes");
    const lista = await api("/remetentes");
    if (!lista.length) { caixa.classList.add("oculto"); return; }
    caixa.classList.remove("oculto");
    caixa.replaceChildren(el("b", {}, "Remetentes ainda não reconhecidos."), " Diga quem é cada um: as prévias dele são refeitas e as próximas fotos já chegam com o nome certo.",
        ...lista.map((remetente) => {
            const escolha = el("select", {}, el("option", { value: "" }, "Quem é?"), estado.opcoes.pessoas.map((pessoa) => el("option", { value: pessoa.id }, pessoa.nome)));
            return el("div", { class: "linha" },
                el("code", {}, remetente.nome || remetente.remetente_id), `${remetente.despesas} despesa(s)`, escolha,
                el("button", { type: "button", class: "secondary", onclick: () => executar(async () => {
                    if (!escolha.value) throw new Error("Escolha a pessoa.");
                    const { regeradas } = await api("/remetentes", { whatsapp_id: remetente.remetente_id, pessoa_id: escolha.value });
                    await recarregar();
                    avisar(`Vinculado. ${regeradas} prévia(s) refeita(s).`, "ok");
                }) }, "Vincular"));
        }));
}

// ---------------------------------------------------------------------------
// Treino
// ---------------------------------------------------------------------------

function mostrarContagem(contagem) {
    for (const [aba, total] of Object.entries(contagem)) {
        const alvo = document.querySelector(`[data-n="${aba}"]`);
        if (alvo) alvo.textContent = total;
    }
}

async function carregarTreino() {
    const [m, { contagem }] = await Promise.all([api("/metricas"), api("/despesas?aba=revisar")]);
    mostrarContagem(contagem);
    const pct = (valor) => (valor == null ? "—" : `${Math.round(valor * 100)}%`);
    const linhas = Object.values(m.por_campo).sort((a, b) => (a.acuracia ?? 1) - (b.acuracia ?? 1));
    $("#areaTreino").replaceChildren(
        el("div", { class: "cartoes-metricas" },
            el("article", {}, el("span", {}, "Exemplos validados"), el("strong", {}, m.exemplos_treino)),
            el("article", {}, el("span", {}, "Aprovadas sem nenhuma correção"), el("strong", {}, m.aprovadas ? pct(m.aprovadas_sem_correcao / m.aprovadas) : "—")),
            el("article", {}, el("span", {}, "Correções de leitura"), el("strong", {}, m.correcoes_por_tipo.LEITURA || 0)),
            el("article", {}, el("span", {}, "Correções de classificação"), el("strong", {}, m.correcoes_por_tipo.CLASSIFICACAO || 0))),
        m.aprovadas
            ? el("div", { class: "rolagem" }, el("table", { class: "tabela-metricas" },
                el("thead", {}, el("tr", {}, ["Campo", "Avaliados", "IA acertou", "Acerto", "Erro de leitura", "Erro de classificação", "IA deixou vazio"].map((t) => el("th", {}, t)))),
                el("tbody", {}, linhas.map((item) => el("tr", {},
                    el("td", {}, item.rotulo), el("td", {}, item.avaliados), el("td", {}, item.acertos),
                    el("td", {}, pct(item.acuracia), el("span", { class: "barra" }, el("i", { style: `width:${Math.round((item.acuracia || 0) * 100)}%` }))),
                    el("td", {}, item.erros_leitura), el("td", {}, item.erros_classificacao), el("td", {}, item.ia_vazia))))))
            : el("div", { class: "vazio" }, "Ainda não há despesas aprovadas. As métricas aparecem conforme você aprova as prévias."),
        el("p", { class: "origem" }, "Só entram nas métricas e no treino as despesas que uma pessoa aprovou. Uma despesa reaberta ou descartada sai do treino."));
}

// ---------------------------------------------------------------------------
// Inicio
// ---------------------------------------------------------------------------

async function trocarAba(aba) {
    estado.aba = aba;
    estado.selecionada = null;
    history.replaceState(null, "", `#${aba}`);
    for (const botao of document.querySelectorAll(".abas button")) botao.setAttribute("aria-selected", botao.dataset.aba === aba ? "true" : "false");
    const treino = aba === "treino";
    $("#areaRevisao").classList.toggle("oculto", treino);
    $("#areaTreino").classList.toggle("oculto", !treino);
    await executar(treino ? carregarTreino : carregarLista);
}

async function iniciar() {
    try { $("#revisor").value = localStorage.getItem("vmac-revisor") || ""; } catch (_) { /* sem armazenamento */ }
    $("#temaToggle").addEventListener("click", () => {
        const novo = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
        document.documentElement.dataset.theme = novo;
        try { localStorage.setItem("vmac-tema", novo); } catch (_) { /* sem armazenamento */ }
    });
    for (const botao of document.querySelectorAll(".abas button")) botao.addEventListener("click", () => trocarAba(botao.dataset.aba));
    try {
        estado.opcoes = await api("/opcoes");
        document.body.append(el("datalist", { id: "listaCategorias" }, estado.opcoes.categorias.map((categoria) =>
            el("option", { value: categoria.nome }, `${categoria.grupo}${categoria.id ? "" : " · sem ID"}`))));
        await carregarRemetentes();
        const abaDaUrl = location.hash.slice(1);
        if (document.querySelector(`.abas [data-aba="${CSS.escape(abaDaUrl)}"]`)) await trocarAba(abaDaUrl);
        else await carregarLista();
    } catch (erro) { avisar(`Não consegui carregar a Central: ${erro.message}`); }
}

iniciar();
