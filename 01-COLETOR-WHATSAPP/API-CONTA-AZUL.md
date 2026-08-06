# Contrato da API Conta Azul (v2)

Anotações levantadas **testando a API da conta de teste** em 03/08/2026, porque o portal de
documentação (`developers.contaazul.com`) responde 403 sem login. Onde estiver marcado
"não verificado", o campo ainda não foi confirmado.

Base: `https://api-v2.contaazul.com`

## Consultas úteis

| Endpoint | Retorno na conta de teste |
| --- | --- |
| `GET /v1/pessoas/conta-conectada` | Empresa vinculada — serve de teste de conexão |
| `GET /v1/categorias?tamanho_pagina=200` | 123 categorias (110 do tipo `DESPESA`) |
| `GET /v1/centro-de-custo` | Vazio — precisa cadastrar |
| `GET /v1/conta-financeira` | Vazio — precisa cadastrar |
| `GET /v1/pessoa` | Cadastro de pessoas (fornecedores/clientes) |
| `GET /v1/financeiro/eventos-financeiros/contas-a-pagar/buscar` | Exige `data_vencimento_de` e `data_vencimento_ate` |

Categorias já úteis para o fluxo de despesas de campo:

| Nome | id |
| --- | --- |
| Combustíveis | `b2e64f41-0b9c-4608-8e3e-0e0a0080e0a0` |
| Lanches e Refeições | `5bd50b47-4409-4157-b631-98a24f26148a` |
| Manutenção de Veículos | `aff51b5a-3b53-4101-9fd5-92d67329df33` |
| Transporte Urbano (táxi, Uber) | `966c057b-f439-4db4-ad46-639527d2a846` |

## Criar despesa

`POST /v1/financeiro/eventos-financeiros/contas-a-pagar`

```json
{
  "descricao": "Refeição (almoço) - Rodrigo e Hugo",
  "valor": 48.0,
  "data_competencia": "2026-07-26",
  "condicao_pagamento": {
    "tipo": "A_VISTA",
    "parcelas": [
      {
        "data_vencimento": "2026-07-26",
        "descricao": "Parcela 1/1",
        "detalhe_valor": {
          "valor_bruto": 48.0,
          "valor_liquido": 48.0,
          "desconto": 0,
          "taxa": 0,
          "multa": 0,
          "juros": 0
        }
      }
    ]
  },
  "rateio": [
    {
      "id_categoria": "5bd50b47-4409-4157-b631-98a24f26148a",
      "valor": 48.0,
      "rateio_centro_custo": [
        { "id_centro_custo": "af692fa0-8f85-11f1-a1fb-07d665f7a520", "valor": 48.0 }
      ]
    }
  ]
}
```

Tudo acima está **confirmado por lançamento real** na conta de teste: categoria, centro de custo,
valor, competência, vencimento e método de pagamento gravam corretamente.

### Centro de custo vai dentro do rateio, como lista

Não é um id solto. Cada item do `rateio` tem seu próprio `rateio_centro_custo`, que é um **array**
(permite dividir uma categoria entre vários centros de custo). A chave interna é `id_centro_custo` —
sem o "de". Foram recusados `id_centro_de_custo` e `id` no lugar dele.

Obrigatórios, segundo as mensagens de validação: `valor`, `data_competencia`,
`condicao_pagamento` (com ao menos uma parcela) e `rateio` (com ao menos uma categoria).

### Pegadinha: o campo da composição de valor chama `detalhe_valor`

Esse foi o campo mais difícil de achar. A mensagem de erro é
`"valor da parcela: A composição de valor é obrigatória."` e **não** muda de texto quando o nome
está errado, então ela não ajuda a encontrar o nome certo. Foram recusados: `composicao_valor`
(que é como a API da **Captura** devolve o mesmo dado, na resposta), `valor`, `composicao`,
`valor_composicao`, `composicao_de_valor`, `composicao_valores`, `valores`, `valor_parcela` e
`valueComposition`.

Ou seja: a Captura **responde** com `composicao_valor`, mas o financeiro **exige** `detalhe_valor`.
Não copie o nome de um para o outro.

### A criação é assíncrona

A resposta não traz o id da despesa:

