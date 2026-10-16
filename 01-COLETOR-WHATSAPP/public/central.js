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
Object.assign(ORIGENS, {
    fornecedor_generico_do_tipo: "fornecedor padrão do tipo", itens_da_nota: "estimado pelos itens da nota (confirme)",
    hospedes_na_nota: "hóspedes na nota (confirme)", habito_do_operador: "costume do operador (confirme)", valor_da_diaria: "estimado pelo valor da diária (confirme)", nota_confirmada_pela_mensagem: "nota (confere com a mensagem)", texto_da_nota: "texto da nota", frota_por_semelhanca: "parecida com a frota",
    material_de_campo: "material de campo (pelos itens/loja)", template_material: "modelo de material de campo",
    costume_cadastrado: "costume cadastrado (confirme)", despesa_administrativa: "regra de despesa administrativa",
    cartao_do_centro_de_custo: "cartão do centro de custo",
    pessoas_do_mesmo_dia: "como nas outras notas do dia", pessoas_de_dias_anteriores: "como em notas dos dias anteriores (confirme)",
});
const nomeOrigem = (codigo) => ORIGENS[codigo] || String(codigo).replaceAll("_", " ");
const MOTIVOS = { LEITURA: "leitura", CLASSIFICACAO: "classificação", NAO_INFORMADO: "não informado", OUTRO: "outro" };
const PAGAMENTOS_EXTRA = [["CARTAO_CREDITO", "Cartão de crédito (banco não informado)"], ["CARTAO_DEBITO", "Cartão de débito"], ["PIX", "PIX"], ["DINHEIRO", "Dinheiro"]];

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

/**
 * Aviso no topo quando a coleta para (programa fora do ar) ou o WhatsApp cai.
 * Confere a cada 30 s; a bandeja do Windows religa o programa sozinha.
 */
