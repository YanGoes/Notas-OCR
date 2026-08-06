# Coletor de fotos do WhatsApp

Este projeto monitora **novas fotos** enviadas aos grupos autorizados e salva, para cada foto:

- a imagem original;
- um arquivo `.txt` legível com data, grupo, remetente e legenda;
- um arquivo `.json` com os mesmos metadados para integração com outros sistemas.

Opcionalmente, envia a foto para a **API de Captura do Conta Azul**, aguarda a extração por IA e salva a prévia da despesa para revisão.

## Estado seguro atual

O fluxo principal está configurado em **modo de simulação**:

```text
WhatsApp -> Azure Document Intelligence -> legenda -> classificação -> validações -> JSON de auditoria
```

Ele **não cria lançamentos no Conta Azul**. A integração financeira continua desligada até a validação do lote piloto.

## Primeiro teste do pipeline Azure

1. Dê dois cliques em `CONFIGURAR_AZURE.bat`.
2. Preencha no `.env`:

```env
AZURE_DOCUMENT_ENDPOINT=https://seu-recurso.cognitiveservices.azure.com/
AZURE_DOCUMENT_KEY=sua_chave
AZURE_DOCUMENT_MODEL_ID=prebuilt-receipt
```

3. Coloque uma imagem em `dados/entrada` e crie ao lado dela um JSON de mesmo nome. Exemplo: `teste.jpg` e `teste.json`.
4. O JSON mínimo deve ser:

```json
{
  "id_mensagem": "teste-001",
  "remetente": "operador-teste",
  "legenda": "Tipo: Alimentacao\nCentro de custo: NOME DO CENTRO\nPessoas: 2\nObservacao: Teste piloto"
}
```

5. Dê dois cliques em `TESTAR_PIPELINE.bat`.
6. Confira o resultado em `dados/auditoria`. O conjunto será movido para:

- `dados/simulacao`: passou em todas as regras;
- `dados/revisao`: exige decisão humana;
- `dados/bloqueados`: duplicado ou fora do escopo;
- `dados/erros`: falha definitiva de processamento;
- `dados/ocr-bruto`: resposta original do Azure.

O programa tenta novamente automaticamente em erros 429 e falhas temporárias do Azure.

O valor na legenda é opcional. Quando ele não for informado, o Azure lê o valor no próprio comprovante. Se o campo estruturado não vier, o programa procura de forma conservadora por `valor total` ou `valor a pagar` no texto reconhecido; resultados ambíguos nunca são escolhidos automaticamente.

Se o Azure não conseguir interpretar o documento, a imagem não é descartada: ela segue para `dados/revisao` e aparece no painel como **Revisão humana**, junto da legenda e dos motivos para a equipe responsável fazer a leitura manual.

## Formato recomendado da legenda

```text
Tipo: Abastecimento
Centro de custo: CONSOL MG-050
Veiculo: FIAT SCUDO - SGR4B54
Conta/cartao: Inter
Pessoas: 2
Valor: 251,14
Observacao: Deslocamento para vistoria
```

`Tipo` e `Centro de custo` são obrigatórios. Veículo é obrigatório para combustível e manutenção. Se o operador informar um valor, ele será comparado ao valor do comprovante.

Em abastecimentos, **placa e litragem são dados obrigatórios**. O sistema tenta lê-los diretamente no comprovante; se algum deles não estiver legível e também não vier informado na legenda, a nota será separada para revisão. Placa, litros, combustível, valor por litro e quilometragem ficam salvos na auditoria e são acrescentados à descrição preparada para o Conta Azul.

### Comentário enviado separado da foto

O programa aceita três formas:

1. comentário na legenda da própria foto;
2. comentário enviado até 45 segundos antes da foto;
3. comentário enviado até 45 segundos depois da foto, pelo mesmo operador e no mesmo grupo.

