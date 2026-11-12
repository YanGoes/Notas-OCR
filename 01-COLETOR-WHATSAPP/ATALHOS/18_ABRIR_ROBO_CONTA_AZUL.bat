@echo off
setlocal
cd /d "%~dp0.."

rem Abre a janela do robo de tela do Conta Azul (um Chrome separado, com perfil proprio).
rem E o robo que anexa a foto da nota em cada lancamento enviado.
rem Cada conta tem a sua janela: escolha qual abrir. O login e feito por voce nessa
rem janela e fica guardado; o programa nunca ve a senha.

echo Qual conta do Conta Azul?
echo   1 - Teste
echo   2 - Oficial
set "CONTA=teste"
set /p "ESCOLHA=Digite 1 ou 2 e aperte Enter: "
if "%ESCOLHA%"=="2" set "CONTA=oficial"

node ferramentas\abrir-navegador-conta-azul.js %CONTA%
if errorlevel 1 (
  echo.
  echo A janela do robo nao abriu. Leia a mensagem acima.
  pause
  exit /b 1
)

echo.
echo Se aparecer a tela de login, entre com o usuario do Conta Azul dessa conta.
echo Depois pode minimizar a janela; nao precisa fechar.
pause
