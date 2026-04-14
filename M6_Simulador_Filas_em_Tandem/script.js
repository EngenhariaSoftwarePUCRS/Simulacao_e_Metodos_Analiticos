const EVENT_TYPES = {
    CHEGADA_F1: "CHEGADA_F1",
    PASSAGEM_F1_F2: "PASSAGEM_F1_F2",
    SAIDA_F2: "SAIDA_F2",
};

let lastResult = null;
let stateChartF1 = null;
let stateChartF2 = null;
let lcgScatterChart = null;
let regenerateTimeoutId = null;
let statesTableLimit = 50;
let scheduleTableLimit = 50;

const AUTO_REGENERATE_DELAY = 250;
const DEFAULT_TABLE_LIMIT = 50;
const EXPANDED_TABLE_LIMIT = 1000;
const MAX_CELL_CHARS = 80;

function createQueue({ id, servers, capacity, minArrival = null, maxArrival = null, minService, maxService }) {
    return {
        id,
        servers,
        capacity,
        minArrival,
        maxArrival,
        minService,
        maxService,
        customers: 0,
        inService: 0,
        loss: 0,
        times: Array(capacity + 1).fill(0),
    };
}

function readParams() {
    return {
        seed: Number.parseInt(document.getElementById("seed").value, 10),
        a: Number.parseInt(document.getElementById("multiplier").value, 10),
        c: Number.parseInt(document.getElementById("increment").value, 10),
        M: Number.parseInt(document.getElementById("modulus").value, 10),
        randomCount: Number.parseInt(document.getElementById("count").value, 10),

        firstArrival: Number.parseFloat(document.getElementById("first-arrival").value),

        f1MinArrival: Number.parseFloat(document.getElementById("f1-min-arrival").value),
        f1MaxArrival: Number.parseFloat(document.getElementById("f1-max-arrival").value),
        f1MinService: Number.parseFloat(document.getElementById("f1-min-service").value),
        f1MaxService: Number.parseFloat(document.getElementById("f1-max-service").value),
        f1Servers: Number.parseInt(document.getElementById("f1-servers").value, 10),
        f1Capacity: Number.parseInt(document.getElementById("f1-capacity").value, 10),

        f2MinService: Number.parseFloat(document.getElementById("f2-min-service").value),
        f2MaxService: Number.parseFloat(document.getElementById("f2-max-service").value),
        f2Servers: Number.parseInt(document.getElementById("f2-servers").value, 10),
        f2Capacity: Number.parseInt(document.getElementById("f2-capacity").value, 10),
    };
}

function validateParams(p) {
    if (!Number.isFinite(p.seed) || !Number.isFinite(p.a) || !Number.isFinite(p.c) || !Number.isFinite(p.M)) {
        return "Parametros do LCG invalidos.";
    }
    if (p.M <= 1) return "M deve ser maior que 1.";
    if (p.seed < 0 || p.seed >= p.M) return "A semente deve obedecer 0 <= X0 < M.";
    if (p.a <= 0 || p.a >= p.M) return "O multiplicador deve obedecer 0 < a < M.";
    if (p.c < 0 || p.c >= p.M) return "O incremento deve obedecer 0 <= c < M.";
    if (p.randomCount < 1) return "Quantidade de aleatorios deve ser >= 1.";

    if (p.firstArrival < 0) return "A primeira chegada deve ser >= 0.";

    if (p.f1MinArrival > p.f1MaxArrival) return "Fila 1: minArrival deve ser <= maxArrival.";
    if (p.f1MinService > p.f1MaxService) return "Fila 1: minService deve ser <= maxService.";
    if (p.f1Servers < 1) return "Fila 1: numero de servidores deve ser >= 1.";
    if (p.f1Capacity < 1) return "Fila 1: capacidade deve ser >= 1.";
    if (p.f1Capacity < p.f1Servers) return "Fila 1: capacidade deve ser >= numero de servidores.";
    if (p.f1MinArrival < 0 || p.f1MaxArrival < 0 || p.f1MinService < 0 || p.f1MaxService < 0) {
        return "Fila 1: os intervalos devem ser nao-negativos.";
    }

    if (p.f2MinService > p.f2MaxService) return "Fila 2: minService deve ser <= maxService.";
    if (p.f2Servers < 1) return "Fila 2: numero de servidores deve ser >= 1.";
    if (p.f2Capacity < 1) return "Fila 2: capacidade deve ser >= 1.";
    if (p.f2Capacity < p.f2Servers) return "Fila 2: capacidade deve ser >= numero de servidores.";
    if (p.f2MinService < 0 || p.f2MaxService < 0) {
        return "Fila 2: os intervalos devem ser nao-negativos.";
    }

    return "";
}