function vigiarColeta() {
    const faixa = document.getElementById("statusColeta");
    const mostrar = (texto, parada) => {
        faixa.textContent = texto;
        faixa.classList.toggle("parada", Boolean(parada));
        faixa.classList.toggle("oculto", !texto);
    };
    const conferir = async () => {
        try {
            const resposta = await fetch("/api/status", { cache: "no-store" });
            const status = await resposta.json();
            const whats = status?.whatsapp?.status;
            if (whats === "conectado") mostrar("");
            else mostrar(`WhatsApp ${whats || "desconectado"}: notas novas NÃO estão chegando. Abra o Painel principal para reconectar.`);
        } catch (_) {
            mostrar("A coleta do WhatsApp está PARADA. Ela religa sozinha em até 1 minuto; se não voltar, use 'Reiniciar coleta' no ícone perto do relógio.", true);
        }
    };
    conferir();
    setInterval(conferir, 30000);
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

// Operador escolhido no filtro (lembrado no navegador). "todos" = sem filtro.
estado.operador = (() => { try { return localStorage.getItem("vmac-operador") || "todos"; } catch (_) { return "todos"; } })();

function desenharFiltroOperador(operadores, totalDaAba) {
    const barra = $("#filtroOperador");
    // Operador lembrado que sumiu do cadastro: volta para "todos".
    if (estado.operador !== "todos" && !operadores.some((item) => item.id === estado.operador)) estado.operador = "todos";
    const botao = (id, rotulo, total) => el("button", {
        type: "button", class: `chip-operador${id === "nao_identificado" ? " sem-operador" : ""}${total === 0 ? " zerado" : ""}`,
        "aria-pressed": String(estado.operador === id), title: id === "todos" ? "Todas as notas desta aba" : `Só as notas de ${rotulo}`,
        onclick: () => {
            estado.operador = id;
            estado.selecionada = null;
            try { localStorage.setItem("vmac-operador", id); } catch (_) { /* sem armazenamento */ }
            executar(carregarLista);
        },
    }, rotulo, " ", el("span", { class: "n" }, total));
    barra.replaceChildren(el("span", { class: "rotulo-operadores" }, "Operador:"), botao("todos", "Todos", totalDaAba),
        ...operadores.map((item) => botao(item.id, item.nome, item.total)));
}

async function carregarLista() {
    const filtro = estado.operador && estado.operador !== "todos" ? `&operador=${encodeURIComponent(estado.operador)}` : "";
    const { itens, contagem, operadores, total_da_aba: totalDaAba } = await api(`/despesas?aba=${encodeURIComponent(estado.aba)}${filtro}`);
    mostrarContagem(contagem);
    desenharFiltroOperador(operadores || [], totalDaAba ?? itens.length);
    const lista = $("#lista");
    lista.replaceChildren();
    if (!itens.length) {
        const nome = (operadores || []).find((item) => item.id === estado.operador)?.nome;
        lista.append(el("div", { class: "vazio" }, nome ? `Nenhuma nota de ${nome} nesta aba.` : "Nada nesta aba."));
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
        // Hodometro com ponto de milhar, como na descricao ("184.428"); ao salvar o ponto e ignorado.
        case "inteiro": return el("input", { ...comum, inputmode: "numeric",
            value: campo.chave === "odometro" && valor != null && valor !== "" ? Number(valor).toLocaleString("pt-BR") : valor ?? "" });
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
        default: return el("input", { ...comum, value: valor ?? "", list: campo.chave === "fornecedor" ? "listaFornecedores" : null });
    }
}

const CAMPOS_ABASTECIMENTO = ["litros", "odometro", "placa"];

/**
 * Motivo da correcao (aparece quando o campo e alterado): leitura,
 * classificacao, nao informado ou outro, mais uma explicacao livre para a IA
 * entender o que errou. Campo que so o operador informa e estava vazio ja vem
 * como "nao informado".
 */
function blocoMotivo(campo, valorAtual) {
    const vazio = valorAtual === null || valorAtual === undefined || valorAtual === "";
    const sugerido = vazio && estado.opcoes.informados_pelo_operador?.includes(campo.chave) ? "NAO_INFORMADO" : campo.erro_sugerido;
    const motivo = el("select", { class: "motivo-erro", "aria-label": `Motivo da correção de ${campo.rotulo}` },
        estado.opcoes.tipos_erro.map((tipo) => el("option", { value: tipo.codigo, selected: tipo.codigo === sugerido }, tipo.rotulo)));
    const explicacao = el("input", { class: "explicacao-erro", maxlength: 300, placeholder: "Explique o erro (opcional) — ex.: operador não disse o cartão" });
    const ajustar = () => {
        const outro = motivo.value === "OUTRO";
        explicacao.placeholder = outro ? "Obrigatório: descreva qual foi o erro" : "Explique o erro (opcional) — ex.: operador não disse o cartão";
        explicacao.required = outro;
    };
    motivo.addEventListener("change", ajustar);
    ajustar();
    return el("div", { class: "tipo-erro" }, el("span", {}, "Motivo da correção:"), motivo, explicacao);
}

function linhaCampo(campo, detalhe) {
    const tipoAtual = detalhe.valores.tipo;
    if (CAMPOS_ABASTECIMENTO.includes(campo.chave) && tipoAtual !== "ABASTECIMENTO" && detalhe.valores[campo.chave] == null) return null;
    if (campo.chave === "pessoas" && !["ALMOCO", "JANTAR", "CAFE_DA_MANHA", "LANCHE", "HOSPEDAGEM"].includes(tipoAtual) && detalhe.valores.pessoas == null) return null;
    const valor = detalhe.valores[campo.chave];
    const origem = origemDe(detalhe.campos, campo.chave);
    const entrada = controle(campo, valor, !detalhe.editavel);
    const linha = el("div", { class: "campo", dataset: { chave: campo.chave, inicial: valorDoControle(entrada, campo) } },
        el("label", { for: `c-${campo.chave}` }, campo.rotulo),
        el("div", { class: "entrada" }, entrada,
            el("span", { class: `origem ${origem === "correcao_humana" ? "humana" : ""}` }, origem ? nomeOrigem(origem) : "sem valor"),
            blocoMotivo(campo, valor)));
    entrada.id = `c-${campo.chave}`;
    const sugestaoPagamento = detalhe.campos.pagamento?.sugestao;
    const sugestao = valor ? null
        : campo.chave === "categoria" ? detalhe.campos.categoria?.sugestao
            : campo.chave === "centro_custo" ? detalhe.campos.centro_custo?.sugestao
            : campo.chave === "placa" && detalhe.campos.abastecimento?.placa?.sugestao
                ? { nome: detalhe.campos.abastecimento.placa.sugestao.valor, origem: detalhe.campos.abastecimento.placa.sugestao.origem }
                : campo.chave === "pagamento" && sugestaoPagamento
                    ? { nome: sugestaoPagamento.rotulo, valor: sugestaoPagamento.codigo, origem: sugestaoPagamento.origem, amostras: sugestaoPagamento.amostras } : null;
    if (sugestao?.nome && detalhe.editavel) {
        const confianca = sugestao.confianca ? ` · ${Math.round(sugestao.confianca * 100)}% de confiança` : "";
        const origemSugestao = { placa_fora_da_frota: "placa fora da frota", frota_por_semelhanca: "placa parecida com a frota",
            habito_do_operador: `costume do operador em ${sugestao.amostras || "várias"} notas`,
            costume_cadastrado: "costume cadastrado do operador", despesa_administrativa: "despesa administrativa" }[sugestao.origem] || "aprendido da planilha";
        linha.querySelector(".entrada").insertBefore(el("div", { class: "sugestao" },
            `Sugestão (${origemSugestao}${confianca}): `, el("b", {}, sugestao.nome), " ",
            el("button", { type: "button", class: "secondary", onclick: () => {
                entrada.value = sugestao.valor ?? sugestao.nome;
                entrada.dispatchEvent(new Event("input"));
                entrada.dispatchEvent(new Event("change"));
            } }, "Usar sugestão")), linha.querySelector(".origem"));
    }
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
    return visualizadorDeFoto(detalhe.imagem_url, `Comprovante da despesa #${detalhe.id}`, false);
}

/**
 * Foto com zoom em niveis (botoes, Ctrl+roda do mouse), arrastar para mover,
 * girar e tela cheia — para ler a nota inteira sem cortar.
 */
function visualizadorDeFoto(url, alt, telaCheia) {
    let zoom = 1;
    const img = el("img", { src: url, alt, draggable: "false" });
    const area = el("div", { class: "foto-area" }, img);
    const rotulo = el("span", { class: "foto-zoom" }, "100%");
    const aplicar = () => {
        img.style.width = `${zoom * 100}%`;
        img.style.transform = estado.giro ? `rotate(${estado.giro}deg)` : "";
        rotulo.textContent = `${Math.round(zoom * 100)}%`;
    };
    const mudarZoom = (fator) => { zoom = Math.min(6, Math.max(0.5, zoom * fator)); aplicar(); };
    area.addEventListener("wheel", (evento) => {
        if (!evento.ctrlKey) return;
        evento.preventDefault();
        mudarZoom(evento.deltaY < 0 ? 1.2 : 1 / 1.2);
    }, { passive: false });
    // Arrastar com o mouse para andar pela nota ampliada.
    let arrasto = null;
    area.addEventListener("mousedown", (evento) => { arrasto = { x: evento.clientX, y: evento.clientY, esquerda: area.scrollLeft, topo: area.scrollTop }; area.classList.add("arrastando"); });
    window.addEventListener("mouseup", () => { arrasto = null; area.classList.remove("arrastando"); });
    area.addEventListener("mousemove", (evento) => {
        if (!arrasto) return;
        area.scrollLeft = arrasto.esquerda - (evento.clientX - arrasto.x);
        area.scrollTop = arrasto.topo - (evento.clientY - arrasto.y);
    });
    img.addEventListener("dblclick", () => mudarZoom(zoom >= 2 ? 1 / zoom : 2));
    const botoes = el("div", { class: "foto-acoes" },
        el("button", { type: "button", class: "secondary", title: "Diminuir", onclick: () => mudarZoom(1 / 1.25) }, "−"),
        rotulo,
        el("button", { type: "button", class: "secondary", title: "Aumentar", onclick: () => mudarZoom(1.25) }, "+"),
        el("button", { type: "button", class: "secondary", onclick: () => { zoom = 1; aplicar(); } }, "Ajustar"),
        el("button", { type: "button", class: "secondary", onclick: () => { estado.giro = (estado.giro + 90) % 360; aplicar(); } }, "Girar"),
        telaCheia
            ? el("button", { type: "button", class: "primary", onclick: fecharTelaCheia }, "Fechar (Esc)")
            : el("button", { type: "button", class: "secondary", onclick: () => abrirTelaCheia(url, alt) }, "Tela cheia"),
        el("span", { class: "origem" }, "Ctrl + roda do mouse dá zoom · arraste para mover · duplo clique amplia"));
    aplicar();
    return el("div", { class: `foto${telaCheia ? " cheia" : ""}` }, botoes, area);
}

function abrirTelaCheia(url, alt) {
    fecharTelaCheia();
    const camada = el("div", { class: "tela-cheia", id: "telaCheia", role: "dialog", "aria-label": "Foto em tela cheia" }, visualizadorDeFoto(url, alt, true));
    camada.addEventListener("click", (evento) => { if (evento.target === camada) fecharTelaCheia(); });
    document.body.append(camada);
}

function fecharTelaCheia() { document.querySelector("#telaCheia")?.remove(); }
document.addEventListener("keydown", (evento) => { if (evento.key === "Escape") fecharTelaCheia(); });

function blocoLeitura(detalhe) {
    if (!detalhe.documento) return null;
    const leitura = detalhe.documento.leitura;
    const linhas = [["Fornecedor", leitura.fornecedor], ["CNPJ", leitura.cnpj], ["Data", dataBr(leitura.data)], ["Hora", leitura.hora],
        ["Valor", leitura.valor != null ? moeda(leitura.valor) : null], ["Confiança", leitura.confianca != null ? `${Math.round(leitura.confianca * 100)}%` : null],
        ["Placa", leitura.placa], ["Litros", leitura.litragem], ["Hodômetro", leitura.odometro != null && leitura.odometro !== "" ? Number(leitura.odometro).toLocaleString("pt-BR") : leitura.odometro], ["Pagamento no cupom", leitura.forma_pagamento], ["Produto", leitura.produto_principal]]
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
            marcadorNaoUsar(),
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
            detalhe.correcoes.map((c) => el("li", {}, `${dataHora(c.em)} · ${c.autor} corrigiu ${c.campo}: ${JSON.stringify(c.valor_anterior)} → ${JSON.stringify(c.valor_novo)} [${MOTIVOS[c.tipo_erro] || c.tipo_erro}]${c.observacao ? ` — "${c.observacao}"` : ""}`))));

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
        valor: linha.querySelector(`#c-${CSS.escape(linha.dataset.chave)}`).value,
        tipo_erro: linha.querySelector(".motivo-erro")?.value,
        observacao: linha.querySelector(".explicacao-erro")?.value.trim() || undefined,
    }));
}

