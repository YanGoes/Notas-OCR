# Como subir o projeto no Git pelo terminal

Guia prático para este projeto. Abra o PowerShell **na pasta raiz**
(`C:\Users\vmac_\Desktop\PROGRAMA OCR`) — é lá que fica o repositório, não
dentro de `01-COLETOR-WHATSAPP`.

Para abrir rápido: entre na pasta pelo Explorador, clique na barra de endereço,
digite `powershell` e dê Enter.

---

## O caminho normal (o que você vai usar quase sempre)

```powershell
# 1. Onde eu estou e o que mudou?
git status

# 2. Criar uma branch nova para o trabalho
git checkout -b feat/nome-do-que-voce-vai-fazer

# 3. Conferir se nao ha segredo prestes a subir (ver secao de seguranca)
git status --short

# 4. Preparar tudo que mudou
git add -A

# 5. Conferir de novo o que EXATAMENTE vai no commit
git status --short

# 6. Salvar com uma mensagem que explica o porque
git commit -m "feat: descricao curta do que mudou"

# 7. Enviar para o GitHub (a primeira vez de cada branch usa -u)
git push -u origin feat/nome-do-que-voce-vai-fazer
```

Depois do primeiro `push -u` naquela branch, os envios seguintes são só:

```powershell
git add -A
git commit -m "fix: corrige tal coisa"
git push
```

---

## ANTES de cada commit: a checagem que evita vazamento

Este projeto tem credenciais reais na pasta. O `.gitignore` já protege, mas
confira mesmo assim — leva 5 segundos e evita um problema sério:

```powershell
# Nenhum destes pode aparecer na lista:
git status --short | Select-String "\.env|token|config\.json$|\.zip|temp_notinhas"
```

Se **não retornar nada**, está seguro. Se aparecer algum, **não commite** e me
chame.

Para conferir se um arquivo específico está protegido:

```powershell
git check-ignore -v "01-COLETOR-WHATSAPP\.env"
```

Se responder com a regra do `.gitignore`, está ignorado corretamente.
Se não responder nada, o arquivo **não** está protegido.

Arquivos que nunca podem subir neste projeto:

| Arquivo | Por quê |
|---|---|
| `.env` | chaves do Azure e do Conta Azul |
| `tokens_conta_azul.json` | acesso à conta financeira |
| `config.json` | dados da empresa e dos grupos |
| `FOTOS NOTINHAS.zip` | 1,5 GB |
| `temp_notinhas/` | fotos extraídas, 1,5 GB |
| `.baileys_sessao/` | dá acesso ao WhatsApp vinculado |

---

## Nomes de branch

Use um prefixo que diga o tipo do trabalho:

```
feat/anexo-automatico-conta-azul     algo novo
fix/corrige-leitura-de-placa         correcao de defeito
refactor/organiza-pastas             arrumacao sem mudar comportamento
docs/atualiza-manual                 so documentacao
```

---

## Mensagens de commit

Primeira linha curta (até ~70 caracteres), dizendo **o que muda**. Se precisar
explicar o **porquê**, pule uma linha e escreva o resto:

```powershell
git commit -m "fix: le a placa escrita sem o rotulo Veiculo"
```

Para mensagem com várias linhas, use o editor:

```powershell
git commit
```

Ele abre o editor; escreva, salve e feche. Se abrir o Vim e você travar:
digite `:wq` e Enter para salvar e sair.

---

## Situações comuns

**Ver as branches que existem**
```powershell
git branch -a
```

**Trocar de branch**
```powershell
git checkout nome-da-branch
```

**Voltar para a principal e atualizar**
```powershell
git checkout main
git pull
```

**Ver o que mudou em um arquivo antes de commitar**
```powershell
git diff 01-COLETOR-WHATSAPP/src/pipeline.js
```

**Desfazer alterações de um arquivo que ainda não foi commitado**
```powershell
git checkout -- 01-COLETOR-WHATSAPP/src/pipeline.js
```
> Cuidado: isso descarta o que você editou nesse arquivo, sem volta.

**Tirar um arquivo do commit sem perder a edição**
```powershell
git restore --staged 01-COLETOR-WHATSAPP/config.json
```

**Ver o histórico resumido**
```powershell
git log --oneline -10
```

**Ver em qual branch está e se há coisa pendente**
```powershell
git status
```

---

## Depois do push: abrir o Pull Request

O `git push -u` mostra um link no terminal, parecido com:

```
https://github.com/YanGoes/Notas-OCR/pull/new/nome-da-sua-branch
```

Abra esse link no navegador, escreva um título e uma descrição do que a branch
faz, e clique em **Create pull request**. O PR é o lugar onde alguém revisa
antes de juntar na `main`.

Se perder o link, ele reaparece na página do repositório, num aviso amarelo com
o botão **Compare & pull request**.

---

## Se algo der errado

**"fatal: not a git repository"** — você está na pasta errada. Suba para
`C:\Users\vmac_\Desktop\PROGRAMA OCR`.

**"Updates were rejected"** — alguém enviou algo antes de você naquela branch.
Traga as mudanças e tente de novo:
```powershell
git pull --rebase
git push
```

**Pediu usuário e senha** — o GitHub não aceita mais senha comum. Use um token
de acesso pessoal (GitHub → Settings → Developer settings → Personal access
tokens) no lugar da senha, ou instale o GitHub CLI (`gh auth login`).

**Commitei um arquivo com segredo** — não faça só um commit apagando: o
conteúdo continua no histórico. Me chame, ou troque a credencial vazada
imediatamente (é o mais importante).