Quando o operador usa **Responder** diretamente na foto, o ID citado é priorizado. Sem resposta direta, o programa associa o texto à foto sem legenda mais próxima daquele mesmo remetente. Durante os 45 segundos de espera, a imagem aparece no painel como `Processando`.

Para evitar associação errada, cada foto deve representar uma despesa e o operador deve enviar o comentário logo em seguida. Um comentário simples como `Restaurante` já é interpretado como alimentação, embora a ausência do centro de custo ainda encaminhe o documento para revisão.

## Mapeamentos obrigatórios antes da aprovação

Substitua os valores `PREENCHER_UUID_...` pelos IDs reais do Conta Azul:

- `configuracao/categorias.json`;
- `configuracao/centros_custo.json`;
- `configuracao/veiculos.json`.

As tolerâncias, tipos permitidos e bloqueados ficam em `configuracao/regras.json`. Enquanto os IDs reais não forem preenchidos, os documentos irão corretamente para revisão.

### Foco das classificações

As regras priorizam alimentação e hospedagem, que são o fluxo principal. Farmácia é aceita como exceção; oficina entra como manutenção e exige veículo. O tipo `outros` sempre exige revisão humana, mesmo quando o OCR tem alta confiança.

### Aprendizado com o histórico

O projeto já contém um modelo local treinado com a planilha histórica `visao_contas_a_pagar (1).xls`. Ele usa fornecedor, descrição e observações para sugerir família, categoria e centro de custo. Ao receber uma nota nova, a sugestão aparece no painel em **Aprendizado histórico**, mas não substitui as validações nem lança automaticamente no Conta Azul.

Resultado da validação isolada, sem reutilizar descrições iguais entre treino e teste:

- família geral (alimentação, hospedagem, oficina etc.): **94,1%** de acerto;
- família em previsões de alta confiança: **98,4%** de precisão;
- categoria contábil exata: **51,7%** de acerto;
- centro de custo: **53,9%** de acerto.

Categoria e centro ainda não possuem precisão suficiente para lançamento sem conferência. Centro de custo depende frequentemente do grupo, projeto ou comentário do operador, algo que a imagem da nota não contém.

Para treinar novamente depois de acrescentar ou corrigir lançamentos na planilha, instale também as dependências de desenvolvimento (`npm.cmd install`) e execute:

```powershell
npm.cmd run treinar-historico -- "C:\caminho\para\visao_contas_a_pagar.xls"
```

O comando precisa ser executado dentro da pasta do projeto. Para evitar erro de pasta ou caminho, use diretamente `ATALHOS\08_TREINAR_IA.bat`: ele entra na pasta correta, instala a biblioteca de leitura e utiliza a planilha histórica já configurada. Também é possível arrastar outra planilha sobre esse BAT.

O modelo atualizado fica em `configuracao/modelo-historico.json` e o relatório detalhado em `dados/aprendizado/relatorio-treinamento.json`. O sistema nunca deve aprender com as próprias previsões; somente lançamentos conferidos por uma pessoa devem voltar para o próximo treinamento.

As 14.967 imagens/PDFs históricos também foram examinados para uma possível ligação automática. Não existe um identificador comum entre nome/caminho dos arquivos e a planilha. Em 1.050 casos a data da pasta encontra vários lançamentos possíveis e em 13.343 não encontra lançamento pela data de competência. Por isso, associar apenas pela data criaria rótulos errados. A etapa seguinte segura é ler uma amostra com OCR e cruzar simultaneamente data, valor e fornecedor, aceitando apenas correspondências únicas.

> A ferramenta usa uma biblioteca não oficial do WhatsApp. Use somente em uma conta e em grupos para os quais a empresa tenha autorização, respeitando privacidade, LGPD e as regras do WhatsApp. Mudanças no WhatsApp podem exigir atualização futura da biblioteca.

## Uso rápido no Windows

