# Regras de classificação das despesas

Levantado a partir do histórico real de contas a pagar exportado do Conta Azul, analisado
localmente. Última revisão em 07/08/2026, sobre 12.457 lançamentos (jan/2025 a jul/2026),
dos quais 3.485 são refeições.

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

## Refeições: separadas por período (decisão fechada)

Em cima de todo o histórico as refeições pareciam caóticas — a mesma descrição classificada de
várias formas. Olhando só os **últimos 3 meses**, o quadro é outro: vocês convergiram sozinhos para
separar por período. `Café da Manhã` só começou a ser usada em **abril/2026** (era zero antes) e
`Lanches e Refeições` caiu de 272 lançamentos/mês para menos de 20.

| Período | Categoria no Conta Azul | Consistência (mai–jul/2026) |
| --- | --- | --- |
| Café da manhã | `Café da Manhã` | 94% (48/51) |
| Almoço | `Refeição - Almoço` | 95% (196/207) |
| Jantar | `Refeição - jantar` | 96% (184/191) |
| Lanche | `Lanches e Refeições` | 93% (26/28) |

**Copie as strings exatamente como estão** — o Conta Azul tem caixa inconsistente entre elas:
`Refeição - Almoço` com A maiúsculo, mas `Refeição - jantar` com j minúsculo.

### O período vem do horário impresso no comprovante

Não há como deduzir o período pelo valor. Almoço e jantar são estatisticamente a mesma coisa:

| R$ por pessoa | Almoço | Jantar | Café |
| --- | --- | --- | --- |
| até 15 | 1% | 0% | 44% |
| 15–25 | 10% | 12% | 47% |
| 25–35 | 40% | 42% | 7% |
| 35–50 | 42% | 39% | 2% |

Medianas: almoço R$ 34,67/pessoa, jantar R$ 34,00/pessoa. Indistinguíveis. Só o café da manhã se
destaca (um corte em R$ 20/pessoa pega 79% dos cafés arrastando 3% dos demais).

Por isso a hora do cupom é o critério, configurada em `configuracao/regras.json`:

| Faixa | Período | Categoria |
| --- | --- | --- |
| 04:00 – 10:29 | `CAFÉ DA MANHÃ` | `Café da Manhã` |
| 10:30 – 15:29 | `ALMOÇO` | `Refeição - Almoço` |
| 15:30 – 17:59 | `LANCHE` | `Lanches e Refeições` |
| 18:00 – 03:59 | `JANTAR` | `Refeição - jantar` |

A hora do comprovante prevalece sobre o que o operador escreveu na legenda; quando as duas
divergem, o lançamento vai para revisão com o motivo registrado. **Sem hora legível, vai sempre
para revisão** — a legenda ainda preenche a sugestão, mas ninguém lança no automático.

### Quantidade de pessoas vem da legenda, não da nota

O comprovante não diz quantas pessoas comeram. Testamos estimar por `valor ÷ ticket médio`
(ticket aprendido em 2025, validado em 2026) e não é confiável o bastante:

| Período | Acerto exato | Erra por 1 | Erra por 2+ |
| --- | --- | --- | --- |
| Almoço | 54% | 39% | 8% |
| Jantar | 65% | 31% | 3% |
| Café da manhã | 44% | 41% | 16% |

Chutar sempre "2 pessoas" acertaria 42–45%, ou seja, a estimativa ganha só ~15 pontos do chute.
Então o número vem do campo `Pessoas:` da legenda. **Quando o operador não informa, a descrição sai
sem o sufixo (`ALMOÇO`) e o lançamento segue normalmente** — não é motivo de revisão. Hoje entre 15%
e 24% das legendas não trazem a contagem.

### Formato da descrição

O robô gera sempre em maiúsculas: `ALMOÇO - 2 PESSOAS`, `JANTAR - 1 PESSOA`,
`CAFÉ DA MANHÃ - 3 PESSOAS` (singular quando for 1 pessoa).

Vale registrar a divergência: os lançamentos manuais migraram para Title case em janeiro/2026
(`Almoço - 2 pessoas`) e desde abril são 100% assim. O formato em maiúsculas foi escolhido de
propósito, e tem o efeito colateral de deixar visível o que veio do robô.

### Validado ponta a ponta em 07/08/2026

Os quatro períodos foram lançados de verdade na conta de teste, partindo da hora do cupom e
passando por classificador → descrição → API → conferência pelo protocolo:

