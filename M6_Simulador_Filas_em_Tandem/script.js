// ===================================================================
// CONSTANTES
// ===================================================================
const MIN_QUEUES = 1;
const MAX_QUEUES = 8;
const AUTO_REGENERATE_DELAY = 400;
const DEFAULT_TABLE_LIMIT = 50;
const EXPANDED_TABLE_LIMIT = 1000;
const MAX_CELL_CHARS = 80;

// ===================================================================
// ESTADO GLOBAL DA APLICAÇÃO
// ===================================================================
// appState.queues[i] guarda a configuração de cada fila.
// appState.routing[i][j] = probabilidade de sair da fila i e ir para a fila j (índice 0).
// appState.routing[i][numQueues] = probabilidade de sair da fila i e sair do sistema.
const appState = {
    numQueues: 2,
    queues: [
        {
            hasExternalArrivals: true,
            firstArrival: 1.5,
            minArrival: 1.0,
            maxArrival: 4.0,
            minService: 3.0,
            maxService: 4.0,
            servers: 2,
            capacity: 3,
        },
        {
            hasExternalArrivals: false,
            firstArrival: 0,
            minArrival: 1.0,
            maxArrival: 4.0,
            minService: 2.0,
            maxService: 3.0,
            servers: 1,
            capacity: 5,
        },
    ],
    // Tandem padrão: fila 1 → fila 2 (100%), fila 2 → saída (100%)
    routing: [
        [0, 1, 0],  // fila 0 → fila 1 com prob 1.0; saída com prob 0.0
        [0, 0, 1],  // fila 1 → saída com prob 1.0
    ],
};

let lastResult = null;
let stateCharts = [];
let lcgScatterChart = null;
let regenerateTimeoutId = null;
let statesTableLimit = DEFAULT_TABLE_LIMIT;
let scheduleTableLimit = DEFAULT_TABLE_LIMIT;

// ===================================================================
// GERENCIAMENTO DO ESTADO DAS FILAS E ROTEAMENTO
// ===================================================================

// Constrói a matriz de roteamento padrão (tandem) para n filas:
// cada fila i roteia 100% para a fila i+1; a última fila roteia 100% para a saída.
function buildDefaultRoutingMatrix(n) {
    const matrix = [];
    for (let i = 0; i < n; i++) {
        const row = Array(n + 1).fill(0);
        if (i < n - 1) {
            row[i + 1] = 1.0;
        } else {
            row[n] = 1.0;
        }
        matrix.push(row);
    }
    return matrix;
}

// Lê os valores atuais da interface e salva em appState (necessário antes de
// alterar o número de filas para não perder os valores já preenchidos).
function saveStateFromDOM() {
    const n = appState.numQueues;

    for (let i = 0; i < n; i++) {
        const q = appState.queues[i] || {};
        q.hasExternalArrivals = document.getElementById(`q${i}-has-arrivals`)?.checked ?? false;
        q.firstArrival  = parseFloat(document.getElementById(`q${i}-first-arrival`)?.value)  || 0;
        q.minArrival    = parseFloat(document.getElementById(`q${i}-min-arrival`)?.value)    || 0;
        q.maxArrival    = parseFloat(document.getElementById(`q${i}-max-arrival`)?.value)    || 0;
        q.minService    = parseFloat(document.getElementById(`q${i}-min-service`)?.value)    || 0;
        q.maxService    = parseFloat(document.getElementById(`q${i}-max-service`)?.value)    || 0;
        q.servers       = parseInt(document.getElementById(`q${i}-servers`)?.value, 10)      || 1;
        q.capacity      = parseInt(document.getElementById(`q${i}-capacity`)?.value, 10)     || 1;
        appState.queues[i] = q;
    }

    for (let i = 0; i < n; i++) {
        for (let j = 0; j <= n; j++) {
            const id  = j < n ? `route-${i}-${j}` : `route-${i}-exit`;
            const val = parseFloat(document.getElementById(id)?.value);
            if (!isNaN(val) && appState.routing[i]) {
                appState.routing[i][j] = val;
            }
        }
    }
}

// Adiciona uma fila ao estado e expande a matriz de roteamento.
function addQueue() {
    saveStateFromDOM();
    const n = appState.numQueues;
    if (n >= MAX_QUEUES) return;

    appState.queues.push({
        hasExternalArrivals: false,
        firstArrival: 0,
        minArrival: 1.0,
        maxArrival: 4.0,
        minService: 2.0,
        maxService: 3.0,
        servers: 1,
        capacity: 5,
    });

    // Expande cada linha existente: insere 0 antes da coluna "saída"
    appState.routing = appState.routing.map(row => [
        ...row.slice(0, n),
        0,
        row[n],   // coluna saída passa de índice n para n+1
    ]);

    // Nova linha: nova fila sai do sistema com 100%
    const newRow = Array(n + 2).fill(0);
    newRow[n + 1] = 1.0;
    appState.routing.push(newRow);

    appState.numQueues += 1;
    refreshUI();
}

// Remove a última fila e contrai a matriz de roteamento.
function removeQueue() {
    saveStateFromDOM();
    const n = appState.numQueues;
    if (n <= MIN_QUEUES) return;

    appState.queues.pop();
    appState.routing.pop();

    // Remove a coluna da fila removida (índice n-1) de cada linha restante
    appState.routing = appState.routing.map(row => [
        ...row.slice(0, n - 1),
        row[n],   // coluna saída estava em n, passa para n-1
    ]);

    appState.numQueues -= 1;
    refreshUI();
}

function refreshUI() {
    updateQueueCountDisplay();
    renderQueueSections();
    renderRoutingMatrix();
    scheduleExecuteSimulation();
}

