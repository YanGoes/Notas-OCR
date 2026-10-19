"use strict";

// =============================================================================
// VEICULOS: km rodados, litros, consumo e gasto por veiculo
// =============================================================================
//
// Junta os abastecimentos da planilha do Conta Azul (descricao no padrao
// "63,57L od 310.748 - OVN5J98", categoria do veiculo) com os da Central (notas
// lidas desde 11/10/2026). Mesma placa + mesmo hodometro = mesmo abastecimento.
//
// Hodometro digitado errado e comum ("od 61,788", "od ..."): leituras fora da
// sequencia (voltando, ou pulando mais de 3.000 km entre dois abastecimentos)
// ficam de fora do calculo de km e sao contadas como "descartadas".
// =============================================================================

const PULO_MAXIMO_KM = 3000;

const placaDe = (texto) => (String(texto || "").toUpperCase().replace(/[\s-]/g, "").match(/[A-Z]{3}\d[A-Z0-9]\d{2}/) || [])[0] || null;

function lerDescricao(descricao) {
    const texto = String(descricao || "");
    const od = texto.match(/\bod\b\s*[:.]?\s*(\d{1,3}(?:\.\d{3})+|\d{4,7})(?![\d,])/i);
    const litros = texto.match(/(\d{1,3}(?:[.,]\d{1,3})?)\s*l(?:t|ts|itros)?\b/i);
    return {
        odometro: od ? Number(od[1].replace(/\./g, "")) : null,
        litros: litros ? Number(litros[1].replace(",", ".")) : null,
    };
}

/** Abastecimentos de todas as fontes, um por (placa, data, hodometro). */
function abastecimentos({ planilha = [], central = [] }) {
    const lista = [];
    for (const l of planilha) {
        const desc = lerDescricao(l.descricao);
        const placa = placaDe(l.categoria) || placaDe(l.descricao);
        if (!placa || !(desc.litros > 0) || /manuten/i.test(l.categoria || "")) continue;
        lista.push({ placa, veiculo: l.categoria, data: l.data, litros: desc.litros, odometro: desc.odometro, valor: Math.abs(Number(l.valor) || 0), fonte: "planilha" });
    }
    for (const d of central) {
        if (!d.placa || !(d.litros > 0)) continue;
        lista.push({ placa: placaDe(d.placa), veiculo: d.veiculo || d.placa, data: d.data, litros: d.litros, odometro: d.odometro || null, valor: Math.abs(Number(d.valor) || 0), fonte: "central" });
    }
    const vistos = new Set();
    return lista.filter((a) => {
        const chave = `${a.placa}|${a.odometro || `${a.data}|${a.litros}`}`;
        if (vistos.has(chave)) return false;
        vistos.add(chave);
        return true;
    }).sort((a, b) => String(a.data).localeCompare(String(b.data)) || (a.odometro || 0) - (b.odometro || 0));
}

/** Resumo por veiculo no periodo. */
function resumoPorVeiculo(lista, { placa = null, de = null, ate = null } = {}) {
    const alvo = placa ? placaDe(placa) || String(placa).toUpperCase() : null;
    const porPlaca = new Map();
    for (const a of lista) {
        if (alvo && a.placa !== alvo) continue;
        if ((de && a.data < de) || (ate && a.data > ate)) continue;
        if (!porPlaca.has(a.placa)) porPlaca.set(a.placa, []);
        porPlaca.get(a.placa).push(a);
    }
    return [...porPlaca.entries()].map(([chave, itens]) => {
        // Sequencia de hodometros plausivel (sempre subindo, sem pulos absurdos).
        const validos = [];
        let descartadas = 0;
        for (const a of itens.filter((i) => i.odometro)) {
            const anterior = validos[validos.length - 1];
            if (!anterior || (a.odometro >= anterior.odometro && a.odometro - anterior.odometro <= PULO_MAXIMO_KM)) validos.push(a);
            else descartadas += 1;
        }
        const km = validos.length >= 2 ? validos[validos.length - 1].odometro - validos[0].odometro : null;
        // Consumo: km rodados / litros abastecidos DEPOIS do primeiro hodometro valido.
        const litrosDepois = validos.slice(1).reduce((soma, a) => soma + a.litros, 0);
        const litros = itens.reduce((soma, a) => soma + a.litros, 0);
        const gasto = itens.reduce((soma, a) => soma + a.valor, 0);
        const ultimo = itens[itens.length - 1];
        const nomes = [...new Set(itens.map((a) => a.veiculo).filter(Boolean))];
        return {
            placa: chave, nomes_no_conta_azul: nomes.slice(0, 4),
            abastecimentos: itens.length, litros: Math.round(litros * 100) / 100, gasto: Math.round(gasto * 100) / 100,
            km_rodados: km, consumo_km_por_litro: km && litrosDepois ? Math.round((km / litrosDepois) * 100) / 100 : null,
            custo_por_km: km ? Math.round((gasto / km) * 100) / 100 : null,
            hodometro_inicial: validos[0]?.odometro ?? null, hodometro_final: validos[validos.length - 1]?.odometro ?? null,
            primeiro_abastecimento: itens[0]?.data, ultimo_abastecimento: ultimo?.data, ultimo_hodometro: ultimo?.odometro ?? null,
            leituras_de_hodometro_descartadas: descartadas, sem_hodometro: itens.filter((a) => !a.odometro).length,
        };
    }).sort((a, b) => (b.km_rodados || 0) - (a.km_rodados || 0));
}

module.exports = { lerDescricao, abastecimentos, resumoPorVeiculo, placaDe };