```json
{ "protocolo": "1ee1d478-...", "status": "PENDING", "data_criacao": "2026-08-03T18:48:53" }
```

`PENDING` significa apenas que a requisição entrou na fila — **não** que a despesa foi criada. Uma
requisição com categoria inexistente foi aceita com `PENDING` e depois descartada silenciosamente,
sem aparecer na busca.

Não achei endpoint que consulte o protocolo (`/protocolo/{id}` dá 404). Para confirmar que a
despesa realmente existe, é preciso consultar depois:

```
GET /v1/financeiro/eventos-financeiros/contas-a-pagar/buscar
    ?data_vencimento_de=AAAA-MM-DD&data_vencimento_ate=AAAA-MM-DD
```

**Qualquer automação precisa fazer essa conferência**, senão vai achar que lançou despesas que
foram descartadas.

## Consultar o que foi lançado

O detalhe de uma parcela é o retorno mais rico da API e foi ele que revelou os nomes dos campos:

```
GET /v1/financeiro/eventos-financeiros/parcelas/{idParcela}
```

Traz o evento com `rateio`, `rateio_centro_custo`, `valor_composicao`, `metodo_pagamento`,
`conta_financeira`, `anexos` e `baixas`. Não existe endpoint de detalhe do **evento**
(`/eventos-financeiros/{idEvento}` dá 404) — só o da parcela.

## Campos que NÃO funcionam na criação

| Campo | Situação |
| --- | --- |
| Fornecedor | Não conseguimos amarrar. Testados sem sucesso: `id_fornecedor`, `fornecedor:{id}`, `fornecedor:{uuid}`, `id_pessoa`, `pessoa:{id}`, `pessoa:{uuid}`, `uuid_fornecedor`, `uuid_pessoa`, `id_pessoa_fornecedor`. O lançamento nasce com `fornecedor: null`, mesmo com um id de fornecedor válido (`perfis: ["Fornecedor"]`). Provavelmente só é vinculado em outro momento, ou a despesa precisa nascer da Captura para ter fornecedor. |
| Conta financeira | `id_conta_financeira` é aceito sem erro mas fica `null`, tanto na raiz quanto na parcela. O campo existe na leitura; a hipótese é que só se define na **baixa** (pagamento), não na criação. |
| Anexos | Existe o campo `anexos` na leitura, sempre `[]`. Não foi testado como enviar a imagem. |

Nenhum desses impede o fluxo principal: categoria e centro de custo — que é o que a legenda do
operador fornece — funcionam.

## O que dá para cadastrar pela API

| Recurso | Criar | Alterar / excluir |
| --- | --- | --- |
| Categoria | **Não** — `POST /v1/categorias` responde 405 | — |
| Centro de custo | **Sim** — `POST /v1/centro-de-custo` com `{"nome": "..."}` | Não (404 em `PUT` e `DELETE`) |

Ou seja: **categorias só pelo ERP**. Isso importa porque as categorias de vocês (por veículo, com
placa) são customizadas e precisam existir antes de qualquer lançamento automático.

Centro de custo criado por engano não sai pela API — só dá para inativar pela interface.

## Não há exclusão

A API não expõe `DELETE` para eventos nem para parcelas (405/404). Lançamento errado só se apaga
pela interface do ERP. **Mais um motivo para conferir antes de lançar, e não depois.**

## Atenção: nome de campo diferente na escrita e na leitura

Vale memorizar, porque custou caro:

| Dado | Escrita (POST) | Leitura (GET) |
| --- | --- | --- |
| Composição do valor | `detalhe_valor` | `valor_composicao` |
| Centro de custo | `rateio_centro_custo[].id_centro_custo` | `centros_de_custo[]` (na busca) |

## Captura (extração por IA), para comparação

Fluxo que funciona, medido em ~24 s numa foto de cupom:

1. `POST /v1/captura/documentos` — multipart, campo `arquivo`, opcional `descricao`
2. `GET /v1/captura/documentos/status?ids={id}` — até `status_captura: PENDENTE`
3. `GET /v1/captura/{idCaptura}` — devolve `previa_evento_financeiro`

A prévia traz tipo, valor, data, descrição, fornecedor com CNPJ e parcelas — mas **nunca categoria
nem centro de custo**, que é a razão de o projeto usar o lançamento direto.