function nextRandom(rng) {
    if (rng.remaining <= 0) {
        return null;
    }

    rng.previous = (rng.a * rng.previous + rng.c) % rng.M;
    rng.remaining -= 1;
    rng.used += 1;
    return rng.previous / rng.M;
}

function uniform(min, max, rng) {
    const u = nextRandom(rng);
    if (u === null) {
        return null;
    }

    return {
        u,
        value: min + (max - min) * u,
    };
}

function enqueueEvent(queue, event) {
    let idx = queue.length;
    while (idx > 0 && queue[idx - 1].tempo > event.tempo) {
        idx -= 1;
    }
    queue.splice(idx, 0, event);
}

function nextEvent(queue) {
    return queue.shift();
}

function formatNumber(value) {
    return value.toFixed(4);
}

function formatEventType(type) {
    switch (type) {
        case EVENT_TYPES.CHEGADA_F1:
            return "Chegada F1";
        case EVENT_TYPES.PASSAGEM_F1_F2:
            return "Passagem F1→F2";
        case EVENT_TYPES.SAIDA_F2:
            return "Saida F2";
        default:
            return type;
    }
}

function setLimitToggleLabel(buttonId, currentLimit) {
    const button = document.getElementById(buttonId);
    if (!button) {
        return;
    }

    button.textContent = currentLimit === DEFAULT_TABLE_LIMIT
        ? "Mostrar 1000 primeiros"
        : "Mostrar 50 primeiros";
}

function escapeHtml(value) {
    return String(value)
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#39;");
}

function truncateForCell(text, maxChars = MAX_CELL_CHARS) {
    const fullText = String(text);
    if (fullText.length <= maxChars) {
        return `<span title="${escapeHtml(fullText)}">${escapeHtml(fullText)}</span>`;
    }

    const shortText = `${fullText.slice(0, maxChars - 1)}…`;
    return `<span title="${escapeHtml(fullText)}">${escapeHtml(shortText)}</span>`;
}

function addSchedulerRow(sim, payload) {
    sim.scheduleCounter += 1;

    if (payload.isInitial) {
        sim.schedulerRows.push({
            event: `(${sim.scheduleCounter}) ${formatEventType(payload.tipo)} inicial`,
            tempo: `0.0000 + t0(${formatNumber(payload.tempoAgendado)}) = ${formatNumber(payload.tempoAgendado)}`,
            sorteio: `t0 = ${formatNumber(payload.tempoAgendado)}`,
        });
        return;
    }

    sim.schedulerRows.push({
        event: `(${sim.scheduleCounter}) ${formatEventType(payload.tipo)}`,
        tempo: `${formatNumber(payload.tempoBase)} + ${formatNumber(payload.sorteio)} = ${formatNumber(payload.tempoAgendado)}`,
        sorteio: `u=${formatNumber(payload.u)}; U(${formatNumber(payload.min)}, ${formatNumber(payload.max)}) = ${formatNumber(payload.sorteio)}`,
    });
}

function scheduleChegadaFila1(sim, params) {
    const draw = uniform(params.f1MinArrival, params.f1MaxArrival, sim.rng);
    if (draw === null) {
        return false;
    }

    const scheduledTime = sim.tempoAtual + draw.value;

    addSchedulerRow(sim, {
        tipo: EVENT_TYPES.CHEGADA_F1,
        tempoBase: sim.tempoAtual,
        sorteio: draw.value,
        u: draw.u,
        tempoAgendado: scheduledTime,
        min: params.f1MinArrival,
        max: params.f1MaxArrival,
    });

    enqueueEvent(sim.events, {
        tempo: scheduledTime,
        tipo: EVENT_TYPES.CHEGADA_F1,
    });

    return true;
}

