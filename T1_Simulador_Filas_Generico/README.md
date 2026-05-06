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
      minArrival: 2.0         # requerido se fila estiver em arrivals
      maxArrival: 4.0         # requerido se fila estiver em arrivals
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
   target: -1                 # -1 representa saida do sistema (exterior)
   probability: 0.2           # soma DEVE ser 1.0 para cada fila

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

### Parâmetros do LCG

Mesmo no modo YAML, os campos do gerador pseudoaleatório
(`X0, a, c, M`) controlam a geração quando o YAML usa `seeds` ou cai no modo LCG
puro. Os valores default do formulário são `a=39758, c=58739, M=987654321`.

## Critério de parada

A simulação encerra **assim que o 100.000º aleatório é consumido**
(`MAX_RANDOM_NUMBERS = 100000`). É o valor pedido pelo enunciado e não pode ser
alterado pela interface no modo YAML.

## Dinâmica da simulação

### Chegadas externas

- Apenas filas **declaradas em `arrivals`** geram chegadas externas periódicas.
- O tempo da primeira chegada é definido em `arrivals` (ex: `Q1: 2.0`).
- Depois, a cada chegada processada, uma nova chegada é agendada:
  - Tempo = tempo_atual + sorteio de U(minArrival, maxArrival)
  - Consome um aleatório para o sorteio.
- Se uma fila **não estiver em `arrivals`**, ela só recebe clientes por roteamento 
  de outras filas (não há chegadas do exterior).

### Processamento de clientes

1. **Na chegada:**
   - Se fila está CHEIA (currentSize = capacity): cliente é rejeitado 
     (incrementa lossCount), **não entra na fila**, nenhum novo serviço é iniciado.
   - Se fila tem espaço:
     - Cliente entra (currentSize += 1).
     - Se há servidores livres: sorteia tempo de serviço e agenda partida.
     - Se não há servidores livres: cliente entra em fila de espera.
   - **Depois (independente de rejeição):** Se era chegada externa de fila em 
     `arrivals`, agenda próxima chegada (consome um aleatório).

2. **Na partida:**
   - Cliente sai da fila (currentSize -= 1).
   - Se há clientes esperando: sorteia tempo de serviço para próximo cliente.
   - Depois, sorteia rota de destino (roteamento com U [0,1)).
   - Se destino ≠ exterior: agenda chegada no destino (instantaneamente).

### Consumo de aleatórios

- Cada sorteio de tempo (chegadas, serviço, roteamento) consome um aleatório.
- **NÃO consomem aleatório:**
  - Serviço para clientes rejeitados (rejeitados não entram na fila).
  - Roteamento determinístico (probabilidade 1.0 com única rota).
  - Agendamentos de saída para o exterior (destino = -1, sem sorteio de rota).

## Saídas reportadas

- **Métricas gerais**: tempo total simulado, aleatórios usados/restantes,
  motivo da parada.
- **Por fila**:
  - Tabela de **estados (i, tempo acumulado, probabilidade)**.
  - Gráfico de barras com a distribuição de probabilidades por estado.
  - Quantidade de **clientes perdidos** por capacidade cheia (rejeitados ao
    chegar em fila cheia).
  - Tamanho médio da fila (Nmédio) e probabilidade da fila estar vazia (P₀).
- **Tabela de eventos processados**: lista de eventos (chegadas/partidas) com
  instante global, snapshot do tamanho de cada fila e clientes em espera.
- **Tabela de escalonamento**: cada evento agendado, com tempo, aleatório 
  consumido, operação e expressão (t_anterior + sorteio = t_agendado).
- Botão **"Baixar CSV"** exporta a distribuição de estados (probabilidades e
  tempos) de todas as filas.

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
