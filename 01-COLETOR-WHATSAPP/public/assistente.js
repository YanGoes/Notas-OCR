"use strict";

// =============================================================================
// Aba "Assistente" da Central: chat com o Claude pela assinatura da empresa.
// Usa os utilitarios do central.js (el, $, api, avisar, dataHora).
// =============================================================================

const chat = { conversa: null, pessoa: null, ocupado: false, estado: null };
const MODELOS = [["", "Padrão da assinatura"], ["opus", "Opus (mais inteligente)"], ["sonnet", "Sonnet (mais rápido)"], ["haiku", "Haiku (mais leve)"]];

function lembrar(chave, valor) { try { if (valor === undefined) return localStorage.getItem(chave); localStorage.setItem(chave, valor); } catch (_) { return null; } return null; }

/** Markdown simples e seguro: escapa tudo e so entao aplica negrito, codigo, listas e tabelas. */
function markdown(texto) {
    const escapar = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
    const inline = (s) => escapar(s).replace(/\*\*(.+?)\*\*/g, "<b>$1</b>").replace(/`([^`]+)`/g, "<code>$1</code>");
    const linhas = String(texto || "").split(/\r?\n/);
    const saida = [];
    for (let i = 0; i < linhas.length; i += 1) {
        const linha = linhas[i];
        if (/^\s*\|.*\|\s*$/.test(linha)) {
            const tabela = [];
            while (i < linhas.length && /^\s*\|.*\|\s*$/.test(linhas[i])) tabela.push(linhas[i++]);
            i -= 1;
            const celulas = (l) => l.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
            const corpo = tabela.filter((l) => !/^\s*\|[\s:|-]+\|\s*$/.test(l));
            const [cabeca, ...resto] = corpo;
            saida.push(`<div class="rolagem"><table class="tabela-metricas"><thead><tr>${celulas(cabeca).map((c) => `<th>${inline(c)}</th>`).join("")}</tr></thead><tbody>${
                resto.map((l) => `<tr>${celulas(l).map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`);
        } else if (/^\s*[-*]\s+/.test(linha)) {
            const itens = [];
            while (i < linhas.length && /^\s*[-*]\s+/.test(linhas[i])) itens.push(linhas[i++].replace(/^\s*[-*]\s+/, ""));
            i -= 1;
            saida.push(`<ul>${itens.map((it) => `<li>${inline(it)}</li>`).join("")}</ul>`);
        } else if (/^#{1,4}\s+/.test(linha)) {
            saida.push(`<p><b>${inline(linha.replace(/^#{1,4}\s+/, ""))}</b></p>`);
        } else if (linha.trim()) {
            saida.push(`<p>${inline(linha)}</p>`);
        }
    }
    const div = document.createElement("div");
    div.className = "md";
    div.innerHTML = saida.join("");
    return div;
}

function bolha(papel, texto, extra = null) {
    const rotulo = papel === "pessoa" ? (extra?.pessoa || "Você") : papel === "assistente" ? "Assistente" : "Programa";
    return el("div", { class: `msg msg-${papel}` }, el("div", { class: "msg-quem" }, rotulo), papel === "assistente" ? markdown(texto) : el("div", {}, texto));
}

function cartaoProposta(proposta) {
    if (proposta.status && proposta.status !== "PENDENTE") {
        return el("div", { class: `proposta decidida` }, el("b", {}, proposta.resumo), ` — ${proposta.status.toLowerCase()}${proposta.decidida_por ? ` por ${proposta.decidida_por}` : ""}`);
    }
    const decidir = (aceito) => executar(async () => {
        const resultado = await api(`/assistente/propostas/${proposta.id}`, { pessoa: chat.pessoa, aceito });
        await abrirConversa(chat.conversa);
        avisar(aceito ? (resultado.status === "EXECUTADA" ? "Confirmado." : `Não executado: ${resultado.erro || ""}`) : "Cancelado.", resultado.status === "FALHOU" ? "erro" : "ok");
    });
    return el("div", { class: "proposta" },
        el("div", {}, el("b", {}, "Ação proposta: "), proposta.resumo),
        el("div", { class: "origem" }, `Só executa com o seu clique. Podem confirmar: ${(chat.estado?.podem_confirmar || []).join(", ")}.`),
        el("div", { class: "acoes" },
            el("button", { type: "button", class: "primary", onclick: () => decidir(true) }, "Confirmar"),
            el("button", { type: "button", class: "ghost", onclick: () => decidir(false) }, "Cancelar")));
}