function schedulePassagemFila1Fila2(sim, queue) {
    const draw = uniform(queue.minService, queue.maxService, sim.rng);
    if (draw === null) {
        return false;
    }

    const scheduledTime = sim.tempoAtual + draw.value;

    addSchedulerRow(sim, {
        tipo: EVENT_TYPES.PASSAGEM_F1_F2,
        tempoBase: sim.tempoAtual,
        sorteio: draw.value,
        u: draw.u,
        tempoAgendado: scheduledTime,
        min: queue.minService,
        max: queue.maxService,
    });

    enqueueEvent(sim.events, {
        tempo: scheduledTime,
        tipo: EVENT_TYPES.PASSAGEM_F1_F2,
    });

    return true;
}

function scheduleSaidaFila2(sim, queue) {
    const draw = uniform(queue.minService, queue.maxService, sim.rng);
    if (draw === null) {
        return false;
    }

    const scheduledTime = sim.tempoAtual + draw.value;

    addSchedulerRow(sim, {
        tipo: EVENT_TYPES.SAIDA_F2,
        tempoBase: sim.tempoAtual,
        sorteio: draw.value,
        u: draw.u,
        tempoAgendado: scheduledTime,
        min: queue.minService,
        max: queue.maxService,
    });

    enqueueEvent(sim.events, {
        tempo: scheduledTime,
        tipo: EVENT_TYPES.SAIDA_F2,
    });

    return true;
}

function queueWaitingCount(queue) {
    return Math.max(0, queue.customers - queue.inService);
}

function accumulateTimes(sim, nextEventTime) {
    const deltaT = nextEventTime - sim.tempoAnterior;
    sim.fila1.times[sim.fila1.customers] += deltaT;
    sim.fila2.times[sim.fila2.customers] += deltaT;
    sim.tempoAnterior = nextEventTime;
}

function processChegadaFila1(sim, params) {
    const fila1 = sim.fila1;

    if (fila1.customers < fila1.capacity) {
        fila1.customers += 1;

        if (fila1.inService < fila1.servers) {
            fila1.inService += 1;
            const scheduled = schedulePassagemFila1Fila2(sim, fila1);
            if (!scheduled) {
                sim.shouldStop = true;
                return;
            }
        }
    } else {
        fila1.loss += 1;
    }

    const scheduledArrival = scheduleChegadaFila1(sim, params);
    if (!scheduledArrival) {
        sim.shouldStop = true;
    }
}

function processPassagemFila1Fila2(sim) {
    const fila1 = sim.fila1;
    const fila2 = sim.fila2;

    if (fila1.inService <= 0 || fila1.customers <= 0) {
        return;
    }

    fila1.inService -= 1;
    fila1.customers -= 1;

    const fila1Waiting = queueWaitingCount(fila1);
    if (fila1Waiting > 0) {
        fila1.inService += 1;
        const scheduledNextPassage = schedulePassagemFila1Fila2(sim, fila1);
        if (!scheduledNextPassage) {
            sim.shouldStop = true;
            return;
        }
    }

    if (fila2.customers < fila2.capacity) {
        fila2.customers += 1;

        if (fila2.inService < fila2.servers) {
            fila2.inService += 1;
            const scheduledExit = scheduleSaidaFila2(sim, fila2);
            if (!scheduledExit) {
                sim.shouldStop = true;
            }
        }
    } else {
        fila2.loss += 1;
    }
}

function processSaidaFila2(sim) {
    const fila2 = sim.fila2;

    if (fila2.inService <= 0 || fila2.customers <= 0) {
        return;
    }

    fila2.inService -= 1;
    fila2.customers -= 1;

    const fila2Waiting = queueWaitingCount(fila2);
    if (fila2Waiting > 0) {
        fila2.inService += 1;
        const scheduledNextExit = scheduleSaidaFila2(sim, fila2);
        if (!scheduledNextExit) {
            sim.shouldStop = true;
        }
    }
}