// ===================================================================
// GERADOR CONGRUENTE LINEAR (LCG)
// ===================================================================
function nextRandom(rng) {
    if (rng.remaining <= 0) return null;
    rng.previous = (rng.a * rng.previous + rng.c) % rng.M;
    rng.remaining -= 1;
    rng.used      += 1;
    return rng.previous / rng.M;
}

function uniform(min, max, rng) {
    const u = nextRandom(rng);
    if (u === null) return null;
    return { u, value: min + (max - min) * u };
}

// ===================================================================
// FILA DE EVENTOS (lista ordenada por tempo)
// ===================================================================
function enqueueEvent(eventQueue, event) {
    let idx = eventQueue.length;
    while (idx > 0 && eventQueue[idx - 1].tempo > event.tempo) idx -= 1;
    eventQueue.splice(idx, 0, event);
}

// ===================================================================
// SELEÇÃO DE DESTINO (ROTEAMENTO)
// ===================================================================
// routingRow: array de probabilidades [p_fila0, p_fila1, ..., p_filaN-1, p_saida]
// Retorna { dest: índice da fila (0-based) | 'exit', u: número | null }
// Retorna null se os aleatórios se esgotaram.
//
// Importante: quando há apenas um destino com probabilidade > 0 (roteamento
// determinístico), nenhum aleatório é consumido.
function selectDestination(routingRow, numQueues, rng) {
    const nonZero = [];
    for (let j = 0; j <= numQueues; j++) {
        const p = routingRow[j] ?? 0;
        if (p > 0) nonZero.push({ to: j < numQueues ? j : 'exit', prob: p });
    }

    if (nonZero.length === 0)  return { dest: 'exit', u: null };
    if (nonZero.length === 1)  return { dest: nonZero[0].to, u: null }; // determinístico

    const u = nextRandom(rng);
    if (u === null) return null;

    let cum = 0;
    for (const r of nonZero) {
        cum += r.prob;
        if (u < cum) return { dest: r.to, u };
    }
    return { dest: nonZero[nonZero.length - 1].to, u };
}

// ===================================================================
// MOTOR DE SIMULAÇÃO DE EVENTOS DISCRETOS
// ===================================================================
function createQueueState(cfg, idx) {
    return {
        id: idx + 1,
        hasExternalArrivals: cfg.hasExternalArrivals,
        minArrival: cfg.minArrival,
        maxArrival: cfg.maxArrival,
        minService: cfg.minService,
        maxService: cfg.maxService,
        servers:    cfg.servers,
        capacity:   cfg.capacity,
        customers:  0,
        inService:  0,
        loss:       0,
        times:      Array(cfg.capacity + 1).fill(0),
    };
}

function waitingCount(q) {
    return Math.max(0, q.customers - q.inService);
}

// Escalonamento de chegada externa para a fila qIdx
function scheduleArrivalEvent(sim, qIdx) {
    const q    = sim.queues[qIdx];
    const draw = uniform(q.minArrival, q.maxArrival, sim.rng);
    if (draw === null) return false;

    const t = sim.currentTime + draw.value;
    sim.schedulerRows.push({
        event:   `(${++sim.scheduleCounter}) Chegada F${qIdx + 1}`,
        tempo:   `${sim.currentTime.toFixed(4)} + ${draw.value.toFixed(4)} = ${t.toFixed(4)}`,
        sorteio: `u=${draw.u.toFixed(4)}; U(${q.minArrival}, ${q.maxArrival}) = ${draw.value.toFixed(4)}`,
    });
    enqueueEvent(sim.events, { tempo: t, tipo: 'ARRIVAL', queueIdx: qIdx });
    return true;
}

// Escalonamento de saída de atendimento na fila qIdx
function scheduleDepartureEvent(sim, qIdx) {
    const q    = sim.queues[qIdx];
    const draw = uniform(q.minService, q.maxService, sim.rng);
    if (draw === null) return false;

    const t = sim.currentTime + draw.value;
    sim.schedulerRows.push({
        event:   `(${++sim.scheduleCounter}) Saida F${qIdx + 1}`,
        tempo:   `${sim.currentTime.toFixed(4)} + ${draw.value.toFixed(4)} = ${t.toFixed(4)}`,
        sorteio: `u=${draw.u.toFixed(4)}; U(${q.minService}, ${q.maxService}) = ${draw.value.toFixed(4)}`,
    });
    enqueueEvent(sim.events, { tempo: t, tipo: 'DEPARTURE', queueIdx: qIdx });
    return true;
}

// Tenta inserir um cliente na fila qIdx.
// Retorna false apenas se esgotou os aleatórios ao escalonar o atendimento.
function tryEnterQueue(sim, qIdx) {
    const q = sim.queues[qIdx];
    if (q.customers < q.capacity) {
        q.customers += 1;
        if (q.inService < q.servers) {
            q.inService += 1;
            if (!scheduleDepartureEvent(sim, qIdx)) return false;
        }
    } else {
        q.loss += 1;
    }
    return true;
}

// Processa evento de chegada (externa) à fila qIdx
function processArrival(sim, qIdx) {
    if (!tryEnterQueue(sim, qIdx)) {
        sim.shouldStop = true;
        return;
    }
    const q = sim.queues[qIdx];
    if (q.hasExternalArrivals) {
        if (!scheduleArrivalEvent(sim, qIdx)) sim.shouldStop = true;
    }
}

