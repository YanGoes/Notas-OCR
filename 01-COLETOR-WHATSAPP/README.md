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

1. Dê dois cliques em `ATALHOS\03_CONFIGURAR_AZURE.bat`.
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

5. Dê dois cliques em `ATALHOS\06_TESTAR_PIPELINE.bat`.
6. Confira o resultado em `dados/auditoria`. O conjunto será movido para:

- `dados/simulacao`: passou em todas as regras;
- `dados/revisao`: exige decisão humana;
- `dados/bloqueados`: duplicado ou fora do escopo;
- `dados/erros`: falha definitiva de processamento;
- `dados/ocr-bruto`: resposta original do Azure.

O programa tenta novamente automaticamente em erros 429 e falhas temporárias do Azure.

O valor na legenda é opcional. Quando ele não for informado, o Azure lê o valor no próprio comprovante. Se o campo estruturado vier incompleto, o programa procura de forma conservadora por `valor total`, `valor a pagar` ou um único valor acompanhado de `R$` no texto reconhecido; resultados ambíguos nunca são escolhidos automaticamente. O tipo semântico retornado pelo Azure (por exemplo, `Meal`) também pode classificar alimentação mesmo sem legenda.

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

Os valores `PREENCHER_UUID_...` precisam ser substituídos pelos IDs reais do Conta Azul nos arquivos:

- `configuracao/categorias.json`;
- `configuracao/centros_custo.json`;
- `configuracao/veiculos.json`.

Use o sincronizador descrito abaixo para fazer isso sem copiar UUIDs manualmente. As tolerâncias, tipos permitidos e bloqueados ficam em `configuracao/regras.json`. Enquanto os IDs reais não forem preenchidos, os documentos irão corretamente para revisão.

### Configurar os IDs sem copiar UUIDs manualmente

Depois de conectar a conta, dê dois cliques em **`ATALHOS\05_CONFIGURAR_IDS_CONTA_AZUL.bat`**. A ferramenta:

1. consulta, somente por `GET`, as categorias de **DESPESA** e os centros de custo ativos da conta conectada;
2. permite pesquisar uma categoria pelo nome e selecionar o resultado correto;
3. importa os centros de custo ativos para `configuracao/centros_custo.json`;
4. associa a categoria do veículo quando existe uma correspondência exata, como `FIAT SCUDO - SGR4B54`;
5. cria um backup `.bak` antes de alterar qualquer configuração local.

Ela não cria nem altera lançamentos, categorias ou centros de custo dentro do Conta Azul. Os catálogos
consultados também ficam disponíveis em `dados/conta-azul`. Não copie IDs de outra empresa ou de uma
conta de teste: cada UUID pertence à conta que respondeu à consulta.

No terminal, a mesma ferramenta pode ser executada assim:

```powershell
npm.cmd run conta-azul:ids
```

Para apenas listar e salvar os IDs, sem alterar os arquivos de mapeamento:

```powershell
npm.cmd run conta-azul:ids -- --somente-listar
```

Para aplicar sem perguntas somente as equivalências já aprovadas e as correspondências exatas:

```powershell
npm.cmd run conta-azul:ids -- --automatico
```

O modo automático mapeia alimentação, combustível genérico, farmácia, deslocamento, manutenção,
material de campo, centros de custo ativos e veículos com categoria inequívoca. Hospedagem e “outros”
continuam pendentes quando a conta não possui uma categoria de despesa com nome correspondente; o
sistema não escolhe uma categoria parecida por conta própria.

O `CONTA_AZUL_CLIENT_ID` do `.env` identifica a aplicação OAuth. Ele é diferente de `id_categoria`,
`id_centro_custo` e `categoria_id` dos veículos, que são os UUIDs consultados por esta ferramenta.

Depois da sincronização, pesquise o grupo no painel e escolha seu **Centro de custo padrão**. Essa
escolha é feita uma vez por grupo e elimina a necessidade de escrever o centro na legenda de cada foto.
A legenda continua tendo prioridade quando informar outro centro. Ao salvar os grupos, as auditorias
locais já existentes também são recalculadas; nenhuma despesa é enviada ao Conta Azul nessa etapa.

### Foco das classificações

As regras priorizam alimentação e hospedagem, que são o fluxo principal. Farmácia é aceita como exceção; oficina entra como manutenção e exige veículo. O tipo `outros` sempre exige revisão humana, mesmo quando o OCR tem alta confiança.

### Aprendizado com o histórico

O projeto já contém um modelo local treinado com a planilha histórica `visao_contas_a_pagar (1).xls`. Ele usa fornecedor, descrição e observações para apoiar a identificação da família da despesa. Ao receber uma nota nova, essa previsão aparece no painel em **Aprendizado histórico**, mas não substitui as validações nem lança automaticamente no Conta Azul. Categoria e centro históricos ficam fora da decisão automática: a categoria vem das regras e do catálogo do Conta Azul; o centro vem do grupo ou da legenda.

