"use strict";

// =============================================================================
// Assistente da Central: painel lateral (como o chat do VS Code), aberto por um
// botao fixo no canto da tela ou por Ctrl+Shift+A, sem sair da aba atual.
// Independente: funciona na Central e no painel principal.
// =============================================================================

(() => {
    const API = "/api/central/assistente";
    const MODELOS = [["", "Padrão"], ["opus", "Opus"], ["sonnet", "Sonnet"], ["haiku", "Haiku"]];
    const chat = { conversa: null, pessoa: null, ocupado: false, estado: null, aberto: false, montado: false };

    const guardar = (chave, valor) => { try { if (valor === undefined) return localStorage.getItem(chave); localStorage.setItem(chave, valor); } catch (_) { return null; } return null; };
    const quando = (iso) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? "" : d.toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" }); };

    function el(tag, atributos = {}, ...filhos) {
        const no = document.createElement(tag);
        for (const [chave, valor] of Object.entries(atributos)) {
            if (valor === null || valor === undefined || valor === false) continue;
            if (chave === "class") no.className = valor;
            else if (chave.startsWith("on")) no.addEventListener(chave.slice(2), valor);
            else no.setAttribute(chave, valor === true ? "" : valor);
        }
        for (const filho of filhos.flat()) if (filho !== null && filho !== undefined && filho !== false) no.append(filho instanceof Node ? filho : String(filho));
        return no;
    }

    async function api(caminho, corpo) {
        const resposta = await fetch(`${API}${caminho}`, corpo === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(corpo) });
        const dados = await resposta.json().catch(() => ({}));
        if (!resposta.ok) throw new Error(dados.erro || `Erro ${resposta.status}`);
        return dados;
    }

    function status(texto, erro = false) {
        const caixa = document.getElementById("assStatus");
        if (!caixa) return;
        caixa.textContent = texto || "";
        caixa.classList.toggle("erro", erro);
    }

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
                const [cabeca, ...resto] = tabela.filter((l) => !/^\s*\|[\s:|-]+\|\s*$/.test(l));
                saida.push(`<div class="ass-tabela"><table><thead><tr>${celulas(cabeca).map((c) => `<th>${inline(c)}</th>`).join("")}</tr></thead><tbody>${
                    resto.map((l) => `<tr>${celulas(l).map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`);
            } else if (/^\s*[-*]\s+/.test(linha)) {
                const itens = [];
                while (i < linhas.length && /^\s*[-*]\s+/.test(linhas[i])) itens.push(linhas[i++].replace(/^\s*[-*]\s+/, ""));
                i -= 1;
                saida.push(`<ul>${itens.map((it) => `<li>${inline(it)}</li>`).join("")}</ul>`);
            } else if (/^#{1,4}\s+/.test(linha)) saida.push(`<p><b>${inline(linha.replace(/^#{1,4}\s+/, ""))}</b></p>`);
            else if (linha.trim()) saida.push(`<p>${inline(linha)}</p>`);
        }
        const div = document.createElement("div");
        div.className = "ass-md";
        div.innerHTML = saida.join("");
        return div;
    }

    function bolha(papel, texto, extra = null) {
        const quem = papel === "pessoa" ? (extra?.pessoa || "Você") : papel === "assistente" ? "Assistente" : "Programa";
        return el("div", { class: `ass-msg ass-${papel}` }, el("div", { class: "ass-quem" }, quem), papel === "assistente" ? markdown(texto) : el("div", {}, texto));
    }

    function cartaoProposta(proposta) {
        if (proposta.status && proposta.status !== "PENDENTE") {
            return el("div", { class: "ass-proposta decidida" }, `${proposta.resumo} — ${proposta.status.toLowerCase()}${proposta.decidida_por ? ` por ${proposta.decidida_por}` : ""}`);
        }
        const decidir = async (aceito) => {
            try {
                const r = await api(`/propostas/${proposta.id}`, { pessoa: chat.pessoa, aceito });
                await abrirConversa(chat.conversa);
                status(aceito ? (r.status === "EXECUTADA" ? "Confirmado." : `Não executado: ${r.erro || ""}`) : "Cancelado.", r.status === "FALHOU");
            } catch (erro) { status(erro.message, true); }
        };
        return el("div", { class: "ass-proposta" },
            el("div", {}, el("b", {}, "Ação proposta: "), proposta.resumo),
            el("small", {}, `Só executa com o clique de ${(chat.estado?.podem_confirmar || []).join(", ")}.`),
            el("div", { class: "ass-acoes" },
                el("button", { type: "button", class: "primary", onclick: () => decidir(true) }, "Confirmar"),
                el("button", { type: "button", class: "ghost", onclick: () => decidir(false) }, "Cancelar")));
    }

    async function abrirConversa(id) {
        chat.conversa = id || null;
        const area = document.getElementById("assMensagens");
        area.replaceChildren();
        if (!id) {
            area.append(el("div", { class: "ass-vazio" },
                el("p", {}, el("b", {}, "Pergunte o que precisar, sem sair da tela.")),
                el("ul", {}, ["Quanto cada operador gastou em outubro?", "Quem está há mais de 3 dias sem mandar nota?", "Por que a nota #81 está pendente?", "O WhatsApp está conectado?"]
                    .map((exemplo) => el("li", {}, el("button", { type: "button", class: "ass-exemplo", onclick: () => { document.getElementById("assTexto").value = exemplo; enviar(); } }, exemplo))))));
        } else {
            const conversa = await api(`/conversas/${id}`);
            for (const m of conversa.mensagens) area.append(bolha(m.papel, m.texto, m.dados));
            for (const p of conversa.propostas) area.append(cartaoProposta(p));
            area.scrollTop = area.scrollHeight;
        }
        await listarConversas();
    }

    async function listarConversas() {
        const lista = await api("/conversas");
        const seletor = document.getElementById("assConversas");
        seletor.replaceChildren(el("option", { value: "" }, "Nova conversa"),
            ...lista.map((c) => el("option", { value: c.id, selected: c.id === chat.conversa }, `${c.titulo || `Conversa ${c.id}`} · ${c.pessoa} · ${quando(c.atualizada_em)}`)));
    }

    async function enviar() {
        const caixa = document.getElementById("assTexto");
        const texto = caixa.value.trim();
        if (!texto || chat.ocupado) return;
        chat.pessoa = document.getElementById("assPessoa").value;
        if (!chat.pessoa) { status("Escolha quem está falando (no topo do painel).", true); document.getElementById("assPessoa").focus(); return; }
        guardar("vmac-chat-pessoa", chat.pessoa);
        chat.ocupado = true;
        document.getElementById("assEnviar").disabled = true;
        document.getElementById("assParar").hidden = false;
        caixa.value = "";
        const area = document.getElementById("assMensagens");
        if (!chat.conversa) area.replaceChildren();
        area.append(bolha("pessoa", texto, { pessoa: chat.pessoa }));
        const resposta = el("div", { class: "ass-msg ass-assistente" }, el("div", { class: "ass-quem" }, "Assistente"), el("div", { class: "ass-md" }, el("span", { class: "ass-pensando" }, "Pensando…")));
        area.append(resposta);
        area.scrollTop = area.scrollHeight;
        let parcial = "";
        let final = null;
        try {
            const http = await fetch(`${API}/enviar`, { method: "POST", headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ pessoa: chat.pessoa, texto, conversa_id: chat.conversa, modelo: document.getElementById("assModelo").value }) });
            const leitor = http.body.getReader();
            const decodificador = new TextDecoder();
            let resto = "";
            for (;;) {
                const { value, done } = await leitor.read();
                if (done) break;
                resto += decodificador.decode(value, { stream: true });
                const linhas = resto.split("\n");
                resto = linhas.pop();
                for (const linha of linhas.filter(Boolean)) {
                    const ev = JSON.parse(linha);
                    if (ev.tipo === "texto_parcial") { parcial += ev.texto; resposta.lastChild.replaceWith(markdown(parcial)); area.scrollTop = area.scrollHeight; }
                    else if (ev.tipo === "ferramenta") status(`Consultando: ${ev.nome.replaceAll("_", " ")}…`);
                    else if (ev.tipo === "uso_plano") mostrarUso(ev);
                    else if (ev.tipo === "final" || ev.tipo === "falha") final = ev;
                }
            }
            if (final?.tipo === "falha") throw new Error(final.erro);
            await abrirConversa(final?.conversa_id || chat.conversa);
            status(final?.resultado === "indisponivel" || final?.resultado === "erro" ? final.texto : "", final?.resultado !== "resposta");
        } catch (erro) {
            status(erro.message, true);
        } finally {
            chat.ocupado = false;
            document.getElementById("assEnviar").disabled = false;
            document.getElementById("assParar").hidden = true;
            caixa.focus();
        }
    }

    function mostrarUso(ev) {
        const pct = (v) => (v == null ? null : `${Math.round(v * 100)}%`);
        const partes = [pct(ev.janela_5h) && `5 h ${pct(ev.janela_5h)}`, pct(ev.semana) && `semana ${pct(ev.semana)}`].filter(Boolean);
        document.getElementById("assUso").textContent = partes.length ? `Uso da assinatura: ${partes.join(" · ")}` : "";
    }

    async function mostrarSugestoes() {
        const caixa = document.getElementById("assSugestoes");
        const lista = await api("/sugestoes");
        const novas = lista.filter((s) => s.status === "NOVA");
        document.getElementById("assSugestoesBotao").textContent = `Sugestões${novas.length ? ` (${novas.length})` : ""}`;
        if (caixa.hidden) return;
        const mudar = async (id, situacao) => { await api(`/sugestoes/${id}`, { status: situacao }); await mostrarSugestoes(); };
        caixa.replaceChildren(el("b", {}, "Sugestões anotadas pelo assistente"),
            ...(lista.length ? lista.slice(0, 30).map((s) => el("div", { class: `ass-sugestao ${s.status.toLowerCase()}` },
                el("small", {}, `${s.tipo || "melhoria"} · ${s.pessoa} · ${quando(s.em)} · ${s.status.toLowerCase()}`), el("div", {}, s.texto),
                s.status === "NOVA" ? el("div", { class: "ass-acoes" },
                    el("button", { type: "button", class: "secondary", onclick: () => mudar(s.id, "FEITA") }, "Feita"),
                    el("button", { type: "button", class: "ghost", onclick: () => mudar(s.id, "DESCARTADA") }, "Descartar")) : null))
                : [el("small", {}, "Nenhuma ainda.")]));
    }

    function montar() {
        if (chat.montado) return;
        chat.montado = true;
        const painel = el("aside", { id: "assPainel", class: "ass-painel", "aria-label": "Assistente", hidden: true },
            el("header", { class: "ass-topo" },
                el("div", { class: "ass-titulo" }, el("b", {}, "Assistente"), el("small", { id: "assEstado" }, "")),
                el("div", { class: "ass-acoes" },
                    el("button", { type: "button", class: "ghost", title: "Nova conversa", onclick: () => abrirConversa(null) }, "＋"),
                    el("button", { type: "button", class: "ghost", title: "Fechar (Ctrl+Shift+A)", onclick: () => alternar(false) }, "✕"))),
            el("div", { class: "ass-opcoes" },
                el("select", { id: "assPessoa", "aria-label": "Quem está falando" }),
                el("select", { id: "assModelo", "aria-label": "Modelo" }, MODELOS.map(([v, r]) => el("option", { value: v }, r))),
                el("select", { id: "assConversas", "aria-label": "Conversas anteriores" })),
            el("div", { id: "assMensagens", class: "ass-mensagens" }),
            el("div", { id: "assSugestoes", class: "ass-sugestoes", hidden: true }),
            el("div", { id: "assStatus", class: "ass-status", role: "status" }),
            el("footer", { class: "ass-envio" },
                el("textarea", { id: "assTexto", rows: 3, placeholder: "Pergunte algo… (Enter envia · Shift+Enter quebra linha)" }),
                el("div", { class: "ass-rodape" },
                    el("button", { id: "assSugestoesBotao", type: "button", class: "ghost", onclick: () => { const c = document.getElementById("assSugestoes"); c.hidden = !c.hidden; mostrarSugestoes(); } }, "Sugestões"),
                    el("small", { id: "assUso" }, ""),
                    el("button", { id: "assParar", type: "button", class: "ghost", hidden: true, onclick: () => api("/parar", {}) }, "Parar"),
                    el("button", { id: "assEnviar", type: "button", class: "primary", onclick: enviar }, "Enviar"))));
        document.body.append(painel);
        document.getElementById("assTexto").addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); enviar(); } });
        document.getElementById("assModelo").value = guardar("vmac-chat-modelo") || "";
        document.getElementById("assModelo").addEventListener("change", (e) => guardar("vmac-chat-modelo", e.target.value));
        document.getElementById("assPessoa").addEventListener("change", (e) => { chat.pessoa = e.target.value; guardar("vmac-chat-pessoa", e.target.value); });
        document.getElementById("assConversas").addEventListener("change", (e) => abrirConversa(e.target.value ? Number(e.target.value) : null).catch((erro) => status(erro.message, true)));
    }

    async function carregar() {
        chat.estado = await api("/estado");
        const salvo = guardar("vmac-chat-pessoa") || "";
        const seletor = document.getElementById("assPessoa");
        seletor.replaceChildren(el("option", { value: "" }, "Quem está falando?"), ...chat.estado.usuarios.map((u) => el("option", { value: u, selected: u === salvo }, u)));
        chat.pessoa = seletor.value || null;
        document.getElementById("assEstado").textContent = chat.estado.disponivel ? "Claude da empresa · sem custo de API" : chat.estado.mensagem;
        document.getElementById("assEnviar").disabled = !chat.estado.disponivel;
        await abrirConversa(chat.conversa);
        await mostrarSugestoes();
    }

    async function alternar(abrir = !chat.aberto) {
        montar();
        chat.aberto = abrir;
        document.getElementById("assPainel").hidden = !abrir;
        document.body.classList.toggle("ass-aberto", abrir);
        guardar("vmac-chat-aberto", abrir ? "1" : "0");
        if (abrir) {
            try { await carregar(); } catch (erro) { status(erro.message, true); }
            document.getElementById("assTexto").focus();
        }
    }

    const botao = el("button", { type: "button", class: "ass-botao", title: "Assistente (Ctrl+Shift+A)", "aria-label": "Abrir o assistente", onclick: () => alternar() },
        el("span", { "aria-hidden": "true" }, "✦"), el("span", {}, "Assistente"));
    document.body.append(botao);
    document.addEventListener("keydown", (e) => { if (e.ctrlKey && e.shiftKey && (e.key === "A" || e.key === "a")) { e.preventDefault(); alternar(); } });
    if (guardar("vmac-chat-aberto") === "1") alternar(true);
})();