// Processa evento de saída de atendimento da fila qIdx
function processDeparture(sim, qIdx) {
    const q = sim.queues[qIdx];
    if (q.inService <= 0 || q.customers <= 0) return;

    q.inService -= 1;
    q.customers -= 1;

    // Se houver clientes aguardando, inicia próximo atendimento
    if (waitingCount(q) > 0) {
        q.inService += 1;
        if (!scheduleDepartureEvent(sim, qIdx)) {
            sim.shouldStop = true;
            return;
        }
    }

    // Roteia o cliente para o próximo destino
    const dest = selectDestination(sim.routing[qIdx], sim.queues.length, sim.rng);
    if (dest === null) {
        sim.shouldStop = true;
        return;
    }

    if (dest.dest !== 'exit') {
        if (!tryEnterQueue(sim, dest.dest)) sim.shouldStop = true;
    }
    // dest === 'exit': cliente deixa o sistema
}

// Acumula o tempo decorrido nos vetores de estado de cada fila
function accumulateTimes(sim, nextTime) {
    const delta = nextTime - sim.prevTime;
    for (const q of sim.queues) q.times[q.customers] += delta;
    sim.prevTime = nextTime;
}

// Ponto de entrada da simulação
function runSimulation(params) {
    const n   = params.queues.length;
    const sim = {
        currentTime:      0,
        prevTime:         0,
        shouldStop:       false,
        events:           [],
        processedRows:    [],
        schedulerRows:    [],
        processedCounter: 0,
        scheduleCounter:  0,
        rng: {
            a:         params.a,
            c:         params.c,
            M:         params.M,
            previous:  params.seed,
            remaining: params.randomCount,
            used:      0,
        },
        queues:  params.queues.map((cfg, i) => createQueueState(cfg, i)),
        routing: params.routing,
    };

    // Agenda chegadas iniciais para filas com chegadas externas
    for (let i = 0; i < n; i++) {
        const q = params.queues[i];
        if (q.hasExternalArrivals) {
            const t0 = q.firstArrival;
            sim.schedulerRows.push({
                event:   `(${++sim.scheduleCounter}) Chegada F${i + 1} inicial`,
                tempo:   `t0 = ${t0.toFixed(4)}`,
                sorteio: `t0 = ${t0.toFixed(4)}`,
            });
            enqueueEvent(sim.events, { tempo: t0, tipo: 'ARRIVAL', queueIdx: i });
        }
    }

    while (sim.events.length > 0 && sim.rng.remaining > 0 && !sim.shouldStop) {
        const evt = sim.events.shift();
        accumulateTimes(sim, evt.tempo);
        sim.currentTime = evt.tempo;

        if (evt.tipo === 'ARRIVAL')    processArrival(sim, evt.queueIdx);
        else                           processDeparture(sim, evt.queueIdx);

        // Registra o estado atual de todas as filas
        sim.processedCounter += 1;
        sim.processedRows.push({
            event:       `${sim.processedCounter} - ${evt.tipo === 'ARRIVAL' ? 'Chegada' : 'Saida'} F${evt.queueIdx + 1}`,
            tempoGlobal: sim.currentTime,
            states:      sim.queues.map(q => ({ customers: q.customers, waiting: waitingCount(q) })),
            times:       sim.queues.map(q => [...q.times]),
        });
    }

    const tempoGlobal   = sim.currentTime;
    const queuesMetrics = sim.queues.map(q => {
        const prob  = q.times.map(t => tempoGlobal > 0 ? t / tempoGlobal : 0);
        const nMedio = tempoGlobal > 0
            ? q.times.reduce((acc, t, i) => acc + i * t, 0) / tempoGlobal
            : 0;
        return { id: q.id, times: q.times, prob, nMedio, pVazia: prob[0] ?? 0, loss: q.loss };
    });

    return {
        tempoGlobal,
        randomUsed:      sim.rng.used,
        randomRemaining: sim.rng.remaining,
        stopReason:      sim.rng.remaining <= 0 ? 'Aleatorios esgotados' : 'Fila de eventos vazia',
        processedRows:   sim.processedRows,
        schedulerRows:   sim.schedulerRows,
        queuesMetrics,
        numQueues: n,
    };
}

// ===================================================================
// LEITURA E VALIDAÇÃO DE PARÂMETROS
// ===================================================================
function readParams() {
    const n      = appState.numQueues;
    const queues = [];

    for (let i = 0; i < n; i++) {
        const hasArrivals = document.getElementById(`q${i}-has-arrivals`)?.checked ?? false;
        queues.push({
            hasExternalArrivals: hasArrivals,
            firstArrival: hasArrivals
                ? parseFloat(document.getElementById(`q${i}-first-arrival`)?.value || '0')
                : null,
            minArrival: hasArrivals
                ? parseFloat(document.getElementById(`q${i}-min-arrival`)?.value || '0')
                : null,
            maxArrival: hasArrivals
                ? parseFloat(document.getElementById(`q${i}-max-arrival`)?.value || '0')
                : null,
            minService: parseFloat(document.getElementById(`q${i}-min-service`)?.value || '0'),
            maxService: parseFloat(document.getElementById(`q${i}-max-service`)?.value || '0'),
            servers:    parseInt(document.getElementById(`q${i}-servers`)?.value   || '1', 10),
            capacity:   parseInt(document.getElementById(`q${i}-capacity`)?.value  || '1', 10),
        });
    }

    const routing = [];
    for (let i = 0; i < n; i++) {
        const row = [];
        for (let j = 0; j <= n; j++) {
            const id  = j < n ? `route-${i}-${j}` : `route-${i}-exit`;
            const val = parseFloat(document.getElementById(id)?.value || '0');
            row.push(isNaN(val) ? 0 : val);
        }
        routing.push(row);
    }

    return {
        seed:        parseInt(document.getElementById('seed')?.value,       10),
        a:           parseInt(document.getElementById('multiplier')?.value, 10),
        c:           parseInt(document.getElementById('increment')?.value,  10),
        M:           parseInt(document.getElementById('modulus')?.value,    10),
        randomCount: parseInt(document.getElementById('count')?.value,      10),
        queues,
        routing,
    };
}

