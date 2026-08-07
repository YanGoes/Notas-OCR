# Comparativo técnico das versões

Comparação feita em 07/08/2026 entre a versão local do painel e a branch
`refeicoes-hospedagem-conta-azul`. As duas versões foram executadas separadamente antes da união.

## Decisão

A versão local permanece como base. A branch do colega nasceu de uma versão anterior do projeto;
um merge integral removeria proteções já existentes. Foram portadas somente as melhorias que
acrescentam precisão ou um caminho novo sem substituir o fluxo validado.

## O que foi mantido da versão local

- OCR fiscal mais completo: fornecedor/CNPJ, chave NFC-e, data, valor, itens, litros, placa e km;
- separação entre maquininha Stone/Cielo/PagBank e o fornecedor fiscal;
- tratamento de fotos com mais de um comprovante;
- interface em tempo real, grupos persistidos e centro de custo padrão por grupo;
- confirmação da empresa, piloto antes do lote, fila sequencial e estados persistidos;
- proteção contra duplicidade, alteração da nota após aprovação e falhas de rede incertas;
- reconciliação completa antes de considerar um lançamento confirmado.

## O que foi aproveitado da branch do colega

- classificação de refeição por horário: café da manhã, almoço, lanche e jantar;
- descrição padronizada da refeição e quantidade de pessoas quando informada;
- regras de hospedagem: pessoas, diárias, check-in/check-out e conferência auxiliar de valor;
- bloqueio de diária de freelancer para não virar hospedagem;
- formato de criação financeira direta com categoria e centro de custo;
- confirmação assíncrona pelo protocolo devolvido pelo Conta Azul.

## Correções feitas durante a união

- combustível com produto e litragem prevalece sobre um rótulo genérico `Meal` do Azure;
- legenda e documento incompatíveis vão para revisão em vez de um deles vencer silenciosamente;
- horários e datas ambíguos não escolhem categoria por palpite;
- datas impossíveis e UUIDs inválidos são recusados;
- tolerância de valor de hospedagem passou a respeitar a configuração;
- freelancer também é procurado no texto bruto e nos itens;
- o caminho financeiro direto exige confirmação explícita e nunca reenvia automaticamente após
  resposta incerta;
- Captura e criação direta são mutuamente exclusivas para impedir duas despesas da mesma nota.

## Limite da API

Os dois caminhos se complementam, mas não devem ser executados juntos para a mesma nota:

| Campo | Conta AI Captura | Criação direta |
| --- | --- | --- |
| Documento para revisão | Sim | Não |
| Fornecedor inferido | Sim | Depende do contrato/cadastro disponível |
| Valor, data e descrição exatos do programa | Podem divergir | Sim |
| Categoria e centro de custo exatos | Podem divergir | Sim |
| Conta financeira, baixa e situação Pago | Revisão no ERP | Não fazem parte da criação básica |

O caminho direto é uma alternativa assistida para prévias divergentes. Ele não entra no lote
automático e não deve ser apresentado como lançamento completo enquanto fornecedor, documento e
pagamento não forem confirmados no ERP.

## Critério de liberação

A integração só pode ser considerada pronta quando todos os testes antigos e novos passarem, a
checagem de sintaxe terminar sem erro e uma única nota controlada for conferida de ponta a ponta na
empresa correta. Nenhum teste automatizado deste repositório deve criar despesas reais.
