import json
import os
import re
import sys
import time
from pathlib import Path

from azure.ai.documentintelligence import DocumentIntelligenceClient
from azure.core.credentials import AzureKeyCredential
from azure.core.exceptions import AzureError


ENDPOINT = os.getenv("AZURE_DOCUMENT_ENDPOINT")
KEY = os.getenv("AZURE_DOCUMENT_KEY")

EXTENSOES_PERMITIDAS = {
    ".jpg",
    ".jpeg",
    ".png",
    ".webp",
    ".bmp",
    ".tif",
    ".tiff",
    ".pdf",
}


def mostrar_campo(nome, campo, nivel=0, linhas_saida=None):
    identacao = "  " * nivel
    confianca = getattr(campo, "confidence", None)

    confianca_texto = (
        f" — confiança: {confianca:.1%}"
        if confianca is not None
        else ""
    )

    tipo = getattr(campo, "type", None)
    valor = getattr(campo, "value", None)
    conteudo = getattr(campo, "content", None)

    if tipo == "array" and valor:
        linha_texto = f"{identacao}{nome}:{confianca_texto}"
        print(linha_texto)
        if linhas_saida is not None:
            linhas_saida.append(linha_texto)

        for indice, item in enumerate(valor, start=1):
            mostrar_campo(
                f"Item {indice}",
                item,
                nivel + 1,
                linhas_saida,
            )

    elif tipo == "object" and valor:
        linha_texto = f"{identacao}{nome}:{confianca_texto}"
        print(linha_texto)
        if linhas_saida is not None:
            linhas_saida.append(linha_texto)

        for subnome, subcampo in valor.items():
            mostrar_campo(
                subnome,
                subcampo,
                nivel + 1,
                linhas_saida,
            )

    else:
        valor_exibido = (
            valor
            if valor is not None
            else conteudo
        )

        linha_texto = (
            f"{identacao}{nome}: "
            f"{valor_exibido}"
            f"{confianca_texto}"
        )
        print(linha_texto)
        if linhas_saida is not None:
            linhas_saida.append(linha_texto)


def detalhes_layout(resultado):
    """Transforma páginas, parágrafos e tabelas em texto legível."""
    linhas = []

    linhas.extend(["=== TEXTO POR PÁGINA E LINHA ===", ""])
    paginas = getattr(resultado, "pages", None) or []
    if not paginas:
        linhas.append("Nenhuma informação de página disponível.")

    for indice, pagina in enumerate(paginas, start=1):
        numero = getattr(pagina, "page_number", None) or indice
        linhas.append(f"--- PÁGINA {numero} ---")
        linhas_pagina = getattr(pagina, "lines", None) or []
        if not linhas_pagina:
            linhas.append("Nenhuma linha individual identificada.")
        for linha in linhas_pagina:
            conteudo = getattr(linha, "content", None)
            if conteudo:
                linhas.append(conteudo)
        linhas.append("")

    linhas.extend(["", "=== PARÁGRAFOS DETECTADOS ===", ""])
    paragrafos = getattr(resultado, "paragraphs", None) or []
    if not paragrafos:
        linhas.append("Nenhum parágrafo identificado.")
    for indice, paragrafo in enumerate(paragrafos, start=1):
        funcao = getattr(paragrafo, "role", None)
        cabecalho = f"Parágrafo {indice}"
        if funcao:
            cabecalho += f" [{funcao}]"
        linhas.extend(
            [cabecalho, getattr(paragrafo, "content", None) or "", ""]
        )

    linhas.extend(["", "=== TABELAS DETECTADAS ===", ""])
    tabelas = getattr(resultado, "tables", None) or []
    if not tabelas:
        linhas.append("Nenhuma tabela identificada.")

    for indice, tabela in enumerate(tabelas, start=1):
        total_linhas = getattr(tabela, "row_count", 0) or 0
        total_colunas = getattr(tabela, "column_count", 0) or 0
        linhas.append(
            f"Tabela {indice}: {total_linhas} linhas × "
            f"{total_colunas} colunas"
        )
        matriz = [
            [""] * total_colunas
            for _ in range(total_linhas)
        ]
        for celula in getattr(tabela, "cells", None) or []:
            linha = getattr(celula, "row_index", -1)
            coluna = getattr(celula, "column_index", -1)
            if 0 <= linha < total_linhas and 0 <= coluna < total_colunas:
                matriz[linha][coluna] = (
                    getattr(celula, "content", "") or ""
                )
        for numero, conteudos in enumerate(matriz, start=1):
            linhas.append(
                f"Linha {numero}: "
                + " | ".join(item.strip() for item in conteudos)
            )
        linhas.append("")

    return linhas