1. Extraia ou copie a pasta do projeto para o computador.
2. Dê dois cliques em **`INICIAR.bat`**. O painel gráfico abrirá automaticamente no navegador.
3. Na primeira execução, aceite a instalação do Node.js caso seja solicitada. O iniciador também instala automaticamente todas as bibliotecas do projeto.
4. Se aparecer um QR Code, no celular abra **WhatsApp > Aparelhos conectados > Conectar aparelho** e leia o código.
5. Deixe a janela aberta. As novas fotos aparecerão em `fotos_recebidas`.
6. Para parar, pressione **Ctrl+C** ou feche a janela.

A sessão fica salva em `.baileys_sessao`, então normalmente o QR Code só é necessário uma vez.

### Painel gráfico

No painel `http://127.0.0.1:3210` você pode:

- visualizar e escanear o QR Code na primeira conexão;
- verificar se a sessão está conectada;
- sair/desvincular a sessão deste computador;
- listar todos os grupos reais da conta;
- adicionar ou remover grupos monitorados;
- acompanhar as quantidades nas filas de entrada, simulação, revisão, bloqueados e erros.
- pesquisar grupos por nome ou ID sem perder seleções anteriores;
- acompanhar comprovantes em tempo real com imagem, legenda, dados lidos e motivos de revisão.

O painel é local e só fica acessível no próprio computador.

### Funcionamento contínuo

Para iniciar o programa automaticamente sempre que o usuário entrar no Windows, execute `ATIVAR_INICIO_AUTOMATICO.bat` uma vez. Para desfazer, execute `REMOVER_INICIO_AUTOMATICO.bat`.

Isso não transforma um computador desligado em servidor: para receber documentos continuamente, ele precisa permanecer ligado, conectado à internet e sem suspensão automática. Para disponibilidade real de 24 horas, use um computador dedicado ou servidor, considerando que a conexão via Baileys é não oficial e precisa ser monitorada.

Depois da primeira instalação pelo `INICIAR.bat`, use `ABRIR_APLICATIVO.bat` no dia a dia. Ele inicia a Central de Despesas minimizada na bandeja do Windows, sem VS Code, terminal ou aba do navegador. Clique duas vezes no ícone para abrir o painel; clique com o botão direito para consultar o status ou encerrar.

Os grupos escolhidos ficam salvos em `config.json` e são carregados automaticamente no painel. Não é necessário atualizar ou salvar a lista a cada execução; esses botões servem somente para alterar a seleção.

## Configuração

Edite `config.json` com o Bloco de Notas:

```json
{
  "pasta_saida": "fotos_recebidas",
  "grupos_permitidos": ["ID_DO_GRUPO@g.us"],
  "nomes_dos_grupos": { "ID_DO_GRUPO@g.us": "Nome do grupo" },
  "exigir_legenda": false,
  "aceitar_webp": false
}
```

- `pasta_saida`: pode ser uma pasta relativa ao projeto ou um caminho completo, como `C:\\FotosWhatsApp`.
- `grupos_permitidos`: somente esses grupos serão monitorados. Uma lista vazia aceita todos os grupos e deve ser usada com cautela.
- `nomes_dos_grupos`: nomes usados nos arquivos salvos.
- `exigir_legenda`: quando `true`, ignora fotos sem legenda.
- `aceitar_webp`: quando `true`, também salva imagens WEBP/figurinhas.

## Integração com o Conta Azul

Por segurança, a integração e a criação automática de despesas começam desligadas.

### 1. Criar e autorizar a aplicação