function buildProcessedRow(sim, eventType) {
    sim.processedCounter += 1;

    sim.processedRows.push({
        event: `${sim.processedCounter} - ${formatEventType(eventType)}`,
        tempoGlobal: sim.tempoAtual,
        fila1Customers: sim.fila1.customers,
        fila1Queue: queueWaitingCount(sim.fila1),
        fila2Customers: sim.fila2.customers,
        fila2Queue: queueWaitingCount(sim.fila2),
        fila1Times: [...sim.fila1.times],
        fila2Times: [...sim.fila2.times],
    });
}

function computeQueueMetrics(queue, tempoGlobal) {
    const prob = queue.times.map((value) => (tempoGlobal > 0 ? value / tempoGlobal : 0));
    const nMedio = tempoGlobal > 0
        ? queue.times.reduce((acc, t, i) => acc + i * t, 0) / tempoGlobal
        : 0;

    return {
        times: queue.times,
        prob,
        nMedio,
        pVazia: prob[0] ?? 0,
        loss: queue.loss,
    };
}

function runSimulation(params) {
    const sim = {
        tempoAtual: 0,
        tempoAnterior: 0,
        shouldStop: false,
        events: [],
        processedRows: [],
        schedulerRows: [],
        processedCounter: 0,
        scheduleCounter: 0,
        rng: {
            a: params.a,
            c: params.c,
            M: params.M,
            previous: params.seed,
            remaining: params.randomCount,
            used: 0,
        },
        fila1: createQueue({
            id: 1,
            servers: params.f1Servers,
            capacity: params.f1Capacity,
            minArrival: params.f1MinArrival,
            maxArrival: params.f1MaxArrival,
            minService: params.f1MinService,
            maxService: params.f1MaxService,
        }),
        fila2: createQueue({
            id: 2,
            servers: params.f2Servers,
            capacity: params.f2Capacity,
            minService: params.f2MinService,
            maxService: params.f2MaxService,
        }),
    };

    enqueueEvent(sim.events, {
        tempo: params.firstArrival,
        tipo: EVENT_TYPES.CHEGADA_F1,
    });

    addSchedulerRow(sim, {
        tipo: EVENT_TYPES.CHEGADA_F1,
        isInitial: true,
        tempoAgendado: params.firstArrival,
    });

    while (sim.events.length > 0 && sim.rng.remaining > 0 && !sim.shouldStop) {
        const evento = nextEvent(sim.events);
        accumulateTimes(sim, evento.tempo);
        sim.tempoAtual = evento.tempo;

        if (evento.tipo === EVENT_TYPES.CHEGADA_F1) {
            processChegadaFila1(sim, params);
        } else if (evento.tipo === EVENT_TYPES.PASSAGEM_F1_F2) {
            processPassagemFila1Fila2(sim);
        } else if (evento.tipo === EVENT_TYPES.SAIDA_F2) {
            processSaidaFila2(sim);
        }

        buildProcessedRow(sim, evento.tipo);
    }

    const tempoGlobal = sim.tempoAtual;
    const fila1Metrics = computeQueueMetrics(sim.fila1, tempoGlobal);
    const fila2Metrics = computeQueueMetrics(sim.fila2, tempoGlobal);

    return {
        tempoGlobal,
        randomUsed: sim.rng.used,
        randomRemaining: sim.rng.remaining,
        stopReason: sim.rng.remaining <= 0 ? "Aleatorios esgotados" : "Fila de eventos vazia",
        processedRows: sim.processedRows,
        schedulerRows: sim.schedulerRows,
        fila1: fila1Metrics,
        fila2: fila2Metrics,
    };
}

function renderMetricCards(containerId, items) {
    const container = document.getElementById(containerId);
    if (!container) {
        return;
    }

    container.innerHTML = items.map(([label, value]) => (
        `<article class="metric-card"><h3>${label}</h3><p>${value}</p></article>`
    )).join("");
}