def informacoes_adicionais(texto):
    """Localiza dados úteis que podem não aparecer nos campos estruturados."""
    texto_sem_espacos = re.sub(r"\s+", "", texto)
    padroes = {
        "CNPJ encontrado": r"CNPJ\s*[:\-]?\s*([0-9.\-/]{14,18})",
        "Número da nota": (
            r"(?:N[uú]mero|N[º°])\s*[:\-]?\s*([0-9]{1,12})"
        ),
        "Série": r"S[eé]rie\s*[:\-]?\s*([0-9]{1,5})",
        "Placa": (
            r"Placa\s*[:\-]?\s*([A-Z]{3}[-\s]?[0-9A-Z][0-9]{2})"
        ),
        "Quilometragem": (
            r"(?:KM|Quilometragem)\s*[:\-]?\s*([0-9.,]+)"
        ),
        "Autorização": (
            r"Autoriza[cç][aã]o\s*[:\-]?\s*([A-Z0-9-]+)"
        ),
        "Protocolo": (
            r"Protocolo(?:\s+Autoriza[cç][aã]o)?"
            r"\s*[:\-]?\s*([0-9]+)"
        ),
        "Documento/NSU": r"(?:DOC|NSU)\s*[=:]\s*([0-9]+)",
        "Cartão final": r"\*{4,}\s*([0-9]{4})",
    }
    encontrados = []
    for nome, padrao in padroes.items():
        resultado = re.search(
            padrao, texto, flags=re.IGNORECASE | re.MULTILINE
        )
        if resultado:
            encontrados.append(f"{nome}: {resultado.group(1).strip()}")

    chave = re.search(r"([0-9]{44})", texto_sem_espacos)
    if chave:
        encontrados.append(f"Chave NFC-e: {chave.group(1)}")

    return [
        "=== INFORMAÇÕES ADICIONAIS LOCALIZADAS ===",
        "",
        *(
            encontrados
            or ["Nenhuma informação adicional foi localizada."]
        ),
    ]


def criar_cliente():
    if not ENDPOINT or not KEY:
        raise RuntimeError(
            "Configure AZURE_DOCUMENT_ENDPOINT e "
            "AZURE_DOCUMENT_KEY no PowerShell."
        )

    return DocumentIntelligenceClient(
        endpoint=ENDPOINT,
        credential=AzureKeyCredential(KEY),
    )