function validateParams(p) {
    if (!Number.isFinite(p.seed) || !Number.isFinite(p.a) ||
        !Number.isFinite(p.c)   || !Number.isFinite(p.M)) {
        return 'Parametros do LCG invalidos.';
    }
    if (p.M <= 1)                           return 'M deve ser maior que 1.';
    if (p.seed < 0 || p.seed >= p.M)        return 'A semente deve obedecer 0 <= X0 < M.';
    if (p.a <= 0   || p.a >= p.M)           return 'O multiplicador deve obedecer 0 < a < M.';
    if (p.c < 0    || p.c >= p.M)           return 'O incremento deve obedecer 0 <= c < M.';
    if (p.randomCount < 1)                  return 'Quantidade de aleatorios deve ser >= 1.';

    for (let i = 0; i < p.queues.length; i++) {
        const q     = p.queues[i];
        const label = `Fila ${i + 1}`;

        if (q.hasExternalArrivals) {
            if (!Number.isFinite(q.firstArrival) || q.firstArrival < 0)
                return `${label}: primeira chegada deve ser >= 0.`;
            if (!Number.isFinite(q.minArrival) || !Number.isFinite(q.maxArrival))
                return `${label}: intervalos de chegada invalidos.`;
            if (q.minArrival > q.maxArrival)
                return `${label}: minArrival deve ser <= maxArrival.`;
        }

        if (!Number.isFinite(q.minService) || !Number.isFinite(q.maxService))
            return `${label}: intervalos de servico invalidos.`;
        if (q.minService > q.maxService)
            return `${label}: minService deve ser <= maxService.`;
        if (q.servers < 1)
            return `${label}: numero de servidores deve ser >= 1.`;
        if (q.capacity < 1)
            return `${label}: capacidade deve ser >= 1.`;
        if (q.capacity < q.servers)
            return `${label}: capacidade deve ser >= numero de servidores.`;

        // Valida soma das probabilidades de roteamento
        const row = p.routing[i];
        const sum = row.reduce((s, v) => s + v, 0);
        if (Math.abs(sum - 1.0) > 0.01) {
            return `${label}: soma das probabilidades de roteamento deve ser 1.0 (atual: ${sum.toFixed(4)}).`;
        }
    }

    // Verifica se ao menos uma fila tem chegadas externas
    if (!p.queues.some(q => q.hasExternalArrivals)) {
        return 'Pelo menos uma fila deve ter chegadas externas.';
    }

    return '';
}

// ===================================================================
// RENDERIZAÇÃO DA INTERFACE
// ===================================================================
function updateQueueCountDisplay() {
    const el = document.getElementById('queue-count-display');
    if (el) el.textContent = `${appState.numQueues} fila${appState.numQueues !== 1 ? 's' : ''}`;

    const removeBtn = document.getElementById('remove-queue');
    const addBtn    = document.getElementById('add-queue');
    if (removeBtn) removeBtn.disabled = appState.numQueues <= MIN_QUEUES;
    if (addBtn)    addBtn.disabled    = appState.numQueues >= MAX_QUEUES;
}

function renderQueueSections() {
    const container = document.getElementById('queues-container');
    if (!container) return;

    const n   = appState.numQueues;
    let html  = '';

    for (let i = 0; i < n; i++) {
        const q           = appState.queues[i] || {};
        const hasArrivals = q.hasExternalArrivals ?? (i === 0);
        const firstArrival = q.firstArrival ?? (i === 0 ? 1.5 : 0);
        const minArrival   = q.minArrival   ?? 1.0;
        const maxArrival   = q.maxArrival   ?? 4.0;
        const minService   = q.minService   ?? 2.0;
        const maxService   = q.maxService   ?? 3.0;
        const servers      = q.servers      ?? 1;
        const capacity     = q.capacity     ?? 5;

        html += `
        <section class="panel">
            <h2>Parametros da Fila ${i + 1}</h2>
            <div class="queue-arrivals-toggle">
                <label class="checkbox-label">
                    <input type="checkbox" id="q${i}-has-arrivals"
                           ${hasArrivals ? 'checked' : ''}
                           onchange="onHasArrivalsChange(${i})" />
                    Recebe chegadas externas
                </label>
            </div>
            <div id="q${i}-arrival-fields" class="params-grid params-grid-3"
                 ${!hasArrivals ? 'hidden' : ''}>
                <label>
                    Primeira chegada (t0)
                    <input type="number" id="q${i}-first-arrival" min="0" step="0.1"
                           value="${firstArrival}" />
                </label>
                <label>
                    minArrival
                    <input type="number" id="q${i}-min-arrival" min="0" step="0.1"
                           value="${minArrival}" />
                </label>
                <label>
                    maxArrival
                    <input type="number" id="q${i}-max-arrival" min="0" step="0.1"
                           value="${maxArrival}" />
                </label>
            </div>
            <div class="params-grid params-grid-4">
                <label>
                    minService
                    <input type="number" id="q${i}-min-service" min="0" step="0.1"
                           value="${minService}" />
                </label>
                <label>
                    maxService
                    <input type="number" id="q${i}-max-service" min="0" step="0.1"
                           value="${maxService}" />
                </label>
                <label>
                    Servidores (c)
                    <input type="number" id="q${i}-servers" min="1" step="1"
                           value="${servers}" />
                </label>
                <label>
                    Capacidade total (K)
                    <input type="number" id="q${i}-capacity" min="1" step="1"
                           value="${capacity}" />
                </label>
            </div>
        </section>`;
    }

    container.innerHTML = html;

    // Re-registra listeners de auto-simulação
    for (let i = 0; i < n; i++) {
        const ids = [
            `q${i}-has-arrivals`,  `q${i}-first-arrival`,
            `q${i}-min-arrival`,   `q${i}-max-arrival`,
            `q${i}-min-service`,   `q${i}-max-service`,
            `q${i}-servers`,       `q${i}-capacity`,
        ];
        for (const id of ids) {
            const el = document.getElementById(id);
            if (el) {
                el.addEventListener('blur',   scheduleExecuteSimulation);
                el.addEventListener('change', scheduleExecuteSimulation);
            }
        }
    }
}