function renderMetrics(result) {
    renderMetricCards("global-metrics", [
        ["Tempo total", `${result.tempoGlobal.toFixed(4)} u.t.`],
        ["Aleatorios usados", `${result.randomUsed} amostras`],
        ["Aleatorios restantes", `${result.randomRemaining} amostras`],
        ["Parada", result.stopReason],
    ]);

    renderMetricCards("queue1-metrics", [
        ["Perdas", `${result.fila1.loss} clientes`],
        ["Populacao media (Nmedio)", `${result.fila1.nMedio.toFixed(4)} clientes`],
        ["Prob. fila vazia", `${(result.fila1.pVazia * 100).toFixed(4)}%`],
    ]);

    renderMetricCards("queue2-metrics", [
        ["Perdas", `${result.fila2.loss} clientes`],
        ["Populacao media (Nmedio)", `${result.fila2.nMedio.toFixed(4)} clientes`],
        ["Prob. fila vazia", `${(result.fila2.pVazia * 100).toFixed(4)}%`],
    ]);
}

function renderStates(result) {
    const head = document.getElementById("states-head");
    const tbody = document.getElementById("states-table");

    if (!head || !tbody) {
        return;
    }

    const fila1Headers = Array.from({ length: result.fila1.times.length }, (_, i) => `<th>F1 Estado ${i}</th>`).join("");
    const fila2Headers = Array.from({ length: result.fila2.times.length }, (_, i) => `<th>F2 Estado ${i}</th>`).join("");

    head.innerHTML = `
        <tr>
            <th>Evento</th>
            <th>Tempo global</th>
            <th>F1 clientes</th>
            <th>F1 fila</th>
            <th>F2 clientes</th>
            <th>F2 fila</th>
            ${fila1Headers}
            ${fila2Headers}
        </tr>
    `;

    const visibleRows = result.processedRows.slice(0, statesTableLimit);
    const hiddenRowsCount = Math.max(0, result.processedRows.length - visibleRows.length);

    let html = visibleRows.map((row) => {
        const fila1Cells = row.fila1Times
            .map((value) => `<td>${formatNumber(value)}</td>`)
            .join("");

        const fila2Cells = row.fila2Times
            .map((value) => `<td>${formatNumber(value)}</td>`)
            .join("");

        return `
            <tr>
                <td>${row.event}</td>
                <td>${formatNumber(row.tempoGlobal)}</td>
                <td>${row.fila1Customers}</td>
                <td>${row.fila1Queue}</td>
                <td>${row.fila2Customers}</td>
                <td>${row.fila2Queue}</td>
                ${fila1Cells}
                ${fila2Cells}
            </tr>
        `;
    }).join("");

    if (hiddenRowsCount > 0) {
        html += `<tr><td colspan="${6 + result.fila1.times.length + result.fila2.times.length}">+ ${hiddenRowsCount} eventos ocultos (use o botao para expandir)</td></tr>`;
    }

    tbody.innerHTML = html;
}

function renderScheduler(result) {
    const tbody = document.getElementById("schedule-table");
    if (!tbody) {
        return;
    }

    const visibleRows = result.schedulerRows.slice(0, scheduleTableLimit);
    const hiddenRowsCount = Math.max(0, result.schedulerRows.length - visibleRows.length);

    let html = visibleRows.map((row) => {
        return `<tr><td>${row.event}</td><td>${truncateForCell(row.tempo)}</td><td>${truncateForCell(row.sorteio)}</td></tr>`;
    }).join("");

    if (hiddenRowsCount > 0) {
        html += `<tr><td colspan="3">+ ${hiddenRowsCount} escalonamentos ocultos (use o botao para expandir)</td></tr>`;
    }

    tbody.innerHTML = html;
}

function renderStateProbabilityTable(tableBodyId, queueResult) {
    const tbody = document.getElementById(tableBodyId);
    if (!tbody) {
        return;
    }

    tbody.innerHTML = queueResult.times.map((tempo, i) => {
        return `<tr><td>${i}</td><td>${tempo.toFixed(4)}</td><td>${queueResult.prob[i].toFixed(4)}</td></tr>`;
    }).join("");
}

function createStateChart(canvasId, existingChart, queueResult, label) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) {
        return existingChart;
    }

    const labels = queueResult.prob.map((_, i) => `Estado ${i}`);
    const values = queueResult.prob;

    if (existingChart) {
        existingChart.destroy();
    }

    return new Chart(canvas.getContext("2d"), {
        type: "bar",
        data: {
            labels,
            datasets: [
                {
                    label,
                    data: values,
                    backgroundColor: "#FF4FD8",
                    borderColor: "#FF4FD8",
                    borderWidth: 1,
                },
            ],
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            scales: {
                x: {
                    title: {
                        display: true,
                        text: "Estado i",
                    },
                },
                y: {
                    beginAtZero: true,
                    title: {
                        display: true,
                        text: "Probabilidade",
                    },
                },
            },
        },
    });
}

