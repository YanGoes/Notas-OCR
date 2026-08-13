# Próximos passos e ideias registradas

Lista de melhorias combinadas mas **ainda não implementadas**. Serve de lembrete
para retomar depois, sem precisar reabrir o histórico de conversas.

---

## 1. Vincular o cadastro de veículos da empresa

**Pedido original:** quando chegar uma nota de abastecimento, identificar de qual
veículo da frota é o abastecimento e **acrescentar essa informação como comentário
no lançamento do Conta Azul**.

**O que já existe hoje e pode ser aproveitado:**

- `src/azure-ocr.js` já lê a placa do comprovante — com o rótulo `Placa:` e também
  sem rótulo, quando há uma única sequência com formato de placa (antiga `ABC1234`
  ou Mercosul `ABC1D23`);
- `configuracao/veiculos.json` já mapeia `placa → categoria_id` do Conta Azul, e é
  usado por `src/classificador.js` para escolher a categoria de combustível/manutenção
  específica de cada veículo;
- `src/detalhes-despesa.js#descricaoContaAzul` já monta a descrição enviada ao
  Conta AI, incluindo `Placa:`, `Litragem:`, `Produto:` e `Km:`.

**O que falta fazer:**

1. Trazer o cadastro real da frota (planilha/sistema da empresa) para
   `configuracao/veiculos.json`, com pelo menos: placa, apelido/modelo, e o
   identificador interno usado pela empresa.
2. Cruzar a placa lida na nota com esse cadastro e, quando houver correspondência,
   incluir o nome do veículo (não só a placa) na descrição/comentário do lançamento.
3. Definir o comportamento quando a placa lida **não** existir no cadastro: hoje o
   documento vai para revisão por falta de veículo; avaliar se deve continuar assim
   ou apenas registrar um aviso.
4. Avaliar se o comentário vai na descrição do lançamento (já funciona hoje) ou em
   um campo separado do Conta Azul — a API não publica um campo de "observação"
   independente para o evento financeiro, então a descrição é o caminho mais provável.

**Cuidado importante:** a extração de placa sem rótulo é deliberadamente conservadora
— se o comprovante tiver duas sequências parecidas com placa, o sistema devolve `null`
em vez de arriscar. Ao ampliar isso, manter esse princípio: **é melhor pedir revisão
do que anexar a nota ao veículo errado.**

---

## 2. Confirmar o contrato do PATCH de centro de custo

A alteração de **forma de pagamento** via `PATCH /v1/financeiro/eventos-financeiros/parcelas/{id}`
está confirmada por teste real. A alteração de **categoria e centro de custo** pelo mesmo
PATCH (via `rateio` / `rateio_centro_custo`) **nunca foi confirmada empiricamente** — a
documentação oficial só descreve esses campos na criação do lançamento.

Hoje o código lida com as duas hipóteses: tenta o payload completo e, se a API recusar
por causa do campo (400/422), cai para payloads menores e registra a pendência. Falta:

- rodar uma vez `node ferramentas/testar_enriquecedor.js ... --executar` contra um
  lançamento real de teste e verificar qual `tentativaAplicada` a API aceitou;
- registrar o resultado em `API-CONTA-AZUL.md`, encerrando a dúvida.

---

## 3. Itens levantados na auditoria e deixados fora de escopo

- `ferramentas/processar_dia.js` importa funções que não existem mais em
  `src/legenda.js`, `src/azure-ocr.js` e `src/classificador.js`. É código morto de uma
  versão anterior e quebra se executado. Avaliar remoção.
- `src/conta-azul.js` (linhas ~240-283) ainda contém o monitor automático legado, com
  a opção `aceitar_despesa_automaticamente`. O monitor está desativado por segurança e
  as funções não são chamadas por ninguém, mas o código continua no arquivo.
- O painel (`src/interface.js`) não tem testes automatizados.