async function salvar(campos) {
    const alteracoes = alteracoesDe(campos);
    if (!alteracoes.length) throw new Error("Nenhum campo foi alterado.");
    await api(`/despesas/${estado.selecionada}/corrigir`, { alteracoes, autor: revisor() });
    await recarregar();
}

/** "Centro e pagamento nao sao reais" (notas antigas de teste): esses dois campos ficam fora do treino. */
function marcadorNaoUsar() {
    let marcado = false;
    try { marcado = localStorage.getItem("vmac-nao-usar-centro-pagamento") === "1"; } catch (_) { /* sem armazenamento */ }
    const caixa = el("input", { type: "checkbox", id: "naoUsarCentroPagamento", checked: marcado });
    caixa.addEventListener("change", () => { try { localStorage.setItem("vmac-nao-usar-centro-pagamento", caixa.checked ? "1" : "0"); } catch (_) { /* ignora */ } });
    return el("label", { class: "nao-usar", title: "Use em notas antigas/de teste em que o centro de custo e o cartão foram preenchidos sem certeza" },
        caixa, " Centro de custo e pagamento não são reais (não usar no treino)");
}

async function aprovar(campos) {
    const autor = revisor();
    const alteracoes = alteracoesDe(campos);
    if (alteracoes.length) await api(`/despesas/${estado.selecionada}/corrigir`, { alteracoes, autor });
    const naoUsar = document.querySelector("#naoUsarCentroPagamento")?.checked ? ["centro_custo", "pagamento"] : [];
    await api(`/despesas/${estado.selecionada}/aprovar`, { autor, nao_usar_no_treino: naoUsar });
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
    const buscar = el("button", { type: "button", class: "secondary", title: "Pergunta ao WhatsApp o telefone de cada número e procura no cadastro de pessoas",
        onclick: () => executar(async () => {
            const r = await api("/remetentes/identificar", {});
            await recarregar();
            const nomes = r.vinculados.map((item) => `${item.pessoa} (${item.notas} nota(s))`).join(", ");
            avisar(r.vinculados.length ? `Reconhecidos: ${nomes}.`
                : `Nenhum reconhecido: ${r.sem_telefone} sem telefone disponível no WhatsApp, ${r.fora_do_cadastro} com telefone fora do cadastro de pessoas.`, r.vinculados.length ? "ok" : "erro");
        }) }, "Buscar nos contatos do WhatsApp");
    caixa.replaceChildren(el("b", {}, "Remetentes ainda não reconhecidos."), " Diga quem é cada um, ou ", buscar,
        ". As prévias deles são refeitas e as próximas fotos já chegam com o nome certo.",
        ...lista.map((remetente) => {
            const escolha = el("select", {}, el("option", { value: "" }, "Quem é?"), estado.opcoes.pessoas.map((pessoa) => el("option", { value: pessoa.id }, pessoa.nome)));
            return el("div", { class: "linha" },
                el("code", {}, remetente.conta_conectada ? "Você (número conectado ao programa)" : remetente.nome || remetente.remetente_id), `${remetente.despesas} despesa(s)`, escolha,
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
        blocoMaturidade(m.maturidade, pct),
        el("h3", { class: "titulo-historico" }, "Histórico das revisões (prévias como a IA gerou na época)"),
        el("div", { class: "cartoes-metricas" },
            el("article", {}, el("span", {}, "Exemplos validados"), el("strong", {}, m.exemplos_treino)),
            el("article", {}, el("span", {}, "Aprovadas sem nenhuma correção"), el("strong", {}, m.aprovadas ? pct(m.aprovadas_sem_correcao / m.aprovadas) : "—")),
            el("article", {}, el("span", {}, "Correções de leitura"), el("strong", {}, m.correcoes_por_tipo.LEITURA || 0)),
            el("article", {}, el("span", {}, "Correções de classificação"), el("strong", {}, m.correcoes_por_tipo.CLASSIFICACAO || 0)),
            el("article", {}, el("span", {}, "Faltou informação (não é erro da IA)"), el("strong", {}, m.correcoes_por_tipo.NAO_INFORMADO || 0)),
            m.azure ? el("article", {}, el("span", {}, `Azure em ${m.azure.mes} (plano gratuito)`),
                el("strong", {}, m.azure.limite ? `${m.azure.paginas} / ${m.azure.limite}` : m.azure.paginas),
                el("span", {}, m.azure.disponivel ? "páginas lidas no mês" : "limite atingido: fotos esperando o próximo mês")) : null),
        m.aprovadas
            ? el("div", { class: "rolagem" }, el("table", { class: "tabela-metricas" },
                el("thead", {}, el("tr", {}, ["Campo", "Avaliados", "IA acertou", "Acerto", "Erro de leitura", "Erro de classificação", "Não informado", "Outro", "IA deixou vazio"].map((t) => el("th", {}, t)))),
                el("tbody", {}, linhas.map((item) => el("tr", {},
                    el("td", {}, item.rotulo), el("td", {}, item.avaliados), el("td", {}, item.acertos),
                    el("td", {}, pct(item.acuracia), el("span", { class: "barra" }, el("i", { style: `width:${Math.round((item.acuracia || 0) * 100)}%` }))),
                    el("td", {}, item.erros_leitura), el("td", {}, item.erros_classificacao), el("td", {}, item.nao_informado ?? 0), el("td", {}, item.outros ?? 0), el("td", {}, item.ia_vazia))))))
            : el("div", { class: "vazio" }, "Ainda não há despesas aprovadas. As métricas aparecem conforme você aprova as prévias."),
        el("p", { class: "origem" }, "Esta parte compara a prévia que a IA gerou NA ÉPOCA com o que foi aprovado; erros já corrigidos nas versões novas continuam contando aqui. A maturidade (acima) mede a versão atual. Só entram despesas aprovadas; reaberta ou descartada sai do treino."),
        blocoPorOperador(m.por_operador, pct),
        blocoPlanilha(m.planilha, pct));
}

/**
 * Uma linha por operador: notas enviadas, onde estao, acerto da IA nas
 * aprovadas e o que FALTOU informar (para orientar quem precisa).
 */
const STATUS_CAMPO = { MADURO: ["maduro", "okk"], QUASE: ["quase", "pend"], APRENDENDO: ["aprendendo", "mau"], POUCOS_DADOS: ["poucos dados", ""] };

/**
 * Maturidade da IA: estagio atual, notas inteiras certas com o minimo
 * garantido (intervalo de confianca) e a situacao de cada campo.
 */
function blocoMaturidade(mat, pct) {
    if (!mat) return el("div", { class: "vazio" }, "Maturidade ainda não medida (rode o treino: atalho 14 ou npm run central:medir).");
    const ni = mat.notas_inteiras;
    return el("div", { class: "bloco maturidade" },
        el("h3", {}, "Maturidade da IA"),
        el("div", { class: "cartoes-metricas" },
            el("article", {}, el("span", {}, "Estágio"), el("strong", {}, mat.rotulo), el("span", {}, mat.explicacao)),
            el("article", {}, el("span", {}, "Notas inteiras certas"), el("strong", {}, `${ni.certas} / ${ni.de}`), el("span", {}, `${pct(ni.taxa)} · mínimo garantido ${pct(ni.minimo_garantido)}`)),
            mat.proximo ? el("article", {}, el("span", {}, `Para chegar em ${mat.proximo.rotulo}`),
                el("strong", {}, mat.proximo.notas_aprovadas_que_faltam == null ? "melhorar a IA" : `+${mat.proximo.notas_aprovadas_que_faltam} notas`),
                el("span", {}, mat.proximo.precisa)) : null),
        el("div", { class: "rolagem" }, el("table", { class: "tabela-metricas" },
            el("thead", {}, el("tr", {}, ["Campo", "Certos", "Acerto", "Mínimo garantido", "Situação"].map((t) => el("th", {}, t)))),
            el("tbody", {}, mat.campos.map((c) => {
                const [nome, classe] = STATUS_CAMPO[c.status] || [c.status, ""];
                return el("tr", {}, el("td", {}, c.rotulo, c.critico ? " *" : ""), el("td", {}, `${c.acertos}/${c.total}`), el("td", {}, pct(c.taxa)),
                    el("td", {}, pct(c.minimo_garantido)), el("td", {}, el("span", { class: `etiqueta ${classe}` }, nome)));
            })))),
        el("p", { class: "origem" }, `Medido em ${dataHora(mat.gerado_em)} com a versão atual da IA reprocessando as ${mat.aprovadas} notas aprovadas (sem gastar o Azure). `
            + "\"Mínimo garantido\" é o pior acerto plausível com 95% de confiança: com poucas notas ele fica baixo mesmo acertando tudo. * = campo que vai para o Conta Azul. "
            + "Campos marcados como \"Não informado\" ficam fora da conta."));
}

function blocoPorOperador(linhas, pct) {
    if (!linhas?.length) return null;
    const faltou = (item) => {
        const partes = [["pagamento", "cartão"], ["centro_custo", "projeto"], ["pessoas", "pessoas"]]
            .filter(([chave]) => item.faltou?.[chave]).map(([chave, nome]) => `${nome} (${item.faltou[chave]})`);
        return partes.length ? partes.join(", ") : "—";
    };
    return el("div", { class: "bloco" },
        el("h3", {}, "Por operador"),
        el("div", { class: "rolagem" }, el("table", { class: "tabela-metricas" },
            el("thead", {}, el("tr", {}, ["Operador", "Notas", "Para revisar", "Aprovadas", "Descartadas", "Acerto da IA", "Faltou informar"].map((t) => el("th", {}, t)))),
            el("tbody", {}, linhas.map((item) => el("tr", {},
                el("td", {}, el("a", { href: "#revisar", onclick: (e) => {
                    e.preventDefault();
                    estado.operador = item.operador;
                    try { localStorage.setItem("vmac-operador", item.operador); } catch (_) { /* sem armazenamento */ }
                    trocarAba("revisar");
                } }, item.nome)),
                el("td", {}, item.notas), el("td", {}, item.para_revisar), el("td", {}, item.aprovadas), el("td", {}, item.descartadas),
                el("td", {}, item.acuracia == null ? "—" : pct(item.acuracia)), el("td", {}, faltou(item))))))),
        el("p", { class: "origem" }, "\"Faltou informar\" conta as correções marcadas como \"Não informado\": mostra quem precisa ser orientado sobre a mensagem padrão. Clique no nome para ver as notas daquele operador."));
}

function blocoPlanilha(planilha, pct) {
    if (!planilha) return el("div", { class: "vazio" }, "Modelo da planilha ainda não treinado (ferramentas/treinar-central.js).");
    const d = planilha.divisao;
    return el("div", { class: "bloco" },
        el("h3", {}, "Categoria: teste com a planilha do Conta Azul"),
        el("p", { class: "origem" }, `Treinado em ${dataHora(planilha.gerado_em)}. Teste com ${d.despesas_de_campo_no_teste} despesas de campo de ${dataBr(d.teste_de)} a ${dataBr(d.teste_ate)}, que o modelo não viu no treino. `,
            `${d.abastecimentos_sem_placa_na_descricao} abastecimentos ficaram de fora: o veículo deles vem da placa lida na nota.`),
        el("div", { class: "rolagem" }, el("table", { class: "tabela-metricas" },
            el("thead", {}, el("tr", {}, ["Abordagem", "Acerto geral", "Quando decide, acerta", "Decide em"].map((t) => el("th", {}, t)))),
            el("tbody", {}, planilha.resultados.map((r) => el("tr", {}, el("td", {}, r.abordagem), el("td", {}, pct(r.acerto_geral)),
                el("td", {}, pct(r.precisao), el("span", { class: "barra" }, el("i", { style: `width:${Math.round(r.precisao * 100)}%` }))), el("td", {}, pct(r.cobertura))))))),
        el("p", { class: "origem" }, "Diferenças entre o cadastro e a prática recente: ",
            planilha.recomendacoes.filter((r) => r.divergente).map((r) => `${r.tipo}: cadastro "${r.cadastro_atual}" × prática "${r.pratica_atual}" (${pct(r.participacao)})`).join(" · ") || "nenhuma."));
}

// ---------------------------------------------------------------------------
// Inicio
// ---------------------------------------------------------------------------

async function trocarAba(aba) {
    estado.aba = aba;
    estado.selecionada = null;
    history.replaceState(null, "", `#${aba}`);
    for (const botao of document.querySelectorAll(".abas button")) botao.setAttribute("aria-selected", botao.dataset.aba === aba ? "true" : "false");
    const area = { treino: "#areaTreino", centros: "#areaCentros", assistente: "#areaAssistente" }[aba] || "#areaRevisao";
    for (const id of ["#areaRevisao", "#areaTreino", "#areaCentros", "#areaAssistente"]) $(id).classList.toggle("oculto", id !== area);
    $("#filtroOperador").classList.toggle("oculto", area !== "#areaRevisao");
    await executar({ treino: carregarTreino, centros: carregarCentros, assistente: carregarAssistente }[aba] || carregarLista);
}

// ---------------------------------------------------------------------------
// Centros de custo (cadastro de projetos)
// ---------------------------------------------------------------------------

const SITUACOES = [["true", "Ativo"], ["false", "Inativo"], ["null", "Não confirmado"]];
const situacaoTexto = (ativo) => (ativo === true ? "Ativo" : ativo === false ? "Inativo" : "Não confirmado");
const situacaoClasse = (ativo) => (ativo === true ? "okk" : ativo === false ? "" : "pend");
estado.filtroCentros = "ativos";

/** Formulario usado para criar e para editar. `projeto` vazio = novo. */
function formularioProjeto(projeto, servicos, aoSalvar, aoCancelar) {
    const campo = (rotulo, entrada, ajuda) => el("label", { class: "campo-centro" }, el("span", {}, rotulo), entrada, ajuda ? el("small", { class: "origem" }, ajuda) : null);
    const nome = el("input", { value: projeto?.nome_oficial || "", maxlength: 160, placeholder: "Ex.: CTVM-IRI-ATR-IGG HOUER MT - ROTA DO PEQUI", required: true });
    const idSistema = el("input", { value: projeto?.id_sistema_projetos ?? "", inputmode: "numeric", maxlength: 6, placeholder: "Ex.: 43" });
    const centro = el("input", { value: projeto?.centro_conta_azul || "", maxlength: 160, placeholder: "Nome exato no Conta Azul" });
    const busca = el("input", { value: projeto?.busca_centro_conta_azul || "", maxlength: 160, placeholder: "Ex.: rota do pequi" });
    const situacao = el("select", {}, SITUACOES.map(([valor, rotulo]) => el("option", { value: valor, selected: String(projeto?.ativo ?? (projeto ? null : true)) === valor }, rotulo)));
    const servico = el("input", { value: projeto?.servico || "", list: "listaServicos", maxlength: 40, placeholder: "FWD, VDROD, IRI…" });
    const cartao = el("select", {}, el("option", { value: "" }, "— não definido"),
        (estado.opcoes?.cartoes || []).map((item) => el("option", { value: item.codigo, selected: item.codigo === (projeto?.cartao || "") }, item.rotulo)));
    const apelidos = el("textarea", { rows: 3, placeholder: "Um por linha. Ex.: Goinfra FWD" });
    apelidos.value = (projeto?.apelidos || []).join("\n");
    const formulario = el("form", { class: "form-centro" },
        el("datalist", { id: "listaServicos" }, servicos.map((s) => el("option", { value: s }))),
        el("div", { class: "grade-centro" },
            campo("Nome do projeto *", nome, "Como está no sistema de projetos."),
            campo("ID no sistema de projetos", idSistema),
            campo("Situação", situacao, "Só projetos ativos são escolhidos automaticamente."),
            campo("Serviço", servico),
            campo("Cartão usado no projeto", cartao, "As notas deste centro já saem com este cartão quando o operador não informar outro."),
            campo("Centro de custo no Conta Azul", centro, "Nome exato. Deixe vazio se for igual ao nome do projeto."),
            campo("…ou trecho do nome para achar", busca, "Usado só enquanto o nome exato estiver vazio; precisa achar um único centro."),
            campo("Como os operadores escrevem", apelidos, "Só um texto IGUAL a um destes resolve o projeto.")),
        el("div", { class: "acoes" },
            el("button", { type: "submit", class: "primary" }, projeto ? "Salvar alterações" : "Cadastrar"),
            aoCancelar ? el("button", { type: "button", class: "ghost", onclick: aoCancelar }, "Cancelar") : null));
    formulario.addEventListener("submit", (evento) => {
        evento.preventDefault();
        const dados = {
            nome_oficial: nome.value, id_sistema_projetos: idSistema.value, centro_conta_azul: centro.value,
            busca_centro_conta_azul: busca.value, ativo: JSON.parse(situacao.value), servico: servico.value, cartao: cartao.value,
            apelidos: apelidos.value.split("\n"),
        };
        executar(() => aoSalvar(dados));
    });
    return formulario;
}

async function depoisDeMudarCadastro(mensagem) {
    estado.opcoes = await api("/opcoes");
    await carregarCentros();
    avisar(`${mensagem} Use "Refazer prévias pendentes" para aplicar às despesas em revisão.`, "ok");
}

async function carregarCentros() {
    const dados = await api("/projetos");
    const { contagem } = await api("/despesas?aba=revisar");
    mostrarContagem(contagem);
    const area = $("#areaCentros");
    const visiveis = dados.projetos.filter((p) => estado.filtroCentros === "todos" || p.ativo !== false);

    const novo = el("details", { class: "bloco-centro" }, el("summary", {}, "+ Cadastrar novo projeto / centro de custo"),
        formularioProjeto(null, dados.servicos, async (projeto) => {
            await api("/projetos", { projeto, autor: revisor() });
            await depoisDeMudarCadastro("Projeto cadastrado.");
        }));

    const linhas = visiveis.map((projeto) => {
        const linha = el("tr", {},
            el("td", {}, el("strong", {}, projeto.nome_oficial), projeto.id_sistema_projetos != null ? el("small", { class: "origem" }, ` · nº ${projeto.id_sistema_projetos}`) : null,
                projeto.no_cadastro ? null : el("div", { class: "origem" }, projeto.origem === "planilha_conta_azul"
                    ? `existe no Conta Azul (planilha)${projeto.ultimo_uso ? ` · último uso ${dataBr(projeto.ultimo_uso)}` : ""}${projeto.usos ? ` · ${projeto.usos} lançamentos` : ""}`
                    : "veio da sincronização com o Conta Azul")),
            el("td", {}, el("span", { class: `etiqueta ${situacaoClasse(projeto.ativo)}` }, situacaoTexto(projeto.ativo)),
                projeto.cartao ? el("div", { class: "origem" }, `cartão: ${projeto.cartao}`) : null),
            el("td", {}, !projeto.centro_conta_azul && projeto.busca_centro_conta_azul && !projeto.id_conta_azul
                ? `procurando "${projeto.busca_centro_conta_azul}"` : projeto.centro_usado || "—",
            el("div", { class: "origem" }, projeto.id_conta_azul ? "ID do Conta Azul encontrado" : "sem ID (sincronize os centros)")),
            el("td", {}, projeto.servico || "—"),
            el("td", {}, projeto.apelidos.length ? projeto.apelidos.join(" · ") : "—"),
            el("td", {}, el("button", { type: "button", class: "secondary", onclick: () => abrirEdicao(linha, projeto, dados.servicos) }, projeto.no_cadastro ? "Editar" : "Confirmar")));
        return linha;
    });

    area.replaceChildren(
        el("p", { class: "origem" }, "Este cadastro diz ao sistema quais projetos estão ativos, qual centro do Conta Azul corresponde a cada um e como os operadores os escrevem. ",
            "Ele não cria nada no Conta Azul: para criar o centro lá, use o painel principal (Gerenciar centros de custo) e depois sincronize. O centro novo aparece aqui como \"não confirmado\" para você confirmar."),
        novo,
        el("div", { class: "acoes" },
            el("button", { type: "button", class: estado.filtroCentros === "ativos" ? "primary" : "secondary", onclick: () => { estado.filtroCentros = "ativos"; executar(carregarCentros); } }, "Ativos e não confirmados"),
            el("button", { type: "button", class: estado.filtroCentros === "todos" ? "primary" : "secondary", onclick: () => { estado.filtroCentros = "todos"; executar(carregarCentros); } }, `Todos (${dados.projetos.length})`),
            el("button", { type: "button", class: "ghost", title: "Gera de novo as prévias em revisão que ninguém corrigiu, com o cadastro atual", onclick: () => executar(async () => {
                const { regeradas, falhas } = await api("/regerar-pendentes", {});
                avisar(`${regeradas} prévia(s) refeita(s)${falhas.length ? `; ${falhas.length} não puderam ser refeitas` : ""}.`, "ok");
            }) }, "Refazer prévias pendentes")),
        el("div", { class: "rolagem" }, el("table", { class: "tabela-metricas tabela-centros" },
            el("thead", {}, el("tr", {}, ["Projeto", "Situação", "Centro no Conta Azul", "Serviço", "Apelidos", ""].map((t) => el("th", {}, t)))),
            el("tbody", {}, linhas))),
        dados.historico.length ? el("details", { class: "leitura" }, el("summary", {}, `Últimas alterações (${dados.historico.length})`),
            el("ul", { class: "historico" }, dados.historico.map((h) => el("li", {}, `${dataHora(h.em)} · ${h.autor} · ${h.acao.toLowerCase().replaceAll("_", " ")} · ${h.chave}`)))) : null);
}

function abrirEdicao(linha, projeto, servicos) {
    const proxima = linha.nextElementSibling;
    if (proxima?.classList.contains("linha-edicao")) { proxima.remove(); return; }
    const edicao = el("tr", { class: "linha-edicao" }, el("td", { colspan: 6 },
        formularioProjeto(projeto, servicos, async (alteracoes) => {
            await api("/projetos/editar", { nome_atual: projeto.nome_oficial, alteracoes, autor: revisor() });
            await depoisDeMudarCadastro("Projeto atualizado.");
        }, () => edicao.remove())));
    linha.after(edicao);
}

async function iniciar() {
    try { $("#revisor").value = localStorage.getItem("vmac-revisor") || ""; } catch (_) { /* sem armazenamento */ }
    $("#temaToggle").addEventListener("click", () => {
        const novo = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
        document.documentElement.dataset.theme = novo;
        try { localStorage.setItem("vmac-tema", novo); } catch (_) { /* sem armazenamento */ }
    });
    for (const botao of document.querySelectorAll(".abas button")) botao.addEventListener("click", () => trocarAba(botao.dataset.aba));
    vigiarColeta();
    try {
        estado.opcoes = await api("/opcoes");
        document.body.append(el("datalist", { id: "listaCategorias" }, estado.opcoes.categorias.map((categoria) =>
            el("option", { value: categoria.nome }, `${categoria.grupo}${categoria.id ? "" : " · sem ID"}`))));
        document.body.append(el("datalist", { id: "listaFornecedores" }, (estado.opcoes.fornecedores || []).map((nome) => el("option", { value: nome }))));
        await carregarRemetentes();
        const abaDaUrl = location.hash.slice(1);
        if (document.querySelector(`.abas [data-aba="${CSS.escape(abaDaUrl)}"]`)) await trocarAba(abaDaUrl);
        else await carregarLista();
    } catch (erro) { avisar(`Não consegui carregar a Central: ${erro.message}`); }
}

iniciar();
