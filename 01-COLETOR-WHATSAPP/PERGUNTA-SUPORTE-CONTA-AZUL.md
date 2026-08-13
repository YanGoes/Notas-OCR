# Perguntas para o suporte do Conta Azul

Cada canal tem a sua seção. **Vá direto na seção do canal que você está usando**
e copie os blocos marcados com `COLE ISTO`.

> ⚠️ Nunca cole `access_token`, `client_secret` ou senha. Os IDs de lançamento
> abaixo são da sua própria conta e podem ser enviados — é o que permite ao
> suporte localizar os registros.

Dados da sua conta, caso peçam:

- **Empresa no ERP:** Jonathan da Cunha Araujo
- **ID da empresa:** 3434571
- **Base da API:** `https://api-v2.contaazul.com`

---

# CANAL 1 — Portal do Desenvolvedor (formulário Zendesk, 4 etapas)

**Onde:** `developers-portal.contaazul.com` → chat "Suporte - Portal do
Desenvolvedor" → abrir chamado.

É o canal **mais importante**. Abra um chamado só para a pergunta do ANEXO
(a mais urgente). Depois abra outro para a pergunta do RATEIO.

## Etapa 1 de 4 — "Informe seu Endpoint ou cURL da request"

**COLE ISTO:**

```
GET https://api-v2.contaazul.com/v1/financeiro/eventos-financeiros/parcelas/ee16c9ab-4764-4e3b-8ee0-74248d9ad5e6
```

## Etapa 2 de 4 — provavelmente "Response" ou "Retorno da API"

**COLE ISTO:**

```json
{
  "id": "ee16c9ab-4764-4e3b-8ee0-74248d9ad5e6",
  "descricao": "Compra de lanche - jul/2026",
  "data_vencimento": "2026-07-27",
  "anexos": [],
  "nota": null,
  "evento": {
    "id": "b2e28c28-71e2-4604-bf8b-6f6ee8828f7c",
    "tipo": "DESPESA",
    "data_competencia": "2026-07-27"
  }
}
```

## Etapa 3 de 4 — provavelmente "Conta logada no ERP"

**COLE ISTO:**

```
Jonathan da Cunha Araujo (ID da empresa: 3434571)
```

## Etapa 4 de 4 — descrição do problema

**COLE ISTO:**

```
Preciso ANEXAR a imagem do comprovante a uma despesa criada pela API, e nao
encontro endpoint para isso.

Contexto: crio as despesas automaticamente por
POST /v1/financeiro/eventos-financeiros/contas-a-pagar. A despesa e criada
corretamente, com categoria e centro de custo. Falta apenas anexar a foto da
nota fiscal - e exigencia interna de auditoria que toda despesa tenha o
comprovante anexado.

O que observei: o campo "anexos" vem sempre vazio ([]) na consulta da parcela,
INCLUSIVE em lancamentos que exibem o icone de clipe na interface web e tem a
imagem visivel na tela. O exemplo enviado (parcela
ee16c9ab-4764-4e3b-8ee0-74248d9ad5e6) e um desses: na interface aparece o
anexo, mas a API retorna anexos: [].

Perguntas:
1) Existe endpoint, mesmo nao documentado publicamente, para enviar um arquivo
   e vincula-lo a um lancamento financeiro existente?
2) Se nao existe hoje, ha previsao de existir?
3) Existe alguma outra forma suportada de fazer isso via API?

Observacao: nao e duvida sobre como anexar pela interface - isso eu ja sei
fazer. Preciso da via programatica, porque sao muitas despesas por dia e o
lancamento e automatico.
```

## Segundo chamado (abrir depois, sobre o RATEIO)

**Etapa 1 — endpoint:**

```
PATCH https://api-v2.contaazul.com/v1/financeiro/eventos-financeiros/parcelas/f6022a67-d404-4aea-8ac7-28b4b0f49c4f
```

**Etapa 2 — request enviada:**

```json
{
  "versao": 3,
  "rateio": [
    {
      "id_categoria": "b2e64f41-0b9c-4608-8e3e-0e0a0080e0a0",
      "valor": 434.53,
      "rateio_centro_custo": [
        { "id_centro_custo": "441058a6-8f89-11f1-a757-1b04f821eecd", "valor": 434.53 }
      ]
    }
  ]
}
```

**Etapa 3 — conta:** `Jonathan da Cunha Araujo (ID da empresa: 3434571)`

**Etapa 4 — descrição:**

