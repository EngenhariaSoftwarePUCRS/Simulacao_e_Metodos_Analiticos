# T1 - Simulador Genérico de Redes de Filas

Implementação de um simulador de eventos discretos para redes de filas com topologia
arbitrária, conforme especificado no Módulo 8 (M8) da disciplina.

## Stack

- HTML, CSS e JavaScript puros (executa direto no navegador, sem build).
- Bibliotecas externas (CDN): `Chart.js` (gráficos) e `js-yaml` (parser YAML).

## Como executar

1. Abra `index.html` em qualquer navegador moderno (Chrome, Firefox, Edge, Safari).
2. Sem necessidade de servidor para o uso normal. Caso queira usar o botão
   *"Carregar model.yml do repositório"* (que faz `fetch` no `model.yml` da raiz),
   sirva a pasta com um servidor estático, por exemplo:

   ```bash
   cd Simulacao_e_Metodos_Analiticos
   python3 -m http.server 8000
   # depois abra http://localhost:8000/T1_Simulador_Filas_Generico/index.html
   ```

A simulação roda automaticamente sempre que algum parâmetro muda, e também no
clique do botão **"Executar simulação"**.

## Modos de operação

### A) Modo YAML (recomendado, alinhado ao M8)

1. Marque a caixa **"Usar configuração YAML para executar a simulação"**.
2. Cole o conteúdo do arquivo YAML no campo **"Conteúdo YAML"** ou clique em
   **"Carregar model.yml do repositório"** para usar o exemplo da raiz.

### B) Modo legado (tandem 2 filas, mantido para compatibilidade)

Desmarque a caixa de YAML e use os campos do formulário (Fila 1 e Fila 2).

## Formato do YAML aceito

Compatível com o estilo usado pelo simulador do M3:

```yaml
!PARAMETERS
arrivals:
   Q1: 2.0           # tempo da primeira chegada externa em cada fila

queues:
   Q1:
      servers: 1
      # capacity opcional: omitido = capacidade infinita (-1)
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
-  source: Q1
   target: Q2
   probability: 0.8
-  source: Q1
   target: -1        # -1 representa saida do sistema (exterior)
   probability: 0.2

# Para os aleatorios, escolher UM dos tres modos:

# (1) Lista direta de aleatorios pre-gerados
rndnumbers:
- 0.2176
- 0.0103

# (2) Geracao automatica via LCG a partir de uma ou mais sementes
rndnumbersPerSeed: 100000
seeds:
- 1

# (3) Se nenhum dos dois acima estiver presente, o simulador usa o LCG
#     com os parametros do formulario (semente, multiplicador, incremento, modulo).
```

### Observações sobre roteamento

- Probabilidades de roteamento de cada fila podem somar **menos do que 1**: o
  restante representa saída implícita do sistema (igual ao M3/M8). O simulador
  acrescenta automaticamente uma rota implícita para `-1` com a probabilidade
  faltante.
- Caso a soma exceda 1, o simulador rejeita o YAML.
- Quando uma fila tem somente uma rota (probabilidade 1 ou determinística), o
  simulador **não consome aleatório** para a decisão de roteamento.

### Parâmetros do LCG

Mesmo no modo YAML, os campos do gerador pseudoaleatório
(`X0, a, c, M`) controlam a geração quando o YAML usa `seeds` ou cai no modo LCG
puro. Os valores default do formulário são `a=39758, c=58739, M=987654321`.

## Critério de parada

A simulação encerra **assim que o 100.000º aleatório é consumido**
(`MAX_RANDOM_NUMBERS = 100000`). É o valor pedido pelo enunciado e não pode ser
alterado pela interface no modo YAML.

## Saídas reportadas

- **Métricas gerais**: tempo total simulado, aleatórios usados/restantes,
  motivo da parada.
- **Por fila**:
  - Tabela de **estados (i, tempo acumulado, probabilidade)**.
  - Gráfico de barras com a distribuição de probabilidades por estado.
  - Quantidade de **clientes perdidos** por capacidade cheia.
  - Tamanho médio da fila (Nmédio) e probabilidade da fila estar vazia.
- **Tabela de eventos processados** (com snapshot do tamanho de cada fila e
  quantos clientes esperando).
- **Tabela de escalonamento** (cada agendamento, com o aleatório consumido e a
  expressão `t_atual + sorteio = t_evento`).
- Botão **"Baixar CSV"** exporta a distribuição de estados de todas as filas.

## Executando uma simulação com o YAML do repositório

1. Abra `index.html`.
2. Marque a caixa **"Usar configuração YAML para executar a simulação"**.
3. Clique em **"Carregar model.yml do repositório"** para carregar o exemplo.
4. Confirme os parâmetros do LCG (defaults do formulário servem).
5. Clique em **"Executar simulação"**.

O YAML carregado contém um exemplo com 3 filas (`Q1`, `Q2`, `Q3`) e roteamento
probabilístico entre elas, simulando uma rede de filas genérica.

## Estrutura dos arquivos

```
T1_Simulador_Filas_Generico/
├── README.md                ← este arquivo
├── index.html               ← interface
├── script.js                ← motor de simulacao + UI
└── styles.css               ← estilos

Arquivos relacionados na raiz:
└── model.yml                ← exemplo de rede de filas genérica
```