function renderStateCharts(result) {
    stateChartF1 = createStateChart("stateChartF1", stateChartF1, result.fila1, "P(i) Fila 1");
    stateChartF2 = createStateChart("stateChartF2", stateChartF2, result.fila2, "P(i) Fila 2");
}

function exportChartPng(chart, filename) {
    if (!chart) {
        return;
    }

    const url = chart.toBase64Image("image/png", 1);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.click();
}

function generateLcgScatterPoints(seed, a, c, M, count) {
    const sampleCount = Math.max(2, Math.min(count, 5000));
    const values = [];
    let previous = seed;

    for (let i = 0; i < sampleCount; i += 1) {
        previous = (a * previous + c) % M;
        values.push(previous / M);
    }

    const points = [];
    for (let i = 0; i < values.length - 1; i += 1) {
        points.push({ x: values[i], y: values[i + 1] });
    }
    return points;
}

function renderLcgDistributionChart(params) {
    const canvas = document.getElementById("lcgScatterPlot");
    if (!canvas) {
        return;
    }

    const points = generateLcgScatterPoints(params.seed, params.a, params.c, params.M, params.randomCount);

    if (lcgScatterChart) {
        lcgScatterChart.destroy();
    }

    lcgScatterChart = new Chart(canvas.getContext("2d"), {
        type: "scatter",
        data: {
            datasets: [
                {
                    label: "U_i x U_i+1",
                    data: points,
                    pointRadius: 2,
                    backgroundColor: "#FF4FD8",
                    borderColor: "#FF4FD8",
                    showLine: false,
                },
            ],
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            scales: {
                x: {
                    min: 0,
                    max: 1,
                    title: {
                        display: true,
                        text: "U_i",
                    },
                },
                y: {
                    min: 0,
                    max: 1,
                    title: {
                        display: true,
                        text: "U_i+1",
                    },
                },
            },
        },
    });
}

function setupLcgAccordion() {
    const toggle = document.getElementById("lcg-accordion-toggle");
    const content = document.getElementById("lcg-distribution-content");
    if (!toggle || !content) {
        return;
    }

    toggle.addEventListener("click", () => {
        const isOpen = toggle.getAttribute("aria-expanded") === "true";
        if (isOpen) {
            toggle.setAttribute("aria-expanded", "false");
            toggle.textContent = "Mostrar grafico de distribuicao do LCG";
            content.hidden = true;
        } else {
            const params = readParams();
            toggle.setAttribute("aria-expanded", "true");
            toggle.textContent = "Ocultar grafico de distribuicao do LCG";
            content.hidden = false;
            renderLcgDistributionChart(params);
        }
    });
}