def analisar_arquivo(
    cliente,
    arquivo: Path,
    modelo: str,
    pasta_saida: Path,
):
    print("\n" + "=" * 75)
    print(f"Enviando: {arquivo.name}")
    print(f"Modelo: {modelo}")
    print("Aguarde...")

    with arquivo.open("rb") as documento:
        poller = cliente.begin_analyze_document(
            model_id=modelo,
            body=documento,
            content_type="application/octet-stream",
        )

    resultado = poller.result()
    resultado_dict = resultado.as_dict()
    resultado_layout = None
    erro_layout = None

    print("\n=== CAMPOS ESTRUTURADOS ===")
    linhas_campos = ["=== CAMPOS ESTRUTURADOS ===", ""]

    if not resultado.documents:
        mensagem = "Nenhum documento estruturado foi identificado."
        print(mensagem)
        linhas_campos.append(mensagem)

    for indice, documento in enumerate(
        resultado.documents or [],
        start=1,
    ):
        print(f"\nDocumento {indice}")
        print(f"Tipo: {documento.doc_type}")
        linhas_campos.extend(
            [f"Documento {indice}", f"Tipo: {documento.doc_type}"]
        )

        for nome, campo in documento.fields.items():
            mostrar_campo(nome, campo, linhas_saida=linhas_campos)
        linhas_campos.append("")

    # Receipt interpreta campos; Layout reforça linhas, parágrafos e tabelas.
    if modelo == "prebuilt-receipt":
        print("\nEnviando novamente para leitura completa...")
        print("Modelo: prebuilt-layout")
        print("Aguarde...")
        try:
            with arquivo.open("rb") as documento:
                poller_layout = cliente.begin_analyze_document(
                    model_id="prebuilt-layout",
                    body=documento,
                    content_type="application/octet-stream",
                )
            resultado_layout = poller_layout.result()
        except AzureError as erro:
            erro_layout = str(erro)
            print(
                "Aviso: a leitura Layout falhou; será usado o "
                f"texto do Receipt. Detalhes: {erro}"
            )

    texto_completo = (
        (
            resultado_layout.content
            if resultado_layout is not None
            else resultado.content
        )
        or "Nenhum texto reconhecido."
    )

    detalhes = detalhes_layout(resultado_layout or resultado)
    adicionais = informacoes_adicionais(texto_completo)

    print("\n" + "\n".join(detalhes))
    print("\n=== TEXTO COMPLETO RECONHECIDO ===")
    print(texto_completo)
    print("\n" + "\n".join(adicionais))

    nome_seguro = arquivo.stem.replace(" ", "_")

    caminho_json = (
        pasta_saida
        / f"{nome_seguro}_{modelo}.json"
    )
    caminho_texto = (
        pasta_saida
        / f"{nome_seguro}_RELATORIO_COMPLETO.txt"
    )

    with caminho_json.open(
        "w",
        encoding="utf-8",
    ) as saida:
        json.dump(
            resultado_dict,
            saida,
            ensure_ascii=False,
            indent=2,
            default=str,
        )

    caminho_json_layout = None
    if resultado_layout is not None:
        caminho_json_layout = (
            pasta_saida
            / f"{nome_seguro}_prebuilt-layout.json"
        )
        with caminho_json_layout.open(
            "w",
            encoding="utf-8",
        ) as saida:
            json.dump(
                resultado_layout.as_dict(),
                saida,
                ensure_ascii=False,
                indent=2,
                default=str,
            )

    relatorio = [
        f"ARQUIVO: {arquivo.name}",
        f"MODELO ESTRUTURADO: {modelo}",
        "",
        *linhas_campos,
        "",
        *detalhes,
        "",
        "=== TEXTO COMPLETO RECONHECIDO ===",
        "",
        texto_completo,
        "",
        *adicionais,
        "",
    ]
    if erro_layout:
        relatorio.extend(
            [
                "=== AVISO DA LEITURA LAYOUT ===",
                "",
                erro_layout,
                "",
            ]
        )

    with caminho_texto.open(
        "w",
        encoding="utf-8",
    ) as saida:
        saida.write("\n".join(relatorio))

    print(f"\nJSON salvo em: {caminho_json}")
    print(f"Texto completo salvo em: {caminho_texto}")

    return {
        "arquivo": arquivo.name,
        "modelo": modelo,
        "status": "sucesso",
        "documentos_detectados": len(
            resultado.documents or []
        ),
        "json": str(caminho_json),
        "json_layout": (
            str(caminho_json_layout)
            if caminho_json_layout is not None
            else None
        ),
        "texto": str(caminho_texto),
        "aviso_layout": erro_layout,
        "erro": None,
    }


def localizar_arquivos(pasta: Path):
    arquivos = []

    for arquivo in pasta.iterdir():
        if (
            arquivo.is_file()
            and arquivo.suffix.lower()
            in EXTENSOES_PERMITIDAS
        ):
            arquivos.append(arquivo)

    return sorted(
        arquivos,
        key=lambda item: item.name.lower(),
    )


def selecionar_pasta():
    """Abre a janela do Windows para escolher a pasta das fotos."""
    try:
        import tkinter as tk
        from tkinter import filedialog
    except ImportError as erro:
        raise RuntimeError(
            "Não foi possível abrir o seletor de pasta. "
            "Informe a pasta pela linha de comando."
        ) from erro

    janela = tk.Tk()
    janela.withdraw()
    janela.attributes("-topmost", True)

    try:
        pasta = filedialog.askdirectory(
            parent=janela,
            title="Selecione a pasta que contém as fotos",
            mustexist=True,
        )
    finally:
        janela.destroy()

    return pasta


