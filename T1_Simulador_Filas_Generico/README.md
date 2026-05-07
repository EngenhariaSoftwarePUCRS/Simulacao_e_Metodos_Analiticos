# T1 - Simulador Genérico de Redes de Filas

Simulador de eventos discretos para redes de filas com topologia arbitrária,
conforme o Módulo 8 (M8). A configuração é declarativa via YAML — a interface
é somente para carregar/executar e visualizar resultados.

## Stack

- HTML, CSS e JavaScript puros (executa no navegador, sem build).
- Bibliotecas externas (CDN): `Chart.js` e `js-yaml`.

## Como executar

1. Abra `index.html` em um navegador moderno.
2. Para usar o botão **"Carregar model.yml do repositório"** (fetch do arquivo na
   raiz), sirva a pasta com um servidor estático, por exemplo:

```bash
cd Simulacao_e_Metodos_Analiticos
python3 -m http.server 8000
# abra http://localhost:8000/T1_Simulador_Filas_Generico/index.html
```

Após carregar/colar o YAML, use **"Executar simulação"** para gerar resultados.

## Fluxo de operação (YAML-only)

- Edite apenas o campo **Conteúdo YAML** ou clique em **Carregar model.yml do
  repositório** para usar o exemplo fornecido.
- A interface não fornece mais um editor visual; toda configuração deve ser no
  YAML.

## Formato do YAML aceito (resumo)

O arquivo deve conter `arrivals`, `queues` e `network` seguindo o exemplo abaixo.

```yaml
!PARAMETERS
arrivals:
  Q1: 2.0

queues:
  Q1:
    servers: 1
    minArrival: 2.0
    maxArrival: 4.0
    minService: 1.0
    maxService: 2.0
  Q2:
    servers: 2
    capacity: 5
    minService: 4.0
    maxService: 6.0

network:
- source: Q1
  target: Q2
  probability: 0.8
- source: Q1
  target: -1
  probability: 0.2

# Aleatórios: lista `rndnumbers`, ou `seeds` + `rndnumbersPerSeed`, ou LCG via
# parâmetros do formulário (X0, a, c, M) se nenhum for declarado no YAML.
```

## Parâmetros do LCG

Mesmo no modo YAML, os campos do gerador (X0, a, c, M) controlam a geração
quando o YAML declara `seeds` ou não fornece `rndnumbers`. Os valores padrão
são `a=39758, c=58739, M=987654321`.

## Critério de parada

A simulação para ao consumir o 100.000º aleatório (`MAX_RANDOM_NUMBERS = 100000`).

## Saídas e visualizações

- **Métricas gerais**: tempo total, aleatórios usados/restantes e motivo de parada.
- **Por fila**: cada painel de fila mostra agora cartas de métricas com **Perdas**,
  **População média (Nmedio)** e **Prob. fila vazia (P₀)**; também há tabela de
  estados e gráfico de probabilidade por estado.
- **Tabela de eventos processados** e **Tabela de escalonamento** com detalhes dos
  eventos e expressões dos tempos.
- Botão **Baixar CSV** (no painel de execução) exporta a distribuição de estados
  de todas as filas.

## Executando com o YAML do repositório

1. Abra `index.html`.
2. Clique **Carregar model.yml do repositório** para popular o campo YAML.
3. Verifique os parâmetros do LCG (se aplicável) e clique **Executar simulação**.

## Estrutura dos arquivos

```
T1_Simulador_Filas_Generico/
├── README.md
├── index.html
├── script.js
└── styles.css

model.yml (na raiz) ← exemplo de rede de filas
```

## Resumo e projeto final

- **Resumo em PDF:** disponível em [T1__Grupo42_FelipeFreitas_MarinaYamaguti_SofiaSartori__SIMULACAO_E_METODOS_ANALITICOS.pdf](T1_Simulador_Filas_Generico/T1__Grupo42_FelipeFreitas_MarinaYamaguti_SofiaSartori__SIMULACAO_E_METODOS_ANALITICOS.pdf)
- **Projeto final (hospedado):** https://engenhariasoftwarepucrs.github.io/Simulacao_e_Metodos_Analiticos/T1_Simulador_Filas_Generico/