| Hora | Descrição gravada | Categoria |
| --- | --- | --- |
| 07:20 | `CAFÉ DA MANHÃ - 2 PESSOAS` | `Café da Manhã` |
| 12:47 | `ALMOÇO - 2 PESSOAS` | `Refeição - Almoço` |
| 16:20 | `LANCHE - 3 PESSOAS` | `Lanches e Refeições` |
| 20:15 | `JANTAR - 3 PESSOAS` | `Refeição - jantar` |

Nenhum caiu em revisão. Centro de custo `CONSOL MG-050` gravou nos quatro.

### Ainda em aberto

- `ÁGUA` (72x) continua dividida entre `Lanches e Refeições` 39 · `Água` 28 · `Diversos` 4.
- A faixa da tarde (15:30–17:59) vai para `Lanches e Refeições`, confirmado em 07/08/2026. As
  fronteiras exatas do horário ainda são convenção: o histórico não tem hora para conferir.
- Falta medir **com que frequência o Azure realmente devolve a hora**. Não há amostras de OCR no
  repositório para conferir, e disso depende quanto volume vai cair na fila de revisão.

## Hospedagem

966 lançamentos no histórico. A categoria é sólida: **`HOSPEDAGEM`** em maiúsculas (não Title case
como as refeições), 96% nos últimos 3 meses — 160 de 166.

### O padrão da descrição é novo

Definido em 07/08/2026: `HOSPEDAGEM - 2 PESSOAS/1 DIÁRIA`, com singular quando for 1.

Isso **não** vem do histórico. Do que existe hoje:

| O que aparece | Quantidade |
| --- | --- |
| `Diária - 3 pessoas` | 53 (últimos 3 meses) |
| `Diária - 2 pessoas` | 45 (últimos 3 meses) |
| `HOSPEDAGEM - 2 PESSOAS` | 97 (era antiga, maiúsculas) |
| pessoas **e** diárias juntos | **3 de 966** |
| com a barra como separador | **nenhum** |

Só **7%** informam a quantidade de diárias. Adotar o padrão novo exige que o operador passe a
informar `Diarias:` na legenda — é mudança de processo, não só de código.

### Cuidado: "diária" também é pagamento de mão de obra

Existe a categoria **`DIÁRIA - FREELANCER`** (46 lançamentos) para pagamento de pessoal:

```
Diária Freelancer - Adonis
Serviços Freelancer 11 diárias - Kauã Souza
Freelancer Batedor - Adonis
Mão de obra - Wendel (Freelancer)
```

O `regras.json` mapeia `"diaria"` como apelido de hospedagem, então sem tratamento um pagamento de
freelancer entraria como HOSPEDAGEM. O padrão
`freelancer|freela|batedor|mão de obra|serviços de digitação` separa 42 dos 46 com **1 falso
positivo em 934** hospedagens — e esse único caso
(`Pix: Freelancer Daniel - 14 Diárias`) parece estar mal classificado no próprio histórico.

Quando o padrão casa, o lançamento é **bloqueado**, não apenas mandado para revisão: é despesa de
outra natureza, e lançar como hospedagem distorce o custo da obra.

### De onde vem o número de diárias

Em ordem: legenda (`Diarias: 2`) → quantidade escrita no documento (`3 DIÁRIAS`) → check-in e
check-out → período (`de 22/08 a 26/08`) → item com unidade de diária. Sem nenhum deles, a
descrição sai parcial (`HOSPEDAGEM - 2 PESSOAS`) e o lançamento vai para revisão.

Datas invertidas ou período acima de 60 dias são recusados em vez de virarem número.

### Conferência de valor

O preço da diária no histórico é estável: **mediana R$ 110**, p25 R$ 100, p75 R$ 120 (55
lançamentos com diárias explícitas). Cruzando com o valor por número de pessoas — 1p R$ 135,
2p R$ 240, 3p R$ 330, 4p R$ 480 — dá ~R$ 110 a 120 por pessoa, ou seja **o caso típico é 1 diária
por pessoa**.

Isso serve para conferir, nunca para preencher: se o valor fugir mais de 60% de
`pessoas × diárias × R$ 110`, o lançamento vai para revisão com o valor esperado no motivo.

### Nota fiscal: decidido não registrar

Hospedagem costuma vir como NF ou PDF, mas o campo "Nota fiscal" está **vazio em todos os 966
lançamentos** — e ficou definido em 07/08/2026 que **continua assim**: o número da NF não é
cadastrado. O documento serve para ler valor, data e diárias; o número não vai para o Conta Azul.

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