Resultado da validação isolada, sem reutilizar descrições iguais entre treino e teste:

- família geral (alimentação, hospedagem, oficina etc.): **94,2%** de acerto;
- família em previsões de alta confiança: **97,0%** de precisão;
- categoria contábil exata: **51,7%** de acerto;
- centro de custo: **53,9%** de acerto.

Categoria e centro ainda não possuem precisão suficiente para lançamento sem conferência. Centro de custo depende frequentemente do grupo, projeto ou comentário do operador, algo que a imagem da nota não contém.

Para treinar novamente depois de acrescentar ou corrigir lançamentos na planilha, instale também as dependências de desenvolvimento (`npm.cmd install`) e execute:

```powershell
npm.cmd run treinar-historico -- "C:\caminho\para\visao_contas_a_pagar.xls"
```

O comando precisa ser executado dentro da pasta do projeto. Para evitar erro de pasta ou caminho, use diretamente `ATALHOS\12_TREINAR_IA.bat`: ele entra na pasta correta, instala a biblioteca de leitura e utiliza a planilha histórica já configurada. Também é possível arrastar outra planilha sobre esse BAT.

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
- alternar entre os modos claro e escuro com a paleta VMac; a escolha fica salva no navegador.
- criar e sincronizar centros de custo diretamente com a empresa confirmada no Conta Azul;
- preparar uma nota, comparar a prévia e criar a despesa com duas confirmações independentes;
- enviar em lote somente depois da aprovação do primeiro lançamento individual.

A classificação principal do Azure e das regras sempre tem prioridade sobre o aprendizado histórico. Quando as duas fontes entram em conflito, a previsão histórica é descartada e isso aparece claramente no painel. Categoria e centro só são exibidos como sugestões seguras quando superam os limites de confiança definidos pelo sistema.

O painel é local e só fica acessível no próprio computador.

### Funcionamento contínuo

Para iniciar o programa automaticamente sempre que o usuário entrar no Windows, execute `ATIVAR_INICIO_AUTOMATICO.bat` uma vez. Para desfazer, execute `REMOVER_INICIO_AUTOMATICO.bat`.

Isso não transforma um computador desligado em servidor: para receber documentos continuamente, ele precisa permanecer ligado, conectado à internet e sem suspensão automática. Para disponibilidade real de 24 horas, use um computador dedicado ou servidor, considerando que a conexão via Baileys é não oficial e precisa ser monitorada.

Depois da primeira instalação pelo `INICIAR.bat`, use `ABRIR_APLICATIVO.bat` no dia a dia. Ele inicia a Central de Despesas minimizada na bandeja do Windows, sem VS Code, terminal ou aba do navegador. Clique duas vezes no ícone para abrir o painel; clique com o botão direito para consultar o status ou encerrar.

Os grupos escolhidos ficam salvos em `config.json` e são carregados automaticamente no painel. Não é necessário atualizar ou salvar a lista a cada execução; esses botões servem somente para alterar a seleção.


## Onde fica cada coisa

```text
INICIAR.bat            Primeira instalacao (instala Node.js e bibliotecas)
ABRIR_APLICATIVO.bat   Uso diario: abre o programa na bandeja do Windows
README.md              Este guia

ATALHOS/               Tarefas ocasionais, numeradas na ordem de uso
                       (configurar Azure e Conta Azul, testar, treinar)
docs/                  Documentacao tecnica
                       API-CONTA-AZUL.md ......... contrato da API, testado
                       REGRAS-CLASSIFICACAO.md ... como a despesa e classificada
                       PROXIMOS-PASSOS.md ........ o que ficou para depois
configuracao/          Regras e mapeamentos (categorias, centros, veiculos)
src/                   Codigo do programa
public/                Painel que abre no navegador
ferramentas/           Comandos de linha (testes e manutencao)
scripts/               Scripts do Windows usados pelos atalhos
testes/                Testes automatizados
dados/                 Notas processadas e auditoria (nao versionado)
legado/                Versoes antigas, mantidas so para consulta
```

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
- `pipeline.encaminhar_automaticamente_conta_ai`: desligado por padrão. Quando `true`, cada foto que o pipeline local processa (e que não for bloqueada por duplicidade ou fora do escopo) é encaminhada automaticamente para o número do Conta AI configurado em `numero_conta_ai`. Isso só envia a foto para a Conta AI processar — não cria nenhuma despesa; a criação continua exigindo os passos manuais descritos em "Integração com o Conta Azul".

## Integração com o Conta Azul

Por segurança, a integração e a criação automática de despesas começam desligadas.

### 1. Criar e autorizar a aplicação