// Atualiza a exibição da soma da linha de roteamento em tempo real
function updateRoutingRowSum(rowIdx) {
    const n = appState.numQueues;
    let sum = 0;
    for (let j = 0; j <= n; j++) {
        const id  = j < n ? `route-${rowIdx}-${j}` : `route-${rowIdx}-exit`;
        const val = parseFloat(document.getElementById(id)?.value || '0');
        if (!isNaN(val)) sum += val;
    }
    const sumEl  = document.getElementById(`route-sum-${rowIdx}`);
    if (sumEl) {
        sumEl.textContent = sum.toFixed(4);
        const isValid     = Math.abs(sum - 1.0) <= 0.01;
        sumEl.className   = `route-sum ${isValid ? 'route-sum-ok' : 'route-sum-err'}`;
    }
}

function renderRoutingMatrix() {
    const container = document.getElementById('routing-matrix-container');
    if (!container) return;

    const n = appState.numQueues;

    let headerCols = '';
    for (let j = 0; j < n; j++) headerCols += `<th>Fila ${j + 1}</th>`;
    headerCols += '<th>Saida</th><th>Soma</th>';

    let rows = '';
    for (let i = 0; i < n; i++) {
        let cells = '';
        for (let j = 0; j <= n; j++) {
            const id  = j < n ? `route-${i}-${j}` : `route-${i}-exit`;
            const val = (appState.routing[i]?.[j] ?? 0).toFixed(4);
            cells += `<td>
                <input type="number" id="${id}" class="route-input"
                       min="0" max="1" step="0.01" value="${val}"
                       oninput="updateRoutingRowSum(${i})" />
            </td>`;
        }
        const row     = appState.routing[i] || Array(n + 1).fill(0);
        const sum     = row.reduce((s, v) => s + v, 0);
        const isValid = Math.abs(sum - 1.0) <= 0.01;
        cells += `<td>
            <span id="route-sum-${i}" class="route-sum ${isValid ? 'route-sum-ok' : 'route-sum-err'}">
                ${sum.toFixed(4)}
            </span>
        </td>`;
        rows += `<tr><th>Fila ${i + 1}</th>${cells}</tr>`;
    }

    container.innerHTML = `
        <p class="table-hint">
            Cada linha define a probabilidade de roteamento a partir de uma fila.
            A soma de cada linha deve ser 1,0.
            Roteamento deterministico (unica rota ativa) nao consome um numero aleatorio.
        </p>
        <div class="routing-table-wrapper">
            <table class="routing-table">
                <thead>
                    <tr><th>De \\ Para</th>${headerCols}</tr>
                </thead>
                <tbody>${rows}</tbody>
            </table>
        </div>`;

    // Re-registra listeners
    for (let i = 0; i < n; i++) {
        for (let j = 0; j <= n; j++) {
            const id = j < n ? `route-${i}-${j}` : `route-${i}-exit`;
            const el = document.getElementById(id);
            if (el) {
                el.addEventListener('blur',   scheduleExecuteSimulation);
                el.addEventListener('change', scheduleExecuteSimulation);
            }
        }
    }
}

function onHasArrivalsChange(qIdx) {
    const checked   = document.getElementById(`q${qIdx}-has-arrivals`)?.checked ?? false;
    const fieldsDiv = document.getElementById(`q${qIdx}-arrival-fields`);
    if (fieldsDiv) fieldsDiv.hidden = !checked;
    scheduleExecuteSimulation();
}

// ===================================================================
// RENDERIZAÇÃO DOS RESULTADOS (dinâmica para N filas)
// ===================================================================
function escapeHtml(v) {
    return String(v)
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
}

function truncateCell(text) {
    const full = String(text);
    if (full.length <= MAX_CELL_CHARS) {
        return `<span title="${escapeHtml(full)}">${escapeHtml(full)}</span>`;
    }
    return `<span title="${escapeHtml(full)}">${escapeHtml(full.slice(0, MAX_CELL_CHARS - 1))}...</span>`;
}

function setLimitToggleLabel(btnId, currentLimit) {
    const btn = document.getElementById(btnId);
    if (btn) {
        btn.textContent = currentLimit === DEFAULT_TABLE_LIMIT
            ? 'Mostrar 1000 primeiros'
            : 'Mostrar 50 primeiros';
    }
}