async function abrirConversa(id) {
    chat.conversa = id;
    const area = $("#chatMensagens");
    area.replaceChildren();
    if (!id) {
        area.append(el("div", { class: "vazio" }, "Pergunte sobre gastos, notas, operadores, o Drive ou a situação do programa. Ex.: \"Quanto cada operador gastou em outubro?\", \"Quem está há mais de 3 dias sem mandar nota?\", \"Por que a nota #81 está pendente?\""));
        return;
    }
    const conversa = await api(`/assistente/conversas/${id}`);
    for (const m of conversa.mensagens) {
        const resultado = m.dados?.resultado;
        area.append(bolha(m.papel, m.texto, m.dados));
        if (resultado && typeof resultado === "object") area.append(el("pre", { class: "resultado" }, JSON.stringify(resultado, null, 2).slice(0, 3000)));
    }
    for (const p of conversa.propostas) area.append(cartaoProposta(p));
    area.scrollTop = area.scrollHeight;
    await listarConversas();
}

async function listarConversas() {
    const lista = await api(`/assistente/conversas`);
    const caixa = $("#chatConversas");
    caixa.replaceChildren(
        el("button", { type: "button", class: "secondary full", onclick: () => abrirConversa(null) }, "+ Nova conversa"),
        ...lista.map((c) => el("button", { type: "button", class: `conversa ${c.id === chat.conversa ? "ativa" : ""}`, onclick: () => executar(() => abrirConversa(c.id)) },
            el("span", {}, c.titulo || `Conversa ${c.id}`), el("small", {}, `${c.pessoa} · ${dataHora(c.atualizada_em)}`))));
}

async function enviarPergunta() {
    const caixa = $("#chatTexto");
    const texto = caixa.value.trim();
    if (!texto || chat.ocupado) return;
    chat.pessoa = $("#chatPessoa").value;
    if (!chat.pessoa) { avisar("Escolha quem está conversando."); return; }
    lembrar("vmac-chat-pessoa", chat.pessoa);
    chat.ocupado = true;
    $("#chatEnviar").disabled = true;
    $("#chatParar").classList.remove("oculto");
    caixa.value = "";
    const area = $("#chatMensagens");
    if (!chat.conversa) area.replaceChildren();
    area.append(bolha("pessoa", texto, { pessoa: chat.pessoa }));
    const resposta = el("div", { class: "msg msg-assistente" }, el("div", { class: "msg-quem" }, "Assistente"), el("div", { class: "md" }, ""));
    const status = el("div", { class: "origem chat-status" }, "Pensando…");
    area.append(resposta, status);
    area.scrollTop = area.scrollHeight;
    let parcial = "";
    try {
        const http = await fetch("/api/central/assistente/enviar", { method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ pessoa: chat.pessoa, texto, conversa_id: chat.conversa, modelo: $("#chatModelo").value }) });
        const leitor = http.body.getReader();
        const decodificador = new TextDecoder();
        let resto = "";
        let final = null;
        for (;;) {
            const { value, done } = await leitor.read();
            if (done) break;
            resto += decodificador.decode(value, { stream: true });
            const linhas = resto.split("\n");
            resto = linhas.pop();
            for (const linha of linhas.filter(Boolean)) {
                const ev = JSON.parse(linha);
                if (ev.tipo === "texto_parcial") { parcial += ev.texto; resposta.lastChild.replaceWith(markdown(parcial)); }
                else if (ev.tipo === "ferramenta") status.textContent = `Consultando: ${ev.nome.replaceAll("_", " ")}…`;
                else if (ev.tipo === "pensando") status.textContent = "Pensando…";
                else if (ev.tipo === "uso_plano") mostrarUso(ev);
                else if (ev.tipo === "final" || ev.tipo === "falha") final = ev;
            }
        }
        if (final?.tipo === "falha") throw new Error(final.erro);
        chat.conversa = final?.conversa_id || chat.conversa;
        await abrirConversa(chat.conversa);
        if (final?.resultado === "indisponivel" || final?.resultado === "erro") avisar(final.texto);
    } catch (erro) {
        status.textContent = erro.message;
        avisar(erro.message);
    } finally {
        chat.ocupado = false;
        $("#chatEnviar").disabled = false;
        $("#chatParar").classList.add("oculto");
    }
}