1. Crie uma aplicação no [Portal do Desenvolvedor Conta Azul](https://developers-portal.contaazul.com/).
2. Cadastre uma URL de redirecionamento e anote exatamente essa URL, o `client_id` e o `client_secret`.
3. Dê dois cliques em `CONECTAR_CONTA_AZUL.bat`.
4. Preencha o `.env`, salve, autorize pelo endereço exibido e cole o parâmetro `code` solicitado.

O código de autorização expira rapidamente. Se a troca falhar, execute a conexão novamente. As credenciais ficam em `.env` e os tokens em `tokens_conta_azul.json`; nunca envie esses arquivos.

Para validar a conexão, execute:

```powershell
npm run conta-azul:testar
```

### 2. Ativar o envio das imagens

Em `config.json`, altere somente `habilitada`:

```json
"conta_azul": {
  "habilitada": true,
  "aceitar_despesa_automaticamente": false,
  "intervalo_segundos": 10,
  "timeout_processamento_segundos": 300
}
```

Reinicie pelo `INICIAR.bat`. O mesmo programa passará a:

1. salvar a foto recebida do WhatsApp;
2. enviá-la à Captura do Conta Azul, com a legenda no campo `descricao`;
3. consultar o processamento periodicamente;
4. salvar upload e prévia em `respostas_conta_azul`;
5. mover os arquivos para `processados_conta_azul`.

Falhas definitivas vão para `erros_conta_azul`. Falhas temporárias, expiração do token e demora da IA são tentadas novamente. O programa renova e salva automaticamente tanto o `access_token` quanto o novo `refresh_token`.

### 3. Revisar antes de criar despesas

Mantenha `aceitar_despesa_automaticamente` como `false` durante a validação. Confira no Conta Azul fornecedor, CNPJ/CPF, valor, vencimento, competência, categoria, centro de custo, pagamento e descrição.

Somente depois de validar o processo com a área financeira, mude essa opção para `true`. O código possui uma trava: só aceita automaticamente prévias cujo tipo retornado seja `DESPESA`.

Importante: o endpoint de aceite atual não permite enviar alterações na prévia. Ajustes de categoria, centro de custo ou descrição devem ser feitos no Conta Azul antes do aceite manual, ou exigirão um fluxo adicional usando os endpoints financeiros.

### Como descobrir o ID de um grupo

Com o coletor fechado, abra o PowerShell dentro da pasta e execute:

```powershell
npm run listar-grupos
```

Copie o ID exibido para `grupos_permitidos` e, opcionalmente, associe um nome em `nomes_dos_grupos`.

## O que enviar ao gestor

Para criar automaticamente um `.zip` seguro, dê dois cliques em **`GERAR_PACOTE_PARA_ENVIO.bat`**. O arquivo será criado na pasta do projeto sem sessões, bibliotecas instaladas ou fotos.

Se preferir fazer manualmente, envie estes itens compactados em `.zip`:

- `src`, `scripts` e `ferramentas`;
- `INICIAR.bat`;
- `config.json` e `config.exemplo.json`;
- `package.json`, `package-lock.json`, `.gitignore` e este `README.md`.

Não envie `node_modules`, `.baileys_sessao`, `.whatsapp_sessao`, `.wwebjs_cache` nem fotos capturadas. A pasta de sessão dá acesso à conta vinculada e deve permanecer privada.

## Solução de problemas

- **Node.js/npm não encontrado após instalar:** feche a janela e execute `INICIAR.bat` novamente.
- **Sessão desconectada:** apague somente `.baileys_sessao`, reinicie e leia um novo QR Code.
- **Foto não aparece:** confirme o ID do grupo, se a mensagem é uma foto nova e se `exigir_legenda` está de acordo com o esperado.
- **Instalação corporativa bloqueada:** solicite à TI o Node.js LTS 20 ou superior; depois execute `INICIAR.bat` novamente.
- **Erro da Conta Azul 401:** execute `npm run conta-azul:testar`; se a renovação também falhar, conecte a conta novamente.
- **Arquivo em `erros_conta_azul`:** leia a mensagem no terminal, corrija a causa e devolva imagem, TXT e JSON para `fotos_recebidas`.

## Execução manual (opcional)

Com Node.js 20 ou superior instalado:

```powershell
npm ci --omit=dev
npm start
```