def analisar_pasta(
    caminho_pasta: str,
    modelo: str,
):
    pasta = Path(caminho_pasta).resolve()

    if not pasta.is_dir():
        raise NotADirectoryError(
            f"Pasta não encontrada: {pasta}"
        )

    arquivos = localizar_arquivos(pasta)

    if not arquivos:
        raise RuntimeError(
            "Nenhuma imagem ou PDF foi encontrado "
            f"na pasta: {pasta}"
        )

    pasta_saida = pasta / "RESULTADOS_AZURE"
    pasta_saida.mkdir(exist_ok=True)

    cliente = criar_cliente()
    resumo = []

    print(f"\nPasta analisada: {pasta}")
    print(f"Arquivos encontrados: {len(arquivos)}")
    print(f"Modelo utilizado: {modelo}")
    print(f"Resultados: {pasta_saida}")

    for indice, arquivo in enumerate(
        arquivos,
        start=1,
    ):
        print(
            f"\nProcessando {indice}/{len(arquivos)}..."
        )

        try:
            item_resumo = analisar_arquivo(
                cliente=cliente,
                arquivo=arquivo,
                modelo=modelo,
                pasta_saida=pasta_saida,
            )

        except AzureError as erro:
            print(f"\nErro do Azure: {erro}")

            item_resumo = {
                "arquivo": arquivo.name,
                "modelo": modelo,
                "status": "erro",
                "documentos_detectados": 0,
                "json": None,
                "erro": str(erro),
            }

        except OSError as erro:
            print(f"\nErro ao abrir o arquivo: {erro}")

            item_resumo = {
                "arquivo": arquivo.name,
                "modelo": modelo,
                "status": "erro",
                "documentos_detectados": 0,
                "json": None,
                "erro": str(erro),
            }

        resumo.append(item_resumo)

        # Pequena pausa para não enviar tudo
        # simultaneamente ao serviço.
        time.sleep(1)

    caminho_resumo = pasta_saida / "resumo_lote.json"

    with caminho_resumo.open(
        "w",
        encoding="utf-8",
    ) as saida:
        json.dump(
            resumo,
            saida,
            ensure_ascii=False,
            indent=2,
        )

    sucessos = sum(
        item["status"] == "sucesso"
        for item in resumo
    )

    erros = len(resumo) - sucessos

    print("\n" + "=" * 75)
    print("PROCESSAMENTO FINALIZADO")
    print("=" * 75)
    print(f"Total: {len(resumo)}")
    print(f"Sucessos: {sucessos}")
    print(f"Erros: {erros}")
    print(f"Resumo salvo em: {caminho_resumo}")


if __name__ == "__main__":
    modelos_permitidos = {
        "prebuilt-receipt",
        "prebuilt-invoice",
        "prebuilt-layout",
    }

    if len(sys.argv) > 3:
        print(
            "Uso:\n"
            "python teste_azure_lote.py\n"
            'python teste_azure_lote.py "."\n'
            'python teste_azure_lote.py "." '
            "prebuilt-invoice"
        )
        sys.exit(1)

    if len(sys.argv) >= 2:
        pasta_escolhida = sys.argv[1]
    else:
        pasta_escolhida = selecionar_pasta()

        if not pasta_escolhida:
            print("\nNenhuma pasta foi selecionada.")
            sys.exit(0)

    modelo_escolhido = (
        sys.argv[2]
        if len(sys.argv) == 3
        else "prebuilt-receipt"
    )

    if modelo_escolhido not in modelos_permitidos:
        print("Modelo inválido.")
        print("Modelos permitidos:")

        for modelo in sorted(modelos_permitidos):
            print(f"- {modelo}")

        sys.exit(1)

    try:
        analisar_pasta(
            caminho_pasta=pasta_escolhida,
            modelo=modelo_escolhido,
        )

    except (
        RuntimeError,
        OSError,
        NotADirectoryError,
    ) as erro:
        print(f"\nErro: {erro}")
        sys.exit(1)