function renderResults(result) {
    const container = document.getElementById('results-container');
    if (!container) return;

    const n = result.numQueues;

    // Seções de métricas por fila
    let queueMetricsSections = '';
    for (let i = 0; i < n; i++) {
        queueMetricsSections += `
        <section class="panel">
            <h2>Metricas da Fila ${i + 1}</h2>
            <div id="queue${i}-metrics" class="metrics"></div>
        </section>`;
    }

    // Tabelas de probabilidade por estado e gráficos (um par por fila)
    let probSections = '';
    for (let i = 0; i < n; i++) {
        probSections += `
        <section class="panel">
            <h2>Distribuicao de probabilidade por estado — Fila ${i + 1}</h2>
            <table>
                <thead>
                    <tr>
                        <th>Estado (i)</th>
                        <th>Tempo acumulado</th>
                        <th>Probabilidade</th>
                    </tr>
                </thead>
                <tbody id="prob-table-${i}"></tbody>
            </table>
        </section>
        <section class="panel chart-panel">
            <div class="chart-header">
                <h2>Grafico P(i) — Fila ${i + 1}</h2>
                <button onclick="exportQueueChart(${i}, 'prob_estados_fila${i + 1}.png')">
                    Baixar PNG
                </button>
            </div>
            <canvas id="stateChart${i}"></canvas>
        </section>`;
    }

    container.innerHTML = `
        <section class="panel">
            <h2>Resumo de metricas globais</h2>
            <div id="global-metrics" class="metrics"></div>
        </section>
        ${queueMetricsSections}
        <section class="panel">
            <div class="table-header">
                <h2>Tabela de estados processados</h2>
                <div class="table-actions">
                    <button id="toggle-states-limit">Mostrar 1000 primeiros</button>
                </div>
            </div>
            <p class="table-hint">Exibindo os primeiros ${DEFAULT_TABLE_LIMIT} eventos por padrao.</p>
            <div class="table-scroll">
                <table>
                    <thead id="states-head"></thead>
                    <tbody id="states-table"></tbody>
                </table>
            </div>
        </section>
        <section class="panel">
            <div class="table-header">
                <h2>Tabela de escalonamento</h2>
                <div class="table-actions">
                    <button id="toggle-schedule-limit">Mostrar 1000 primeiros</button>
                </div>
            </div>
            <p class="table-hint">Exibindo os primeiros ${DEFAULT_TABLE_LIMIT} escalonamentos por padrao.</p>
            <div class="table-scroll">
                <table>
                    <thead>
                        <tr>
                            <th>Evento</th>
                            <th>Tempo</th>
                            <th>Sorteio</th>
                        </tr>
                    </thead>
                    <tbody id="schedule-table"></tbody>
                </table>
            </div>
        </section>
        ${probSections}
        <section class="panel method-panel">
            <h2>Como o simulador funciona</h2>
            <p>
                Este simulador implementa um motor de eventos discretos generico para redes de filas
                com topologia arbitraria (ate ${MAX_QUEUES} filas). Cada fila pode ter chegadas
                externas opcionais, qualquer numero de servidores e capacidade. Ao finalizar o
                atendimento em uma fila, o cliente e roteado segundo a matriz de probabilidades
                configurada pelo usuario.
            </p>
            <p>
                Tipos de evento: <strong>ARRIVAL</strong> (chegada em qualquer fila) e
                <strong>DEPARTURE</strong> (saida de qualquer fila). Roteamento deterministico
                (unica rota com probabilidade 1,0) nao consome aleatorio. Para roteamentos
                probabilisticos, um aleatorio e consumido para decidir o destino.
            </p>
            <div class="formula">
                X(n+1) = (a * X(n) + c) mod M,  U = X / M
            </div>
            <p>
                Antes de processar cada evento, o tempo decorrido e acumulado nos vetores de estado
                de todas as filas simultaneamente. Ao final, P(i) = tempo_acumulado(i) / tempo_global.
            </p>
            <p>
                Perda ocorre quando um cliente (externo ou roteado) tenta entrar em uma fila com
                capacidade maxima atingida. As perdas sao contabilizadas individualmente por fila.
            </p>
        </section>`;

    // Re-registra listeners dos botões de toggle
    document.getElementById('toggle-states-limit')?.addEventListener('click', () => {
        if (!lastResult) return;
        statesTableLimit = statesTableLimit === DEFAULT_TABLE_LIMIT
            ? EXPANDED_TABLE_LIMIT
            : DEFAULT_TABLE_LIMIT;
        setLimitToggleLabel('toggle-states-limit', statesTableLimit);
        renderStatesTable(lastResult);
    });
    document.getElementById('toggle-schedule-limit')?.addEventListener('click', () => {
        if (!lastResult) return;
        scheduleTableLimit = scheduleTableLimit === DEFAULT_TABLE_LIMIT
            ? EXPANDED_TABLE_LIMIT
            : DEFAULT_TABLE_LIMIT;
        setLimitToggleLabel('toggle-schedule-limit', scheduleTableLimit);
        renderSchedulerTable(lastResult);
    });

    // Preenche dados
    renderGlobalMetrics(result);
    renderQueueMetrics(result);
    renderStatesTable(result);
    renderSchedulerTable(result);
    renderProbabilityTables(result);
    renderStateCharts(result);
}

function renderGlobalMetrics(result) {
    const el = document.getElementById('global-metrics');
    if (!el) return;
    el.innerHTML = [
        ['Tempo global',          `${result.tempoGlobal.toFixed(4)} u.t.`],
        ['Aleatorios usados',     `${result.randomUsed}`],
        ['Aleatorios restantes',  `${result.randomRemaining}`],
        ['Motivo de parada',      result.stopReason],
    ].map(([label, value]) =>
        `<article class="metric-card"><h3>${label}</h3><p>${value}</p></article>`
    ).join('');
}

