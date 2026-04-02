const EVENT_TYPES = {
    CHEGADA: "CHEGADA",
    SAIDA: "SAIDA",
};

let lastResult = null;
let stateChart = null;
let lcgScatterChart = null;
let regenerateTimeoutId = null;
let statesTableLimit = 50;
let scheduleTableLimit = 50;

const AUTO_REGENERATE_DELAY = 250;
const DEFAULT_TABLE_LIMIT = 50;
const EXPANDED_TABLE_LIMIT = 1000;
const MAX_CELL_CHARS = 60;

function readParams() {
    return {
        seed: Number.parseInt(document.getElementById("seed").value, 10),
        a: Number.parseInt(document.getElementById("multiplier").value, 10),
        c: Number.parseInt(document.getElementById("increment").value, 10),
        M: Number.parseInt(document.getElementById("modulus").value, 10),
        firstArrival: Number.parseFloat(document.getElementById("first-arrival").value),
        minArrival: Number.parseFloat(document.getElementById("min-arrival").value),
        maxArrival: Number.parseFloat(document.getElementById("max-arrival").value),
        minService: Number.parseFloat(document.getElementById("min-service").value),
        maxService: Number.parseFloat(document.getElementById("max-service").value),
        servers: Number.parseInt(document.getElementById("servers").value, 10),
        K: Number.parseInt(document.getElementById("capacity").value, 10),
        randomCount: Number.parseInt(document.getElementById("count").value, 10),
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

    if (p.firstArrival < 0) return "A primeira chegada deve ser >= 0.";
    if (p.minArrival > p.maxArrival) return "minArrival deve ser <= maxArrival.";
    if (p.minService > p.maxService) return "minService deve ser <= maxService.";
    if (p.minArrival < 0 || p.maxArrival < 0 || p.minService < 0 || p.maxService < 0) {
        return "Intervalos uniformes devem ser nao-negativos.";
    }

    if (p.servers < 1) return "c deve ser >= 1.";
    if (p.K < 1) return "K deve ser >= 1.";
    if (p.K < p.servers) return "K deve ser >= c.";
    if (p.randomCount < 1) return "Quantidade de aleatorios deve ser >= 1.";
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
    return type === EVENT_TYPES.CHEGADA ? "Chegada" : "Saida";
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

function addSchedulerRow(state, payload) {
    state.scheduleCounter += 1;

    if (payload.isInitial) {
        state.schedulerRows.push({
            event: `(${state.scheduleCounter}) ${formatEventType(payload.tipo)} inicial`,
            tempo: `0.0000 + t0(${formatNumber(payload.tempoAgendado)}) = ${formatNumber(payload.tempoAgendado)}`,
            sorteio: `t0 = ${formatNumber(payload.tempoAgendado)}`,
        });
        return;
    }

    state.schedulerRows.push({
        event: `(${state.scheduleCounter}) ${formatEventType(payload.tipo)}`,
        tempo: `${formatNumber(payload.tempoBase)} + ${formatNumber(payload.sorteio)} = ${formatNumber(payload.tempoAgendado)}`,
        sorteio: `u=${formatNumber(payload.u)}; U(${formatNumber(payload.min)}, ${formatNumber(payload.max)}) = ${formatNumber(payload.sorteio)}`,
    });
}

function scheduleNextArrival(state, params) {
    const draw = uniform(params.minArrival, params.maxArrival, state.rng);
    if (draw === null) {
        return false;
    }

    const scheduledTime = state.tempoAtual + draw.value;
    addSchedulerRow(state, {
        tipo: EVENT_TYPES.CHEGADA,
        tempoBase: state.tempoAtual,
        sorteio: draw.value,
        u: draw.u,
        tempoAgendado: scheduledTime,
        min: params.minArrival,
        max: params.maxArrival,
    });

    enqueueEvent(state.events, {
        tempo: scheduledTime,
        tipo: EVENT_TYPES.CHEGADA,
    });
    return true;
}

function scheduleDeparture(state, params) {
    const draw = uniform(params.minService, params.maxService, state.rng);
    if (draw === null) {
        return false;
    }

    const scheduledTime = state.tempoAtual + draw.value;
    addSchedulerRow(state, {
        tipo: EVENT_TYPES.SAIDA,
        tempoBase: state.tempoAtual,
        sorteio: draw.value,
        u: draw.u,
        tempoAgendado: scheduledTime,
        min: params.minService,
        max: params.maxService,
    });

    enqueueEvent(state.events, {
        tempo: scheduledTime,
        tipo: EVENT_TYPES.SAIDA,
    });
    return true;
}

function processArrival(state, params) {
    if (state.N < params.K) {
        state.N += 1;

        if (state.emServico < params.servers) {
            state.emServico += 1;
            const scheduledDeparture = scheduleDeparture(state, params);
            if (!scheduledDeparture) {
                state.shouldStop = true;
                return;
            }
        }
    } else {
        state.perdas += 1;
    }

    const scheduledArrival = scheduleNextArrival(state, params);
    if (!scheduledArrival) {
        state.shouldStop = true;
    }
}

function processDeparture(state, params) {
    if (state.emServico <= 0 || state.N <= 0) {
        return;
    }

    state.emServico -= 1;
    state.N -= 1;

    const fila = state.N - state.emServico;
    if (fila > 0) {
        state.emServico += 1;
        const scheduledDeparture = scheduleDeparture(state, params);
        if (!scheduledDeparture) {
            state.shouldStop = true;
        }
    }
}

function runSimulation(params) {
    const state = {
        tempoAtual: 0,
        tempoAnterior: 0,
        N: 0,
        emServico: 0,
        perdas: 0,
        times: Array(params.K + 1).fill(0),
        events: [],
        processedRows: [],
        schedulerRows: [],
        processedCounter: 0,
        scheduleCounter: 0,
        shouldStop: false,
        rng: {
            a: params.a,
            c: params.c,
            M: params.M,
            previous: params.seed,
            remaining: params.randomCount,
            used: 0,
        },
    };

    enqueueEvent(state.events, {
        tempo: params.firstArrival,
        tipo: EVENT_TYPES.CHEGADA,
    });

    addSchedulerRow(state, {
        tipo: EVENT_TYPES.CHEGADA,
        isInitial: true,
        tempoAgendado: params.firstArrival,
    });

    while (state.events.length > 0 && state.rng.remaining > 0 && !state.shouldStop) {
        const evento = nextEvent(state.events);
        state.tempoAtual = evento.tempo;

        const deltaT = state.tempoAtual - state.tempoAnterior;
        state.times[state.N] += deltaT;
        state.tempoAnterior = state.tempoAtual;

        if (evento.tipo === EVENT_TYPES.CHEGADA) {
            processArrival(state, params);
        } else {
            processDeparture(state, params);
        }

        state.processedCounter += 1;
        state.processedRows.push({
            event: `${state.processedCounter} - ${formatEventType(evento.tipo)}`,
            fila: Math.max(0, state.N - state.emServico),
            tempoGlobal: state.tempoAtual,
            accumulatedByState: [...state.times],
        });
    }

    const tempoGlobal = state.tempoAtual;
    const prob = state.times.map((value) => (tempoGlobal > 0 ? value / tempoGlobal : 0));
    const Nmedio = tempoGlobal > 0
        ? state.times.reduce((acc, t, i) => acc + i * t, 0) / tempoGlobal
        : 0;

    return {
        tempoGlobal,
        times: state.times,
        prob,
        Nmedio,
        perdas: state.perdas,
        pFilaVazia: prob[0] ?? 0,
        randomUsed: state.rng.used,
        randomRemaining: state.rng.remaining,
        processedRows: state.processedRows,
        schedulerRows: state.schedulerRows,
        stopReason: state.rng.remaining <= 0 ? "Aleatorios esgotados" : "Fila de eventos vazia",
    };
}

function renderMetrics(result) {
    const container = document.getElementById("metrics");
    const items = [
        ["Tempo total", `${result.tempoGlobal.toFixed(4)} u.t.`],
        ["Perdas", `${result.perdas} clientes`],
        ["Populacao media (Nmedio)", `${result.Nmedio.toFixed(4)} clientes`],
        ["Prob. fila vazia", `${(result.pFilaVazia * 100).toFixed(4)}%`],
        ["Aleatorios usados", `${result.randomUsed} amostras`],
        ["Aleatorios restantes", `${result.randomRemaining} amostras`],
    ];

    if (result.stopReason && result.stopReason !== "Aleatorios esgotados") {
        items.push(["Parada", result.stopReason]);
    }

    container.innerHTML = items.map(([label, value]) => (
        `<article class="metric-card"><h3>${label}</h3><p>${value}</p></article>`
    )).join("");
}

function renderStates(result) {
    const head = document.getElementById("states-head");
    const tbody = document.getElementById("states-table");

    if (!head || !tbody) {
        return;
    }

    const stateHeaders = result.times.map((_, i) => `<th>Estado ${i}</th>`).join("");
    head.innerHTML = `<tr><th>Evento</th><th>Fila</th><th>Tempo global</th>${stateHeaders}</tr>`;

    const visibleRows = result.processedRows.slice(0, statesTableLimit);
    const hiddenRowsCount = Math.max(0, result.processedRows.length - visibleRows.length);

    let html = visibleRows.map((row) => {
        const accumulatedCells = row.accumulatedByState
            .map((value) => `<td>${formatNumber(value)}</td>`)
            .join("");

        return `<tr><td>${row.event}</td><td>${row.fila}</td><td>${formatNumber(row.tempoGlobal)}</td>${accumulatedCells}</tr>`;
    }).join("");

    if (hiddenRowsCount > 0) {
        html += `<tr><td colspan="${result.times.length + 3}">+ ${hiddenRowsCount} eventos ocultos (use o botão para expandir)</td></tr>`;
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
        html += `<tr><td colspan="3">+ ${hiddenRowsCount} escalonamentos ocultos (use o botão para expandir)</td></tr>`;
    }

    tbody.innerHTML = html;
}

function renderStateProbabilityTable(result) {
    const tbody = document.getElementById("state-probability-table");
    if (!tbody) {
        return;
    }

    tbody.innerHTML = result.times.map((tempo, i) => {
        return `<tr><td>${i}</td><td>${tempo.toFixed(4)}</td><td>${result.prob[i].toFixed(4)}</td></tr>`;
    }).join("");
}

function renderStateChart(result) {
    const canvas = document.getElementById("stateChart");
    if (!canvas) {
        return;
    }

    const labels = result.prob.map((_, i) => `Estado ${i}`);
    const values = result.prob;

    if (stateChart) {
        stateChart.destroy();
    }

    stateChart = new Chart(canvas.getContext("2d"), {
        type: "bar",
        data: {
            labels,
            datasets: [
                {
                    label: "P(i)",
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

function exportChartPng() {
    if (!stateChart && lastResult) {
        renderStateChart(lastResult);
    }
    if (!stateChart) {
        return;
    }

    const url = stateChart.toBase64Image("image/png", 1);
    const link = document.createElement("a");
    link.href = url;
    link.download = "probabilidade_estados.png";
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
    const rows = ["estado,tempo,probabilidade"];
    for (let i = 0; i < result.times.length; i += 1) {
        rows.push(`${i},${result.times[i].toFixed(4)},${result.prob[i].toFixed(4)}`);
    }

    const blob = new Blob([rows.join("\n")], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "resultado_simulacao_fila.csv";
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
    renderStateProbabilityTable(lastResult);
    renderStateChart(lastResult);

    const isLcgVisible = document.getElementById("lcg-accordion-toggle")?.getAttribute("aria-expanded") === "true";
    if (isLcgVisible) {
        renderLcgDistributionChart(params);
    }
}

function loadMinimumScenario(servers) {
    document.getElementById("first-arrival").value = "2.0";
    document.getElementById("min-arrival").value = "2.0";
    document.getElementById("max-arrival").value = "5.0";
    document.getElementById("min-service").value = "3.0";
    document.getElementById("max-service").value = "5.0";
    document.getElementById("servers").value = String(servers);
    document.getElementById("capacity").value = "5";
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
        "min-arrival",
        "max-arrival",
        "min-service",
        "max-service",
        "servers",
        "capacity",
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

document.getElementById("run").addEventListener("click", executeSimulation);

document.getElementById("scenario-c1").addEventListener("click", () => {
    loadMinimumScenario(1);
    executeSimulation();
});

document.getElementById("scenario-c2").addEventListener("click", () => {
    loadMinimumScenario(2);
    executeSimulation();
});

document.getElementById("download-csv").addEventListener("click", () => {
    if (!lastResult) {
        executeSimulation();
    }
    if (lastResult) {
        exportCsv(lastResult);
    }
});

document.getElementById("download-chart").addEventListener("click", exportChartPng);

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
    executeSimulation();
});
