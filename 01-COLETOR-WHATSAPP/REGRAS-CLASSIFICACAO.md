# Regras de classificação das despesas

Levantado a partir do histórico real de contas a pagar exportado do Conta Azul
(10.809 lançamentos, jun/2025 em diante), analisado localmente em 03/08/2026.

> O arquivo de origem fica em `Downloads` e **não deve ser copiado para dentro do projeto**, nem
> versionado, nem enviado a serviço externo. Este documento contém apenas as regras derivadas.

## Como vocês lançam hoje

| Campo | Como é preenchido |
| --- | --- |
| Fornecedor | Balde genérico, não a empresa real: `RESTAURANTES` (2.678), `POSTOS DE COMBUSTÍVEL` (1.722), `HOTÉIS` (736), `SUPERMERCADO` (214) |
| Descrição | Texto curto com a quantidade: `ALMOÇO - 2 PESSOAS`, `6 DIÁRIAS`, `58,8L od 84.019 - SGR-4B54` |
| Categoria | Define **o que** é a despesa |
| Centro de custo | Define **de qual contrato/obra** é a despesa |
| Conta bancária | `Inter - Conta Corrente` (4.421), `Banco do Brasil` (3.991), `C6`, `Porto Seguro`, `Nubank` |
| Forma de pagamento | `Cartão de crédito` em 52% dos casos |

Metade do volume (5.553 de 10.809, ou 51%) é despesa de campo — o alvo da automação.

## Categoria de combustível é POR VEÍCULO

Esta é a regra mais importante e menos óbvia. Abastecimento **não** vai para "Combustíveis":
cada veículo tem sua própria categoria, com a placa no nome.

| Veículo | Categoria | Lançamentos (campo) |
| --- | --- | --- |
| Gol | `GOL - RLQ4C16` | 197 |
| Hilux | `HILUX - OVN5J98` | 188 |
| Etios | `ETIOS - JKM0I96` | 167 |
| Etios | `ETIOS - OVN1505` | 165 |
| Saveiro | `SAVEIRO - RBT2E25` | 154 |
| Fiat Scudo (van) | `FIAT SCUDO - SGR4B54` | 143 |
| S10 | `S10 - REP7B39` | 136 |
| Gerador | `GERADOR` | 102 |
| Veículo alugado | `VEICULO - ALUGADO` | 87 |
| Hilux | `HILUX - OMU7H82` | 80 |
| Onix | `ONIX - SFI4A94` | 29 |
| Duster | `DUSTER - JJK0492` | 24 |
| S10 | `S10 - PRE5B39` | 12 |

Manutenção segue a mesma lógica, em categoria separada:
`MANUTENÇÃO FIAT SCUDO SGR4B54`, `MANUTENÇÃO HILUX OVN5J98`, `MANUTENÇÃO S10 REP7B39`…

**Consequência para a automação:** a legenda precisa identificar o veículo, e quando houver dois do
mesmo modelo (duas Hilux, dois Etios, dois S10) o nome do modelo **não basta** — é preciso a placa
ou outra marca que desempate.

## Onde a classificação manual é consistente

Dá para automatizar com segurança:

| Palavra na descrição | Categoria | Consistência |
| --- | --- | --- |
| `PEDÁGIO` | `Pedágios` | 100% (153/153) |
| `DIÁRIA` | `HOSPEDAGEM` | 99,8% (536/537) |
| `LANCHE` | `Lanches e Refeições` | 99,2% (239/241) |

## Onde a classificação manual é inconsistente

**37% das despesas de campo (2.060 lançamentos) têm descrição idêntica classificada de formas
diferentes.** O problema está concentrado nas refeições:

| Descrição | Foi classificada como |
| --- | --- |
| `ALMOÇO - 2 PESSOAS` (311x) | `Refeição - Almoço` 196 · `Lanches e Refeições` 110 · outras 5 |
| `JANTAR - 2 PESSOAS` (289x) | `Refeição - jantar` 193 · `Lanches e Refeições` 93 · outras 3 |
| `CAFÉ DA MANHÃ - 2 PESSOAS` (94x) | `Lanches e Refeições` 73 · `Café da Manhã` 21 |
| `ÁGUA` (72x) | `Lanches e Refeições` 39 · `Água` 28 · `Diversos` 4 |

Repare no café da manhã: a categoria específica é usada **menos** (29%) que a genérica (68%).

Isso não é erro de quem lançou — são categorias que se sobrepõem. Mas significa que **não existe
regra a aprender do histórico para refeições**: é preciso decidir a regra.

### Decisão pendente

Escolher uma das duas e aplicar sempre:

- **A)** Uma categoria só para toda refeição → `Lanches e Refeições`. Simples, e é a que já
  aparece mais no histórico (1.157 no campo).
- **B)** Separar por período → `Café da Manhã`, `Refeição - Almoço`, `Refeição - jantar`,
  com `Lanches e Refeições` só para lanche fora de hora. Dá mais detalhe no relatório e a legenda
  do operador já informa o período (`Refeição (almoço)`).

## Centro de custo: "Consol" é ambíguo

Os centros de custo são contratos/obras — 56 no total. Os maiores:

| Centro de custo | Lançamentos |
| --- | --- |
| DESPESAS ADMINISTRATIVAS | 3.757 |
| DYNATEST INVT. NORDESTE | 529 |
| PENTÁGONO SP | 487 |
| CONSOL MG-050 | 454 |
| IRI/IGG DYNA GO | 320 |
| ESTRATÉGICA FWD NORDESTE | 306 |
| INFRA - ECOSUL | 305 |

A legenda do operador trazia `Centro de Custo: Consol`, mas existem **`CONSOL MG-050`** (454) e
**`CONSOL MG-259`** (11). O nome curto não resolve. Ou o operador passa a escrever o nome completo,
ou é preciso uma regra de desempate (a mais provável: rodovia citada na legenda).

## O que NÃO entra na automação

Conforme definido: salários e despesas administrativas ficam de fora. Na prática, excluir o centro
de custo `DESPESAS ADMINISTRATIVAS` já remove a maior parte, e junto com ele as categorias
`Salários`, `Seguro de Vida`, `Honorários Contábeis`, `FGTS`, `Impostos`, `Empréstimos`,
`Plano de Saúde Sócios`, `Pró-labore` e `Aluguel`.

Entram: refeições, hospedagem, combustível, pedágio, material de campo, manutenções, lavagem,
lavanderia, estacionamento, água e diversos de obra.