function renderQueueMetrics(result) {
    for (let i = 0; i < result.numQueues; i++) {
        const el = document.getElementById(`queue${i}-metrics`);
        if (!el) continue;
        const m  = result.queuesMetrics[i];
        el.innerHTML = [
            ['Perdas',                `${m.loss} clientes`],
            ['Populacao media (N)',   `${m.nMedio.toFixed(4)} clientes`],
            ['Prob. fila vazia P(0)', `${(m.pVazia * 100).toFixed(4)}%`],
        ].map(([label, value]) =>
            `<article class="metric-card"><h3>${label}</h3><p>${value}</p></article>`
        ).join('');
    }
}

function renderStatesTable(result) {
    const head  = document.getElementById('states-head');
    const tbody = document.getElementById('states-table');
    if (!head || !tbody) return;

    const n = result.numQueues;

    // Cabeçalho dinâmico
    let headerCols = '';
    for (let i = 0; i < n; i++) {
        headerCols += `<th>F${i + 1} clientes</th><th>F${i + 1} fila</th>`;
    }
    for (let i = 0; i < n; i++) {
        const cap = result.queuesMetrics[i].times.length;
        for (let s = 0; s < cap; s++) headerCols += `<th>F${i + 1} t[${s}]</th>`;
    }
    head.innerHTML = `<tr><th>Evento</th><th>Tempo global</th>${headerCols}</tr>`;

    const visible   = result.processedRows.slice(0, statesTableLimit);
    const hidden    = result.processedRows.length - visible.length;
    const totalCols = 2 + n * 2 + result.queuesMetrics.reduce((s, m) => s + m.times.length, 0);

    let html = visible.map(row => {
        let cells = '';
        for (let i = 0; i < n; i++) {
            cells += `<td>${row.states[i].customers}</td><td>${row.states[i].waiting}</td>`;
        }
        for (let i = 0; i < n; i++) {
            for (const t of row.times[i]) cells += `<td>${t.toFixed(4)}</td>`;
        }
        return `<tr>
            <td>${escapeHtml(row.event)}</td>
            <td>${row.tempoGlobal.toFixed(4)}</td>
            ${cells}
        </tr>`;
    }).join('');

    if (hidden > 0) {
        html += `<tr><td colspan="${totalCols}">+ ${hidden} eventos ocultos</td></tr>`;
    }
    tbody.innerHTML = html;
}

function renderSchedulerTable(result) {
    const tbody = document.getElementById('schedule-table');
    if (!tbody) return;

    const visible = result.schedulerRows.slice(0, scheduleTableLimit);
    const hidden  = result.schedulerRows.length - visible.length;

    let html = visible.map(row =>
        `<tr>
            <td>${escapeHtml(row.event)}</td>
            <td>${truncateCell(row.tempo)}</td>
            <td>${truncateCell(row.sorteio)}</td>
        </tr>`
    ).join('');

    if (hidden > 0) {
        html += `<tr><td colspan="3">+ ${hidden} escalonamentos ocultos</td></tr>`;
    }
    tbody.innerHTML = html;
}

function renderProbabilityTables(result) {
    for (let i = 0; i < result.numQueues; i++) {
        const tbody = document.getElementById(`prob-table-${i}`);
        if (!tbody) continue;
        const m = result.queuesMetrics[i];
        tbody.innerHTML = m.times.map((t, s) =>
            `<tr>
                <td>${s}</td>
                <td>${t.toFixed(4)}</td>
                <td>${m.prob[s].toFixed(4)}</td>
            </tr>`
        ).join('');
    }
}

function renderStateCharts(result) {
    // Destrói gráficos anteriores
    for (const chart of stateCharts) {
        if (chart) chart.destroy();
    }
    stateCharts = [];

    for (let i = 0; i < result.numQueues; i++) {
        const canvas = document.getElementById(`stateChart${i}`);
        if (!canvas) {
            stateCharts.push(null);
            continue;
        }
        const m     = result.queuesMetrics[i];
        const chart = new Chart(canvas.getContext('2d'), {
            type: 'bar',
            data: {
                labels:   m.prob.map((_, s) => `Estado ${s}`),
                datasets: [{
                    label:           `P(i) Fila ${i + 1}`,
                    data:            m.prob,
                    backgroundColor: '#FF4FD8',
                    borderColor:     '#FF4FD8',
                    borderWidth:     1,
                }],
            },
            options: {
                responsive:          true,
                maintainAspectRatio: false,
                scales: {
                    x: { title: { display: true, text: 'Estado i' } },
                    y: { beginAtZero: true, title: { display: true, text: 'Probabilidade' } },
                },
            },
        });
        stateCharts.push(chart);
    }
}

// Acessível via onclick inline no HTML gerado dinamicamente
function exportQueueChart(queueIdx, filename) {
    exportChartPng(stateCharts[queueIdx], filename);
}

function exportChartPng(chart, filename) {
    if (!chart) return;
    const link     = document.createElement('a');
    link.href      = chart.toBase64Image('image/png', 1);
    link.download  = filename;
    link.click();
}

// ===================================================================
// GRÁFICO DE DISTRIBUIÇÃO DO LCG
// ===================================================================
function generateLcgScatterPoints(seed, a, c, M, count) {
    const n    = Math.min(count, 5000);
    const vals = [];
    let prev   = seed;
    for (let i = 0; i < n; i++) {
        prev = (a * prev + c) % M;
        vals.push(prev / M);
    }
    return vals.slice(0, -1).map((x, i) => ({ x, y: vals[i + 1] }));
}