1. Crie uma aplicação no [Portal do Desenvolvedor Conta Azul](https://developers-portal.contaazul.com/).
2. Cadastre uma URL de redirecionamento e anote exatamente essa URL, o `client_id` e o `client_secret`.
3. Dê dois cliques em `ATALHOS\04_CONECTAR_CONTA_AZUL.bat`.
4. Preencha o `.env`, salve, autorize pelo endereço exibido e cole o parâmetro `code` solicitado.

O código de autorização expira rapidamente. Se a troca falhar, execute a conexão novamente. As credenciais ficam em `.env` e os tokens em `tokens_conta_azul.json`; nunca envie esses arquivos.

O e-mail e a senha da conta de teste fornecida pelo Portal do Desenvolvedor são usados **somente na
tela oficial de login/autorização do Conta Azul**. Não salve a senha no `.env` nem informe a senha ao
programa: depois da autorização, a integração trabalha com `access_token` e `refresh_token`.

Para validar a conexão, execute:

```powershell
npm run conta-azul:testar
```

Depois, execute `ATALHOS\05_CONFIGURAR_IDS_CONTA_AZUL.bat` para selecionar as categorias e importar os centros
de custo da própria empresa. Essa etapa resolve os avisos “ID do Conta Azul ainda não foi configurado”.

### 2. Confirmar a empresa conectada

Não altere `conta_azul.habilitada` no `config.json`. O monitor automático antigo foi desativado porque
ele poderia enviar a imagem antes da conclusão do OCR e das validações.

No painel, abra **Envio ao Conta Azul** e confira o nome e o ID da empresa exibida. Clique em
**Confirmar empresa correta** somente depois de verificar que é a empresa onde as despesas devem ser
criadas. A confirmação fica vinculada ao ID: se outra empresa for autorizada depois, os botões são
bloqueados novamente.

### 3. Cadastrar centros de custo pelo painel

Em **Grupos monitorados → Gerenciar centros de custo**:

1. informe um código opcional e o nome do projeto;
2. clique em **Criar no Conta Azul**;
3. confirme a empresa e o nome mostrados;
4. escolha o novo centro como padrão do grupo e salve os grupos.

O cadastro usa `POST /v1/centro-de-custo`. A API não publica exclusão ou alteração desse recurso, por
isso o sistema impede duplicidade por nome/código e sempre pede confirmação. **Sincronizar lista**
importa para o programa os centros ativos cadastrados diretamente no ERP.

### 4. Fazer o primeiro envio real

Use primeiro uma única nota que esteja com o selo **Simulação aprovada**:

1. em **Teste real guiado · uma nota**, escolha no seletor a nota que você já conferiu;
2. clique em **1. Preparar prévia (não cria despesa)**;
3. confirme o envio da imagem — essa etapa ainda não cria despesa;
4. o arquivo aparece em **Conta AI Captura** e o programa compara tipo, valor, data, fornecedor,
   categoria e centro de custo da prévia com a auditoria local;
5. somente quando não houver divergências o mesmo botão muda para **2. Criar esta despesa real**;
6. confira novamente empresa, valor, categoria e centro e confirme o lançamento real;
7. no Conta Azul, abra **Financeiro → Contas a pagar**, filtre pela data/fornecedor e abra o lançamento.
   A imagem original fica anexada nos detalhes;
8. somente depois de conferir os dados e o anexo no ERP, clique em
   **3. Conferi no Conta Azul — liberar lote**.

Se a prévia divergir, ela não é aceita automaticamente. Abra **Conta AI Captura**, revise os dados e
use **Verificar status** no painel depois da correção. A API oficial de aceite da Captura não recebe um
corpo para substituir categoria ou centro de custo.

### 5. Enviar em lote

Depois que o primeiro envio individual for criado **e a conferência no ERP for registrada no passo 3**,
o quadro de lote aparece com os botões:

- **Preparar todos os prontos**: envia apenas imagens de `dados/simulacao` e gera as prévias;
- **Criar todas as prévias conferidas**: cria somente despesas sem nenhuma divergência.

O lote é sequencial para respeitar os limites da API. Documentos em entrada, revisão, bloqueados ou
com confirmação incerta nunca entram automaticamente. Em falha de rede durante a criação, não repita
o clique: use **Verificar status** para evitar duplicidade.

### Como descobrir o ID de um grupo

Com o coletor fechado, abra o PowerShell dentro da pasta e execute:

```powershell
npm run listar-grupos
```

Copie o ID exibido para `grupos_permitidos` e, opcionalmente, associe um nome em `nomes_dos_grupos`.

## O que enviar ao gestor

Para criar automaticamente um `.zip` seguro, dê dois cliques em **`ATALHOS\11_GERAR_PACOTE_PARA_ENVIO.bat`**. O arquivo será criado na pasta do projeto sem sessões, bibliotecas instaladas ou fotos.

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