```
O PATCH da parcela ACEITA o campo "rateio" (responde 200 e incrementa a versao),
mas NAO altera o rateio de fato.

Teste feito na parcela f6022a67-d404-4aea-8ac7-28b4b0f49c4f:
- centro de custo original: CONSOL MG-050 (43a40a34-8f89-11f1-8cae-0b3dbe3e2005)
- enviei PATCH trocando para CONSOL MG-259 (441058a6-8f89-11f1-a757-1b04f821eecd)
- resposta: HTTP 200, campo "versao" foi de 3 para 4
- ao reler a parcela, o centro de custo continuava CONSOL MG-050
- repeti e a versao foi para 5, e o centro seguiu inalterado
- no MESMO PATCH, o campo "metodo_pagamento" e gravado normalmente

Perguntas:
1) Esse comportamento e esperado? O rateio nao pode ser alterado por este
   endpoint?
2) Se nao pode, seria possivel a API RETORNAR ERRO em vez de aceitar e ignorar
   em silencio? Uma integracao que recebe 200 assume que a alteracao funcionou.
3) Existe outro endpoint para alterar categoria e centro de custo de um
   lancamento ja criado? Notei que
   GET /v1/financeiro/eventos-financeiros/{idEvento} retorna 404.
```

---

# CANAL 2 — Chat "Precisa de ajuda?" (dentro do Conta Azul)

**Onde:** botão azul no canto inferior direito da tela do ERP.

**Regra:** mande **só a primeira mensagem**. Não junte as duas perguntas — em
chat, duas perguntas técnicas viram uma resposta genérica só.

## Mensagem inicial

**COLE ISTO:**

```
Ola! Minha duvida e sobre a API Financeira, nao sobre a interface - preciso
que seja encaminhada ao time tecnico responsavel pela API.

Uso a API para criar despesas automaticamente
(POST /v1/financeiro/eventos-financeiros/contas-a-pagar).

Preciso anexar a imagem do comprovante a despesa criada. Existe algum endpoint
da API para enviar um anexo a um lancamento financeiro?

Detalhe que pode ajudar: em
GET /v1/financeiro/eventos-financeiros/parcelas/{id} o campo "anexos" vem vazio
mesmo em lancamentos que mostram o clipe na tela. Exemplo na minha conta:
parcela ee16c9ab-4764-4e3b-8ee0-74248d9ad5e6.
```

## Se responderem "anexe pela tela" (vão responder isso)

**COLE ISTO:**

```
Obrigado, mas anexar pela tela eu ja sei fazer. O que preciso e fazer isso PELA
API, porque sao muitas despesas por dia e o lancamento e automatico.
Pode encaminhar para o time da API Financeira, por favor?
```

## Só depois de encaminharem, mande a segunda pergunta

**COLE ISTO:**

```
Aproveitando: o PATCH da parcela aceita o campo "rateio" e responde 200,
incrementando a versao, mas o centro de custo nao muda de fato. Isso e
esperado? Existe outro endpoint para alterar categoria e centro de custo depois
que o lancamento ja foi criado?
```

---

# CANAL 3 — WhatsApp / "Fale com um especialista"

**Onde:** link na faixa azul do topo da tela do ERP.

**Para que serve:** só para conseguir o direcionamento. Não espere resposta
técnica aqui.

**COLE ISTO:**

```
Boa tarde! Sou cliente e tenho uma duvida tecnica de API (nao e sobre a
interface).

Preciso saber se existe endpoint na API Financeira para anexar a imagem do
comprovante a uma despesa criada pela API. Ja uso
POST /v1/financeiro/eventos-financeiros/contas-a-pagar e o lancamento e criado
certo, mas nao consigo anexar o arquivo.

Consegue me direcionar ao time responsavel pela API, ou me passar o canal certo
para essa pergunta?
```

---

# O que fazer com a resposta

| Resposta deles | O que fazer |
|---|---|
| Existe endpoint de anexo | Me mande a documentação/exemplo. Implemento rápido — o resto do fluxo já está pronto. |
| Não existe endpoint | Seguimos com anexo manual em lote (fotos já organizadas no Drive por operador/mês/dia) e você decide com seu supervisor sobre o robô de tela. |
| Resposta genérica ("use a interface") | Use a réplica pronta do Canal 2 e insista no encaminhamento técnico. |
| Sobre o rateio, disserem "não dá para alterar" | Tudo bem — mas registre o pedido de a API retornar erro em vez de aceitar em silêncio. Isso é defeito de contrato e pode virar correção do lado deles. |