function mostrarUso(ev) {
    const pct = (v) => (v == null ? null : `${Math.round(v * 100)}%`);
    const partes = [pct(ev.janela_5h) && `5 h: ${pct(ev.janela_5h)}`, pct(ev.semana) && `semana: ${pct(ev.semana)}`].filter(Boolean);
    $("#chatUso").textContent = partes.length ? `Uso da assinatura · ${partes.join(" · ")}` : ev.status === "allowed" ? "Assinatura disponível" : `Assinatura: ${ev.status}`;
}

async function carregarSugestoes() {
    const lista = await api("/assistente/sugestoes");
    const caixa = $("#chatSugestoes");
    caixa.replaceChildren(el("summary", {}, `Sugestões anotadas pelo assistente (${lista.filter((s) => s.status === "NOVA").length} novas)`),
        ...(lista.length ? lista.map((s) => el("div", { class: `sugestao-item ${s.status.toLowerCase()}` },
            el("div", {}, el("b", {}, `${s.tipo || "melhoria"} · ${s.pessoa}`), ` · ${dataHora(s.em)} · ${s.status.toLowerCase()}`),
            el("div", {}, s.texto),
            s.status === "NOVA" ? el("div", { class: "acoes" },
                el("button", { type: "button", class: "secondary", onclick: () => executar(async () => { await api(`/assistente/sugestoes/${s.id}`, { status: "FEITA" }); await carregarSugestoes(); }) }, "Marcar como feita"),
                el("button", { type: "button", class: "ghost", onclick: () => executar(async () => { await api(`/assistente/sugestoes/${s.id}`, { status: "DESCARTADA" }); await carregarSugestoes(); }) }, "Descartar")) : null))
            : [el("div", { class: "origem" }, "Nenhuma ainda. Quando alguém der uma ideia ou relatar um problema na conversa, o assistente anota aqui.")]));
}

async function carregarAssistente() {
    const area = $("#areaAssistente");
    if (!area.dataset.montado) {
        area.dataset.montado = "1";
        area.append(
            el("div", { class: "chat-topo" },
                el("label", {}, el("span", {}, "Quem está falando"), el("select", { id: "chatPessoa" })),
                el("label", {}, el("span", {}, "Modelo"), el("select", { id: "chatModelo" }, MODELOS.map(([v, r]) => el("option", { value: v }, r)))),
                el("span", { id: "chatEstado", class: "origem" }), el("span", { id: "chatUso", class: "origem" })),
            el("div", { class: "chat" },
                el("aside", { id: "chatConversas", class: "chat-conversas" }),
                el("div", { class: "chat-principal" },
                    el("div", { id: "chatMensagens", class: "chat-mensagens" }),
                    el("div", { class: "chat-envio" },
                        el("textarea", { id: "chatTexto", rows: 3, placeholder: "Escreva sua pergunta… (Enter envia, Shift+Enter quebra linha)" }),
                        el("div", { class: "acoes" },
                            el("button", { id: "chatEnviar", type: "button", class: "primary", onclick: enviarPergunta }, "Enviar"),
                            el("button", { id: "chatParar", type: "button", class: "ghost oculto", onclick: () => api("/assistente/parar", {}) }, "Parar"))))),
            el("details", { id: "chatSugestoes", class: "bloco-centro" }));
        $("#chatTexto").addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); enviarPergunta(); } });
        $("#chatModelo").value = lembrar("vmac-chat-modelo") || "";
        $("#chatModelo").addEventListener("change", () => lembrar("vmac-chat-modelo", $("#chatModelo").value));
    }
    chat.estado = await api("/assistente/estado");
    const seletor = $("#chatPessoa");
    const salvo = lembrar("vmac-chat-pessoa") || "";
    seletor.replaceChildren(el("option", { value: "" }, "— escolha —"), ...chat.estado.usuarios.map((u) => el("option", { value: u, selected: u === salvo }, u)));
    chat.pessoa = seletor.value || null;
    seletor.onchange = () => { chat.pessoa = seletor.value; lembrar("vmac-chat-pessoa", seletor.value); };
    $("#chatEstado").textContent = chat.estado.mensagem;
    $("#chatEnviar").disabled = !chat.estado.disponivel;
    await listarConversas();
    if (!chat.conversa) await abrirConversa(null);
    await carregarSugestoes();
}