function renderLcgDistributionChart(params) {
    const canvas = document.getElementById('lcgScatterPlot');
    if (!canvas) return;
    const points = generateLcgScatterPoints(params.seed, params.a, params.c, params.M, params.randomCount);
    if (lcgScatterChart) lcgScatterChart.destroy();
    lcgScatterChart = new Chart(canvas.getContext('2d'), {
        type: 'scatter',
        data: {
            datasets: [{
                label:           'Ui x Ui+1',
                data:            points,
                pointRadius:     2,
                backgroundColor: '#FF4FD8',
                borderColor:     '#FF4FD8',
                showLine:        false,
            }],
        },
        options: {
            responsive:          true,
            maintainAspectRatio: false,
            scales: {
                x: { min: 0, max: 1, title: { display: true, text: 'Ui' } },
                y: { min: 0, max: 1, title: { display: true, text: 'Ui+1' } },
            },
        },
    });
}

// ===================================================================
// EXPORTAÇÃO CSV
// ===================================================================
function exportCsv() {
    if (!lastResult) return;
    const rows = ['fila,estado,tempo,probabilidade'];
    for (let i = 0; i < lastResult.numQueues; i++) {
        const m = lastResult.queuesMetrics[i];
        m.times.forEach((t, s) => {
            rows.push(`Fila${i + 1},${s},${t.toFixed(4)},${m.prob[s].toFixed(4)}`);
        });
    }
    const blob = new Blob([rows.join('\n')], { type: 'text/csv;charset=utf-8;' });
    const url  = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href      = url;
    link.download  = 'resultado_simulacao.csv';
    link.click();
    URL.revokeObjectURL(url);
}

// ===================================================================
// EXECUÇÃO DA SIMULAÇÃO
// ===================================================================
function executeSimulation() {
    const errorEl = document.getElementById('error');
    const params  = readParams();
    const error   = validateParams(params);

    if (error) {
        if (errorEl) errorEl.textContent = error;
        return;
    }
    if (errorEl) errorEl.textContent = '';

    lastResult       = runSimulation(params);
    statesTableLimit  = DEFAULT_TABLE_LIMIT;
    scheduleTableLimit = DEFAULT_TABLE_LIMIT;

    renderResults(lastResult);
    setLimitToggleLabel('toggle-states-limit',  statesTableLimit);
    setLimitToggleLabel('toggle-schedule-limit', scheduleTableLimit);

    const lcgVisible = document.getElementById('lcg-accordion-toggle')
        ?.getAttribute('aria-expanded') === 'true';
    if (lcgVisible) renderLcgDistributionChart(params);
}

function scheduleExecuteSimulation() {
    clearTimeout(regenerateTimeoutId);
    regenerateTimeoutId = setTimeout(executeSimulation, AUTO_REGENERATE_DELAY);
}

// ===================================================================
// CENÁRIO DO ENUNCIADO (M6)
// ===================================================================
// Fila 1: G/G/2/3, chegadas 1..4, servico 3..4, primeira chegada t0=1.5
// Fila 2: G/G/1/5, sem chegadas externas, servico 2..3
// Roteamento: fila 1 → fila 2 (100%), fila 2 → saida (100%)
function loadEnunciadoScenario() {
    appState.numQueues = 2;
    appState.queues    = [
        {
            hasExternalArrivals: true,
            firstArrival: 1.5,
            minArrival:   1.0,
            maxArrival:   4.0,
            minService:   3.0,
            maxService:   4.0,
            servers:      2,
            capacity:     3,
        },
        {
            hasExternalArrivals: false,
            firstArrival: 0,
            minArrival:   1.0,
            maxArrival:   4.0,
            minService:   2.0,
            maxService:   3.0,
            servers:      1,
            capacity:     5,
        },
    ];
    appState.routing = [
        [0, 1, 0],  // fila 1 → fila 2 (100%)
        [0, 0, 1],  // fila 2 → saida  (100%)
    ];

    document.getElementById('seed').value        = '42';
    document.getElementById('multiplier').value  = '39758';
    document.getElementById('increment').value   = '58739';
    document.getElementById('modulus').value     = '987654321';
    document.getElementById('count').value       = '100000';

    updateQueueCountDisplay();
    renderQueueSections();
    renderRoutingMatrix();
    executeSimulation();
}

// ===================================================================
// ACORDEÃO LCG
// ===================================================================
function setupLcgAccordion() {
    const toggle  = document.getElementById('lcg-accordion-toggle');
    const content = document.getElementById('lcg-distribution-content');
    if (!toggle || !content) return;

    toggle.addEventListener('click', () => {
        const isOpen = toggle.getAttribute('aria-expanded') === 'true';
        toggle.setAttribute('aria-expanded', String(!isOpen));
        toggle.textContent = isOpen
            ? 'Mostrar grafico de distribuicao do LCG'
            : 'Ocultar grafico de distribuicao do LCG';
        content.hidden = isOpen;
        if (!isOpen) {
            renderLcgDistributionChart(readParams());
        }
    });
}

// ===================================================================
// INICIALIZAÇÃO
// ===================================================================
window.addEventListener('DOMContentLoaded', () => {
    setupLcgAccordion();

    document.getElementById('add-queue')?.addEventListener('click',       addQueue);
    document.getElementById('remove-queue')?.addEventListener('click',    removeQueue);
    document.getElementById('run')?.addEventListener('click',             executeSimulation);
    document.getElementById('scenario-minimum')?.addEventListener('click', loadEnunciadoScenario);
    document.getElementById('download-csv')?.addEventListener('click',    exportCsv);

    ['seed', 'multiplier', 'increment', 'modulus', 'count'].forEach(id => {
        const el = document.getElementById(id);
        if (el) {
            el.addEventListener('blur',   scheduleExecuteSimulation);
            el.addEventListener('change', scheduleExecuteSimulation);
        }
    });

    updateQueueCountDisplay();
    renderQueueSections();
    renderRoutingMatrix();
    executeSimulation();
});