function exportCsv(result) {
    const rows = [
        "fila,estado,tempo,probabilidade",
        ...result.fila1.times.map((tempo, i) => `Fila1,${i},${tempo.toFixed(4)},${result.fila1.prob[i].toFixed(4)}`),
        ...result.fila2.times.map((tempo, i) => `Fila2,${i},${tempo.toFixed(4)},${result.fila2.prob[i].toFixed(4)}`),
    ];

    const blob = new Blob([rows.join("\n")], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "resultado_simulacao_tandem.csv";
    link.click();
    URL.revokeObjectURL(url);
}

function executeSimulation() {
    const errorNode = document.getElementById("error");
    const params = readParams();
    const error = validateParams(params);

    if (error) {
        errorNode.textContent = error;
        return;
    }

    errorNode.textContent = "";
    lastResult = runSimulation(params);

    statesTableLimit = DEFAULT_TABLE_LIMIT;
    scheduleTableLimit = DEFAULT_TABLE_LIMIT;
    setLimitToggleLabel("toggle-states-limit", statesTableLimit);
    setLimitToggleLabel("toggle-schedule-limit", scheduleTableLimit);

    renderMetrics(lastResult);
    renderStates(lastResult);
    renderScheduler(lastResult);
    renderStateProbabilityTable("state-probability-table-f1", lastResult.fila1);
    renderStateProbabilityTable("state-probability-table-f2", lastResult.fila2);
    renderStateCharts(lastResult);

    const isLcgVisible = document.getElementById("lcg-accordion-toggle")?.getAttribute("aria-expanded") === "true";
    if (isLcgVisible) {
        renderLcgDistributionChart(params);
    }
}

function loadMinimumScenario() {
    document.getElementById("seed").value = "42";
    document.getElementById("multiplier").value = "39758";
    document.getElementById("increment").value = "58739";
    document.getElementById("modulus").value = "987654321";
    document.getElementById("count").value = "100000";

    document.getElementById("first-arrival").value = "1.5";

    document.getElementById("f1-min-arrival").value = "1.0";
    document.getElementById("f1-max-arrival").value = "4.0";
    document.getElementById("f1-min-service").value = "3.0";
    document.getElementById("f1-max-service").value = "4.0";
    document.getElementById("f1-servers").value = "2";
    document.getElementById("f1-capacity").value = "3";

    document.getElementById("f2-min-service").value = "2.0";
    document.getElementById("f2-max-service").value = "3.0";
    document.getElementById("f2-servers").value = "1";
    document.getElementById("f2-capacity").value = "5";
}

function scheduleExecuteSimulation() {
    window.clearTimeout(regenerateTimeoutId);
    regenerateTimeoutId = window.setTimeout(() => {
        executeSimulation();
    }, AUTO_REGENERATE_DELAY);
}

function setupAutoRegeneration() {
    const fields = [
        "seed",
        "multiplier",
        "increment",
        "modulus",
        "count",
        "first-arrival",
        "f1-min-arrival",
        "f1-max-arrival",
        "f1-min-service",
        "f1-max-service",
        "f1-servers",
        "f1-capacity",
        "f2-min-service",
        "f2-max-service",
        "f2-servers",
        "f2-capacity",
    ];

    fields.forEach((id) => {
        const node = document.getElementById(id);
        if (!node) {
            return;
        }

        node.addEventListener("blur", scheduleExecuteSimulation);
        node.addEventListener("change", scheduleExecuteSimulation);
    });
}

document.getElementById("run")?.addEventListener("click", executeSimulation);

document.getElementById("scenario-minimum")?.addEventListener("click", () => {
    loadMinimumScenario();
    executeSimulation();
});

document.getElementById("download-csv")?.addEventListener("click", () => {
    if (!lastResult) {
        executeSimulation();
    }
    if (lastResult) {
        exportCsv(lastResult);
    }
});

document.getElementById("download-chart-f1")?.addEventListener("click", () => {
    if (!stateChartF1 && lastResult) {
        renderStateCharts(lastResult);
    }
    exportChartPng(stateChartF1, "probabilidade_estados_fila1.png");
});

document.getElementById("download-chart-f2")?.addEventListener("click", () => {
    if (!stateChartF2 && lastResult) {
        renderStateCharts(lastResult);
    }
    exportChartPng(stateChartF2, "probabilidade_estados_fila2.png");
});

document.getElementById("toggle-states-limit")?.addEventListener("click", () => {
    if (!lastResult) {
        executeSimulation();
        return;
    }

    statesTableLimit = statesTableLimit === DEFAULT_TABLE_LIMIT ? EXPANDED_TABLE_LIMIT : DEFAULT_TABLE_LIMIT;
    setLimitToggleLabel("toggle-states-limit", statesTableLimit);
    renderStates(lastResult);
});

document.getElementById("toggle-schedule-limit")?.addEventListener("click", () => {
    if (!lastResult) {
        executeSimulation();
        return;
    }

    scheduleTableLimit = scheduleTableLimit === DEFAULT_TABLE_LIMIT ? EXPANDED_TABLE_LIMIT : DEFAULT_TABLE_LIMIT;
    setLimitToggleLabel("toggle-schedule-limit", scheduleTableLimit);
    renderScheduler(lastResult);
});

window.addEventListener("DOMContentLoaded", () => {
    setupLcgAccordion();
    setupAutoRegeneration();
    loadMinimumScenario();
    executeSimulation();
});